/* ChromaFrame -> Synesthesia syn_* audio uniforms
   ============================================================================
   Synesthesia scenes are written against a specific set of audio signals, and
   vizier's AnalysisEngine produces a different (richer, but differently shaped)
   one. This module is the translation layer: one `SynAudio` instance per scene,
   fed a ChromaFrame each render, exposing every documented `syn_*` scalar plus
   the two 1-row data textures.

   The docs give names, ranges and prose semantics but no formulas — the actual
   DSP is compiled C++ in the desktop app and is not recoverable. So each family
   below implements the DOCUMENTED BEHAVIOUR with its own envelope, tuned by eye
   against real music until scenes react the way their thumbnails suggest. The
   doc line each one is answering is quoted above it.

   Two structural mismatches worth knowing about:

     * vizier's `energy` is folded onto the PITCH-CLASS circle (angle = pitch,
       band = register), not a frequency axis. Band means over the angular bins
       still give a clean 4-band level split, which is all the Level/Hits/
       Presence/Time families need.
     * A real frequency axis does exist in `rim` (48 log-spaced register bins x
       256 angles). Summing that across angle recovers a 48-bin log-frequency
       spectrum spanning 20 Hz - 20 kHz, which is what syn_Spectrum wants.

   The engine has no tempo estimator, so BPM is derived here from the spacing of
   beat-pulse onsets (see estimateBPM). Nothing allocates per frame.

   The gallery's control panel can lean on all of this through SYN_GAIN
   (syn-settings.js): a master gain, four band gains and a hits sensitivity,
   sampled once per update() and applied downstream of each normalizer.
   Everything else — envelopes, BPM tracking, the beat detector's onset test —
   is left on the untouched signal, so turning a band up changes how hard a
   scene reacts, not what the shim thinks the music is doing.
   ========================================================================== */

'use strict';

import { SYN_GAIN } from './syn-settings.js';

const SPECTRUM_BINS = 1024;   // syn_Spectrum texture width (matches desktop)
const TRAIL_BINS = 512;       // syn_LevelTrail history length
const RIM_REGS = 48;          // log-frequency bins in ChromaFrame.rim

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
// frame-rate independent one-pole: fraction of the way to target in `dt`
const lerpK = (dt, tau) => 1 - Math.exp(-dt / Math.max(tau, 1e-4));

/* ----------------------------------------------------------- BPM estimator
   vizier's engine has no tempo tracker, so this derives one from the only tempo
   evidence available: rising edges of the bass beat pulse.

   Two things make the raw inter-onset intervals unusable on their own, both
   measured against a real DJ set:

     1. The detector fires on some off-beats and drops out entirely through busy
        sections, so raw intervals are a mix of one-beat, half-beat and
        several-beat gaps. Taking a plain median of those wanders — it read
        118 -> 173 BPM over 24 s of a steady mix.
     2. A beat detector cannot distinguish a tempo from its double or half
        anyway; that ambiguity is inherent, not a bug.

   So every interval is FOLDED into a single tempo octave (100..200 BPM) by
   repeated doubling/halving before it is counted. A half-beat gap and a
   two-beat gap then land on the same value as a true beat, and the median has a
   real cluster to find. The reported BPM is eased toward each new estimate
   rather than snapped, because scenes drive geometry from the oscillators and a
   step change in tempo reads as a glitch. Confidence is the share of intervals
   sitting within 8% of that median. */
const FOLD_LO = 0.30;   // 200 BPM
const FOLD_HI = 0.60;   // 100 BPM

function foldInterval(dt) {
  if (!(dt > 0)) return 0;
  for (let i = 0; i < 8 && dt < FOLD_LO; i++) dt *= 2;
  for (let i = 0; i < 8 && dt > FOLD_HI; i++) dt *= 0.5;
  return dt;
}

class BPMEstimator {
  constructor() {
    this.intervals = new Float32Array(16);
    this.n = 0;
    this.write = 0;
    this.lastOnset = -1;
    this.sorted = new Float32Array(16);
    this.bpm = 120;         // documented range is 50..220; 120 is the fallback
    this.confidence = 0;
  }

