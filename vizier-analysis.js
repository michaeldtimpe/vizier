/* vizier — analysis engine
   ============================================================================
   Reverse-engineered out of the original single-file waveloop.html. This module
   owns EVERYTHING upstream of pixels: audio sources, the FFT/CQT analysis, the
   DSP stage, the fold onto the pitch-class circle, makeup gain, the per-angle
   AGC + display smoothing, chord detection, and level/beat tracking.

   It is source-agnostic about how the result is drawn. Each call to
   `engine.update(nowSec)` returns a ChromaFrame (see the bottom of this file
   for the exact shape) — a smoothed, normalized snapshot of the pitch-class
   field that any visualizer can read and draw. The bundled WheelVisualizer is
   one such consumer; write your own against the same ChromaFrame contract.

   Single-instance: the heavy analysis buffers are module-scoped scratch (one
   audio pipeline per page), so construct exactly one AnalysisEngine. You can
   point any number of visualizers at the frames it produces.
   ========================================================================== */

'use strict';

/* ----------------------------------------------------------- shared geometry
   The pitch-class circle resolution. These define the coordinate system both
   the engine (which fills the field) and a visualizer (which draws it) speak
   in, so they are exported together as SPEC. ANG angular bins around the
   circle (angle = fract(log2(f/440)), 0 = A); NREG register bands stacked low
   to high; RIM_REGS finer register bins for the rim histogram. */
const ANG = 256;            // angular bins around the pitch-class circle
const NREG = 4;             // register bands, ~2.5 octaves each
const RIM_REGS = 48;        // fine register histogram bins (per angle)
const F_LO = 20, F_HI = 20000;             // full audible band
const OCT_SPAN = Math.log2(F_HI / F_LO);   // ~9.97 octaves
const SPLIT_HZ = 1000;      // dual-FFT crossover (long FFT below, short above)
const E_MAX = 2.0;          // display-energy ceiling; the AGC knee tops out here

export const SPEC = Object.freeze({
  ANG, NREG, RIM_REGS, F_LO, F_HI, OCT_SPAN, SPLIT_HZ, E_MAX,
});

/* ------------------------------------------------------------------- color
   register -> sRGB lookup: Oklch hue advances ~60 degrees per octave so
   absolute register is readable without fighting angular pitch class;
   lightness climbs the whole 20 Hz..20 kHz axis (dark bass -> near-white air
   band) while chroma peaks around common musical fundamentals (~C4). Exported
   so visualizers can color anything by register the same way the engine does. */
export function oklchToSrgb(L, C, h) {
  const a = C * Math.cos(h), b = C * Math.sin(h);
  let l = L + 0.3963377774 * a + 0.2158037573 * b;
  let m = L - 0.1055613458 * a - 0.0638541728 * b;
  let s = L - 0.0894841775 * a - 1.2914855480 * b;
  l = l * l * l; m = m * m * m; s = s * s * s;
  return [
     4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ].map((v) => Math.pow(Math.min(Math.max(v, 0), 1), 0.4545));
}

const REG_STEPS = 256;
const REG_LUT = new Float32Array(REG_STEPS * 3);
for (let i = 0; i < REG_STEPS; i++) {
  const reg = i / (REG_STEPS - 1);
  const oct = reg * OCT_SPAN;
  const h = (24 + oct * 60) * Math.PI / 180;  // ~60 degrees per octave
  const t = (reg - 0.37) / 0.30;   // chroma peak: 0.37 ~ 260 Hz (around C4)
  const c = oklchToSrgb(0.30 + 0.63 * reg, 0.05 + 0.145 * Math.exp(-t * t), h);
  REG_LUT[i * 3] = c[0]; REG_LUT[i * 3 + 1] = c[1]; REG_LUT[i * 3 + 2] = c[2];
}
export { REG_LUT };

// register (0..1 over 20 Hz..20 kHz) -> [r,g,b], for visualizers
export function regColor(o) {
  const i = Math.min(REG_STEPS - 1, Math.max(0, (o * (REG_STEPS - 1)) | 0)) * 3;
  return [REG_LUT[i], REG_LUT[i + 1], REG_LUT[i + 2]];
}

// color weights are compressed (w^REG_GAMMA) so a quieter octave doubling
// still tints the mix instead of vanishing under a dominant register
const REG_GAMMA = 0.7;

function regLutIndex(o) {
  return ((o * (REG_STEPS - 1)) | 0) * 3;
}

// which of the NREG rim/trail bands a register belongs to
function regBand(o) {
  return Math.min(NREG - 1, (o * NREG) | 0);
}

/* --------------------------------------------------------------- host hooks
   Set by the AnalysisEngine constructor; the module-scoped functions below
   reach back through these instead of touching the DOM directly. */
let audioEl = null;
let basePath = 'waveloop/';
let onMessage = () => {};         // status-line text (deck/cqt messages)
let onTracksLoaded = () => {};    // manifest arrived; host renders the deck
let onStatusChange = () => {};    // mode/track/cqt readiness changed

/* --------------------------------------------------------------- live state */

const state = {
  mode: 'sim',          // 'sim' (idle) | 'local' | 'mic'
  level: 0,             // smoothed 0..1
  beat: 0,              // beat pulse envelope, decays each frame
};

// per-frame accumulators, written by liveFrame / vqtFrame / simFrame, kept
// separate per register band (index = band * ANG + angularBin) so simultaneous
// octaves of one pitch class survive as distinct layers. Within a band, colors
// accumulate in RGB so the register hue survives. angRim is the rim's finer
// register histogram (RIM_REGS bins, register-major).
const angEnergy = new Float32Array(NREG * ANG);
const angR = new Float32Array(NREG * ANG);
const angG = new Float32Array(NREG * ANG);
const angB = new Float32Array(NREG * ANG);
const angRim = new Float32Array(RIM_REGS * ANG);
const angW = new Float32Array(NREG * ANG);   // total color weight, for normalization
const angTot = new Float32Array(ANG);        // per-angle sum over bands, for the AGC

// smoothed display state, same band-major layout — this is what a ChromaFrame
// hands to the visualizer
const dispE = new Float32Array(NREG * ANG);
const dispR = new Float32Array(NREG * ANG);
const dispG = new Float32Array(NREG * ANG);
const dispB = new Float32Array(NREG * ANG);
const dispRim = new Float32Array(RIM_REGS * ANG);
const chromaRaw = new Float32Array(12);   // 12-bin chroma for chord detection
const chroma = new Float32Array(12);
const agcScratch = new Float32Array(ANG); // sorted copy for the percentile AGC
let angRef = 2e-4;                        // loudness reference for the wheel bins
let totalAgc = 1e-9, bassAgc = 1e-9, chromaAgc = 1e-6;
let bassAvg = 0, lastBeatAt = 0;

