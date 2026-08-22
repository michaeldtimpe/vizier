/* demos/show/timeline-preview.js — live scene preview for the cue timeline editor
   ============================================================================
   The editor's right-hand box: a real vizier scene, rendered small, driven by
   the same ChromaFrame the gallery uses, so the operator sees what the cue at
   the playhead will actually look like against the music.

   Three jobs:
     * PreviewHost  — instantiate/cache real scene instances, one canvas each,
                      display-toggled (never destroyed) so scrubbing back and
                      forth across a cue boundary costs nothing after the first
                      visit.
     * driveVideo   — a clone of demos.html's video-insert driver, retargeted at
                      the editor's own <video> element.
     * palette math — iq cosine evaluation + interpolation, shared with the
                      timeline renderer (the palette BARS are drawn with the
                      same function that feeds NEBULA.setPalette).

   This module never touches the cue documents. It is told what to show.
   ========================================================================== */
'use strict';

import { SYN_SCENES } from '../syn/syn-manifest.js';

/* ============================================================================
   !!!!!!!!!!!!!!!!!!!!!!  MIRROR — DRIFT WARNING  !!!!!!!!!!!!!!!!!!!!!!!!!!!!
   ============================================================================
   The rows below are a HAND COPY of the native (non-Synesthesia) entries in the
   gallery's DEMOS array, which lives INLINE IN demos.html AT LINES 414-439 and
   is therefore not importable from a module. There is no build step and no
   shared file: the gallery is an HTML page with its roster in a <script>.

   IF YOU ADD, REMOVE OR RENAME A NATIVE SCENE IN demos.html, COPY IT HERE.
   Nothing will fail loudly if you don't — the scene will simply be missing from
   this editor's scene picker and any cue naming it will preview as
   "SCENE UNAVAILABLE" while working perfectly on the real follower. That is the
   drift to watch for.

   Two deliberate differences from the demos.html rows:
     * `path` there is repo-root-relative ('./demos/viz-nebula.js') because the
       gallery page sits at the repo root. This module sits in demos/show/, so
       every path is rewritten to '../viz-X.js'.
     * The Synesthesia rows are not copied — SYN_SCENES is a real module and is
       imported above.

   Mirrored from demos.html:414-439 on 2026-08-21.
   ========================================================================== */
export const NATIVE_SCENES = [
  { name: 'NEBULA',      path: '../viz-nebula.js',
    desc: 'Domain-warped plasma; chord root sets the palette, chroma draws veins.' },
  { name: 'MANDALA',     path: '../viz-mandala.js',
    desc: 'Kaleidoscope in log-polar space; fold count from chord quality.' },
  { name: 'GEODE',       path: '../syn-geode.js',
    desc: 'raymarched Voronoi geode; crystal lattice over agate.' },
  { name: 'FLAME',       path: '../syn-flame.js',
    desc: 'two-buffer reaction-diffusion flame, stoked by bass presence.' },
  { name: 'NOVA',        path: '../syn-nova.js',
    desc: 'radial mandala burst; exercises most of the syn_* uniform set.' },
  { name: 'MAGNETISMIC', path: '../syn-magnetismic.js',
    desc: 'marketplace scene — raymarched fractal noise sphere / flare.' },
  { name: 'BLACK',       path: '../viz-black.js',
    desc: 'blackout — an 8x8 black canvas, no GPU work. Boot / idle / done.' },
];

/* Every scene the editor can name, native first (same order the gallery shows
   them in), then the manifest. Used for the preview AND for the inspector's
   scene <select>. */
export const ALL_SCENES = NATIVE_SCENES.concat(SYN_SCENES);

const SCENE_BY_NAME = new Map(ALL_SCENES.map((r) => [r.name, r]));
export function sceneRow(name) { return SCENE_BY_NAME.get(name) || null; }

