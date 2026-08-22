/* demos/show/timeline.js — the show cue timeline editor
   ============================================================================
   Purpose: dial in visual-transition timing against the music, at the desk, on
   show day. A DAW-style timeline of the set with the cue list laid over it —
   drag a bar, hear the moment, watch the scene it brings up, save it back into
   the running follower without restarting anything.

   Everything is drawn into ONE canvas (ruler / video sub-lane / scene+palette
   cue lane / coloured music lane / waveform / playhead). DOM is only used where
   DOM is better than pixels: the inspector, the transport bar, the stage
   switcher. See timeline.html for the shell and timeline-preview.js for the
   live scene box.

   THE CUE DOCUMENTS ARE HANDLED AS DATA, NOT AS A MODEL. A cue is a plain
   object out of the JSON and is mutated IN PLACE, `at` only. `at_original`,
   `at_original_hms`, `snap` and `track` are documentation the snapper wrote for
   a human; this editor reads them and never writes them. Nothing is rebuilt,
   reformatted or normalized on the way out, so a cue you did not touch is a cue
   you did not change.

   (One caveat learned from the server side: POST /show/cues round-trips through
   write_json_atomic with sort_keys=True, so the file on disk comes back with
   its keys reordered. Values are identical; key ORDER is not preserved past the
   first save. Nothing here fights that.)
   ========================================================================== */
'use strict';

import { AnalysisEngine } from '../../vizier-analysis.js';
import {
  PreviewHost, ALL_SCENES, iqCss, normPalette,
} from './timeline-preview.js';

/* ------------------------------------------------------------------ config */

const PARAMS = new URLSearchParams(location.search);
/* The leader (show-view) owns the track analysis that colours the music lane.
   Different origin, so it needs CORS on /api/* — if it is missing or the leader
   is down, the lane degrades to plain grey and says so. */
const LEADER = (PARAMS.get('leader') || 'http://127.0.0.1:8090').replace(/\/+$/, '');
/* The follower serves this page, so its own origin is the right default for
   /show/*. Overridable for the odd case of editing from another machine. */
const FOLLOWER = (PARAMS.get('follower') || location.origin).replace(/\/+$/, '');
/* Video inserts. Relative on purpose: resolves to /demos/show/media/<name>
   when served normally, and keeps working under any mount prefix. */
const MEDIA_BASE = './media/';

const STAGES = ['main', 'opener'];

/* Last-resort defaults, used only when a cue doc does not name its own audio /
   duration (the main doc does; a hand-written opener doc might not). Numbers
   come from data/analysis.json's last track end. */
const STAGE_FALLBACK = {
  main: { file: 'cues-pm-2026.json', audio: 'party-mountain-16bit-release.wav', duration: 4702.041 },
  opener: { file: 'cues-pm-2026-opener.json', audio: 'pm-2026-opening-set.wav', duration: 1253.331 },
};

const BINS_PER_SEC = 20;      // waveform resolution: 50 ms per min/max pair

/* --------------------------------------------------------------- dom + util */

const $ = (id) => document.getElementById(id);
const cv = $('tl');
const ctx = cv.getContext('2d');
const tlwrap = $('tlwrap');
const audioEl = $('au');

const clamp = (v, a, b) => (v < a ? a : (v > b ? b : v));

function clone(o) {
  if (typeof structuredClone === 'function') {
    try { return structuredClone(o); } catch (e) { /* fall through */ }
  }
  return JSON.parse(JSON.stringify(o));
}

function fmtClock(t) {
  if (!isFinite(t)) return '--:--';
  const neg = t < 0; t = Math.abs(t);
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = Math.floor(t) % 60;
  const p2 = (n) => (n < 10 ? '0' + n : '' + n);
  return (neg ? '-' : '') + (h ? h + ':' + p2(m) : '' + m) + ':' + p2(s);
}

function fmtTc(t) {
  if (!isFinite(t)) return '--:--:--.---';
  const neg = t < 0; t = Math.abs(t);
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60;
  const s = Math.floor(t) % 60, ms = Math.round((t - Math.floor(t)) * 1000);
  const p2 = (n) => (n < 10 ? '0' + n : '' + n);
  const p3 = (n) => ('00' + n).slice(-3);
  return (neg ? '-' : '') + p2(h) + ':' + p2(m) + ':' + p2(s) + '.' + p3(ms);
}

/* Accepts H:MM:SS.mmm | MM:SS(.mmm) | plain seconds. Returns NaN on anything
   else, and the caller puts the old value back rather than writing garbage. */
function parseTimecode(str) {
  if (str == null) return NaN;
  const s = String(str).trim();
  if (!s || !/^-?[0-9]*(\.[0-9]+)?(:[0-9]*(\.[0-9]+)?){0,2}$/.test(s)) return NaN;
  const neg = s[0] === '-';
  const parts = (neg ? s.slice(1) : s).split(':');
  let v = 0;
  for (const p of parts) {
    const n = p === '' ? 0 : Number(p);
    if (!isFinite(n) || n < 0) return NaN;
    v = v * 60 + n;
  }
  return neg ? -v : v;
}

/* FNV-1a over the scene name -> a stable hue. Same scene, same colour, in every
   session and at any zoom. */
function hashHue(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h % 360;
}

const atOf = (c) => (c && isFinite(Number(c.at)) ? Number(c.at) : 0);

/* A cue's type. `type` is authoritative when present (contract), and the shape
   is the fallback for a legacy doc that predates the field. */
function cueType(c) {
  if (!c) return 'scene';
  if (c.type) return String(c.type);
  if (c.video) return 'video';
  if (c.palette) return 'palette';
  return 'scene';
}

/* ------------------------------------------------------------------ warnings */

const warnings = new Map();
function warn(key, msg) {
  if (msg) warnings.set(key, msg); else warnings.delete(key);
  const chip = $('warnChip');
  if (!warnings.size) { chip.style.display = 'none'; return; }
  chip.style.display = '';
  chip.textContent = Array.from(warnings.values()).join('  ·  ');
  chip.title = Array.from(warnings.values()).join('\n');
}
let flashTimer = 0;
function flash(msg, bad) {
  warn('_flash', msg);
  $('warnChip').classList.toggle('bad', !!bad);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { warn('_flash', null); $('warnChip').classList.remove('bad'); }, 6000);
}

/* ================================================================ EditModel */

class EditModel {
  constructor() {
    this.stages = {};       // name -> {file, doc, saved, undo, redo, audio, duration}
    this.active = 'main';
    this.sel = null;        // the SELECTED CUE OBJECT, by identity
    this.rev = 0;           // bumped on every mutation; caches key off it
  }

  setStage(name, file, doc, fb) {
    const d = doc && typeof doc === 'object' ? clone(doc) : { cues: [] };
    if (!Array.isArray(d.cues)) d.cues = [];
    this.stages[name] = {
      name,
      file: file || (d._file || (fb && fb.file) || null),
      doc: d,
      saved: JSON.stringify(d),
      undo: [], redo: [],
      audio: d.audio || (fb && fb.audio) || null,
      duration: Number(d.duration) || (fb && fb.duration) || 0,
    };
    this.rev++;
  }

  get cur() { return this.stages[this.active] || null; }

  cues(st) {
    st = st || this.cur;
    if (!st) return [];
    if (!Array.isArray(st.doc.cues)) st.doc.cues = [];
    return st.doc.cues;
  }

  dirty(name) {
    const st = this.stages[name];
    return !!st && JSON.stringify(st.doc) !== st.saved;
  }

  anyDirty() { return Object.keys(this.stages).some((n) => this.dirty(n)); }

  selIndex() {
    const st = this.cur;
    if (!st || !this.sel) return -1;
    return this.cues(st).indexOf(this.sel);   // identity, not value
  }

  /* Undo snapshots are whole-document JSON strings. Cheap (a few kB), and it
     makes "did anything change?" the same comparison as `dirty`.

     Selection is by object IDENTITY while editing, but JSON.parse on undo
     necessarily makes new objects — so the snapshot also carries the selected
     cue's INDEX, and the selection is re-anchored to the equivalent cue in the
     restored array. */
  beginGesture() {
    const st = this.cur;
    if (!st) return null;
    const snap = { json: JSON.stringify(st.doc), sel: this.selIndex() };
    st.undo.push(snap);
    if (st.undo.length > 100) st.undo.shift();
    st.redo.length = 0;
    return { st, snap };
  }

  /* Drop a snapshot that turned out to record no change (a focus that never
     became an edit), so undo never becomes a run of no-ops. */
  endGesture(tok) {
    if (!tok) return;
    const st = tok.st;
    if (st.undo[st.undo.length - 1] === tok.snap && JSON.stringify(st.doc) === tok.snap.json) {
      st.undo.pop();
    }
  }

  _restore(snap) {
    const st = this.cur;
    st.doc = JSON.parse(snap.json);
    st.audio = st.doc.audio || st.audio;
    if (Number(st.doc.duration)) st.duration = Number(st.doc.duration);
    const cs = this.cues(st);
    this.sel = (snap.sel >= 0 && snap.sel < cs.length) ? cs[snap.sel] : null;
    this.rev++;
  }

  undo() {
    const st = this.cur;
    if (!st || !st.undo.length) return false;
    const snap = st.undo.pop();
    st.redo.push({ json: JSON.stringify(st.doc), sel: this.selIndex() });
    this._restore(snap);
    return true;
  }

  redo() {
    const st = this.cur;
    if (!st || !st.redo.length) return false;
    const snap = st.redo.pop();
    st.undo.push({ json: JSON.stringify(st.doc), sel: this.selIndex() });
    this._restore(snap);
    return true;
  }