/* ------------------------------------------------------------------- fold
   Fold a real FFT onto the pitch-class circle. angle = fract(log2(f/440)) so
   0 = A; each bin also deposits its register color into the RGB accumulators
   so stacked octaves layer. For chord chroma we keep only local spectral peaks
   below ~2.2 kHz and compress with sqrt, discounting highs. */
function foldBand(b) {
  const { mag, hz, i0, i1 } = b;
  let total = 0;
  for (let i = i0; i <= i1; i++) {
    const m = mag[i];
    if (m <= 0) continue;
    const f = i * hz;
    total += m;

    const lg = Math.log2(f / 440);
    const frac = lg - Math.floor(lg);
    const x = frac * ANG;
    const o = Math.min(Math.max(Math.log2(f / F_LO) / OCT_SPAN, 0), 1);
    const li = regLutIndex(o);
    const cr = REG_LUT[li], cg = REG_LUT[li + 1], cb = REG_LUT[li + 2];
    const ro = regBand(o) * ANG;
    const rr = Math.min(RIM_REGS - 1, (o * RIM_REGS) | 0) * ANG;
    const cmag = Math.pow(m, REG_GAMMA);
    // paint the bin over its true angular footprint: low bins are wide on a
    // log axis (smooth arcs instead of comb teeth), high bins stay thin.
    const sig = Math.max(0.9, Math.log2((f + hz) / f) * ANG * 0.5);
    const rad = Math.min(Math.ceil(sig * 2.5), 96);
    const base = Math.round(x);
    const inv2s2 = 1 / (2 * sig * sig);
    const norm = 1 / (sig * 2.50662827);   // Gaussian area, keeps energy mass exact
    for (let d = -rad; d <= rad; d++) {
      const ai = ((base + d) % ANG + ANG) % ANG;
      const a = ai + ro;
      const dd = base + d - x;
      const g = Math.exp(-dd * dd * inv2s2) * norm;
      angEnergy[a] += m * g;
      angRim[rr + ai] += m * g;
      const cw = cmag * g;
      angR[a] += cw * cr; angG[a] += cw * cg; angB[a] += cw * cb;
      angW[a] += cw;
    }

    // 3.2e-4 is the old -70 dB peak threshold in linear magnitude
    if (f < 2200 && m > mag[i - 1] && m >= mag[i + 1] && m > 3.2e-4) {
      const pc = Math.round(frac * 12) % 12;
      chromaRaw[pc] += Math.sqrt(m) * (1 - 0.35 * o);
    }
  }
  return total;
}

/* ------------------------------------------- optional DSP postprocessing
   Six independent layers between FFT and fold, all knob-controlled. The
   Melodic preset is the page-load default; the Raw preset zeroes every knob,
   which makes the whole stage a no-op. Order: drum cut -> phon weight -> gate
   -> whiten -> overtone cut -> peak focus. */
const DSP_PRESETS = {
  raw:     { overtone: 0,    whiten: 0,    phon: 0,    focus: 0,    gate: 0,    drums: 0 },
  melodic: { overtone: 0.35, whiten: 0.35, phon: 0.35, focus: 0.3,  gate: 0.25, drums: 0.3 },
};
export { DSP_PRESETS };

const dsp = Object.assign({}, DSP_PRESETS.melodic);

function dspActive() {
  return dsp.overtone > 0 || dsp.whiten > 0 || dsp.phon > 0 || dsp.focus > 0
      || dsp.gate > 0 || dsp.drums > 0;
}

// dB -> linear magnitude over a band's used range (plus one guard bin each
// side); bins under the -85 dB floor become exact zeros. Returns band total.
function toMag(db, mag, i0, i1) {
  let total = 0;
  for (let i = i0 - 1; i <= i1 + 1; i++) {
    const d = db[i];
    const m = d < -85 ? 0 : Math.pow(10, d / 20);
    mag[i] = m;
    if (i >= i0 && i <= i1) total += m;
  }
  return total;
}

// A-weighting-style amplitude gain, normalized near its 1 kHz reference.
function aWeightGain(f) {
  const f2 = f * f;
  const ra = (12200 * 12200 * f2 * f2)
    / ((f2 + 20.6 * 20.6)
    * Math.sqrt((f2 + 107.7 * 107.7) * (f2 + 737.9 * 737.9))
    * (f2 + 12200 * 12200));
  const db = 20 * Math.log10(Math.max(ra, 1e-12)) + 2.0;
  return Math.pow(10, db / 20);
}

/* constant-Q-ish envelope: forward+backward one-pole whose window grows
   proportionally with bin index (frac of center frequency), floored at wMin */
function smoothEnvCQ(mag, env, i0, i1, frac, wMin) {
  let acc = mag[i0];
  for (let i = i0; i <= i1; i++) {
    acc += (mag[i] - acc) / Math.max(frac * i, wMin);
    env[i] = acc;
  }
  acc = env[i1];
  for (let i = i1; i >= i0; i--) {
    acc += (env[i] - acc) / Math.max(frac * i, wMin);
    env[i] = acc;
  }
}

/* overtone suppression: every local spectral peak is a candidate fundamental,
   processed in ascending frequency; energy near its integer multiples is
   attenuated by however much of that harmonic the fundamental can explain. */
const PEAK_CAP = 80;
const peakIdx = new Int32Array(PEAK_CAP);
const peakBand = new Uint8Array(PEAK_CAP);