/* ------------------------------------------------------------- palette math
   iq's cosine palette: color(t) = bias + amp * cos(2pi * (freq*t + phase)).
   Same form the NEBULA shader uses, evaluated on the CPU here so the timeline
   can paint a cue's actual colors into its bar and so the editor can compute
   mid-fade coefficients itself (see interpPalette). */
const TAU = Math.PI * 2;
const DEF3 = { bias: [0.5, 0.5, 0.5], amp: [0.5, 0.5, 0.5], freq: [1, 1, 1], phase: [0, 0.33, 0.67] };

function vec3(v, d) {
  if (!Array.isArray(v) || v.length < 3) return d.slice();
  return [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0];
}

/** Normalize whatever a cue carries into a full {bias,amp,freq,phase,root,drift}. */
export function normPalette(p) {
  p = p || {};
  return {
    bias: vec3(p.bias, DEF3.bias),
    amp: vec3(p.amp, DEF3.amp),
    freq: vec3(p.freq, DEF3.freq),
    phase: vec3(p.phase, DEF3.phase),
    root: p.root == null ? null : Number(p.root),
    drift: p.drift == null ? null : Number(p.drift),
  };
}

/** RGB 0..1 triple at position t (0..1) along the palette. */
export function iqColor(p, t) {
  const q = normPalette(p);
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const v = q.bias[i] + q.amp[i] * Math.cos(TAU * (q.freq[i] * t + q.phase[i]));
    out[i] = v < 0 ? 0 : (v > 1 ? 1 : v);
  }
  return out;
}

/** '#rrggbb' at position t, for canvas gradients and DOM swatches. */
export function iqCss(p, t) {
  const c = iqColor(p, t);
  const h = (x) => ('0' + Math.round(x * 255).toString(16)).slice(-2);
  return '#' + h(c[0]) + h(c[1]) + h(c[2]);
}

export function smoothstep(x) {
  const t = x < 0 ? 0 : (x > 1 ? 1 : x);
  return t * t * (3 - 2 * t);
}

/* Coefficient-space blend. The editor does this itself rather than letting the
   scene run its own timed fade: the preview must match the PLAYHEAD, including
   when the playhead is parked in the middle of a fade or moving backwards, and
   a scene-side fade is a wall-clock animation that knows nothing about scrubs. */
export function interpPalette(from, to, mix) {
  const a = normPalette(from), b = normPalette(to);
  const k = smoothstep(mix);
  const lerp3 = (u, v) => [u[0] + (v[0] - u[0]) * k, u[1] + (v[1] - u[1]) * k, u[2] + (v[2] - u[2]) * k];
  const out = {
    bias: lerp3(a.bias, b.bias),
    amp: lerp3(a.amp, b.amp),
    freq: lerp3(a.freq, b.freq),
    phase: lerp3(a.phase, b.phase),
  };
  if (b.root != null || a.root != null) {
    const ar = a.root == null ? 1 : a.root, br = b.root == null ? 1 : b.root;
    out.root = ar + (br - ar) * k;
  }
  if (b.drift != null || a.drift != null) {
    const ad = a.drift == null ? 0 : a.drift, bd = b.drift == null ? 0 : b.drift;
    out.drift = ad + (bd - ad) * k;
  }
  return out;
}

/* ============================================================== PreviewHost */