  /* THE edit. Clamped to the stage, rounded to the millisecond (the follower
     compares floats against a 20 Hz transport; sub-ms precision is noise), and
     it touches NOTHING but `at`. */
  setCueAt(cue, t) {
    const st = this.cur;
    const dur = (st && st.duration) || 1e9;
    const v = Math.round(clamp(t, 0, dur) * 1000) / 1000;
    if (cue.at === v) return;
    cue.at = v;
    this.rev++;
  }

  addCue(cue) {
    const st = this.cur;
    if (!st) return null;
    this.cues(st).push(cue);
    this.rev++;
    return cue;
  }

  removeCue(cue) {
    const st = this.cur;
    if (!st) return false;
    const cs = this.cues(st);
    const i = cs.indexOf(cue);
    if (i < 0) return false;
    cs.splice(i, 1);
    if (this.sel === cue) this.sel = null;
    this.rev++;
    return true;
  }

  markSaved(name) {
    const st = this.stages[name];
    if (st) st.saved = JSON.stringify(st.doc);
  }
}

const model = new EditModel();

/* =========================================================== MiniCueEngine
   A faithful-enough mirror of Box._eval_cues (follower_server.py:286-353) so
   the preview shows what the TV will show at this position.

   ONE DELIBERATE DIVERGENCE, and it matters: the follower only plays a video
   insert if the playhead ENTERED its window by playing through the start
   (follower_server.py:310-325 — the armed/active/skipped state machine, which
   exists so that seeking into the middle of a clip on the night does not raise
   half a clip on the big screen). This editor has no such state: any position
   inside [at, at+duration) SHOWS the clip. An editor that hid the clip you just
   scrubbed onto would be useless for the one job this page has, which is
   deciding where the clip should start. Everything else — the last-cue-wins
   scene lookup, return_scene overriding the scene while an insert is up, the
   logo riding the scene cue — matches. */
class MiniCueEngine {
  constructor(m) {
    this.model = m;
    this._rev = -1; this._st = null;
    this.scene = []; this.video = []; this.pal = [];
  }

  _sync() {
    const st = this.model.cur;
    if (!st) { this.scene = []; this.video = []; this.pal = []; this._st = null; return; }
    if (this._rev === this.model.rev && this._st === st) return;
    this._rev = this.model.rev; this._st = st;

    const cs = this.model.cues(st).slice();
    // sort by time; equal times keep DOCUMENT order. Never write a sort key on
    // to the cue objects themselves — they are the document.
    const ord = new Map();
    cs.forEach((c, i) => ord.set(c, i));
    cs.sort((a, b) => (atOf(a) - atOf(b)) || (ord.get(a) - ord.get(b)));

    this.scene = []; this.video = []; this.pal = [];
    for (const c of cs) {
      const t = cueType(c);
      if (t === 'video') this.video.push(c);
      else if (t === 'palette') this.pal.push(c);
      else this.scene.push(c);
    }
  }

  eval(pos) {
    this._sync();
    let sceneCue = null;
    for (let i = 0; i < this.scene.length; i++) {
      if (atOf(this.scene[i]) <= pos) sceneCue = this.scene[i]; else break;
    }
    let scene = sceneCue ? (sceneCue.scene || null) : null;
    const logo = sceneCue ? !!sceneCue.logo : false;

    let video = null;
    for (const c of this.video) {
      const a = atOf(c), d = Number(c.duration) || 0;
      if (a <= pos && pos < a + d) { video = c; break; }
    }
    // the insert names what sits underneath it and what to come back to
    if (video && video.return_scene) scene = video.return_scene;

    let palette = null, pi = -1;
    for (let i = 0; i < this.pal.length; i++) {
      if (atOf(this.pal[i]) <= pos) pi = i; else break;
    }
    if (pi >= 0) {
      const c = this.pal[pi];
      const fade = Math.max(Number(c.fade) || 0, 0.001);
      palette = { cue: c, prev: pi > 0 ? this.pal[pi - 1] : null, mix: clamp((pos - atOf(c)) / fade, 0, 1) };
    }
    return { scene, logo, sceneCue, video, palette };
  }

  /* Every cue in time order — for Tab-walking and for drawing. */
  ordered() { this._sync(); return this.scene.concat(this.video, this.pal).sort((a, b) => atOf(a) - atOf(b)); }
  sceneList() { this._sync(); return this.scene; }
  videoList() { this._sync(); return this.video; }
  palList() { this._sync(); return this.pal; }
}

const cueEngine = new MiniCueEngine(model);

/* ================================================================= peaks
   No decodeAudioData: the main set is a 1.6 GB wav and decoding it would want
   ~8 GB of Float32 in one allocation. Instead the file is STREAMED, its RIFF
   header parsed by hand, and the interleaved PCM frames folded into min/max
   bins as they arrive (~20 bins/s, so ~94 k bins / 750 kB for the main set).
   Both show wavs are covered: the main set is 16-bit stereo, the opening set is
   24-bit inside a WAVE_FORMAT_EXTENSIBLE wrapper.
   The canvas redraws as the bins fill, so the operator gets a waveform from the
   front of the file within a second.

   The follower is a ThreadingHTTPServer (follower_server.py:1094), so this long
   read does not block /show/* for anything else. */

function riffTag(u8, o) {
  return String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
}

/* Returns null when more bytes are needed, or the fmt + data-chunk location. */
function parseRiff(u8) {
  if (u8.length < 12) return null;
  if (riffTag(u8, 0) !== 'RIFF' || riffTag(u8, 8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.length);
  let off = 12, fmt = null;
  while (off + 8 <= u8.length) {
    const id = riffTag(u8, off);
    const size = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      if (body + 16 > u8.length) return null;
      fmt = {
        format: dv.getUint16(body, true),
        channels: dv.getUint16(body + 2, true),
        rate: dv.getUint32(body + 4, true),
        bits: dv.getUint16(body + 14, true),
      };
      // WAVE_FORMAT_EXTENSIBLE hides the real format in the sub-format GUID
      if (fmt.format === 0xFFFE && body + 26 <= u8.length) fmt.format = dv.getUint16(body + 24, true);
    } else if (id === 'data') {
      if (!fmt) throw new Error('data chunk before fmt chunk');
      return Object.assign({ dataOffset: body, dataBytes: size }, fmt);
    }
    const next = body + size + (size & 1);
    if (!(next > off)) break;     // zero / bogus size: stop rather than spin
    off = next;
  }
  return null;
}

function concatU8(a, b) {
  if (!a.length) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}

async function buildPeaks(url, binsPerSec, onChunk, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  if (!res.body || !res.body.getReader) throw new Error('this browser has no streaming fetch');
  const reader = res.body.getReader();
  const clen = Number(res.headers.get('Content-Length')) || 0;

  let hdr = new Uint8Array(0), info = null;
  const HDR_CAP = 1 << 20;
  while (!info) {
    const r = await reader.read();
    if (r.done) throw new Error('stream ended before the data chunk');
    hdr = concatU8(hdr, r.value);
    if (hdr.length > HDR_CAP) throw new Error('no data chunk in the first 1 MB');
    info = parseRiff(hdr);
  }

  /* 16-bit AND 24-bit, because the show needs both: the main set is 16-bit
     stereo PCM, and the opening set is 24-bit inside a WAVE_FORMAT_EXTENSIBLE
     wrapper (measured off the real files through GET /show/audio). Anything
     else — 8-bit, 32-bit float (format 3), compressed — is skipped with a note
     rather than mis-drawn. */
  if (info.format !== 1 || (info.bits !== 16 && info.bits !== 24)) {
    reader.cancel().catch(() => {});
    return {
      skipped: true,
      reason: 'wav is format ' + info.format + (info.format === 3 ? ' (float)' : '')
        + ' / ' + info.bits + '-bit (want 16- or 24-bit PCM)',
    };
  }

  const ch = Math.max(1, info.channels);
  const bps = info.bits >> 3;          // bytes per sample: 2 or 3
  const bpf = ch * bps;
  const FS = info.bits === 16 ? 32768 : 8388608;
  let dataBytes = info.dataBytes;
  if (!dataBytes || dataBytes === 0xFFFFFFFF || (clen && info.dataOffset + dataBytes > clen)) {
    dataBytes = clen ? Math.max(0, clen - info.dataOffset) : 0;
  }
  const totalFrames = dataBytes ? Math.floor(dataBytes / bpf) : 0;
  const duration = totalFrames / info.rate;
  const nBins = Math.max(1, Math.ceil((duration || 7200) * binsPerSec));

  const peaks = {
    skipped: false, min: new Float32Array(nBins), max: new Float32Array(nBins),
    nBins, bins: 0, binsPerSec, duration, rate: info.rate, channels: ch, bits: info.bits,
  };

  const spb = info.rate / binsPerSec;
  let frames = 0, bin = 0, binEnd = spb, bmn = FS, bmx = -FS;
  let residual = new Uint8Array(0);

  function feed(chunk) {
    const buf = residual.length ? concatU8(residual, chunk) : chunk;
    const n = Math.floor(buf.length / bpf);
    const usable = n * bpf;

    // 16-bit gets a typed-array view (the main set is 829 MB — this is the hot
    // loop); 24-bit is read byte-wise, which needs no alignment at all.
    let i16 = null;
    if (bps === 2) {
      if ((buf.byteOffset & 1) === 0) {
        i16 = new Int16Array(buf.buffer, buf.byteOffset, usable >> 1);
      } else {
        // odd byteOffset: Int16Array cannot view it, so copy the usable span
        const cp = buf.slice(0, usable);
        i16 = new Int16Array(cp.buffer, 0, usable >> 1);
      }
    }

    let k = 0, o = 0;
    for (let f = 0; f < n; f++) {
      let mn = FS, mx = -FS;
      if (i16) {
        for (let c = 0; c < ch; c++) { const v = i16[k++]; if (v < mn) mn = v; if (v > mx) mx = v; }
      } else {
        for (let c = 0; c < ch; c++) {
          // little-endian 24-bit, sign-extended through a 32-bit shift pair
          const v = ((buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16)) << 8) >> 8;
          o += 3;
          if (v < mn) mn = v; if (v > mx) mx = v;
        }
      }
      if (mn < bmn) bmn = mn;
      if (mx > bmx) bmx = mx;
      frames++;
      if (frames >= binEnd) {
        if (bin < nBins) { peaks.min[bin] = bmn / FS; peaks.max[bin] = bmx / FS; }
        bin++; binEnd += spb; bmn = FS; bmx = -FS;
      }
    }
    peaks.bins = Math.min(bin, nBins);
    residual = buf.subarray(usable);
  }

  feed(hdr.subarray(info.dataOffset));
  let ticks = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    feed(r.value);
    if ((++ticks % 24) === 0 && onChunk) onChunk(peaks);
  }
  if (bin < nBins && bmx >= bmn) { peaks.min[bin] = bmn / 32768; peaks.max[bin] = bmx / 32768; peaks.bins = bin + 1; }
  if (onChunk) onChunk(peaks);
  return peaks;
}