  /* Call once per frame with the wall clock and whether a beat just started. */
  update(now, onset) {
    if (!onset) return;
    if (this.lastOnset >= 0) {
      const gap = now - this.lastOnset;
      // beyond ~2.5 s the detector has dropped out rather than found a slow
      // tempo, and folding that would invent an interval that was never played
      if (gap > 0.12 && gap < 2.5) {
        this.intervals[this.write] = foldInterval(gap);
        this.write = (this.write + 1) % this.intervals.length;
        if (this.n < this.intervals.length) this.n++;
        this._recompute();
      }
    }
    this.lastOnset = now;
  }

  _recompute() {
    const n = this.n;
    if (n < 4) return;                       // not enough to call a tempo yet
    const s = this.sorted;
    for (let i = 0; i < n; i++) s[i] = this.intervals[i];
    // insertion sort: n <= 16, and it allocates nothing
    for (let i = 1; i < n; i++) {
      const v = s[i];
      let j = i - 1;
      while (j >= 0 && s[j] > v) { s[j + 1] = s[j]; j--; }
      s[j + 1] = v;
    }
    const median = (n & 1) ? s[(n - 1) >> 1] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
    if (median <= 0) return;

    let agree = 0;
    for (let i = 0; i < n; i++) if (Math.abs(s[i] - median) < median * 0.08) agree++;
    this.confidence = clamp01(agree / n) * Math.min(1, n / 8);

    const est = Math.min(220, Math.max(50, 60 / median));
    // ease toward the estimate; trust it faster when the cluster is tight
    this.bpm += (est - this.bpm) * (0.10 + 0.35 * this.confidence);
  }
}

/* ------------------------------------------------------------ the shim */
export class SynAudio {
  constructor() {
    // --- per-band raw energy and its slow normalizer ---
    this.raw = new Float32Array(4);
    this.peak = new Float32Array(4).fill(1e-3);
    this.level = new Float32Array(4);     // syn_{Bass,Mid,MidHigh,High}Level
    this.prevLevel = new Float32Array(4);
    this.hits = new Float32Array(4);      // syn_*Hits envelopes
    this.presence = new Float32Array(4);  // syn_*Presence envelopes
    this.timeAcc = new Float32Array(4);   // syn_*Time clocks

    this.allHit = 0;
    this.allPresence = 0;
    this._prevAll = 0;
    this.synTime = 0;
    this.curvedTime = 0;
    this.intensity = 0;

    // --- beat / tempo ---
    this.bpmEst = new BPMEstimator();
    this.prevBeat = 0;
    this.beatTime = 0;        // integer beat counter
    this.bpmPhase = 0;        // continuous beats, drives the oscillators
    this.toggle = 0;
    this.toggleTarget = 0;
    this.random = 0.5;
    this.randomTarget = 0.5;

    // --- spectrum / trail scratch (allocated once) ---
    this.regSum = new Float32Array(RIM_REGS);
    this.regSmooth = new Float32Array(RIM_REGS);
    this.regPeak = 1e-4;
    this.spectrum = new Float32Array(SPECTRUM_BINS * 4);
    this.trail = new Float32Array(TRAIL_BINS * 4);
    this.trailRing = new Float32Array(TRAIL_BINS * 4);
    this.trailCursor = 0;
    this.wavePhase = 0;

    this.time = 0;
    this.frame = 0;
    this.spectrumDirty = true;

    // live gains, refreshed from SYN_GAIN at the top of every update()
    this.gMaster = 1;
    this.gHits = 1;
    this.gBand = SYN_GAIN.band;
  }

  /* ------------------------------------------------------------- per frame */
  update(f, dt) {
    dt = Math.min(Math.max(dt, 1e-4), 0.1);
    this.time += dt;
    this.frame++;

    /* Snapshot the live gains once per frame (see syn-settings.js for why they
       are applied post-normalization rather than to the incoming frame). Held
       on `this` so the private helpers below can read them without a second
       argument; no allocation. */
    this.gMaster = SYN_GAIN.master;
    this.gHits = SYN_GAIN.hits;
    this.gBand = SYN_GAIN.band;

    this._bands(f, dt);
    this._beat(f, dt);
    this._spectrum(f, dt);
  }

