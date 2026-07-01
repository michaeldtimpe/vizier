/* vizier — grid visualizer
   ============================================================================
   A visualization written against the ChromaFrame contract (see
   vizier-analysis.js), rendered with Canvas2D + a tiny software 3D pipeline.

   A slowly rotating square of gap-separated cubes, driven as an EQ / spectral
   surface. Two arrangements, cross-faded by the EQ-slide FX:
     - default: rows = register (BASS front -> TREBLE back), columns sweep the
       pitch classes; a note lights its column across the octaves it occupies.
     - EQ slide: the whole log-frequency spectrum is unwrapped row-by-row across
       the grid, so each row is a contiguous slice of the spectrum (low front ->
       high back) and walking cell-by-cell walks up the spectrum.
   Cube hue tracks the current key; taller cubes read brighter.

   FX layers (independent toggles): Pulse (beat-driven brightness/hue/height),
   Sweep (a light band travelling across the frequency axis), Slide (the
   arrangement morph above), Fog (drifting tinted haze).

   Performance: cubes form a heightfield, so draw order is a per-column
   back-to-front traversal (sort GRID_N^2 columns, not every face) with
   bottom-to-top within a column and back-face culling - no per-frame face pool,
   no global face sort, no allocations in the hot path.
   ========================================================================== */

'use strict';

import { SPEC } from './vizier-analysis.js';

const { ANG, RIM_REGS, F_LO, OCT_SPAN } = SPEC;
const TWO_PI = Math.PI * 2;

/* ----------------------------------------------------------- tunables */
const GRID_N    = 16;
const MAX_STACK = 9;
const CUBE      = 0.58;
const PITCH     = 1.0;
const TILT      = 0.62;
const ROT_SPEED = 0.13;
const FILL_FRAC = 0.46;
const CY_FRAC   = 0.64;
const NB        = 44;
const L_MIN = 0.04, L_MAX = 0.94;
const DPR_CAP   = 1.5;       // grid is flat-shaded; a lighter DPR buys fill-rate

// FX tunables
const PULSE_HZ    = 1.6;     // continuous throb rate under the beat pulse
const SWEEP_WAVES = 1.5;     // bands across the frequency axis
const SWEEP_SPEED = 2.2;     // sweep travel speed
const FOG_BLOBS   = 6;

const LIGHT = (() => {
  const v = [-0.4, 0.78, -0.5];
  const m = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / m, v[1] / m, v[2] / m];
})();
const AMBIENT = 0.34;

const CS = [
  [-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1],
  [-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1],
];
const FACE_IDX = [
  [4, 5, 6, 7], [0, 3, 2, 1], [1, 2, 6, 5], [0, 4, 7, 3], [3, 7, 6, 2], [0, 1, 5, 4],
];
const FACE_N = [
  [0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
];

function hsl(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h * 12) % 12;
    return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255);
  };
  return [f(0), f(8), f(4)];
}