/* ===================================================================== net */

/* GET /show/cues, tolerating BOTH shapes:
     new    {active, cues_rev, stages: {main:{file,doc}, opener:{file,doc}}}
     legacy the bare cue doc itself, {audio, duration, cues:[...]}  <- what the
            follower answers TODAY (follower_server.py:645 returns box.cue_doc
            verbatim), so this is the path that actually runs until the
            per-stage endpoint lands. */
async function loadCues() {
  let body;
  try {
    const res = await fetch(FOLLOWER + '/show/cues', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    body = await res.json();
  } catch (e) {
    warn('cues', 'no cue list: ' + (e.message || e));
    return false;
  }
  if (!body || typeof body !== 'object') { warn('cues', 'cue list was not an object'); return false; }

  if (body.stages && typeof body.stages === 'object') {
    S.legacy = false;
    S.cuesRev = body.cues_rev == null ? null : body.cues_rev;
    let got = 0;
    for (const name of STAGES) {
      const s = body.stages[name];
      if (!s || !s.doc) continue;
      model.setStage(name, s.file, s.doc, STAGE_FALLBACK[name]);
      got++;
    }
    if (!got) { warn('cues', 'GET /show/cues named no main/opener stage'); return false; }
    warn('cues', null);
    // `active` is the active doc's FILENAME (follower_server.py:624), not a
    // stage name — resolve it through the per-stage `file`.
    if (body.active && !PARAMS.get('stage')) {
      const hit = STAGES.find((n) => model.stages[n] && model.stages[n].file === body.active);
      if (hit) model.active = hit;
    }
    return true;
  }

  // legacy single doc -> the main stage
  S.legacy = true;
  S.cuesRev = body.cues_rev == null ? null : body.cues_rev;
  const file = body._file || STAGE_FALLBACK.main.file;
  model.setStage('main', file, body, STAGE_FALLBACK.main);
  model.active = 'main';
  warn('cues', 'follower answered the LEGACY single-doc /show/cues — opener stage unavailable');
  return true;
}

/* GET {leader}/api/analysis. EVERY NUMERIC FIELD ARRIVES AS A STRING in
   show-view's data/analysis.json ("start":"5", "bpm":"165.3"), and `marker` is
   the STRING "False" — which is truthy. Coerce everything, trust nothing.
   Row 0 of each stage is an INTRO marker row with no bpm and no sections, so
   optional fields are optional. The file also carries a `preshow` key with a
   completely different shape (per-file objects); it is not ours, ignore it. */
async function loadAnalysis(fromDrop) {
  let body = fromDrop;
  if (!body) {
    try {
      const res = await fetch(LEADER + '/api/analysis', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      body = await res.json();
    } catch (e) {
      warn('analysis', 'no track colours (' + LEADER + '/api/analysis: ' + (e.message || e)
        + ') — drop an analysis.json on the timeline to load one');
      return false;
    }
  }
  let any = false;
  for (const name of STAGES) {
    const rows = body && Array.isArray(body[name]) ? body[name] : null;
    if (!rows) continue;
    S.analysis[name] = rows.map((e, i) => ({
      index: Number(e.index) || i,
      start: Number(e.start) || 0,
      end: Number(e.end) || 0,
      artist: e.artist == null ? '' : String(e.artist),
      title: e.title == null ? '' : String(e.title),
      bpm: e.bpm == null ? null : Number(e.bpm),
      marker: String(e.marker).toLowerCase() === 'true',
      sections: Array.isArray(e.sections) ? e.sections : [],
    })).filter((e) => e.end > e.start);
    any = any || S.analysis[name].length > 0;
  }
  if (!any) { warn('analysis', 'analysis had no main/opener tracks'); return false; }
  warn('analysis', null);
  needDraw = true;
  return true;
}

/* ================================================================== state */

const S = {
  legacy: false,
  cuesRev: null,
  analysis: { main: [], opener: [] },
  peaks: { main: null, opener: null },
  peaksAbort: { main: null, opener: null },
};

const view = { t0: 0, pps: 1 };
let needDraw = true;
let hits = [];            // rebuilt every draw: {cue, x, y, w, h}
let cw = 1, chh = 1;
let armed = false;        // has the audio graph been built by a user gesture?
let posManual = 0;
let audioOk = false;
let lastPosText = '', lastCueText = '', lastPlayText = '';

function curStage() { return model.cur; }
function curDuration() {
  const st = curStage();
  if (!st) return 1;
  if (st.duration) return st.duration;
  const an = S.analysis[st.name];
  if (an && an.length) return an[an.length - 1].end;
  const p = S.peaks[st.name];
  if (p && p.duration) return p.duration;
  if (audioOk && isFinite(audioEl.duration)) return audioEl.duration;
  return 1;
}

/* ================================================================== audio
   ONE AnalysisEngine for the page. vizier-analysis.js keeps its audio element,
   graph and delay node in MODULE-level state, so a second instance would fight
   the first over the same <audio>. */
const engine = new AnalysisEngine({ audioEl, onMessage: () => {}, onStatusChange: () => {}, onTracksLoaded: () => {} });

/* CRITICAL. The default is 0.11 s (vizier-analysis.js:596): a DelayNode on the
   AUDIBLE branch that lines up the sound with a visual pipeline that trails it.
   Here the operator is matching cue times to what they HEAR, so the heard audio
   must be the playhead exactly. 110 ms of offset is 110 ms of wrong cue times. */
engine.setSyncDelay(0);

/* --------------------------------------------------------------- volume
   The rig is at the venue, wired to the PA. The editor is MEANT to be audible
   (unlike the TV follower, which sets this to 0 because that machine makes no
   sound) — but "audible" must not mean "full gain into the house on page load".

   setOutputGain is the right knob, and the only right one:
     * audioEl.volume would attenuate the element, and in some browsers that
       starves the MediaElementSource feeding the analysers — the preview would
       go still exactly when you turn the room down.
     * a gain in front of the analyser tap has the same problem.
   setOutputGain sits AFTER the tap (vizier-analysis.js:604-608), so every
   ChromaFrame field stays live at any volume, including silence. It is also
   safe to call before the graph exists: ensureLocalGraph reads the stored
   value when it builds the node (vizier-analysis.js:606), which is what makes
   "apply before the first playTrack" work at all. */
const VOL_KEY = 'vizier.timeline.volume';
const VOL_DEFAULT = 25;                 // first run: quiet enough for a PA
let volPct = VOL_DEFAULT;

function loadVolume() {
  try {
    const raw = localStorage.getItem(VOL_KEY);
    if (raw != null) {
      const n = Math.round(Number(raw));
      if (isFinite(n)) return clamp(n, 0, 100);
    }
  } catch (e) { /* private window, blocked storage — the default is fine */ }
  return VOL_DEFAULT;
}

function saveVolume(pct) {
  try { localStorage.setItem(VOL_KEY, String(pct)); } catch (e) { /* not fatal */ }
}

function applyVolume(pct) {
  volPct = clamp(Math.round(Number(pct) || 0), 0, 100);
  // squared taper: a linear slider on a linear gain spends most of its travel
  // in the top few dB and feels dead at the bottom
  const gain = Math.pow(volPct / 100, 2);
  if (typeof engine.setOutputGain === 'function') {
    engine.setOutputGain(gain);
  } else {
    // Older vizier-analysis.js without the post-tap gain node. Works, but the
    // analysers now see the attenuated signal, so the preview goes quiet with
    // the room. Better than an editor with no volume control at a PA.
    audioEl.volume = gain;
  }
  const sl = $('volSlider');
  if (sl && Number(sl.value) !== volPct) sl.value = String(volPct);
  const t = volPct + '%';
  if ($('volText').textContent !== t) $('volText').textContent = t;
}

/* BEFORE anything can call playTrack: a reload must never come back at
   whatever gain the previous session left, and never at full. */
applyVolume(loadVolume());

function trackIdx() {
  const st = curStage();
  if (!st || !st.audio) return -1;
  return engine.addTrackUrl(st.audio, FOLLOWER + '/show/audio/' + encodeURIComponent(st.audio));
}

function playing() { return !!audioEl.src && !audioEl.paused && !audioEl.ended; }
function position() { return audioOk ? (audioEl.currentTime || 0) : posManual; }

function seek(t) {
  const d = curDuration();
  const v = clamp(t, 0, d);
  posManual = v;
  if (audioOk) { try { audioEl.currentTime = v; } catch (e) { /* not seekable yet */ } }
  needDraw = true;
}

function togglePlay(forcePlay) {
  if (playing() && !forcePlay) { engine.pause(); needDraw = true; return; }
  const i = trackIdx();
  if (i < 0) { flash('this stage names no audio file', true); return; }
  const want = position();
  const switching = engine.currentTrack !== i;
  // playTrack() builds the WebAudio graph, which must happen inside a user
  // gesture — every caller of this function is one.
  engine.playTrack(i);
  armed = true;
  $('armHint').style.display = armed ? 'none' : '';
  if (switching) {
    // playTrack reassigns audioEl.src, which resets the clock to 0
    const restore = () => { try { audioEl.currentTime = want; } catch (e) {} };
    if (audioEl.readyState >= 1) restore();
    else audioEl.addEventListener('loadedmetadata', restore, { once: true });
  }
  needDraw = true;
}

audioEl.addEventListener('loadedmetadata', () => {
  audioOk = true;
  warn('audio', null);
  if (posManual) { try { audioEl.currentTime = posManual; } catch (e) {} }
  needDraw = true;
});
audioEl.addEventListener('error', () => {
  audioOk = false;
  const st = curStage();
  warn('audio', 'audio unavailable (' + (st && st.audio) + ') — timeline still editable, no waveform or playback');
});
audioEl.addEventListener('play', () => { needDraw = true; });
audioEl.addEventListener('pause', () => { needDraw = true; });

/* ================================================================ preview */

const preview = new PreviewHost($('pvbox'), $('pv'), $('pvlogo'), (t) => { $('pvnote').textContent = t; });

/* ================================================================== view */

function fitCanvas() {
  const r = tlwrap.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cw = Math.max(1, Math.round(r.width));
  chh = Math.max(1, Math.round(r.height));
  cv.width = Math.round(cw * dpr);
  cv.height = Math.round(chh * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  needDraw = true;
}

const xOf = (t) => (t - view.t0) * view.pps;
const tOf = (x) => view.t0 + x / view.pps;

function minPps() { return Math.max(0.0005, (cw / Math.max(curDuration(), 1)) * 0.95); }

function clampView() {
  const d = curDuration();
  view.pps = clamp(view.pps, minPps(), 400);
  const span = cw / view.pps;
  view.t0 = clamp(view.t0, -span * 0.02, Math.max(0, d - span * 0.5));
  needDraw = true;
}

function fitView() {
  view.pps = cw / Math.max(curDuration(), 1);
  view.t0 = 0;
  clampView();
}

function zoomAbout(x, factor) {
  const t = tOf(x);
  view.pps = clamp(view.pps * factor, minPps(), 400);
  view.t0 = t - x / view.pps;
  clampView();
}

function ensureVisible(t) {
  const span = cw / view.pps;
  if (t < view.t0 + span * 0.05 || t > view.t0 + span * 0.95) {
    view.t0 = t - span * 0.35;
    clampView();
  }
}

/* =================================================================== draw */

const LANE_RULER = 28, LANE_VIDEO = 24, LANE_CUE = 56, LANE_MUSIC = 48;
const Y_RULER = 0;
const Y_VIDEO = Y_RULER + LANE_RULER;
const Y_CUE = Y_VIDEO + LANE_VIDEO;
const Y_MUSIC = Y_CUE + LANE_CUE;
const Y_WAVE = Y_MUSIC + LANE_MUSIC;
const CUE_SCENE_H = 32;                  // top of the cue lane: scene bars
const CUE_PAL_H = LANE_CUE - CUE_SCENE_H;  // bottom: palette bars

const MONO = '11px "IBM Plex Mono", monospace';
const MONO_B = '600 11px "IBM Plex Mono", monospace';

function clipText(s, w) {
  if (w < 14) return '';
  let t = s;
  if (ctx.measureText(t).width <= w - 6) return t;
  while (t.length > 1 && ctx.measureText(t + '…').width > w - 6) t = t.slice(0, -1);
  return t + '…';
}

const RULER_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];

function draw() {
  const st = curStage();
  const dur = curDuration();
  const waveH = Math.max(56, chh - Y_WAVE);

  ctx.clearRect(0, 0, cw, chh);
  ctx.fillStyle = '#04070a';
  ctx.fillRect(0, 0, cw, chh);

  // ---- lane backgrounds
  ctx.fillStyle = 'rgba(70,255,200,0.030)'; ctx.fillRect(0, Y_VIDEO, cw, LANE_VIDEO);
  ctx.fillStyle = 'rgba(70,255,200,0.045)'; ctx.fillRect(0, Y_CUE, cw, LANE_CUE);
  ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(0, Y_WAVE, cw, waveH);

  // ---- ruler
  ctx.font = MONO;
  let step = RULER_STEPS[RULER_STEPS.length - 1];
  for (const s of RULER_STEPS) { if (s * view.pps >= 66) { step = s; break; } }
  const t0 = Math.floor(view.t0 / step) * step;
  ctx.strokeStyle = 'rgba(70,255,200,0.13)';
  ctx.fillStyle = 'rgba(207,238,226,0.5)';
  ctx.beginPath();
  for (let t = t0; t <= view.t0 + cw / view.pps + step; t += step) {
    const x = Math.round(xOf(t)) + 0.5;
    if (x < -40 || x > cw + 40) continue;
    ctx.moveTo(x, 0); ctx.lineTo(x, chh);
    if (t >= 0) ctx.fillText(fmtClock(t), x + 3, 12);
  }
  ctx.stroke();

  // ---- music lane (track colours). Golden-angle hue walk keyed on the track
  //      INDEX, so neighbours never collide and the colours are stable.
  const an = (st && S.analysis[st.name]) || [];
  ctx.save();
  ctx.beginPath(); ctx.rect(0, Y_MUSIC, cw, LANE_MUSIC); ctx.clip();
  if (!an.length) {
    ctx.fillStyle = 'rgba(70,255,200,0.06)';
    ctx.fillRect(0, Y_MUSIC, cw, LANE_MUSIC);
    ctx.fillStyle = 'rgba(207,238,226,0.35)';
    ctx.font = MONO;
    ctx.fillText('no track analysis — drop an analysis.json here', 8, Y_MUSIC + LANE_MUSIC / 2 + 4);
  } else {
    for (const e of an) {
      const x = xOf(e.start), w = Math.max(1, xOf(e.end) - x);
      if (x > cw || x + w < 0) continue;
      const hue = (e.index * 137.508) % 360;
      ctx.fillStyle = 'hsl(' + hue.toFixed(1) + ', 60%, 42%)';
      ctx.fillRect(x, Y_MUSIC + 1, w - 1, LANE_MUSIC - 2);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(x, Y_MUSIC + 1, Math.min(w - 1, 2), LANE_MUSIC - 2);
      ctx.font = MONO_B;
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      const lab = (e.artist ? e.artist + ' — ' : '') + e.title;
      const txt = clipText(lab, w);
      if (txt) ctx.fillText(txt, x + 5, Y_MUSIC + 18);
      if (e.bpm) {
        ctx.font = MONO;
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        const b = clipText(e.bpm.toFixed(1) + ' bpm', w);
        if (b) ctx.fillText(b, x + 5, Y_MUSIC + 34);
      }
    }
  }
  ctx.restore();

  // ---- waveform
  const pk = st && S.peaks[st.name];
  ctx.save();
  ctx.beginPath(); ctx.rect(0, Y_WAVE, cw, waveH); ctx.clip();
  const mid = Y_WAVE + waveH / 2;
  ctx.strokeStyle = 'rgba(70,255,200,0.12)';
  ctx.beginPath(); ctx.moveTo(0, mid + 0.5); ctx.lineTo(cw, mid + 0.5); ctx.stroke();
  if (pk && !pk.skipped && pk.bins > 0) {
    ctx.strokeStyle = 'rgba(70,255,200,0.55)';
    ctx.beginPath();
    const half = waveH / 2 - 2;
    for (let x = 0; x < cw; x++) {
      const ta = tOf(x), tb = tOf(x + 1);
      let b0 = Math.floor(ta * pk.binsPerSec), b1 = Math.ceil(tb * pk.binsPerSec);
      if (b1 <= 0 || b0 >= pk.bins) continue;
      b0 = Math.max(0, b0); b1 = Math.min(pk.bins, Math.max(b1, b0 + 1));
      let mn = 1, mx = -1;
      for (let b = b0; b < b1; b++) { if (pk.min[b] < mn) mn = pk.min[b]; if (pk.max[b] > mx) mx = pk.max[b]; }
      if (mx < mn) continue;
      ctx.moveTo(x + 0.5, mid - mx * half);
      ctx.lineTo(x + 0.5, mid - mn * half);
    }
    ctx.stroke();
    if (pk.bins < pk.nBins) {
      const x = xOf(pk.bins / pk.binsPerSec);
      ctx.fillStyle = 'rgba(255,177,61,0.7)';
      ctx.fillRect(x, Y_WAVE, 2, waveH);
    }
  } else {
    ctx.fillStyle = 'rgba(207,238,226,0.3)';
    ctx.font = MONO;
    ctx.fillText(pk && pk.skipped ? 'waveform skipped — ' + pk.reason : 'waveform loading…', 8, mid + 4);
  }
  ctx.restore();

  // ---- cue bars
  hits = [];
  const sel = model.sel;
  const scenes = cueEngine.sceneList();
  const vids = cueEngine.videoList();
  const pals = cueEngine.palList();

  // scene bars span to the next scene cue
  ctx.save();
  ctx.beginPath(); ctx.rect(0, Y_CUE, cw, CUE_SCENE_H); ctx.clip();
  for (let i = 0; i < scenes.length; i++) {
    const c = scenes[i];
    const a = atOf(c), b = i + 1 < scenes.length ? atOf(scenes[i + 1]) : dur;
    const x = xOf(a), w = Math.max(3, xOf(b) - x);
    if (x > cw || x + w < 0) continue;
    const nm = String(c.scene || '?');
    const hue = hashHue(nm);
    ctx.fillStyle = 'hsl(' + hue + ', 62%, 34%)';
    ctx.fillRect(x, Y_CUE + 2, w - 1, CUE_SCENE_H - 4);
    ctx.fillStyle = 'hsl(' + hue + ', 90%, 66%)';
    ctx.fillRect(x, Y_CUE + 2, 2, CUE_SCENE_H - 4);
    ctx.font = MONO_B;
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    const txt = clipText(nm + (c.logo ? ' •LOGO' : ''), w);
    if (txt) ctx.fillText(txt, x + 6, Y_CUE + 20);
    if (isFinite(Number(c.at_original)) && Number(c.at_original) !== a) {
      ctx.fillStyle = 'rgba(255,177,61,0.95)';
      ctx.fillRect(x + 2, Y_CUE + 2, 3, 4);
    }
    hits.push({ cue: c, x, y: Y_CUE + 2, w: Math.min(w, 220), h: CUE_SCENE_H - 4 });
    if (c === sel) { ctx.strokeStyle = '#46ffc8'; ctx.lineWidth = 2; ctx.strokeRect(x + 1, Y_CUE + 3, Math.max(4, w - 3), CUE_SCENE_H - 6); ctx.lineWidth = 1; }
  }
  ctx.restore();

  // palette bars: filled with the cue's OWN cosine palette, plus a leading
  // wedge showing the crossfade from the previous palette
  ctx.save();
  ctx.beginPath(); ctx.rect(0, Y_CUE + CUE_SCENE_H, cw, CUE_PAL_H); ctx.clip();
  const py = Y_CUE + CUE_SCENE_H + 1, ph = CUE_PAL_H - 2;
  for (let i = 0; i < pals.length; i++) {
    const c = pals[i];
    const a = atOf(c), b = i + 1 < pals.length ? atOf(pals[i + 1]) : dur;
    const x = xOf(a), w = Math.max(3, xOf(b) - x);
    if (x > cw || x + w < 0) continue;
    const g = ctx.createLinearGradient(x, 0, x + w, 0);
    for (let k = 0; k <= 16; k++) g.addColorStop(k / 16, iqCss(c.palette, k / 16));
    ctx.fillStyle = g;
    ctx.fillRect(x, py, w - 1, ph);
    const fadeW = Math.max(0, (Number(c.fade) || 0) * view.pps);
    if (fadeW > 1 && i > 0) {
      // ramp the PREVIOUS palette out across the fade window
      const prev = pals[i - 1];
      const slices = 14;
      for (let k = 0; k < slices; k++) {
        const sx = x + (fadeW * k) / slices, sw = fadeW / slices + 1;
        ctx.globalAlpha = 1 - (k + 0.5) / slices;
        ctx.fillStyle = iqCss(prev.palette, (k + 0.5) / slices);
        ctx.fillRect(sx, py, sw, ph);
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.beginPath(); ctx.moveTo(x, py + ph); ctx.lineTo(x + fadeW, py); ctx.stroke();
    }
    ctx.font = MONO;
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    const txt = clipText(String(c.track || 'palette'), w);
    if (txt) ctx.fillText(txt, x + 5, py + ph - 5);
    hits.push({ cue: c, x, y: py, w: Math.min(w, 220), h: ph });
    if (c === sel) { ctx.strokeStyle = '#46ffc8'; ctx.lineWidth = 2; ctx.strokeRect(x + 1, py + 1, Math.max(4, w - 3), ph - 2); ctx.lineWidth = 1; }
  }
  ctx.restore();

  // video inserts: amber, width = duration
  ctx.save();
  ctx.beginPath(); ctx.rect(0, Y_VIDEO, cw, LANE_VIDEO); ctx.clip();
  for (const c of vids) {
    const a = atOf(c), d = Number(c.duration) || 0;
    const x = xOf(a), w = Math.max(3, d * view.pps);
    if (x > cw || x + w < 0) continue;
    ctx.fillStyle = 'rgba(255,177,61,0.30)';
    ctx.fillRect(x, Y_VIDEO + 2, w, LANE_VIDEO - 4);
    ctx.fillStyle = '#ffb13d';
    ctx.fillRect(x, Y_VIDEO + 2, 2, LANE_VIDEO - 4);
    ctx.font = MONO_B;
    ctx.fillStyle = '#ffd79a';
    const txt = clipText(String(c.video || 'video') + (c.return_scene ? ' → ' + c.return_scene : ''), Math.max(w, 120));
    if (txt) ctx.fillText(txt, x + 5, Y_VIDEO + 16);
    hits.push({ cue: c, x, y: Y_VIDEO + 2, w: Math.max(w, 20), h: LANE_VIDEO - 4 });
    if (c === sel) { ctx.strokeStyle = '#ffb13d'; ctx.lineWidth = 2; ctx.strokeRect(x + 1, Y_VIDEO + 3, Math.max(4, w - 2), LANE_VIDEO - 6); ctx.lineWidth = 1; }
  }
  ctx.restore();

  // ---- lane separators
  ctx.strokeStyle = 'rgba(70,255,200,0.18)';
  ctx.beginPath();
  for (const y of [Y_VIDEO, Y_CUE, Y_CUE + CUE_SCENE_H, Y_MUSIC, Y_WAVE]) {
    ctx.moveTo(0, y + 0.5); ctx.lineTo(cw, y + 0.5);
  }
  ctx.stroke();

  // ---- snap marker: the track boundary the drag is currently locked to
  if (snapMark != null) {
    const sx = Math.round(xOf(snapMark)) + 0.5;
    ctx.strokeStyle = '#ffb13d'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, chh); ctx.stroke();
    ctx.lineWidth = 1;
    ctx.fillStyle = '#ffb13d'; ctx.font = MONO_B;
    ctx.fillText('SNAP ' + fmtTc(snapMark), sx + 5, Y_MUSIC - 6);
  }

  // ---- playhead
  const px = Math.round(xOf(position())) + 0.5;
  if (px >= -2 && px <= cw + 2) {
    ctx.strokeStyle = '#46ffc8';
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, chh); ctx.stroke();
    ctx.fillStyle = '#46ffc8';
    ctx.beginPath();
    ctx.moveTo(px - 5, 0); ctx.lineTo(px + 5, 0); ctx.lineTo(px, 8); ctx.closePath();
    ctx.fill();
  }
}

/* ============================================================ interaction */

function hitAt(x, y) {
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    if (x >= h.x - 3 && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) return h;
  }
  return null;
}