function suppressOvertones(bands, fmax) {
  const floor = fmax * 0.004;   // ~-48 dB below frame peak
  if (floor <= 0) return;
  let np = 0;
  for (let bi = 0; bi < 2 && np < PEAK_CAP; bi++) {
    const { mag, i0, i1 } = bands[bi];
    for (let i = i0; i <= i1 && np < PEAK_CAP; i++) {
      const m = mag[i];
      if (m > floor && m > mag[i - 1] && m >= mag[i + 1]) {
        peakIdx[np] = i; peakBand[np] = bi; np++;
      }
    }
  }
  const amt = dsp.overtone;
  for (let p = 0; p < np; p++) {
    const b = bands[peakBand[p]];
    const i = peakIdx[p];
    const mf = b.mag[i];          // current value: may itself have been cut
    if (mf <= 0) continue;
    const f = i * b.hz;
    for (let k = 2; k <= 12; k++) {
      const fk = f * k;
      if (fk > F_HI) break;
      const tb = fk < SPLIT_HZ ? bands[0] : bands[1];
      const ci = Math.round(fk / tb.hz);
      const tol = Math.min(Math.max(fk * 0.008 / tb.hz, 1.5), 8);
      const r = Math.ceil(tol);
      if (ci + r < tb.i0 || ci - r > tb.i1) continue;
      const cap = mf / Math.pow(k, 0.6);
      const inv = 1 / (2 * tol * tol);
      for (let d = -r; d <= r; d++) {
        const j = ci + d;
        if (j < tb.i0 || j > tb.i1) continue;
        const mh = tb.mag[j];
        if (mh <= 0) continue;
        const conf = Math.min(cap / mh, 1);
        tb.mag[j] = mh * (1 - amt * conf * Math.exp(-d * d * inv));
      }
    }
  }
}

function dspApply(ana, dt) {
  const bands = ana.bands;

  // drum cut: bins jumping far above their own ~300 ms average get pulled back
  // toward it. The EMA always tracks the RAW magnitudes so the stats stay honest.
  const emaK = 1 - Math.exp(-dt / 0.3);
  for (const b of bands) {
    const { mag, ema, i0, i1 } = b;
    for (let i = i0; i <= i1; i++) {
      const m = mag[i], e = ema[i];
      if (dsp.drums > 0 && m > e * 1.8) {
        mag[i] = m * Math.pow((e * 1.8 + 1e-12) / m, dsp.drums);
      }
      ema[i] = e + (m - e) * emaK;
    }
  }

  // phon weighting: morph from raw magnitude toward A-weighted loudness.
  if (dsp.phon > 0) {
    for (const b of bands) {
      const { mag, phon, i0, i1 } = b;
      for (let i = i0; i <= i1; i++) {
        mag[i] *= Math.pow(Math.min(Math.max(phon[i], 0.06), 1.25), dsp.phon);
      }
    }
  }

  // frame peak across both bands, shared by gate and overtone cut
  let fmax = 0;
  for (const b of bands) {
    for (let i = b.i0; i <= b.i1; i++) if (b.mag[i] > fmax) fmax = b.mag[i];
  }

  // soft noise gate: knob maps the knee from -72 dB to -32 dB below frame peak
  if (dsp.gate > 0 && fmax > 0) {
    const thr = fmax * Math.pow(10, (-72 + 40 * dsp.gate) / 20);
    const t2 = thr * thr;
    for (const b of bands) {
      const { mag } = b;
      for (let i = b.i0; i <= b.i1; i++) {
        const m2 = mag[i] * mag[i];
        mag[i] *= m2 / (m2 + t2);
      }
    }
  }

  // whitening: divide by a ~half-octave-wide envelope so the broadband tilt
  // flattens; boost capped at 6x so the noise floor can't take over
  if (dsp.whiten > 0) {
    let ref = 0, cnt = 0;
    for (const b of bands) {
      smoothEnvCQ(b.mag, b.env, b.i0, b.i1, 0.5, 8);
      for (let i = b.i0; i <= b.i1; i++) ref += b.env[i];
      cnt += b.i1 - b.i0 + 1;
    }
    ref = ref / cnt + 1e-12;
    for (const b of bands) {
      const { mag, env } = b;
      for (let i = b.i0; i <= b.i1; i++) {
        const g = Math.pow(ref / (env[i] + 0.05 * ref), dsp.whiten);
        mag[i] *= Math.min(g, 6);
      }
    }
  }

  if (dsp.overtone > 0) suppressOvertones(bands, fmax);

  // peak focus: spectral contrast against a ~semitone-wide local mean
  if (dsp.focus > 0) {
    for (const b of bands) {
      smoothEnvCQ(b.mag, b.env, b.i0, b.i1, 0.06, 4);
      const { mag, env } = b;
      for (let i = b.i0; i <= b.i1; i++) {
        if (env[i] <= 0) continue;
        const g = Math.pow(mag[i] / env[i], dsp.focus * 1.5);
        mag[i] *= Math.min(g, 4);
      }
    }
  }
}

/* ---------------------------------------------------- adaptive makeup gain
   Upstream of the DSP stage and fold: when the source runs quiet, the linear
   magnitudes are multiplied (up to 10x for mic, 4x for files) so soft material
   still reaches the wheel's working range. Two guards keep this from
   normalizing silence: the boost is a hard cap, and it is only granted to
   signal standing clear of a tracked noise-floor estimate. */
const MAKEUP_MAX_MIC = 10;    // +20 dB
const MAKEUP_MAX_FILE = 4;    // +12 dB
const MAKEUP_TARGET = 1.0;
let makeupEnv = 0;
let makeupNoise = 1;
let makeupGain = 1;

function updateMakeup(total, dt, maxGain) {
  makeupEnv += (total - makeupEnv)
    * (1 - Math.exp(-dt / (total > makeupEnv ? 0.06 : 2.0)));
  makeupNoise += (total - makeupNoise)
    * (1 - Math.exp(-dt / (total < makeupNoise ? 0.4 : 30)));
  let g = Math.min(Math.max(MAKEUP_TARGET / Math.max(makeupEnv, 1e-6), 1), maxGain);
  const snr = makeupEnv / (3 * Math.max(makeupNoise, 1e-6));
  if (snr < 1) g = 1 + (g - 1) * snr * snr * snr * snr;
  makeupGain += (g - makeupGain)
    * (1 - Math.exp(-dt / (g < makeupGain ? 0.15 : 0.6)));
  return makeupGain;
}

/* level AGC + bass beat detection, shared by the live and cqt frame paths */
function trackEnergy(total, bass, now) {
  totalAgc = Math.max(totalAgc * 0.995, total, 1e-9);
  state.level += (Math.min(total / totalAgc * 1.1, 1) - state.level) * 0.12;

  bassAgc = Math.max(bassAgc * 0.995, bass, 1e-9);
  bassAvg += (bass - bassAvg) * 0.04;
  if (bass > bassAvg * 1.35 && bass > 0.2 * bassAgc && now - lastBeatAt > 0.24) {
    state.beat = 1;
    lastBeatAt = now;
  }
}