  /* Level / Hits / Presence / Time, all four bands plus the whole-spectrum
     versions. Bass=band0 .. High=band3 straight off the register split. */
  _bands(f, dt) {
    const e = f.energy, ang = f.ang, n = f.nreg;
    const raw = this.raw, peak = this.peak, lvl = this.level;

    for (let b = 0; b < n && b < 4; b++) {
      let s = 0;
      const base = b * ang;
      for (let a = 0; a < ang; a++) s += e[base + a];
      raw[b] = s / ang;
    }

    /* Level. The docs only promise "normalized to the range 0.0 to 1.0", and
       the raw band means sit very low (energy is concentrated in a handful of
       pitch bins, so the mean over 256 angles is small and its absolute size
       depends on the material). A slow-decay running peak per band turns that
       into a real 0..1 with the music's own dynamics intact; the 0.75 power is
       a gentle expansion so mid-level passages do not all read as 0.2. */
    const decay = Math.pow(0.5, dt / 20);   // peak half-life ~20 s
    const gm = this.gMaster, gh = this.gHits, gb = this.gBand;
    for (let b = 0; b < 4; b++) {
      const p = Math.max(peak[b] * decay, raw[b], 2e-4);
      peak[b] = p;
      const v = clamp01(Math.pow(raw[b] / p, 0.75) * gm * gb[b]);

      /* Hits: "spiking in value during the isolated transients". Positive
         derivative of the band level with a fast decay — rise is instant,
         fall is ~90 ms, which reads as a drum hit rather than a level. */
      const d = Math.max(0, v - this.prevLevel[b]) / dt;
      const strike = clamp01(d * 0.10 * gh);
      this.hits[b] = Math.max(this.hits[b] * Math.exp(-dt / 0.09), strike);
      this.prevLevel[b] = v;
      lvl[b] = v;

      /* Presence: "rising or falling action without reacting to each
         individual sound" — a long asymmetric envelope, slower to fall than
         to rise so a busy section stays "present" through its gaps. */
      const tau = v > this.presence[b] ? 1.2 : 3.0;
      this.presence[b] += (v - this.presence[b]) * lerpK(dt, tau);

      /* Time: "clocks that move forward when the volume of a specific
         frequency band is high ... similar scale to the TIME uniform". A
         small floor keeps a scene breathing through silence. */
      this.timeAcc[b] += dt * (0.15 + 1.7 * v);
    }

    // whole-spectrum versions: syn_Level is already an AGC'd 0..1 from vizier
    const all = clamp01(f.level * gm);
    const dAll = Math.max(0, all - this._prevAll) / dt;
    this._prevAll = all;
    // the engine's beat detector is bass-triggered and lands exactly on 1.0,
    // so folding it in gives syn_Hits/syn_BassHits the crisp full-scale spike
    // that scenes threshold against (e.g. `if (syn_BassHits > 0.98)`)
    const beatHit = clamp01(f.beat * gh);
    this.allHit = Math.max(this.allHit * Math.exp(-dt / 0.09),
                           clamp01(dAll * 0.10 * gh), beatHit);
    this.hits[0] = Math.max(this.hits[0], beatHit);

    const tauA = all > this.allPresence ? 1.2 : 3.0;
    this.allPresence += (all - this.allPresence) * lerpK(dt, tauA);
    this.synTime += dt * (0.15 + 1.7 * all);
    // "responds to volume increases with much higher acceleration"
    this.curvedTime += dt * (0.10 + 3.4 * all * all);
    // "slowly accumulates to 1.0 depending on the intensity of the song"
    this.intensity += (clamp01(all * 1.5) - this.intensity) * lerpK(dt, 6.0);
  }

  /* Beat family + the BPM oscillators. */
  _beat(f, dt) {
    // rising edge of the decaying pulse == a fresh onset
    const onset = f.beat > 0.95 && this.prevBeat < 0.95;
    this.prevBeat = f.beat;

    this.bpmEst.update(this.time, onset);
    const bpm = this.bpmEst.bpm;

    if (onset) {
      this.beatTime += 1;
      this.toggleTarget = this.toggleTarget > 0.5 ? 0 : 1;
      this.randomTarget = Math.random();
      /* Resync the oscillator phase to the downbeat — but FORWARD ONLY. Scenes
         use floor(syn_BPMTwitcher) as a beat counter, so the phase must never
         run backwards; snapping to round() would do exactly that whenever the
         beat arrived early. max() advances to the next integer once we are
         past halfway and otherwise leaves the phase alone. */
      this.bpmPhase = Math.max(this.bpmPhase, Math.round(this.bpmPhase));
    }
    this.bpmPhase += dt * bpm / 60;

    /* "Smoothly transitions between values using a logistic curve" — a one-pole
       toward the new target is the practical form of that. */
    const k = lerpK(dt, 0.06);
    this.toggle += (this.toggleTarget - this.toggle) * k;
    this.random += (this.randomTarget - this.random) * k;
  }