/* ------------------------------------------------------------- drag rules
   Dial-in dragging must not be able to reorder the show by accident: on the
   night a scene cue was nudged across two of its neighbours without anyone
   noticing, and the set played its scenes in the wrong order.

   So a plain drag is CLAMPED — a cue may not cross its SAME-TYPE neighbours
   (scene against scene, palette against palette; video inserts are free, they
   overlay whatever is underneath and their order means nothing). Reordering is
   still possible, but it is now a DELIBERATE gesture: hold Shift.

   And because almost every cue wants to land on a song change, dragging SNAPS
   to the track boundaries underneath — the analysis entries' `start` times, and
   only those. Never to other cues: cue-to-cue snapping is how you end up with
   two cues stacked on one frame. Alt/Option turns snapping off for fine work. */
const SNAP_PX = 10;        // snap radius in PIXELS, so it scales with zoom
const MIN_GAP = 0.05;      // closest a clamped drag may come to its neighbour

/* The same-type cues either side of `cue`, as times. Resolved against the whole
   mixed list, so a scene cue is bounded by scene cues however many palette or
   video cues sit between them. Captured once at pointerdown: a clamped drag can
   never cross, so the neighbours cannot change mid-gesture. */
function sameTypeNeighbours(cues, cue) {
  const type = cueType(cue), self = atOf(cue);
  let prevAt = -Infinity, nextAt = Infinity;
  for (const c of cues) {
    if (c === cue || cueType(c) !== type) continue;
    const t = atOf(c);
    if (t <= self) { if (t > prevAt) prevAt = t; }
    else if (t < nextAt) nextAt = t;
  }
  return { prevAt, nextAt };
}