export class PreviewHost {
  /* box       element the scene canvases live in (position: relative)
     videoEl   <video> overlaying that box, for video-insert cues
     logoEl    element shown while the active scene cue asks for the logo
     onNote(t) status text for the preview box's corner readout            */
  constructor(box, videoEl, logoEl, onNote) {
    this.box = box;
    this.videoEl = videoEl || null;
    this.logoEl = logoEl || null;
    this.onNote = onNote || (() => {});
    this.enabled = true;
    this.scenes = new Map();       // name -> {status, canvas, inst, err}
    this.activeName = null;
    this.videoUrl = null;
    this._palSig = '';
    this._palWarned = false;
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!this.enabled) {
      const e = this.scenes.get(this.activeName);
      if (e && e.canvas) e.canvas.style.display = 'none';
      this.driveVideo(null);
      if (this.logoEl) this.logoEl.style.display = 'none';
    } else if (this.activeName) {
      const e = this.scenes.get(this.activeName);
      if (e && e.status === 'ok') {
        e.canvas.style.display = 'block';
        this._resize(e);
      }
    }
  }

  /* ------------------------------------------------------------ scene cache */
  ensureScene(name) {
    let e = this.scenes.get(name);
    if (e) return e;
    const row = sceneRow(name);
    e = { status: 'loading', canvas: null, inst: null, err: '' };
    this.scenes.set(name, e);
    if (!row) {
      e.status = 'error';
      e.err = 'not in NATIVE_SCENES or SYN_SCENES (see the drift warning at the '
        + 'top of timeline-preview.js — it may be a scene added to demos.html '
        + 'that was never mirrored here)';
      this._note(name, e);
      return e;
    }

    const cv = document.createElement('canvas');
    cv.className = 'pvcanvas';
    // visible before construction so the scene's first resize() measures a real
    // box (same reason demos.html:673 does it)
    cv.style.display = 'block';
    this.box.appendChild(cv);
    e.canvas = cv;

    /* NOTE one preview/TV divergence: `backdrop` is deliberately NOT passed.
       The six B&W scenes that show Nebula through their white areas get that
       from a shared hidden NebulaViz the GALLERY owns and feeds per frame
       (demos.html's ensureBackdrop). Without a source SynScene's bgMix.x stays
       0 and the scene renders plain, which is the right trade for a 480 px
       preview — but it means PLUS/CIRCLES5/COMPOUND_IRIS/REPLIK8/MIN_MAX_HEX/
       FUZZY_SIGNAL look flatter here than they will on the TV. */
    const build = row.scene
      ? import('../syn/syn-runtime.js').then(({ SynScene }) => new SynScene(cv, {
        dir: '../syn/scenes/' + row.scene,
        // the preview box is ~480 px wide; a 1280-cap scene would render four
        // times the pixels it can show. min() keeps the scene's own cost
        // rating as the ceiling for the cheap ones.
        maxDim: Math.min(Number(row.maxDim) || 768, 480),
        media: !!row.media,
        patches: row.patches,
      }))
      : import(/* @vite-ignore */ row.path).then((mod) => {
        const Klass = mod.default || mod[row.name] || Object.values(mod)[0];
        if (typeof Klass !== 'function') throw new Error('module has no default-exported class');
        return new Klass(cv);
      });

    build.then((inst) => {
      e.inst = inst;
      e.status = 'ok';
      if (this.activeName === name && this.enabled) {
        this._resize(e);
        this._activate(e);
      } else {
        cv.style.display = 'none';
      }
      this._note(name, e);
    }).catch((err) => {
      e.status = 'error';
      e.err = String((err && (err.message || err)) || 'load failed');
      if (e.canvas) e.canvas.style.display = 'none';
      this._note(name, e);
      console.error('[timeline] preview scene ' + name, err);
    });

    return e;
  }

  _note(name, e) {
    if (this.activeName !== name) return;
    if (e.status === 'error') this.onNote(name + ' UNAVAILABLE — ' + e.err);
    else if (e.status === 'loading') this.onNote('loading ' + name + '...');
    else this.onNote('');
  }

  _resize(e) {
    if (e.inst && typeof e.inst.resize === 'function') {
      try { e.inst.resize(); } catch (err) { console.error('[timeline] resize', err); }
    }
  }

  _activate(e) {
    e.canvas.style.display = 'block';
    if (e.inst && typeof e.inst.onActivate === 'function') {
      try { e.inst.onActivate(); } catch (err) { console.error('[timeline] onActivate', err); }
    }
  }

  /** Show `name`. Cheap and idempotent; safe to call every frame. */
  setActive(name) {
    if (!name || name === this.activeName) return;
    const old = this.scenes.get(this.activeName);
    if (old && old.canvas) old.canvas.style.display = 'none';
    this.activeName = name;
    this._palSig = '';                       // the new instance has no palette yet
    const e = this.ensureScene(name);
    this._note(name, e);
    if (!this.enabled) return;
    if (e.status === 'ok') { this._resize(e); this._activate(e); }
  }

  /** Called once per rAF with the engine's ChromaFrame. */
  tick(frame, now, dt) {
    if (!this.enabled) return;
    const e = this.scenes.get(this.activeName);
    if (!e || e.status !== 'ok' || !e.inst) return;
    try {
      e.inst.render(frame, now, dt);
    } catch (err) {
      // one bad scene must not take the editor's rAF loop down with it
      e.status = 'error';
      e.err = String((err && (err.message || err)) || err);
      e.canvas.style.display = 'none';
      this._note(this.activeName, e);
      console.error('[timeline] preview render ' + this.activeName, err);
    }
  }

  setLogo(on) {
    if (this.logoEl) this.logoEl.style.display = (on && this.enabled) ? 'block' : 'none';
  }

  /* ---------------------------------------------------------------- palette
     `p` is MiniCueEngine's palette result: {cue, prev, mix}. We interpolate the
     coefficients ourselves and hand the scene a finished set with fade 0.

     setPalette() arrives on NEBULA with Workstream 1A. Until then the
     feature-detect below simply never fires and the preview shows NEBULA's
     built-in palette — correct-looking, just not cue-driven. */
  applyPalette(p) {
    if (!this.enabled || !p || !p.cue) return;
    const e = this.scenes.get(this.activeName);
    if (!e || e.status !== 'ok' || !e.inst) return;
    if (typeof e.inst.setPalette !== 'function') {
      if (!this._palWarned) {
        this._palWarned = true;
        console.info('[timeline] ' + this.activeName + ' has no setPalette() — '
          + 'palette cues will not colour the preview (expected until the '
          + 'NEBULA palette engine lands).');
      }
      return;
    }
    const target = p.cue.palette;
    const pal = (p.prev && p.mix < 1)
      ? interpPalette(p.prev.palette, target, p.mix)
      : normPalette(target);
    // uploading identical coefficients every frame would restart the scene's own
    // fade bookkeeping; only push on change
    const sig = this.activeName + '|' + JSON.stringify(pal);
    if (sig === this._palSig) return;
    this._palSig = sig;
    try { e.inst.setPalette(pal, 0); } catch (err) { console.error('[timeline] setPalette', err); }
  }

  /* ------------------------------------------------------------------ video
     Cloned from demos.html:1674-1709 (driveVideo). Same contract: `st` is null
     or {url, t, playing}; the clip plays OVER the live scene, which keeps
     rendering underneath, so leaving an insert is a hidden element and not a
     reload. Kept as a copy rather than a shared import because demos.html holds
     it inline in a <script> — if the original grows a fix, bring it here. */
  driveVideo(st) {
    const v = this.videoEl;
    if (!v) return;
    if (!st || !st.url || !this.enabled) {
      if (this.videoUrl) {
        v.pause();
        v.classList.remove('on');
        v.removeAttribute('src');
        v.load();              // drop the decoder rather than hold it hidden
        this.videoUrl = null;
      }
      return;
    }
    if (st.url !== this.videoUrl) {
      this.videoUrl = st.url;
      v.muted = true;
      v.src = st.url;
      v.classList.add('on');
    }
    if (st.playing) {
      if (v.paused) { const pr = v.play(); if (pr && pr.catch) pr.catch(() => {}); }
    } else if (!v.paused) {
      v.pause();
    }
    // 0.3 s of slack keeps the chase from fighting normal playback
    if (v.readyState >= 1 && Math.abs(v.currentTime - st.t) > 0.3) {
      v.currentTime = Math.max(0, st.t);
    }
  }

  /** Window resize: only the visible instance needs to hear about it. */
  onResize() {
    const e = this.scenes.get(this.activeName);
    if (e && e.status === 'ok' && this.enabled) this._resize(e);
  }
}