function liveFrame(ana, now) {
  const dt = Math.min(Math.max(now - ana.lastT, 0.001), 0.1);
  ana.lastT = now;
  ana.harm.getFloatFrequencyData(ana.harmData);
  ana.fast.getFloatFrequencyData(ana.fastData);
  angEnergy.fill(0); angR.fill(0); angG.fill(0); angB.fill(0); angRim.fill(0); angW.fill(0);
  chromaRaw.fill(0);

  let raw = 0;
  for (const b of ana.bands) raw += toMag(b.data, b.mag, b.i0, b.i1);
  const g = updateMakeup(raw, dt,
    state.mode === 'mic' ? MAKEUP_MAX_MIC : MAKEUP_MAX_FILE);
  if (g > 1.001) {
    for (const b of ana.bands) {
      for (let i = b.i0 - 1; i <= b.i1 + 1; i++) b.mag[i] *= g;
    }
  }
  if (dspActive()) dspApply(ana, dt);
  let total = foldBand(ana.bands[0]) + foldBand(ana.bands[1]);

  // bass for the beat detector comes off the short FFT, reading raw dB so the
  // DSP layers never starve the beat
  let bass = 0;
  const fastHz = ana.bands[1].hz;
  const bTop = Math.min(Math.floor(150 / fastHz), ana.fast.frequencyBinCount - 1);
  for (let i = 1; i <= bTop; i++) {
    const db = ana.fastData[i];
    if (db > -85) bass += Math.pow(10, db / 20);
  }

  trackEnergy(total, bass, now);
}

/* ------------------------------------------------------- chord detection */

// pitch-class names, index 0 = A (the wheel's 12 o'clock)
const NOTE_NAMES = ['A', 'A#', 'B', 'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#'];
export { NOTE_NAMES };

const QUALITIES = [
  { name: '',     ivs: [0, 4, 7] },
  { name: 'm',    ivs: [0, 3, 7] },
  { name: 'dim',  ivs: [0, 3, 6] },
  { name: 'aug',  ivs: [0, 4, 8] },
  { name: 'sus4', ivs: [0, 5, 7] },
  { name: 'sus2', ivs: [0, 2, 7] },
  { name: '7',    ivs: [0, 4, 7, 10] },
  { name: 'maj7', ivs: [0, 4, 7, 11] },
  { name: 'm7',   ivs: [0, 3, 7, 10] },
];

function detectChord() {
  let total = 0;
  for (let i = 0; i < 12; i++) total += chroma[i];
  chromaAgc = Math.max(chromaAgc * 0.995, total, 1e-6);
  if (total < 0.15 * chromaAgc || chromaAgc < 1e-3) return null;

  const c = new Array(12);
  for (let i = 0; i < 12; i++) c[i] = chroma[i] / total;

  let best = null, bestScore = 0;
  for (let root = 0; root < 12; root++) {
    for (const q of QUALITIES) {
      let inS = 0;
      for (let k = 0; k < q.ivs.length; k++) {
        inS += c[(root + q.ivs[k]) % 12] * (k === 0 ? 1.15 : 1);
      }
      const score = inS / Math.pow(q.ivs.length, 0.55);
      if (score > bestScore) { bestScore = score; best = { root, q }; }
    }
  }
  if (!best) return null;
  let frac = 0;
  for (const iv of best.q.ivs) frac += c[(best.root + iv) % 12];
  if (frac < 0.5) return null;   // too much energy outside the chord tones
  return {
    name: NOTE_NAMES[best.root] + best.q.name,
    root: best.root,
    pcs: best.q.ivs.map((iv) => (best.root + iv) % 12),
    conf: frac,
  };
}

let chordShown = null, candName = null, candAt = 0, shownConf = 1;

// chord state machine with hysteresis; no DOM here — the held chord and its
// live confidence ride out on the ChromaFrame for the host to render.
function updateChord(now) {
  const det = detectChord();
  const name = det ? det.name : null;
  if (name !== candName) { candName = name; candAt = now; }
  const shownName = chordShown ? chordShown.name : null;
  if (now - candAt > 0.25 && candName !== shownName) {  // hysteresis
    chordShown = det;
    if (det) shownConf = det.conf;
  }
  if (chordShown) {
    const live = (det && det.name === chordShown.name) ? det.conf : chordShown.conf;
    shownConf += (live - shownConf) * 0.1;
  }
}

/* ------------------------------------------------- analyser graph builder
   dual-resolution analyser pair, shared by mic and local modes */
function makeAnalysers(ctx, src) {
  const harm = ctx.createAnalyser();
  harm.fftSize = 16384;             // ~2.9 Hz bins: separates semitones down to ~G1
  harm.smoothingTimeConstant = 0.35;
  const fast = ctx.createAnalyser();
  fast.fftSize = 4096;              // ~85 ms window: highs and beats stay snappy
  fast.smoothingTimeConstant = 0.4;
  src.connect(harm);
  src.connect(fast);
  const rate = ctx.sampleRate;
  const mkBand = (a, data, lo, hi) => {
    const n = a.frequencyBinCount, hz = rate / 2 / n;
    return {
      data, hz,
      i0: Math.max(2, Math.ceil(lo / hz)),
      i1: Math.min(n - 2, Math.floor(hi / hz)),
      mag: new Float32Array(n),
      ema: new Float32Array(n),
      env: new Float32Array(n),
      phon: (() => {
        const w = new Float32Array(n);
        for (let i = 0; i < n; i++) w[i] = aWeightGain(Math.max(i * hz, 1));
        return w;
      })(),
    };
  };
  const harmData = new Float32Array(harm.frequencyBinCount);
  const fastData = new Float32Array(fast.frequencyBinCount);
  return {
    harm, fast, harmData, fastData, rate, lastT: 0,
    bands: [mkBand(harm, harmData, F_LO, SPLIT_HZ),
            mkBand(fast, fastData, SPLIT_HZ, F_HI)],
  };
}

/* --- mic mode: real audio via getUserMedia --- */
let micCtx = null, micAna = null, micStream = null;

async function enableMic() {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  micCtx = new (window.AudioContext || window.webkitAudioContext)();
  micAna = makeAnalysers(micCtx, micCtx.createMediaStreamSource(micStream));
}

function disableMic() {
  if (micStream) micStream.getTracks().forEach(t => t.stop());
  if (micCtx) micCtx.close();
  micCtx = micAna = micStream = null;
}

/* --- local mode: real audio files through an AnalyserNode --- */
let TRACKS = [];