/* Where the dragged cue actually lands. Snap first, then clamp — and if the
   clamp moved the value off the boundary, the snap did not happen, so the
   marker does not lie about where the cue is. */
function resolveDragAt(drag, rawT, free, noSnap, pps) {
  let at = rawT, snap = null;
  if (!noSnap && drag.bounds.length) {
    const tol = SNAP_PX / pps;
    let best = null, bd = Infinity;
    for (const b of drag.bounds) {
      const d = Math.abs(b - at);
      if (d < bd) { bd = d; best = b; }
    }
    if (best != null && bd <= tol) { at = best; snap = best; }
  }
  if (!free) {
    const lo = drag.prevAt + MIN_GAP, hi = drag.nextAt - MIN_GAP;
    at = (lo <= hi) ? clamp(at, lo, hi) : (lo + hi) / 2;
    if (snap != null && Math.abs(at - snap) > 1e-9) snap = null;
  }
  return { at, snap };
}

/* The next cue of the same type, as an OBJECT (sameTypeNeighbours returns
   times). This is what a scene or palette cue's bar ends at, because spans are
   derived from neighbours at draw time — a cue has no length of its own. */
function nextSameType(cues, cue) {
  const type = cueType(cue), self = atOf(cue);
  let best = null;
  for (const c of cues) {
    if (c === cue || cueType(c) !== type) continue;
    const t = atOf(c);
    if (t > self && (best === null || t < atOf(best))) best = c;
  }
  return best;
}