  /* syn_Spectrum (r raw / g juiced / b smooth / a waveform) and
     syn_LevelTrail (r whole / g bass / b mid / a high, scrolling in time). */
  _spectrum(f, dt) {
    const rim = f.rim, ang = f.ang, nreg = f.rimRegs || RIM_REGS;
    const reg = this.regSum;

    let peak = 0;
    for (let r = 0; r < nreg; r++) {
      let s = 0;
      const base = r * ang;
      for (let a = 0; a < ang; a++) s += rim[base + a];
      reg[r] = s;
      if (s > peak) peak = s;
    }
    // slow-decay normalizer, same idea as the band peaks
    this.regPeak = Math.max(this.regPeak * Math.pow(0.5, dt / 12), peak, 1e-5);
    const inv = 1 / this.regPeak;

    /* "bin smoothing ... and high-end boosting" for the juiced channel. The
       panel's band gains ride along here too: the 48 log-frequency registers
       split four ways onto the same bass/mid/midhigh/high split the Level
       family uses, so a boosted band reads boosted in syn_Spectrum as well. */
    const sm = this.regSmooth;
    const kk = lerpK(dt, 0.08);
    const gm = this.gMaster, gb = this.gBand;
    for (let r = 0; r < nreg; r++) {
      const boost = 1 + 1.4 * (r / (nreg - 1));   // lift the thin high end
      const g = gm * gb[Math.min(3, (r * 4 / nreg) | 0)];
      const v = clamp01(Math.pow(reg[r] * inv, 0.6) * boost * g);
      sm[r] += (v - sm[r]) * kk;
    }

    const out = this.spectrum;
    const lvl = clamp01(f.level * gm);
    this.wavePhase += dt * 6.2831853;
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      const x = i / (SPECTRUM_BINS - 1);

      /* g: juiced == the log-frequency curve, linearly interpolated up to
         texture width. This is the channel the docs tell scene authors to use
         by default, so it gets the good data. */
      const fp = x * (nreg - 1);
      const i0 = fp | 0, i1 = Math.min(nreg - 1, i0 + 1), ft = fp - i0;
      const juiced = sm[i0] + (sm[i1] - sm[i0]) * ft;

      /* r: raw == LINEAR frequency. Map the linear axis onto the log register
         axis so bass piles into the first few bins the way a real FFT does. */
      const hz = 20 + x * (20000 - 20);
      const oct = Math.log2(hz / 20) / 9.9658;    // 0..1 over 20 Hz..20 kHz
      const rp = clamp01(oct) * (nreg - 1);
      const r0 = rp | 0, r1 = Math.min(nreg - 1, r0 + 1), rt = rp - r0;
      const rawv = (reg[r0] + (reg[r1] - reg[r0]) * rt) * inv * gm;

      /* b: smooth == "much less frequency resolution". Three-tap blur of the
         juiced curve over the register axis. */
      const b0 = Math.max(0, i0 - 2), b1 = Math.min(nreg - 1, i0 + 2);
      const smooth = (sm[b0] + sm[i0] + sm[b1]) / 3;

      /* a: waveform. vizier hands over spectra, never raw samples, so there is
         nothing to copy — this is a stand-in: band-weighted partials on a
         common phase, centred on 0.5, which scopes and displacement lookups
         read as a plausible wave that moves with the mix. */
      const w = 0.5 + 0.5 * lvl * (
        0.55 * Math.sin(this.wavePhase * 1.0 + x * 34.0) * (0.3 + this.level[0]) +
        0.28 * Math.sin(this.wavePhase * 2.3 + x * 91.0) * (0.3 + this.level[1]) +
        0.17 * Math.sin(this.wavePhase * 4.1 + x * 197.0) * (0.3 + this.level[3]));

      const o = i * 4;
      out[o] = clamp01(rawv);
      out[o + 1] = juiced;
      out[o + 2] = smooth;
      out[o + 3] = clamp01(w);
    }