async function loadTracks() {
  try {
    const resp = await fetch(basePath + 'tracks.json', { cache: 'no-cache' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const list = await resp.json();
    if (!Array.isArray(list)) throw new Error('manifest is not an array');
    TRACKS = list.filter((t) =>
      t && typeof t.name === 'string' && typeof t.file === 'string');
    TRACKS.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
    onTracksLoaded(TRACKS);
  } catch (err) {
    onMessage('> deck manifest unavailable: '
      + (err.message || err.name || err));
  }
}

let actx = null, localAna = null, localDelay = null, localOut = null;
let currentTrack = -1;

/* Output attenuation, applied AFTER the analyser tap (see ensureLocalGraph).
   A show follower plays the set purely to analyse it and must stay silent, so
   it sets this to 0 — element.muted / element.volume would starve the
   MediaElementSource in some browsers and kill the analysis with it. */
let outGainValue = 1;

// the visual pipeline trails the signal; delaying only the audible branch by
// this much lines the two up. The analysers keep tapping the undelayed source.
let syncDelaySec = 0.11;

function ensureLocalGraph() {
  if (actx) return;
  actx = new (window.AudioContext || window.webkitAudioContext)();
  const src = actx.createMediaElementSource(audioEl);
  localAna = makeAnalysers(actx, src);   // analysers tap the undelayed signal
  localDelay = actx.createDelay(0.5);
  localDelay.delayTime.value = syncDelaySec;
  localOut = actx.createGain();
  localOut.gain.value = outGainValue;
  src.connect(localDelay);
  localDelay.connect(localOut);
  localOut.connect(actx.destination);
}

function localPlaying() {
  return currentTrack >= 0 && !audioEl.paused && !audioEl.ended;
}

function playTrack(i) {
  if (!TRACKS[i]) return;
  ensureLocalGraph();
  if (actx.state === 'suspended') actx.resume();
  if (currentTrack !== i) {
    currentTrack = i;
    const t = TRACKS[i];
    if (t.url) {
      // ad-hoc local file (no CQT sidecar): drive the wheel from the live
      // analyser, and cancel any sidecar load still in flight for the old track
      if (vqtAbort) { vqtAbort.abort(); vqtAbort = null; }
      vqt = null; vqtState = 'none'; vqtSeq++;
      audioEl.src = t.url;
    } else {
      audioEl.src = basePath + 'audio/' + encodeURIComponent(t.file);
      loadVqt(i);
    }
  }
  audioEl.play();
  if (state.mode !== 'mic') state.mode = 'local';
  onStatusChange();
}

// add a user-picked audio file to the deck as a track carrying a blob URL,
// and return its index. No sidecar exists for it, so it plays via liveFrame.
function addLocalFile(file) {
  const url = URL.createObjectURL(file);
  const idx = TRACKS.push({ name: file.name, url }) - 1;
  onTracksLoaded(TRACKS);
  return idx;
}

// same, for a track the host already has a URL for (the show follower fetches
// the leader's wavs over the LAN). Idempotent: re-adding a known URL returns
// the existing index rather than growing the deck on every stage change.
function addTrackUrl(name, url) {
  const hit = TRACKS.findIndex((t) => t.url === url);
  if (hit >= 0) return hit;
  const idx = TRACKS.push({ name: name || url, url }) - 1;
  onTracksLoaded(TRACKS);
  return idx;
}

/* ------------------------------------------- precomputed CQT sidecars
   Local tracks have offline variable-Q spectrograms in
   <basePath>analysis/<stem>.vqt.gz. When a sidecar is loaded it drives the
   wheel instead of the live FFT, indexed by the audio clock, so the bass
   resolves as cleanly as the highs. The analyser graph keeps running
   underneath as the fallback. */
const VQT_CACHE_MAX = 3;
const VQT_VIS_LEAD = 0.03;

const vqtCache = new Map();
let vqt = null;
let vqtState = 'none';       // none | loading | ready | failed
let vqtSeq = 0;
let vqtAbort = null;
let vqtLastT = 0;

function parseWlq(u8) {
  if (u8.length < 8 || u8[0] !== 0x57 || u8[1] !== 0x4C
      || u8[2] !== 0x51 || u8[3] !== 0x31) throw new Error('bad magic');
  const hlen = u8[4] | (u8[5] << 8) | (u8[6] << 16) | (u8[7] << 24);
  const h = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + hlen)));
  const stride = h.bins + (h.extras ? h.extras.length : 0);
  const payload = u8.subarray(8 + hlen);
  if (h.v !== 1 || h.frames < 1 || payload.length < h.frames * stride) {
    throw new Error('bad header/payload');
  }
  return { h, payload, stride };
}

let foldTab = null, foldKey = '';

function buildFoldTab(h) {
  const key = [h.bins, h.bpo, h.fmin, h.gamma].join('/');
  if (foldTab && foldKey === key) return foldTab;
  const n = h.bins, alpha = Math.pow(2, 1 / h.bpo) - 1;
  const kStart = new Int32Array(n), kOff = new Int32Array(n), kLen = new Int32Array(n);
  const colR = new Float32Array(n), colG = new Float32Array(n), colB = new Float32Array(n);
  const rimRow = new Int32Array(n);
  const band = new Int32Array(n);
  const pcIdx = new Int32Array(n).fill(-1), pcW = new Float32Array(n);
  const phon = new Float32Array(n);
  const hOff = new Int32Array(13);
  for (let k = 2; k <= 12; k++) hOff[k] = Math.round(h.bpo * Math.log2(k));
  const w = [];
  let bassTop = 0;
  for (let i = 0; i < n; i++) {
    const f = h.fmin * Math.pow(2, i / h.bpo);
    if (f <= 150) bassTop = i;
    const o = Math.min(Math.max(Math.log2(f / F_LO) / OCT_SPAN, 0), 1);
    const li = regLutIndex(o);
    colR[i] = REG_LUT[li]; colG[i] = REG_LUT[li + 1]; colB[i] = REG_LUT[li + 2];
    rimRow[i] = Math.min(RIM_REGS - 1, (o * RIM_REGS) | 0) * ANG;
    band[i] = regBand(o);
    const lg = Math.log2(f / 440), frac = lg - Math.floor(lg);
    if (f < 2200) { pcIdx[i] = Math.round(frac * 12) % 12; pcW[i] = 1 - 0.35 * o; }
    phon[i] = Math.min(Math.max(aWeightGain(f), 0.06), 1.25);
    const bw = alpha * f + (h.gamma || 0);
    const sig = Math.max(0.9, Math.log2((f + bw) / f) * ANG * 0.5);
    const rad = Math.min(Math.ceil(sig * 2.5), 96);
    const x = frac * ANG, base = Math.round(x);
    const inv2s2 = 1 / (2 * sig * sig);
    const norm = 1 / (sig * 2.50662827);
    kOff[i] = w.length; kLen[i] = 2 * rad + 1;
    kStart[i] = ((base - rad) % ANG + ANG) % ANG;
    for (let d = -rad; d <= rad; d++) {
      const dd = base + d - x;
      w.push(Math.exp(-dd * dd * inv2s2) * norm);
    }
  }
  foldKey = key;
  foldTab = { kStart, kOff, kLen, kW: new Float32Array(w),
              colR, colG, colB, rimRow, band, pcIdx, pcW, phon, hOff, bassTop };
  return foldTab;
}