/* Where this cue stops being on screen. A video insert owns its end (`duration`);
   everything else ends where its successor starts, and null means "runs to the
   end of the set". */
function endOfCue(cues, cue) {
  if (cueType(cue) === 'video') return atOf(cue) + (Number(cue.duration) || 0);
  const nx = nextSameType(cues, cue);
  return nx ? atOf(nx) : null;
}

/* Editing an END is editing something else's START — so say exactly what would
   be written, and let the caller do it through the normal mutators.
   Returns {target, field, value} or null when there is nothing to move. */
function resolveEndEdit(cues, cue, endT) {
  if (cueType(cue) === 'video') {
    return { target: cue, field: 'duration',
             value: Math.max(MIN_GAP, Math.round((endT - atOf(cue)) * 1000) / 1000) };
  }
  const nx = nextSameType(cues, cue);
  if (!nx) return null;                       // last of its type: no end to move
  const after = nextSameType(cues, nx);
  const lo = atOf(cue) + MIN_GAP;
  const hi = after ? atOf(after) - MIN_GAP : Infinity;
  return { target: nx, field: 'at', value: (lo <= hi) ? clamp(endT, lo, hi) : lo };
}

function trackBoundaries() {
  const st = curStage();
  const an = (st && S.analysis[st.name]) || [];
  return an.map((e) => e.start);
}

let drag = null;     // {cue, tok, startAt, startT, bounds, prevAt, nextAt} | {seek:true}
let snapMark = null; // boundary the drag is currently sitting on, for the marker

cv.addEventListener('pointerdown', (e) => {
  cv.setPointerCapture(e.pointerId);
  const r = cv.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const h = hitAt(x, y);
  if (h) {
    select(h.cue);
    const nb = sameTypeNeighbours(model.cues(), h.cue);
    drag = {
      cue: h.cue, tok: model.beginGesture(), startAt: atOf(h.cue), startT: tOf(x),
      bounds: trackBoundaries(),
      // video inserts are never clamped: nothing depends on their order
      clamped: cueType(h.cue) !== 'video',
      prevAt: nb.prevAt, nextAt: nb.nextAt, didFree: false,
    };
  } else if (y < Y_VIDEO || y >= Y_MUSIC) {
    // ruler, music lane and waveform are all "scrub here"
    drag = { seek: true };
    seek(tOf(x));
  } else {
    select(null);
  }
  needDraw = true;
});

cv.addEventListener('pointermove', (e) => {
  const r = cv.getBoundingClientRect();
  const x = e.clientX - r.left;
  if (!drag) return;
  if (drag.seek) { seek(tOf(x)); return; }
  // An undo mid-drag replaces every cue object (JSON.parse), so the reference
  // this gesture is holding can stop being part of the document. Writing to it
  // would edit an orphan and look like nothing happening; drop the drag.
  if (model.cues().indexOf(drag.cue) < 0) { drag = null; snapMark = null; needDraw = true; return; }
  // Shift = free move (the reorder gesture); Alt = snapping off
  const free = e.shiftKey || !drag.clamped;
  if (e.shiftKey) drag.didFree = true;
  const land = resolveDragAt(drag, drag.startAt + (tOf(x) - drag.startT), free, e.altKey, view.pps);
  snapMark = land.snap;
  model.setCueAt(drag.cue, land.at);
  syncInspector();          // the AT field shows the exact snapped time
  needDraw = true;
});

function endDrag() {
  if (drag && drag.didFree) {
    // A free drag IS the reorder: put the array back into time order on drop.
    // sort() mutates in place and moves the SAME objects, so the selected cue
    // stays selected by identity across the reorder.
    model.cues().sort((a, b) => atOf(a) - atOf(b));
    model.rev++;
  }
  if (drag && drag.tok) model.endGesture(drag.tok);
  drag = null;
  snapMark = null;
  syncInspector();
  refreshChrome();
  needDraw = true;
}
cv.addEventListener('pointerup', endDrag);
cv.addEventListener('pointercancel', endDrag);

cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const r = cv.getBoundingClientRect();
    zoomAbout(e.clientX - r.left, Math.pow(1.0022, -e.deltaY));
  } else {
    // trackpads send deltaX; a plain wheel only has deltaY, which scrolls here
    const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    view.t0 += dx / view.pps;
    clampView();
  }
}, { passive: false });

// drag-and-drop an analysis.json when the leader is unreachable
['dragover', 'drop'].forEach((k) => document.addEventListener(k, (e) => e.preventDefault()));
document.addEventListener('drop', async (e) => {
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f) return;
  try {
    const body = JSON.parse(await f.text());
    if (await loadAnalysis(body)) flash('loaded track analysis from ' + f.name);
  } catch (err) { flash('could not read ' + f.name + ': ' + err.message, true); }
});

/* ============================================================== selection */

function select(cue) {
  model.sel = cue || null;
  syncInspector();
  needDraw = true;
}

/* ============================================================== inspector */

const PAL_ROWS = [['bias', 'BIAS'], ['amp', 'AMP'], ['freq', 'FREQ'], ['phase', 'PHASE']];
const palInputs = {};
let insLock = false;      // suppress the input handlers while we write the DOM

function buildInspector() {
  // scene pickers: everything the gallery can show, native rows first
  for (const id of ['insScene', 'insVret']) {
    const sel = $(id);
    sel.innerHTML = '';
    if (id === 'insVret') sel.appendChild(new Option('(none)', ''));
    for (const r of ALL_SCENES) sel.appendChild(new Option(r.name, r.name));
  }

  const grid = $('palGrid');
  grid.innerHTML = '';
  for (const [key, label] of PAL_ROWS) {
    const lab = document.createElement('div');
    lab.className = 'lab'; lab.textContent = label;
    grid.appendChild(lab);
    palInputs[key] = [];
    for (let i = 0; i < 3; i++) {
      const inp = document.createElement('input');
      inp.type = 'number'; inp.step = '0.01';
      inp.title = label + ' ' + 'RGB'[i];
      grid.appendChild(inp);
      palInputs[key].push(inp);
      wire(inp, (c) => {
        if (cueType(c) !== 'palette') return;
        if (!c.palette || typeof c.palette !== 'object') c.palette = normPalette(null);
        const arr = Array.isArray(c.palette[key]) ? c.palette[key] : normPalette(c.palette)[key];
        arr[i] = Number(inp.value) || 0;
        c.palette[key] = arr;
        model.rev++;
      });
    }
  }

  wire($('insAt'), null, (c) => {
    const v = parseTimecode($('insAt').value);
    if (!isFinite(v)) { flash('could not read that time — use HH:MM:SS.mmm, MM:SS or seconds', true); syncInspector(); return; }
    model.setCueAt(c, v);
    syncInspector(); needDraw = true;
  });

  wire($('insEnd'), null, (c) => {
    const v = parseTimecode($('insEnd').value);
    if (!isFinite(v)) { flash('could not read that time — use HH:MM:SS.mmm, MM:SS or seconds', true); syncInspector(); return; }
    const r = resolveEndEdit(model.cues(), c, v);
    if (!r) { flash('last cue of its type — it runs to the end of the set', true); syncInspector(); return; }
    if (r.field === 'duration') { r.target.duration = r.value; model.rev++; }
    else model.setCueAt(r.target, r.value);   // moves the NEXT cue, by design
    syncInspector(); needDraw = true;
  });

  wire($('insScene'), (c) => {
    c.scene = $('insScene').value; model.rev++;
  });
  wire($('insLogo'), (c) => {
    c.logo = $('insLogo').checked; model.rev++;
  });
  wire($('insVdur'), (c) => {
    c.duration = Math.max(0, Number($('insVdur').value) || 0); model.rev++;
  });
  wire($('insVret'), (c) => {
    const v = $('insVret').value;
    if (v) c.return_scene = v; else delete c.return_scene;
    model.rev++;
  });
  wire($('insFade'), (c) => {
    c.fade = Math.max(0, Number($('insFade').value) || 0); model.rev++;
  });
  wire($('insRoot'), (c) => {
    if (!c.palette) return;
    const s = $('insRoot').value;
    if (s === '') delete c.palette.root; else c.palette.root = Number(s) || 0;
    model.rev++;
  });
  wire($('insDrift'), (c) => {
    if (!c.palette) return;
    const s = $('insDrift').value;
    if (s === '') delete c.palette.drift; else c.palette.drift = Number(s) || 0;
    model.rev++;
  });

  $('btnDel').addEventListener('click', () => {
    const c = model.sel;
    if (!c) return;
    if (!confirm('Delete this ' + cueType(c) + ' cue at ' + fmtTc(atOf(c)) + '?')) return;
    model.beginGesture();
    model.removeCue(c);
    select(null); refreshChrome(); needDraw = true;
  });
  $('btnAddScene').addEventListener('click', () => addCueAtPlayhead('scene'));
  $('btnAddPal').addEventListener('click', () => addCueAtPlayhead('palette'));
}

/* Focus opens an undo gesture, blur closes it (and drops it if nothing moved),
   input applies. That way one edit = one undo step, however many keystrokes. */