    // level trail: newest sample at x=0, scrolling backwards in time
    this.trailCursor = (this.trailCursor - 1 + TRAIL_BINS) % TRAIL_BINS;
    const rc = this.trailCursor * 4, ring = this.trailRing;
    ring[rc] = lvl;
    ring[rc + 1] = this.level[0];
    ring[rc + 2] = this.level[1];
    ring[rc + 3] = this.level[3];
    const tr = this.trail;
    for (let i = 0; i < TRAIL_BINS; i++) {
      const src = ((this.trailCursor + i) % TRAIL_BINS) * 4, dst = i * 4;
      tr[dst] = ring[src]; tr[dst + 1] = ring[src + 1];
      tr[dst + 2] = ring[src + 2]; tr[dst + 3] = ring[src + 3];
    }
  }

  /* ------------------------------------------------- uniform value getters */

  /* Write every syn_* scalar into `dst` (a plain object the runtime uploads).
     Reusing one object keeps this allocation-free. */
  writeUniforms(dst, f) {
    const l = this.level, h = this.hits, p = this.presence, t = this.timeAcc;
    // the level/hits families below already carry their gain from update();
    // these three read the frame directly, so they take it here
    const gm = this.gMaster, gh = this.gHits;

    dst.syn_Level = clamp01(f.level * gm);
    dst.syn_RawLevel = clamp01(f.level * 1.25 * gm);
    dst.syn_BassLevel = l[0];
    dst.syn_MidLevel = l[1];
    dst.syn_MidHighLevel = l[2];
    dst.syn_HighLevel = l[3];

    dst.syn_Hits = this.allHit;
    dst.syn_BassHits = h[0];
    dst.syn_MidHits = h[1];
    dst.syn_MidHighHits = h[2];
    dst.syn_HighHits = h[3];

    dst.syn_Time = this.synTime;
    dst.syn_BassTime = t[0];
    dst.syn_MidTime = t[1];
    dst.syn_MidHighTime = t[2];
    dst.syn_HighTime = t[3];
    dst.syn_CurvedTime = this.curvedTime;

    dst.syn_Presence = this.allPresence;
    dst.syn_BassPresence = p[0];
    dst.syn_MidPresence = p[1];
    dst.syn_MidHighPresence = p[2];
    dst.syn_HighPresence = p[3];

    dst.syn_OnBeat = clamp01(f.beat * gh);
    dst.syn_ToggleOnBeat = this.toggle;
    dst.syn_RandomOnBeat = this.random;
    dst.syn_BeatTime = this.beatTime;

    const bpm = this.bpmEst.bpm;
    const ph = this.bpmPhase;
    dst.syn_BPM = bpm;
    dst.syn_BPMConfidence = this.bpmEst.confidence;
    // "exponentially jumps in value to the next beat"; floor() is a beat clock
    // and fract() is the jump, exactly as the docs describe
    const fr = ph - Math.floor(ph);
    dst.syn_BPMTwitcher = Math.floor(ph) + (1 - Math.exp(-5 * fr)) / (1 - Math.exp(-5));
    dst.syn_BPMSin = 0.5 + 0.5 * Math.sin(ph * Math.PI * 2);
    dst.syn_BPMSin2 = 0.5 + 0.5 * Math.sin(ph * Math.PI);
    dst.syn_BPMSin4 = 0.5 + 0.5 * Math.sin(ph * Math.PI * 0.5);
    dst.syn_BPMTri = tri(ph);
    dst.syn_BPMTri2 = tri(ph * 0.5);
    dst.syn_BPMTri4 = tri(ph * 0.25);

    // no scene start/end lifecycle here, so the scene is always fully faded in
    dst.syn_FadeInOut = 1;
    dst.syn_Intensity = this.intensity;

    /* Two names from an older revision of the uniform set that two shipped
       scenes still read (audio_indicators, exoplanet). syn_InputLevel is the
       pre-normalization input meter; syn_BassExpoCurve is the bass level on an
       expanded curve, so it sits near zero except on the hits. */
    dst.syn_InputLevel = clamp01(f.level * gm);
    dst.syn_BassExpoCurve = l[0] * l[0] * l[0];

    dst.syn_MediaType = 0;          // None: `_isMediaActive()` stays false
    dst.syn_Prefs_ZoomOrFit = 0;
    return dst;
  }
}

function tri(x) {
  const f = x - Math.floor(x);
  return f < 0.5 ? f * 2 : 2 - f * 2;
}

export { SPECTRUM_BINS, TRAIL_BINS };