function prepareVqt(parsed) {
  const h = parsed.h;
  const lut = new Float32Array(256);
  for (let u = 1; u < 256; u++) lut[u] = Math.pow(10, (u / 255 - 1) * h.dbRange / 20);
  return {
    h, payload: parsed.payload, stride: parsed.stride,
    fps: h.fps || h.sr / h.hop, frames: h.frames, nBins: h.bins,
    bassIdx: h.extras ? h.extras.indexOf('bass') : -1,
    lut, tab: buildFoldTab(h),
    mag: new Float32Array(h.bins),
    ema: new Float32Array(h.bins),
    env: new Float32Array(h.bins),
  };
}

async function loadVqt(i) {
  const file = TRACKS[i].file;
  const seq = ++vqtSeq;
  if (vqtAbort) { vqtAbort.abort(); vqtAbort = null; }
  vqt = null;
  const cached = vqtCache.get(file);
  if (cached) {
    vqtCache.delete(file); vqtCache.set(file, cached);   // LRU bump
    vqt = cached; vqtState = 'ready';
    onStatusChange();
    return;
  }
  vqtState = 'loading';
  onStatusChange();
  try {
    vqtAbort = new AbortController();
    const url = basePath + 'analysis/'
      + encodeURIComponent(file.replace(/\.[^.]+$/, '')) + '.vqt.gz';
    const resp = await fetch(url, { signal: vqtAbort.signal });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const body = new Uint8Array(await resp.arrayBuffer());
    let raw = body;
    if (body[0] === 0x1f && body[1] === 0x8b) {   // still gzipped on the wire
      if (typeof DecompressionStream !== 'function') {
        throw new Error('DecompressionStream unsupported');
      }
      raw = new Uint8Array(await new Response(new Blob([body]).stream()
        .pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    }
    const prepared = prepareVqt(parseWlq(raw));
    if (seq !== vqtSeq) return;   // a newer track took over meanwhile
    vqtCache.set(file, prepared);
    while (vqtCache.size > VQT_CACHE_MAX) {
      vqtCache.delete(vqtCache.keys().next().value);
    }
    vqt = prepared;
    vqtState = 'ready';
    onMessage('> cqt loaded: ' + prepared.nBins + ' bins x '
      + prepared.frames + ' frames');
  } catch (err) {
    if (seq !== vqtSeq) return;
    vqtState = 'failed';
    onMessage('> cqt sidecar unavailable ('
      + (err.message || err.name || err) + '); using live analyser');
  }
  onStatusChange();
}

function smoothEnvLog(mag, env, n, w) {
  let acc = mag[0];
  for (let i = 0; i < n; i++) { acc += (mag[i] - acc) / w; env[i] = acc; }
  acc = env[n - 1];
  for (let i = n - 1; i >= 0; i--) { acc += (env[i] - acc) / w; env[i] = acc; }
}

function vqtSuppressOvertones(v, fmax) {
  const floor = fmax * 0.004;
  if (floor <= 0) return;
  const n = v.nBins, mag = v.mag, hOff = v.tab.hOff;
  let np = 0;
  for (let i = 1; i < n - 1 && np < PEAK_CAP; i++) {
    const m = mag[i];
    if (m > floor && m > mag[i - 1] && m >= mag[i + 1]) peakIdx[np++] = i;
  }
  const amt = dsp.overtone;
  const tol = Math.max(1.5, v.h.bpo * Math.log2(1.008));
  const r = Math.ceil(tol), inv = 1 / (2 * tol * tol);
  for (let p = 0; p < np; p++) {
    const i = peakIdx[p];
    const mf = mag[i];
    if (mf <= 0) continue;
    for (let k = 2; k <= 12; k++) {
      const ci = i + hOff[k];
      if (ci - r >= n) break;
      const cap = mf / Math.pow(k, 0.6);
      for (let d = -r; d <= r; d++) {
        const j = ci + d;
        if (j < 0 || j >= n) continue;
        const mh = mag[j];
        if (mh <= 0) continue;
        const conf = Math.min(cap / mh, 1);
        mag[j] = mh * (1 - amt * conf * Math.exp(-d * d * inv));
      }
    }
  }
}

function vqtDspApply(v, dt) {
  const n = v.nBins, mag = v.mag, ema = v.ema, env = v.env;
  const bpo = v.h.bpo;

  const emaK = 1 - Math.exp(-dt / 0.3);
  for (let i = 0; i < n; i++) {
    const m = mag[i], e = ema[i];
    if (dsp.drums > 0 && m > e * 1.8) {
      mag[i] = m * Math.pow((e * 1.8 + 1e-12) / m, dsp.drums);
    }
    ema[i] = e + (m - e) * emaK;
  }

  if (dsp.phon > 0) {
    const ph = v.tab.phon;
    for (let i = 0; i < n; i++) mag[i] *= Math.pow(ph[i], dsp.phon);
  }

  let fmax = 0;
  for (let i = 0; i < n; i++) if (mag[i] > fmax) fmax = mag[i];

  if (dsp.gate > 0 && fmax > 0) {
    const thr = fmax * Math.pow(10, (-72 + 40 * dsp.gate) / 20);
    const t2 = thr * thr;
    for (let i = 0; i < n; i++) {
      const m2 = mag[i] * mag[i];
      mag[i] *= m2 / (m2 + t2);
    }
  }

  if (dsp.whiten > 0) {
    smoothEnvLog(mag, env, n, bpo * 0.5);
    let ref = 0;
    for (let i = 0; i < n; i++) ref += env[i];
    ref = ref / n + 1e-12;
    for (let i = 0; i < n; i++) {
      mag[i] *= Math.min(Math.pow(ref / (env[i] + 0.05 * ref), dsp.whiten), 6);
    }
  }

  if (dsp.overtone > 0) vqtSuppressOvertones(v, fmax);

  if (dsp.focus > 0) {
    smoothEnvLog(mag, env, n, Math.max(bpo * 0.085, 4));
    for (let i = 0; i < n; i++) {
      if (env[i] <= 0) continue;
      mag[i] *= Math.min(Math.pow(mag[i] / env[i], dsp.focus * 1.5), 4);
    }
  }
}

function vqtFrame(v, now) {
  const dt = Math.min(Math.max(now - vqtLastT, 0.001), 0.1);
  vqtLastT = now;
  angEnergy.fill(0); angR.fill(0); angG.fill(0); angB.fill(0); angRim.fill(0); angW.fill(0);
  chromaRaw.fill(0);

  let total = 0, bass = 0;
  if (localPlaying()) {
    const t = Math.max(audioEl.currentTime - syncDelaySec + VQT_VIS_LEAD, 0);
    const p = Math.min(Math.max(t * v.fps, 0), v.frames - 1);
    const f0 = p | 0, fr = p - f0;
    const r0 = f0 * v.stride;
    const r1 = Math.min(f0 + 1, v.frames - 1) * v.stride;
    const payload = v.payload, lut = v.lut, mag = v.mag, n = v.nBins;
    let raw = 0;
    for (let i = 0; i < n; i++) {
      const m = lut[payload[r0 + i]] * (1 - fr) + lut[payload[r1 + i]] * fr;
      mag[i] = m;
      raw += m;
    }
    if (v.bassIdx >= 0) {
      bass = lut[payload[r0 + n + v.bassIdx]] * (1 - fr)
           + lut[payload[r1 + n + v.bassIdx]] * fr;
    } else {
      for (let i = 0; i <= v.tab.bassTop; i++) bass += mag[i];
    }

    const g = updateMakeup(raw, dt, MAKEUP_MAX_FILE);
    if (g > 1.001) for (let i = 0; i < n; i++) mag[i] *= g;

    if (dspActive()) vqtDspApply(v, dt);

    const tab = v.tab, kW = tab.kW;
    const mask = ANG - 1;
    for (let i = 0; i < n; i++) {
      const m = mag[i];
      if (m <= 0) continue;
      total += m;
      const cm = Math.pow(m, REG_GAMMA);
      const cr = tab.colR[i], cg = tab.colG[i], cb = tab.colB[i];
      const rr = tab.rimRow[i];
      const ro = tab.band[i] * ANG;
      const off = tab.kOff[i], len = tab.kLen[i], s = tab.kStart[i];
      for (let j = 0; j < len; j++) {
        const ai = (s + j) & mask;
        const a = ai + ro;
        const g = kW[off + j];
        angEnergy[a] += m * g;
        angRim[rr + ai] += m * g;
        const cw = cm * g;
        angR[a] += cw * cr; angG[a] += cw * cg; angB[a] += cw * cb;
        angW[a] += cw;
      }
      if (tab.pcIdx[i] >= 0 && m > 3.2e-4
          && (i === 0 || m > mag[i - 1]) && (i === n - 1 || m >= mag[i + 1])) {
        chromaRaw[tab.pcIdx[i]] += Math.sqrt(m) * tab.pcW[i];
      }
    }
  }
  trackEnergy(total, bass, now);
}

/* --- idle shimmer: a slow synthetic drift when nothing real is playing --- */
const SIM_SIG = ANG / 170;
const SIM_RAD = Math.ceil(SIM_SIG * 3.3);
const SIM_INV2S2 = 1 / (2 * SIM_SIG * SIM_SIG);

function addSimNote(pc, oct01, amp) {
  if (amp <= 0) return;
  const c = (((pc % 12) + 12) % 12) / 12 * ANG;
  const base = Math.round(c);
  const li = regLutIndex(oct01);
  const cr = REG_LUT[li], cg = REG_LUT[li + 1], cb = REG_LUT[li + 2];
  const ro = regBand(oct01) * ANG;
  const rr = Math.min(RIM_REGS - 1, (oct01 * RIM_REGS) | 0) * ANG;
  const camp = Math.pow(amp, REG_GAMMA);
  for (let d = -SIM_RAD; d <= SIM_RAD; d++) {
    const ai = ((base + d) % ANG + ANG) % ANG;
    const a = ai + ro;
    const dd = base + d - c;
    const g = Math.exp(-dd * dd * SIM_INV2S2);
    angEnergy[a] += amp * g;
    angRim[rr + ai] += amp * g;
    const cw = camp * g;
    angR[a] += cw * cr; angG[a] += cw * cg; angB[a] += cw * cb;
    angW[a] += cw;
  }
}

function simFrame(t) {
  angEnergy.fill(0); angR.fill(0); angG.fill(0); angB.fill(0); angRim.fill(0); angW.fill(0);
  chromaRaw.fill(0);

  for (let k = 0; k < 3; k++) {
    addSimNote((t * 0.6 + k * 4) % 12, 0.37 + 0.13 * k,
      0.06 + 0.04 * Math.sin(t * 0.7 + k * 2.1));
  }
  state.level += (0.08 - state.level) * 0.1;
}

/* ------------------------------------------- AGC + display smoothing
   Turns the per-frame fold accumulators into the smoothed, normalized display
   field a ChromaFrame carries. This is the last engine stage before pixels:
   the per-angle percentile AGC normalizes loudness, a soft knee maps energy
   into 0..E_MAX, the kneed total is split back across register bands, and
   attack/release smoothing + the chord detector run. */
function finishFrame(now, dt) {
  for (let a = 0; a < ANG; a++) {
    angTot[a] = angEnergy[a] + angEnergy[a + ANG]
              + angEnergy[a + 2 * ANG] + angEnergy[a + 3 * ANG];
  }
  agcScratch.set(angTot);
  agcScratch.sort();
  const stat = Math.max(agcScratch[(ANG * 0.85) | 0], agcScratch[ANG - 1] * 0.2);
  angRef += (stat - angRef) * (1 - Math.exp(-dt / (stat > angRef ? 0.25 : 4.0)));
  if (angRef < 2e-4) angRef = 2e-4;   // gate so silence isn't boosted to noise
  for (let a = 0; a < ANG; a++) {
    const x = angTot[a] / angRef;
    const e = E_MAX * x / (x + 1.5);
    const shareK = angTot[a] > 1e-12 ? e / angTot[a] : 0;
    for (let jr = 0; jr < NREG; jr++) {
      const i = jr * ANG + a;
      const eb = angEnergy[i] * shareK;
      dispE[i] += (eb - dispE[i]) * (eb > dispE[i] ? 0.5 : 0.16);
      if (angW[i] > 1e-9) {
        const inv = 1 / angW[i];
        dispR[i] += (angR[i] * inv - dispR[i]) * 0.3;
        dispG[i] += (angG[i] * inv - dispG[i]) * 0.3;
        dispB[i] += (angB[i] * inv - dispB[i]) * 0.3;
      }
    }
  }
  for (let i = 0; i < 12; i++) chroma[i] += (chromaRaw[i] - chroma[i]) * 0.07;
  updateChord(now);

  // rim register histogram: same attack/release as the band energies (only
  // per-angle ratios matter here). A visualizer inverts this into whatever
  // per-angle register stack it wants.
  for (let i = 0; i < RIM_REGS * ANG; i++) {
    dispRim[i] += (angRim[i] - dispRim[i]) * (angRim[i] > dispRim[i] ? 0.5 : 0.16);
  }
}

/* ============================================================ public API */

export class AnalysisEngine {
  /* opts:
       audioEl         <audio> element for local playback (required for the deck)
       basePath        where tracks.json / audio/ / analysis/ live ('waveloop/')
       onMessage(text) status-line text callback
       onTracksLoaded(tracks)  manifest loaded; host renders the deck
       onStatusChange()        mode / current track / cqt readiness changed   */
  constructor(opts = {}) {
    audioEl = opts.audioEl || null;
    if (opts.basePath != null) basePath = opts.basePath;
    onMessage = opts.onMessage || (() => {});
    onTracksLoaded = opts.onTracksLoaded || (() => {});
    onStatusChange = opts.onStatusChange || (() => {});

    this._lastNow = 0;
    // the reused frame object: fields point at the engine's live buffers, so
    // a visualizer reads them in-place (zero allocation per frame). Treat the
    // arrays as read-only and consume them before the next update().
    this._frame = {
      ang: ANG, nreg: NREG, rimRegs: RIM_REGS,
      fLo: F_LO, fHi: F_HI, octSpan: OCT_SPAN, eMax: E_MAX,
      energy: dispE, r: dispR, g: dispG, b: dispB, rim: dispRim,
      chroma,
      chord: null, chordConf: 1,
      level: 0, beat: 0, mode: 'sim',
    };
  }

  /* Advance the analysis by one frame and return the ChromaFrame. `nowSec` is
     a monotonically increasing clock in seconds (e.g. performance.now()/1000). */
  update(nowSec) {
    const dt = this._lastNow ? Math.min(nowSec - this._lastNow, 0.1) : 0.016;
    this._lastNow = nowSec;

    if (state.mode === 'mic' && micAna) {
      liveFrame(micAna, nowSec);
    } else if (state.mode === 'local' && vqtState === 'ready' && vqt) {
      vqtFrame(vqt, nowSec);
    } else if (state.mode === 'local' && localAna) {
      liveFrame(localAna, nowSec);
    } else {
      simFrame(nowSec);
    }
    state.beat = Math.max(0, state.beat - dt * 3.2);

    finishFrame(nowSec, dt);

    const f = this._frame;
    f.chord = chordShown;
    f.chordConf = shownConf;
    f.level = state.level;
    f.beat = state.beat;
    f.mode = state.mode;
    return f;
  }

  /* --- sources --- */
  async enableMic() {
    await enableMic();
    state.mode = 'mic';
    onStatusChange();
  }
  disableMic() {
    disableMic();
    state.mode = currentTrack >= 0 ? 'local' : 'sim';
    onStatusChange();
  }

  /* --- deck --- */
  loadTracks() { return loadTracks(); }
  playTrack(i) { playTrack(i); }
  addLocalFile(file) { return addLocalFile(file); }   // user-picked file -> deck index
  addTrackUrl(name, url) { return addTrackUrl(name, url); }
  pause() { if (audioEl) audioEl.pause(); }
  get tracks() { return TRACKS; }
  get currentTrack() { return currentTrack; }
  isPlaying() { return localPlaying(); }
  notePlayStateChange() { onStatusChange(); }   // host calls after audio events

  /* --- tuning --- */
  get mode() { return state.mode; }
  get dsp() { return dsp; }
  get presets() { return DSP_PRESETS; }
  setDsp(key, value) { dsp[key] = value; }
  setDspPreset(name) { Object.assign(dsp, DSP_PRESETS[name]); }
  setSyncDelay(sec) {
    syncDelaySec = sec;
    if (localDelay) localDelay.delayTime.value = sec;
  }
  get syncDelay() { return syncDelaySec; }
  /* Attenuate the AUDIBLE branch only — the analysers tap ahead of it, so a
     gain of 0 leaves every frame field live on a silent machine. */
  setOutputGain(g) {
    outGainValue = Math.max(0, Number(g) || 0);
    if (localOut) localOut.gain.value = outGainValue;
  }
  get outputGain() { return outGainValue; }
}

/* ----------------------------------------------------------------------------
   ChromaFrame — the contract between engine and visualizer
   ----------------------------------------------------------------------------
   {
     ang      256   angular bins (pitch classes), index 0 = A at 12 o'clock
     nreg     4     register bands stacked low -> high
     rimRegs  48    fine register histogram bins
     fLo,fHi        audible band edges (Hz)
     octSpan        log2(fHi/fLo), ~9.97
     eMax     2.0   ceiling of the `energy` values

     energy   Float32Array(nreg*ang)  smoothed, AGC-normalized energy per band
                                       per angle. Index = band*ang + angle.
                                       0..eMax (loud fundamentals overshoot 1).
     r,g,b    Float32Array(nreg*ang)  register color per band/angle, 0..1.
     rim      Float32Array(rimRegs*ang) smoothed register histogram, register-
                                       major: index = reg*ang + angle. Invert per
                                       angle for a continuous register stack.
     chroma   Float32Array(12)        smoothed 12-bin chroma, index 0 = A.
     chord    {name,root,pcs,conf}|null  detected chord (hysteresis applied).
     chordConf  number               live confidence of the held chord, 0..1.
     level    number                 smoothed overall loudness, 0..1.
     beat     number                 beat pulse envelope, 0..1.
     mode     'sim' | 'local' | 'mic'
   }
   The typed arrays are the engine's live buffers — read them within the frame;
   they are overwritten on the next update().
   ------------------------------------------------------------------------- */