function wire(el, onInput, onChange) {
  let tok = null, target = null;

  /* THE CUE THIS FIELD WAS OPENED AGAINST — captured on focus and handed to
     the callbacks, which must NEVER re-read model.sel at commit time.

     That was a real bug, and it is the reason a cue's neighbour appeared to
     move when the operator retimed it. `change` on a text input does not fire
     when you stop typing; it fires when focus leaves. If focus leaves because
     you CLICKED THE NEXT CUE BAR, the browser runs pointerdown listeners first
     and only then performs the focus change as mousedown's default action — so
     by the time `change` arrives, our own pointerdown handler has already
     called select() and model.sel is the cue you just clicked. The pending
     edit then landed on THAT cue. Type an earlier time for cue N, click cue
     N+1 to check it, and cue N+1 is what moved.

     Capturing on focus makes the target the cue that was on screen when the
     operator started typing, which is the only cue they can have meant. */
  const aim = () => {
    const c = target || model.sel;
    if (!c) return null;
    // undone, deleted or reloaded out from under the field: drop the edit
    // rather than write to an object no longer in the document
    if (model.cues().indexOf(c) < 0) return null;
    return c;
  };

  el.addEventListener('focus', () => { target = model.sel; tok = model.beginGesture(); });
  el.addEventListener('blur', () => { model.endGesture(tok); tok = null; target = null; refreshChrome(); });
  if (onInput) el.addEventListener('input', () => {
    if (insLock) return;
    const c = aim(); if (!c) return;
    onInput(c); syncSwatch(); needDraw = true; refreshChrome();
  });
  if (onChange) el.addEventListener('change', () => {
    if (insLock) return;
    const c = aim(); if (!c) return;
    onChange(c); refreshChrome();
  });
}

function trackTitleAt(t) {
  const st = curStage();
  const an = (st && S.analysis[st.name]) || [];
  for (const e of an) if (t >= e.start && t < e.end) return (e.artist ? e.artist + ' — ' : '') + e.title;
  return '';
}

function syncSwatch() {
  const c = model.sel;
  const el = $('insSwatch');
  if (!c || cueType(c) !== 'palette') return;
  const g = el.getContext('2d');
  const w = el.width = el.clientWidth || 300, h = el.height;
  const grd = g.createLinearGradient(0, 0, w, 0);
  for (let k = 0; k <= 24; k++) grd.addColorStop(k / 24, iqCss(c.palette, k / 24));
  g.fillStyle = grd; g.fillRect(0, 0, w, h);
}

function syncInspector() {
  const c = model.sel;
  const body = $('insBody'), empty = $('insEmpty');
  if (!c) {
    body.style.display = 'none'; empty.style.display = '';
    $('insHead').textContent = 'NO CUE SELECTED';
    return;
  }
  insLock = true;
  body.style.display = ''; empty.style.display = 'none';
  const t = cueType(c);
  $('insHead').textContent = t.toUpperCase() + ' CUE';
  $('insType').textContent = t;
  $('insTrack').textContent = trackTitleAt(atOf(c)) || (c.track ? String(c.track) : '—');
  if (document.activeElement !== $('insAt')) $('insAt').value = fmtTc(atOf(c));

  // at_original / snap are DOCUMENTATION written by snap_cues.py. Read-only
  // here, always; the delta is the whole point of showing them.
  const orig = Number(c.at_original);
  if (isFinite(orig)) {
    const d = atOf(c) - orig;
    $('insOrig').innerHTML = '';
    $('insOrig').appendChild(document.createTextNode(
      fmtTc(orig) + '  (' + (d >= 0 ? '+' : '') + d.toFixed(3) + ' s)'));
    if (Math.abs(d) > 0.0005) {
      const tag = document.createElement('span');
      tag.className = 'tag'; tag.textContent = 'HAND-TUNED';
      $('insOrig').appendChild(tag);
    }
    $('rowOrig').style.display = '';
  } else {
    $('rowOrig').style.display = 'none';
  }

  // ENDS. For scene/palette this is the NEXT same-type cue's start, and the
  // label says so — editing it moves that cue, not this one.
  const endT = endOfCue(model.cues(), c);
  const isVid = (t === 'video');
  $('insEndK').textContent = isVid ? 'Ends' : 'Ends =';
  $('insEndHint').textContent = isVid ? '(at + duration)' : (endT == null ? '' : '(next cue start)');
  if (endT == null) {
    $('insEnd').value = '';
    $('insEnd').placeholder = '— runs to end of set';
    $('insEnd').disabled = true;
  } else {
    $('insEnd').disabled = false;
    $('insEnd').placeholder = '';
    if (document.activeElement !== $('insEnd')) $('insEnd').value = fmtTc(endT);
  }

  $('grpScene').style.display = (t === 'scene') ? '' : 'none';
  $('grpVideo').style.display = (t === 'video') ? '' : 'none';
  $('grpPal').style.display = (t === 'palette') ? '' : 'none';

  if (t === 'scene') {
    const sel = $('insScene');
    const nm = String(c.scene || '');
    if (nm && !Array.from(sel.options).some((o) => o.value === nm)) {
      // a cue naming a scene this editor does not know about (see the drift
      // warning in timeline-preview.js). Offer it rather than silently
      // rewriting the document to something else.
      sel.appendChild(new Option(nm + ' (unknown)', nm));
    }
    sel.value = nm;
    $('insLogo').checked = !!c.logo;
  } else if (t === 'video') {
    $('insVideo').textContent = String(c.video || '—');
    $('insVdur').value = Number(c.duration) || 0;
    const sel = $('insVret');
    const nm = String(c.return_scene || '');
    if (nm && !Array.from(sel.options).some((o) => o.value === nm)) sel.appendChild(new Option(nm + ' (unknown)', nm));
    sel.value = nm;
  } else if (t === 'palette') {
    $('insFade').value = Number(c.fade) || 0;
    const p = normPalette(c.palette);
    for (const [key] of PAL_ROWS) {
      for (let i = 0; i < 3; i++) palInputs[key][i].value = Number(p[key][i]).toFixed(3);
    }
    $('insRoot').value = (c.palette && c.palette.root != null) ? c.palette.root : '';
    $('insDrift').value = (c.palette && c.palette.drift != null) ? c.palette.drift : '';
    syncSwatch();
  }
  insLock = false;
}

/* normPalette() fills root/drift with null so callers can test them; a document
   should carry the key or not carry it, never a null. */
function palForDoc(p) {
  const q = normPalette(p);
  if (q.root == null) delete q.root;
  if (q.drift == null) delete q.drift;
  return q;
}

function addCueAtPlayhead(kind) {
  const st = curStage();
  if (!st) return;
  model.beginGesture();
  const at = Math.round(position() * 1000) / 1000;
  const ev = cueEngine.eval(at);
  // brand-new cues carry ONLY live fields. No fabricated at_original / snap:
  // those mean "the snapper put this here", and it did not.
  const cue = (kind === 'palette')
    ? { type: 'palette', at, fade: 6, track: trackTitleAt(at) || '', palette: palForDoc(ev.palette && ev.palette.cue && ev.palette.cue.palette) }
    : { type: 'scene', at, scene: (ev.scene || (ALL_SCENES[0] && ALL_SCENES[0].name) || 'BLACK'), logo: false };
  model.addCue(cue);
  select(cue);
  refreshChrome();
  needDraw = true;
}

/* ================================================================== save */

/* The doc as it goes on the wire / into a download:
     * `_file` stripped — it is this editor's bookkeeping, not part of the doc
       (POST /show/cues carries the filename in its own `file` field).
     * top-level `edited` ISO stamp, which is also what snap_cues.py's
       overwrite guard looks for.
   Stamped on the CLONE, so a DOWNLOAD never makes a clean stage look dirty.
   A successful SAVE copies the stamp back on to the working doc afterwards, so
   memory and disk agree. */
function exportDoc(st) {
  const d = clone(st.doc);
  delete d._file;
  d.edited = new Date().toISOString();
  return d;
}

async function saveAll() {
  const names = STAGES.filter((n) => model.dirty(n));
  if (!names.length) { flash('nothing to save'); return; }

  // Conflict pre-check: has anyone else saved since this page loaded?
  // Read it from /show/cues, NOT /show/status — status.cue is null unless the
  // follower is standing on a cue stage (cue_status(), follower_server.py:540),
  // and it will not be while the show is idle and you are editing.
  try {
    const res = await fetch(FOLLOWER + '/show/cues', { cache: 'no-store' });
    const j = await res.json();
    const rev = j && (j.cues_rev != null ? j.cues_rev : (j.cue && j.cue.cues_rev));
    if (rev != null && S.cuesRev != null && rev !== S.cuesRev) {
      if (!confirm('The follower’s cue revision moved from ' + S.cuesRev + ' to ' + rev
        + ' since this page loaded — something else saved cues.\n\n'
        + 'Overwrite with what is on screen?')) return;
    }
  } catch (e) {
    if (!confirm('Could not reach the follower for a conflict check (' + (e.message || e)
      + ').\n\nTry the save anyway?')) return;
  }

  for (const n of names) {
    const st = model.stages[n];
    if (!st.file) { flash(n + ': no filename known, use DOWNLOAD instead', true); continue; }
    const doc = exportDoc(st);
    try {
      const res = await fetch(FOLLOWER + '/show/cues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: st.file, doc }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        const errs = Array.isArray(j.errors) ? j.errors.join('; ') : (j.error || ('HTTP ' + res.status));
        flash('SAVE REJECTED (' + n + '): ' + errs, true);
        continue;
      }
      // the doc on disk now also carries `edited` and comes back key-sorted;
      // ours is value-identical, which is all `dirty` cares about
      st.doc.edited = doc.edited;
      model.markSaved(n);
      if (j.cues_rev != null) S.cuesRev = j.cues_rev;
      flash('saved ' + st.file + (j.cues_rev != null ? ' — rev ' + j.cues_rev : ''));
    } catch (e) {
      flash('SAVE FAILED (' + n + '): ' + (e.message || e), true);
    }
  }
  refreshChrome();
}