export class GridVisualizer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    const CELLS = GRID_N * GRID_N;
    this.cellRawA = new Float32Array(CELLS);   // pitch x register field
    this.cellRawB = new Float32Array(CELLS);   // spectrum-unwrapped field
    this.cellDisp = new Float32Array(CELLS);   // smoothed, morphed heights 0..1
    this.cellCnt = new Float32Array(CELLS);
    this.cellWx = new Float32Array(CELLS);
    this.cellWz = new Float32Array(CELLS);
    this.keyArr = new Float32Array(CELLS);
    this.order = new Array(CELLS);
    this.agcA = 1e-3; this.agcB = 1e-3;
    this.hue = 0;
    this.guides = true;
    this.fx = { pulse: false, sweep: false, slide: false, fog: false };
    this.slideAmt = 0;      // eased 0..1 toward fx.slide
    this.pulseEnv = 0;      // beat pulse envelope

    // --- arrangement A mapping: rim (angle,register) -> grid cell
    this.giOf = new Int16Array(ANG);
    this.gjOf = new Int16Array(RIM_REGS);
    for (let a = 0; a < ANG; a++) this.giOf[a] = Math.min(GRID_N - 1, (a / ANG * GRID_N) | 0);
    for (let r = 0; r < RIM_REGS; r++) this.gjOf[r] = Math.min(GRID_N - 1, (r / RIM_REGS * GRID_N) | 0);
    for (let r = 0; r < RIM_REGS; r++) {
      for (let a = 0; a < ANG; a++) this.cellCnt[this.giOf[a] * GRID_N + this.gjOf[r]]++;
    }

    // --- arrangement B: unwrap a log-frequency spectrum across the grid.
    // spectrum bin i -> a rim (register,pitch) cell, and -> a grid cell
    // (row-major so row gj = a contiguous slice of the spectrum).
    const M = CELLS;
    this.specRim = new Int32Array(M);
    this.specCell = new Int32Array(M);
    for (let i = 0; i < M; i++) {
      const o = M > 1 ? i / (M - 1) : 0;                 // 0..1 == log-freq
      const f = F_LO * Math.pow(2, o * OCT_SPAN);
      const regbin = Math.min(RIM_REGS - 1, (o * RIM_REGS) | 0);
      const lg = Math.log2(f / 440), frac = lg - Math.floor(lg);
      const ang = Math.min(ANG - 1, (frac * ANG) | 0);
      this.specRim[i] = regbin * ANG + ang;
      const gj = (i / GRID_N) | 0, gi = i % GRID_N;
      this.specCell[i] = gi * GRID_N + gj;
    }

    // precompute per-cell world position + draw order seed
    const half = (GRID_N - 1) / 2;
    for (let gi = 0; gi < GRID_N; gi++) {
      for (let gj = 0; gj < GRID_N; gj++) {
        const cell = gi * GRID_N + gj;
        this.cellWx[cell] = (gi - half) * PITCH;
        this.cellWz[cell] = (gj - half) * PITCH;
        this.order[cell] = cell;
      }
    }

    this.palette = new Array(NB);
    this._sxc = new Float64Array(8);
    this._syc = new Float64Array(8);
    this._rzc = new Float64Array(8);

    this.cw = 0; this.ch = 0; this.cx = 0; this.cy = 0; this.scale = 1;
    this.resize();
  }

  setGuides(on) { this.guides = !!on; }
  getGuides() { return this.guides; }
  toggleFx(name) { if (name in this.fx) this.fx[name] = !this.fx[name]; return this.fx[name]; }
  getFx(name) { return !!this.fx[name]; }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    const w = innerWidth, h = innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cw = w; this.ch = h;
    this.cx = w / 2;
    this.cy = h * CY_FRAC;
    const halfDiag = ((GRID_N - 1) * PITCH * Math.SQRT2 + CUBE) * 0.5;
    this.scale = Math.min(w, h) * FILL_FRAC / halfDiag;
  }

  _updateHue(frame, dt) {
    let root;
    if (frame.chord) {
      root = frame.chord.root;
    } else {
      const c = frame.chroma;
      root = 0; let m = c[0];
      for (let i = 1; i < 12; i++) if (c[i] > m) { m = c[i]; root = i; }
    }
    const target = root / 12;
    const d = ((target - this.hue + 1.5) % 1) - 0.5;
    this.hue = (this.hue + d * (1 - Math.exp(-dt / 0.22)) + 1) % 1;
  }

  _buildField(frame, dt) {
    const rim = frame.rim, rawA = this.cellRawA, rawB = this.cellRawB;
    const giOf = this.giOf, gjOf = this.gjOf;

    // A: pitch x register
    rawA.fill(0);
    for (let r = 0; r < RIM_REGS; r++) {
      const rowGj = gjOf[r], base = r * ANG;
      for (let a = 0; a < ANG; a++) rawA[giOf[a] * GRID_N + rowGj] += rim[base + a];
    }
    let maxA = 1e-6;
    for (let i = 0; i < rawA.length; i++) {
      const m = rawA[i] / this.cellCnt[i];
      rawA[i] = m;
      if (m > maxA) maxA = m;
    }
    this.agcA = Math.max(this.agcA * (1 - dt * 0.45), maxA, 1e-6);

    // B: spectrum unwrapped row-major
    let maxB = 1e-6;
    for (let i = 0; i < this.specRim.length; i++) {
      const v = rim[this.specRim[i]];
      rawB[this.specCell[i]] = v;
      if (v > maxB) maxB = v;
    }
    this.agcB = Math.max(this.agcB * (1 - dt * 0.45), maxB, 1e-6);

    // ease the arrangement morph
    const slideTarget = this.fx.slide ? 1 : 0;
    this.slideAmt += (slideTarget - this.slideAmt) * (1 - Math.exp(-dt / 0.5));

    const invA = 1 / this.agcA, invB = 1 / this.agcB, s = this.slideAmt;
    const disp = this.cellDisp;
    for (let i = 0; i < disp.length; i++) {
      const nA = Math.min(rawA[i] * invA, 1);
      const nB = Math.min(rawB[i] * invB, 1);
      const target = nA + (nB - nA) * s;
      const tau = target > disp[i] ? 0.05 : 0.26;
      disp[i] += (target - disp[i]) * (1 - Math.exp(-dt / tau));
    }
  }

  render(frame, now, dt) {
    const ctx = this.ctx;
    this._updateHue(frame, dt);
    this._buildField(frame, dt);

    // beat pulse envelope
    this.pulseEnv = Math.max(this.pulseEnv - dt * 2.5, 0);
    if (frame.beat > this.pulseEnv) this.pulseEnv = frame.beat;

    ctx.fillStyle = '#04070a';
    ctx.fillRect(0, 0, this.cw, this.ch);

    if (this.fx.fog) this._drawFog(now, frame, 0.55);   // dim haze behind cubes

    const a = now * ROT_SPEED;
    const ca = Math.cos(a), sa = Math.sin(a);
    const ct = Math.cos(TILT), st = Math.sin(TILT);
    const scale = this.scale, cx = this.cx, cy = this.cy;
    const Lx = LIGHT[0], Ly = LIGHT[1], Lz = LIGHT[2];

    // rotated normals + visibility + shading, once per frame (shared by cubes)
    const nVis = [], nLit = [], visFaces = [];
    for (let f = 0; f < 6; f++) {
      const n = FACE_N[f];
      const nx1 = n[0] * ca + n[2] * sa;
      const nz1 = -n[0] * sa + n[2] * ca;
      const ny2 = n[1] * ct + nz1 * st;
      const nz2 = -n[1] * st + nz1 * ct;
      nVis[f] = nz2 < 0;
      nLit[f] = AMBIENT + (1 - AMBIENT) * Math.max(0, nx1 * Lx + ny2 * Ly + nz2 * Lz);
      if (nVis[f]) visFaces.push(f);
    }

    // FX-driven globals
    const pulseOn = this.fx.pulse ? 1 : 0;
    const throb = 0.5 + 0.5 * Math.sin(now * PULSE_HZ * TWO_PI);
    const levelLift = (0.85 + 0.3 * frame.level + 0.25 * frame.beat)
      * (1 + pulseOn * (0.5 * this.pulseEnv + 0.07 * throb));
    const vBump = 1 + pulseOn * 0.07 * this.pulseEnv;    // beat height bump
    const hueOff = pulseOn * 0.10 * this.pulseEnv;        // beat hue nudge
    const sat = 0.55 + 0.12 * Math.min(frame.level * 2, 1);
    const sweepOn = this.fx.sweep;

    // per-frame palette (hue includes the pulse nudge)
    const pal = this.palette, effHue = (this.hue + hueOff) % 1;
    for (let i = 0; i < NB; i++) {
      const c = hsl(effHue, sat, L_MIN + (L_MAX - L_MIN) * i / (NB - 1));
      pal[i] = 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
    }
    const lScale = (NB - 1) / (L_MAX - L_MIN);

    // back-to-front column order (heightfield painter's algorithm)
    const order = this.order, keyArr = this.keyArr;
    for (let cell = 0; cell < keyArr.length; cell++) {
      keyArr[cell] = -this.cellWx[cell] * sa + this.cellWz[cell] * ca;
    }
    order.sort((p, q) => keyArr[q] - keyArr[p]);

    const disp = this.cellDisp, hs = CUBE / 2;
    const sxc = this._sxc, syc = this._syc, rzc = this._rzc;

    for (let oi = 0; oi < order.length; oi++) {
      const cell = order[oi];
      const nstk = 1 + Math.round(disp[cell] * (MAX_STACK - 1));
      const wx = this.cellWx[cell], wz = this.cellWz[cell];
      const gj = cell % GRID_N;

      let sweepMul = 1;
      if (sweepOn) {
        const w = 0.5 + 0.5 * Math.sin(gj / GRID_N * TWO_PI * SWEEP_WAVES - now * SWEEP_SPEED);
        sweepMul = 0.55 + 0.7 * w;
      }

      for (let k = 0; k < nstk; k++) {
        const cyW = hs + k * PITCH;
        for (let c = 0; c < 8; c++) {
          const s = CS[c];
          const X = wx + s[0] * hs;
          const Y = (cyW + s[1] * hs) * vBump;
          const Z = wz + s[2] * hs;
          const x1 = X * ca + Z * sa;
          const z1 = -X * sa + Z * ca;
          const y2 = Y * ct + z1 * st;
          sxc[c] = cx + x1 * scale;
          syc[c] = cy - y2 * scale;
          rzc[c] = -Y * st + z1 * ct;
        }
        const heightT = (MAX_STACK > 1) ? k / (MAX_STACK - 1) : 0;
        const baseL = (0.14 + 0.52 * heightT) * levelLift * sweepMul;

        for (let vf = 0; vf < visFaces.length; vf++) {
          const f = visFaces[vf], id = FACE_IDX[f];
          let L = baseL * (0.42 + 0.58 * nLit[f]);
          if (L < L_MIN) L = L_MIN; else if (L > L_MAX) L = L_MAX;
          let ci = ((L - L_MIN) * lScale + 0.5) | 0;
          if (ci < 0) ci = 0; else if (ci >= NB) ci = NB - 1;
          ctx.fillStyle = pal[ci];
          ctx.beginPath();
          ctx.moveTo(sxc[id[0]], syc[id[0]]);
          ctx.lineTo(sxc[id[1]], syc[id[1]]);
          ctx.lineTo(sxc[id[2]], syc[id[2]]);
          ctx.lineTo(sxc[id[3]], syc[id[3]]);
          ctx.closePath();
          ctx.fill();
        }
      }
    }

    if (this.fx.fog) this._drawFog(now, frame, 0.4, true);   // faint glow in front
    if (this.guides) this._drawLabels(ca, sa, ct, st);
  }

  _drawFog(now, frame, strength, front) {
    const ctx = this.ctx, w = this.cw, h = this.ch;
    const c = hsl(this.hue, 0.7, 0.55);
    const base = (front ? 0.05 : 0.09) * strength * (0.5 + frame.level + 0.4 * this.pulseEnv);
    const R = Math.min(w, h) * (front ? 0.34 : 0.5);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < FOG_BLOBS; i++) {
      const ph = i * 1.7;
      // swirl: circular drift with a second harmonic so it churns
      const x = this.cx + Math.cos(now * 0.13 + ph) * w * 0.28
              + Math.sin(now * 0.07 + ph * 2) * w * 0.12;
      const y = this.cy - h * 0.12 + Math.sin(now * 0.11 + ph) * h * 0.2
              + Math.cos(now * 0.05 + ph * 1.5) * h * 0.08;
      const a = base * (0.6 + 0.4 * Math.sin(now * 0.5 + ph * 3));
      const g = ctx.createRadialGradient(x, y, 0, x, y, R);
      g.addColorStop(0, 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a.toFixed(3) + ')');
      g.addColorStop(1, 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.restore();
  }

  _drawLabels(ca, sa, ct, st) {
    const ctx = this.ctx, scale = this.scale, cx = this.cx, cy = this.cy;
    const half = (GRID_N - 1) / 2;
    ctx.font = '600 12px "IBM Plex Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const marks = [{ label: 'BASS', gj: 0 }, { label: 'TREBLE', gj: GRID_N - 1 }];
    for (const m of marks) {
      const wz = (m.gj - half) * PITCH, wy = -0.4;
      const x1 = wz * sa;             // wx = 0 at the axis midline
      const z1 = wz * ca;
      const y2 = wy * ct + z1 * st;
      ctx.fillStyle = 'rgba(70,255,200,0.5)';
      ctx.fillText(m.label, cx + x1 * scale, cy - y2 * scale);
    }
  }
}