function download() {
  const st = curStage();
  if (!st) return;
  const blob = new Blob([JSON.stringify(exportDoc(st), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = st.file || (st.name + '-cues.json');
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  flash('downloaded ' + a.download);
}

window.addEventListener('beforeunload', (e) => {
  if (!model.anyDirty()) return;
  e.preventDefault();
  e.returnValue = '';
  return '';
});

/* ================================================================ chrome */

function refreshChrome() {
  const dirty = model.anyDirty();
  $('dirtyDot').classList.toggle('on', dirty);
  $('btnSave').disabled = !dirty;
  const st = curStage();
  const bits = [];
  bits.push('rev ' + (S.cuesRev == null ? '—' : S.cuesRev));
  if (st) bits.push(st.file || '(no file)');
  bits.push(STAGES.filter((n) => model.dirty(n)).map((n) => n.toUpperCase() + '*').join(' ') || 'clean');
  $('revText').textContent = bits.join('  ·  ');
  $('stageMain').classList.toggle('toggled', model.active === 'main');
  $('stageOpener').classList.toggle('toggled', model.active === 'opener');
  $('stageOpener').disabled = !model.stages.opener;
  if (!model.stages.opener) $('stageOpener').title = 'the follower reported no opener stage';
}

/* ============================================================ stage switch */

function startPeaks(name) {
  const st = model.stages[name];
  if (!st || !st.audio || S.peaks[name]) return;
  if (S.peaksAbort[name]) return;
  const ac = new AbortController();
  S.peaksAbort[name] = ac;
  const url = FOLLOWER + '/show/audio/' + encodeURIComponent(st.audio);
  buildPeaks(url, BINS_PER_SEC, (p) => { S.peaks[name] = p; needDraw = true; }, ac.signal)
    .then((p) => {
      S.peaks[name] = p;
      if (p.skipped) warn('wave-' + name, name + ' waveform skipped: ' + p.reason);
      needDraw = true;
    })
    .catch((e) => {
      if (e && e.name === 'AbortError') return;
      warn('wave-' + name, name + ' waveform unavailable: ' + (e.message || e));
    })
    .finally(() => { S.peaksAbort[name] = null; });
}

function setStage(name) {
  if (!model.stages[name] || model.active === name) return;
  model.active = name;
  model.sel = null;
  const st = curStage();
  audioOk = false;
  posManual = 0;
  if (st.audio) {
    const url = FOLLOWER + '/show/audio/' + encodeURIComponent(st.audio);
    if (audioEl.src !== url) { audioEl.pause(); audioEl.src = url; }
  }
  fitView();
  startPeaks(name);
  select(null);
  refreshChrome();
  needDraw = true;
}

/* ============================================================== keyboard */

function nudge(dt) {
  const c = model.sel;
  if (!c) return;
  const tok = model.beginGesture();
  model.setCueAt(c, atOf(c) + dt);
  model.endGesture(tok);
  ensureVisible(atOf(c));
  syncInspector(); refreshChrome(); needDraw = true;
}

function walk(dir) {
  const all = cueEngine.ordered();
  if (!all.length) return;
  let i;
  if (model.sel && all.indexOf(model.sel) >= 0) i = all.indexOf(model.sel) + dir;
  else {
    const p = position();
    i = dir > 0 ? all.findIndex((c) => atOf(c) > p) : -1;
    if (dir > 0 && i < 0) i = 0;
    if (dir < 0) { for (let k = all.length - 1; k >= 0; k--) if (atOf(all[k]) < p) { i = k; break; } if (i < 0) i = all.length - 1; }
  }
  i = ((i % all.length) + all.length) % all.length;
  select(all[i]);
  ensureVisible(atOf(all[i]));
}

document.addEventListener('keydown', (e) => {
  const tgt = e.target;
  if (tgt && tgt.matches && tgt.matches('input, select, textarea')) {
    if (e.key === 'Escape') tgt.blur();
    return;
  }
  const meta = e.metaKey || e.ctrlKey;

  if (meta && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveAll(); return; }
  if (meta && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    if (e.shiftKey) model.redo(); else model.undo();
    syncInspector(); refreshChrome(); needDraw = true;
    return;
  }
  if (meta) return;

  switch (e.key) {
    case ' ':
      // a focused button would ALSO activate on space; blur it first
      if (tgt && tgt.tagName === 'BUTTON') tgt.blur();
      e.preventDefault(); togglePlay(); break;
    case 'Tab':
      e.preventDefault(); walk(e.shiftKey ? -1 : 1); break;
    case 'ArrowLeft':
      e.preventDefault(); nudge(e.shiftKey ? -0.5 : -0.05); break;
    case 'ArrowRight':
      e.preventDefault(); nudge(e.shiftKey ? 0.5 : 0.05); break;
    case 'Enter': {
      e.preventDefault();
      const c = model.sel;
      if (!c) break;
      seek(Math.max(0, atOf(c) - 2));
      ensureVisible(atOf(c));
      togglePlay(true);
      break;
    }
    case 'Escape': select(null); break;
    case '0': fitView(); break;
    case '+': case '=': zoomAbout(cw / 2, 1.5); break;
    case '-': case '_': zoomAbout(cw / 2, 1 / 1.5); break;
    case '1': setStage('main'); break;
    case '2': setStage('opener'); break;
    case 'p': case 'P': $('btnPreview').click(); break;
    default: break;
  }
});

/* =============================================================== rAF loop */

let lastNow = performance.now() / 1000;
let lastDrawKey = '';

function frame() {
  const now = performance.now() / 1000;
  const dt = Math.min(now - lastNow, 0.1);
  lastNow = now;

  // one engine, one update, every frame — exactly as demos.html does it
  const f = engine.update(now);
  const pos = position();
  const ev = cueEngine.eval(pos);

  if (preview.enabled && !document.hidden) {
    if (ev.scene) preview.setActive(ev.scene);
    preview.setLogo(ev.logo);
    if (ev.palette) preview.applyPalette(ev.palette);
    preview.driveVideo(ev.video
      ? { url: MEDIA_BASE + encodeURIComponent(String(ev.video.video || '')), t: pos - atOf(ev.video), playing: playing() }
      : null);
    preview.tick(f, now, dt);
    $('pvscene').textContent = ev.scene || '';
  }

  const key = pos.toFixed(3) + '|' + model.rev + '|' + view.t0.toFixed(4) + '|' + view.pps.toFixed(4);
  if (needDraw || key !== lastDrawKey) { draw(); needDraw = false; lastDrawKey = key; }

  const pt = fmtTc(pos) + '  /  ' + fmtClock(curDuration());
  if (pt !== lastPosText) { $('posText').textContent = pt; lastPosText = pt; }
  const ct = (ev.scene || '—') + (ev.logo ? ' +LOGO' : '')
    + (ev.video ? '  ▶ ' + ev.video.video : '')
    + (ev.palette ? '  pal ' + (ev.palette.cue.track || '') + ' ' + Math.round(ev.palette.mix * 100) + '%' : '');
  if (ct !== lastCueText) { $('cueText').textContent = ct; lastCueText = ct; }
  const bt = playing() ? 'PAUSE' : 'PLAY';
  if (bt !== lastPlayText) { $('btnPlay').textContent = bt; lastPlayText = bt; }

  requestAnimationFrame(frame);
}

/* ==================================================================== boot */

function wireChrome() {
  $('stageMain').addEventListener('click', () => setStage('main'));
  $('stageOpener').addEventListener('click', () => setStage('opener'));
  $('btnPreview').addEventListener('click', () => {
    const on = !preview.enabled;
    preview.setEnabled(on);
    $('btnPreview').classList.toggle('toggled', on);
    if (!on) { $('pvscene').textContent = ''; $('pvnote').textContent = ''; }
    $('btnPreview').blur();
  });
  $('btnSave').addEventListener('click', saveAll);
  $('btnDownload').addEventListener('click', download);
  $('btnPlay').addEventListener('click', () => togglePlay());
  // apply live while dragging, persist on release. No keyboard bindings: the
  // arrow keys belong to cue-nudge, so the slider hands focus back when the
  // pointer lets go rather than quietly eating them.
  $('volSlider').addEventListener('input', () => applyVolume($('volSlider').value));
  $('volSlider').addEventListener('change', () => {
    applyVolume($('volSlider').value);
    saveVolume(volPct);
    $('volSlider').blur();
  });
  window.addEventListener('resize', () => { fitCanvas(); clampView(); preview.onResize(); });
  if (window.ResizeObserver) new ResizeObserver(() => { fitCanvas(); clampView(); }).observe(tlwrap);
}

async function boot() {
  buildInspector();
  wireChrome();
  fitCanvas();

  const ok = await loadCues();
  if (!ok) {
    // nothing to edit, but the page must not be a blank screen: say why
    $('insHead').textContent = 'NO CUES';
    refreshChrome();
    fitView();
    requestAnimationFrame(frame);
    return;
  }

  const wanted = PARAMS.get('stage');
  if (wanted && model.stages[wanted]) model.active = wanted;

  const st = curStage();
  if (st && st.audio) audioEl.src = FOLLOWER + '/show/audio/' + encodeURIComponent(st.audio);

  fitView();
  refreshChrome();
  startPeaks(model.active);
  loadAnalysis();                       // fire and forget; the lane fills in late

  // Legacy follower only: the per-stage GET already carries cues_rev, but the
  // old single-doc answer does not. status.cue is null off a cue stage, so this
  // is best-effort — a null just means the save does no conflict check.
  if (S.cuesRev == null) {
    fetch(FOLLOWER + '/show/status', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => { if (j && j.cue && j.cue.cues_rev != null) { S.cuesRev = j.cue.cues_rev; refreshChrome(); } })
      .catch(() => {});
  }

  requestAnimationFrame(frame);
}

boot();
