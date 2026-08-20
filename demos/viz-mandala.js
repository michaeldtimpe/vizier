/* vizier demo — MANDALA
   ============================================================================
   A real kaleidoscope: the PLANE is folded, not a set of stamped shapes.

   The screen is taken to conformal log-polar coordinates — (wedge angle,
   log radius) — which is the natural space of a kaleidoscope tube: a straight
   drift along the log-radius axis reads as the whole pattern flowing endlessly
   inward, with no seam and no repeat. In that space we mirror the angle into
   N wedges and lay down a domain-warped fbm, its contour lace, concentric
   ring strokes and radial spokes. Every element runs off the wedge edges, so
   the mirrored copies join across the seams into figures no single wedge
   contains — that interlock is the whole trick.

   Fold count comes from the chord and morphs by cross-dissolving two
   symmetries (a uniform branch, so the second sample only costs anything while
   a change is actually in flight). The centre is a dark anchor with a thin
   iris; light lives out in the folds.

   audio map
     chord quality   -> fold count (aug 3, sus 5, maj 6, dom7 7, min 8,
                        dim 10, none 12), cross-dissolved, never popping
     chord root      -> palette phase; one narrow hue band rotates with harmony
     dominant pitch  -> sign and rate of the rotational drift
     register bands  -> which radii light up (bass outside, treble in), the
                        register ramp tinting the ring strokes
     level           -> exposure, flow speed, warp depth
     beat            -> zoom pump + a wave travelling outward through the folds
   ========================================================================== */

'use strict';

import {
  getGL, makeProgram, makeQuad, bindQuad, uniforms, fitCanvas, canvasMessage,
  bandLevels, chromaAngle, regColorInto,
  QUAD_VERT, GLSL_NOISE,
} from './gl-util.js';

const FRAG = `
precision highp float;
uniform vec2  u_res;
uniform float u_time;
uniform float u_level;
uniform float u_beat;
uniform float u_rot;      // accumulated rotation (radians, wrapped)
uniform float u_flow;     // accumulated travel along the log-radius axis
uniform float u_n0;       // lower fold count
uniform float u_nmix;     // 0..1 cross-dissolve toward u_n0 + 1
uniform float u_hue;      // palette phase from the chord root
uniform float u_warp;     // domain-warp depth, from mid energy
uniform float u_detail;   // lace frequency, from high energy
uniform float u_wave;     // beat wave position, in log-radius
uniform float u_wamp;     // beat wave amplitude
uniform float u_conf;     // chord confidence
uniform vec3  u_tint;     // register accent colour
uniform float u_band[4];
${GLSL_NOISE}

/* Three cheap octaves — plenty for the warp and the lighting mask, and the
   two of them are half this shader's noise budget. */
float fbm3(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += a * vnoise(p);
    p = p * 2.02 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return v * 1.107;
}

vec3 hue3(float h) { return 0.5 + 0.5 * cos(TAU * (h + vec3(0.0, 0.33, 0.67))); }

/* One hue family, slid by the chord root. t is a VALUE axis — deep saturated
   shadow up to a hot, slightly desaturated highlight — and hs offsets the hue
   by at most a few percent of the circle, so the whole picture stays analogous
   instead of sweeping a rainbow. */
vec3 pal(float t, float hs) {
  float h = u_hue + hs;
  vec3 lo = hue3(h) * 0.26;
  vec3 hi = mix(hue3(h + 0.05), vec3(1.0), 0.30);
  return mix(lo, hi, clamp(t, 0.0, 1.0));
}

vec3 sat(vec3 c, float k) { return max(mix(vec3(dot(c, vec3(0.333))), c, k), 0.0); }

/* Smooth read of the four register bands across a 0..1 axis. */
float bandAt(float x) {
  float p = clamp(x, 0.0, 1.0) * 3.0;
  float s = 0.0, w = 0.0;
  for (int i = 0; i < 4; i++) {
    float d = float(i) - p;
    float k = exp(-d * d * 1.7);
    s += u_band[i] * k; w += k;
  }
  return s / w;
}

/* The kaleidoscope itself. Returns unlit-by-radius pattern colour; everything
   that depends on radius alone is applied once, in main(), after the mix. */
vec3 kaleido(vec2 uv, float n, float lr, float fw) {
  float a = atan(uv.x, uv.y) + u_rot;

  // ---- N-fold mirror of the plane ----
  float sect = TAU / max(n, 2.0);
  float fa = mod(a + 32.0 * TAU, sect);
  fa = abs(fa - 0.5 * sect);                  // 0 .. sect/2, mirrored

  // ---- conformal log-polar field coordinate; u_flow is the tube travel ----
  vec2 p = vec2(fa, lr) * 4.4;
  p.y += u_flow;

  // ---- domain warp: this is what makes the mirrored copies interfere ----
  vec2 w = vec2(fbm3(p * 0.50 + vec2(0.0, u_time * 0.021)),
                fbm3(p * 0.50 + vec2(4.7, 1.9) - u_time * 0.017));
  vec2 pw = p + u_warp * (w - 0.5);
  float f = fbm(pw * 1.15);

  float amp = bandAt(1.0 - clamp((lr + 3.2) / 3.4, 0.0, 1.0));  // bass outside
  float wid = 0.030 + 2.2 * fw;

  // ---- contour lace: iso-lines of the warped field, thin and luminous ----
  float freq = 7.0 + 5.0 * u_detail;
  float g = abs(fract(f * freq + 0.11 * u_time) - 0.5);
  float lace = wid / (g * g * 34.0 + wid);
  float core = (wid * 0.40) / (g * g * 180.0 + wid * 0.40);

  // a finer second set of iso-lines, so there is structure at two scales
  float g2 = abs(fract(f * freq * 2.2 + 0.31 * u_time) - 0.5);
  float fine = wid / (g2 * g2 * 90.0 + wid);

  // lit zones: a slow large-scale mask so light pools in parts of the figure
  // instead of flooding all of it — this is what keeps the value range wide
  float m = fbm3(p * 0.24 + vec2(1.3, u_time * 0.013 - u_flow * 0.22));
  m = smoothstep(0.38, 0.66, m);

  /* Second layer, in the FOLDED CARTESIAN plane. The log-polar layer's feature
     size scales with radius — fine mush at the centre, big empty blobs at the
     rim — so this one runs at a fixed screen scale and fills the frame evenly.
     It is warped by the first layer's field, which is what makes the two
     interfere instead of merely stacking. */
  vec2 qc = vec2(sin(fa), cos(fa)) * exp(lr) * (5.2 + 0.5 * sin(u_time * 0.063));
  float f2 = fbm(qc + 0.9 * vec2(w.y, w.x) + vec2(0.0, u_time * 0.035));
  // fw*exp(lr) is 4.4/minres, so this is a true constant screen-space width
  float wid2 = 0.026 + 2.6 * fw * exp(lr);
  float g3 = abs(fract(f2 * (7.0 + 3.0 * u_detail) - 0.085 * u_time) - 0.5);
  float lace2 = wid2 / (g3 * g3 * 34.0 + wid2);
  float core2 = (wid2 * 0.4) / (g3 * g3 * 180.0 + wid2 * 0.4);

  // ---- concentric ring strokes, flowing inward with the field ----
  float gy = abs(fract(p.y * 0.55 + 0.5) - 0.5);
  float ring = wid / (gy * gy * 30.0 + wid);

  // ---- radial spokes inside the wedge; they mirror into chevrons ----
  float gx = abs(fract(p.x * 0.85 + 0.5) - 0.5);
  float spoke = wid / (gx * gx * 26.0 + wid);

  vec3 col = vec3(0.0);

  float glow = 0.20 + 1.35 * m;

  /* One narrow hue band for the whole figure: every t below sits inside about
     half a cosine period, so the picture reads as a single colour scheme that
     the chord root slides, not as a spectrum. */
  // ground: a dark, hue-varying wash so the voids are never flat black
  col += pal(f * 1.1 - 0.15, 0.03 * lr) * (0.030 + 0.075 * f) * (0.45 + 0.8 * u_level);

  // the lace, its value taken from the field it traces
  vec3 lc = pal(f * 1.9 - 0.30, 0.0);
  col += lc * lace * (0.34 + 0.52 * amp) * glow;
  col += mix(lc, vec3(1.0), 0.12) * core * (0.15 + 0.50 * amp) * glow;
  col += lc * fine * (0.05 + 0.16 * amp) * (0.30 + 0.70 * u_detail) * glow;

  // the fixed-scale layer, one step round the hue circle from the first
  vec3 lc2 = pal(f2 * 1.9 - 0.25, 0.06);
  col += lc2 * lace2 * (0.30 + 0.46 * amp) * (0.30 + 1.0 * m);
  col += mix(lc2, vec3(1.0), 0.14) * core2 * (0.10 + 0.38 * amp) * (0.30 + 1.0 * m);

  // rings carry the register accent — a tint, not a second palette. Both
  // fields gate them, so they read as arcs woven through the lace, never as a
  // bullseye of perfect circles.
  vec3 rc = sat(mix(pal(0.55 + 0.4 * f, -0.07), u_tint, 0.30), 1.3);
  float rgate = (0.10 + 1.05 * smoothstep(0.32, 0.68, f))
              * (0.25 + 0.95 * smoothstep(0.30, 0.66, f2));
  col += rc * ring * (0.17 + 0.50 * amp) * (0.40 + 0.80 * m) * rgate;

  // spokes stay quiet — they are structure, not light, and the same gate stops
  // them fanning out into a cheap sunburst
  col += pal(0.45 + 0.4 * f, 0.05) * spoke * (0.045 + 0.13 * amp)
       * (0.4 + 0.6 * u_conf) * rgate;

  // nodes: where the two laces and a ring coincide, a small bright jewel —
  // the only place the picture is allowed to approach white
  col += mix(rc, vec3(1.0), 0.35) * core * (ring + core2)
       * (0.22 + 1.00 * amp) * glow;

  return col;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / min(u_res.x, u_res.y);
  float r = max(length(uv) * (1.0 - 0.10 * u_beat), 2e-4);
  float lr = log(r);
  // field units per pixel (the log map stretches hard near the centre)
  float fw = 4.4 / (r * min(u_res.x, u_res.y));

  vec3 col = kaleido(uv, u_n0, lr, fw);
  if (u_nmix > 0.0) col = mix(col, kaleido(uv, u_n0 + 1.0, lr, fw), u_nmix);

  // detail dies where a pixel covers more than a feature — this is also what
  // keeps the centre a clean dark anchor instead of an aliased white blob
  col *= smoothstep(0.020, 0.105, r) / (1.0 + 4.5 * fw);

  // beat wave travelling outward through the folds
  float dw = (lr - u_wave) * 1.9;
  col *= 1.0 + u_wamp * 1.35 * exp(-dw * dw);

  // iris: one thin filament around the dark core, never a glowing disc
  float ir = abs(r - 0.036);
  col += pal(0.72, 0.02) * (0.00030 / (ir * ir * 90.0 + 0.0009))
       * (0.30 + 0.4 * u_level + 0.7 * u_beat);

  col *= 0.68 + 0.95 * u_level + 0.38 * u_beat;
  col *= 1.0 - 0.52 * smoothstep(0.42, 1.12, length(uv));
  col = col / (0.62 + 0.90 * col);                    // soft shoulder
  col = sat(col, 1.22);                               // the shoulder eats hue
  col += (hash21(gl_FragCoord.xy + fract(u_time) * 100.0) - 0.5) * 0.016;
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

/* chord quality -> fold count: the symmetry of the chord becomes the symmetry
   of the figure. Quality is whatever the engine appends after the root name.
   Memoized on the chord name, because the regex below would otherwise mint a
   throwaway string on every single frame. */
let foldsName = null, foldsVal = 12;
function foldsFor(chord) {
  if (!chord) return 12;
  if (chord.name === foldsName) return foldsVal;
  foldsName = chord.name;
  foldsVal = foldsCalc(chord.name);
  return foldsVal;
}

function foldsCalc(name) {
  const q = name.replace(/^[A-G]#?/, '');
  if (q === 'aug') return 3;
  if (q === 'sus2' || q === 'sus4') return 5;
  if (q === '' || q === 'maj7') return 6;
  if (q === '7') return 7;
  if (q === 'm' || q === 'm7') return 8;
  if (q === 'dim') return 10;
  return 12;
}

const TAU = Math.PI * 2;

export default class MandalaViz {
  constructor(canvas) {
    this.canvas = canvas;
    this.ok = false;
    const gl = getGL(canvas);
    if (!gl) { canvasMessage(canvas, ['WebGL unavailable', 'mandala needs a GL context']); return; }
    const prog = makeProgram(gl, QUAD_VERT, FRAG);
    if (!prog) { canvasMessage(canvas, ['mandala: shader failed to compile']); return; }

    this.gl = gl;
    this.prog = prog;
    this.quad = makeQuad(gl);
    gl.useProgram(prog);
    bindQuad(gl, prog, this.quad);
    this.U = uniforms(gl, prog, ['u_res', 'u_time', 'u_level', 'u_beat', 'u_rot',
      'u_flow', 'u_n0', 'u_nmix', 'u_hue', 'u_warp', 'u_detail', 'u_wave',
      'u_wamp', 'u_conf', 'u_tint', 'u_band[0]']);

    // per-frame scratch — render() allocates nothing
    this.bands = new Float32Array(4);
    this.tint = new Float32Array(3);

    this.foldF = 12;        // eased fold count, fractional between two symmetries
    this.pend = 12;         // candidate fold count awaiting the hold time
    this.pendT = 0;
    this.rot = 0;
    this.rotSpd = 0.05;
    this.flow = 0;
    this.hue = 0.12;
    this.warp = 1.0;
    this.detail = 0.2;
    this.waveT = 9;
    this.prevBeat = 0;
    this.ok = true;
    this.resize();
  }

  resize() {
    if (!this.ok) return;
    // fbm-based field: resolution-independent, so a capped buffer upscaled to
    // the canvas via CSS is visually indistinguishable. At 4K this demo was
    // the one that missed 60fps uncapped (26.1ms/frame) — cap the long side
    // the same way the syn scenes cap their render buffers.
    if (fitCanvas(this.canvas, 2, 2048)) {
      this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  render(frame, now, dt) {
    if (!this.ok) return;
    const gl = this.gl, U = this.U;
    this.resize();

    const b = bandLevels(frame, this.bands);
    const mid = (b[1] + b[2]) * 0.5, hi = b[3];
    const k = Math.min(1, dt * 6);

    // shape controls, smoothed so the lace never twitches
    this.warp += (0.55 + 4.2 * mid + 0.9 * frame.beat - this.warp) * k;
    this.detail += (Math.min(1, hi * 7.0) - this.detail) * k;

    // fold count: adopt a new symmetry only once the chord has held for a
    // beat, then cross-dissolve to it over ~0.5s
    const want = foldsFor(frame.chord);
    if (want !== this.pend) { this.pend = want; this.pendT = 0; }
    else this.pendT += dt;
    const target = this.pendT > 0.35 ? this.pend : Math.round(this.foldF);
    this.foldF += (target - this.foldF) * Math.min(1, dt * 2.6);

    let n0 = Math.floor(this.foldF), m = this.foldF - n0;
    if (m < 0.004) m = 0;
    else if (m > 0.996) { n0 += 1; m = 0; }
    else m = m * m * (3 - 2 * m);                 // smoothstep the dissolve

    // rotation: the dominant pitch class sets the drift's sign and rate, so
    // the figure slowly reverses as the harmony moves round the circle
    const ca = chromaAngle(frame.chroma);
    const wantSpd = 0.035 + 0.16 * Math.sin(ca * TAU);
    this.rotSpd += (wantSpd - this.rotSpd) * Math.min(1, dt * 0.8);
    this.rot = (this.rot + dt * this.rotSpd + TAU) % TAU;

    // tube travel: always inward, faster when loud, kicked by the beat
    this.flow += dt * (0.34 + 1.15 * frame.level + 0.9 * frame.beat
                       + 0.07 * Math.sin(now * 0.11));

    // beat wave: retriggered on the rising edge, sweeping centre -> rim
    if (frame.beat > 0.55 && this.prevBeat <= 0.55) this.waveT = 0;
    this.prevBeat = frame.beat;
    this.waveT += dt;
    const wu = Math.min(1, this.waveT / 0.85);
    const wave = -3.3 + 3.6 * wu;
    const wamp = (1 - wu) * (1 - wu) * 0.85;

    /* Palette phase. The chord root walks a curated half of the hue circle —
       blue -> violet -> magenta -> red -> amber — rather than the whole thing,
       because the part it skips is where the muddy olives and chartreuses
       live. Lerped along the arc, never wrapped the short way round. */
    const pos = frame.chord ? frame.chord.root / 12 : ca;
    this.hue += (0.35 - 0.47 * pos - this.hue) * Math.min(1, dt * 0.5);

    // register accent: the energy-weighted position on the engine's own ramp
    let wsum = 0, osum = 0;
    for (let i = 0; i < 4; i++) { wsum += b[i]; osum += b[i] * (i + 0.5) / 4; }
    const c = regColorInto(wsum > 1e-5 ? osum / wsum : 0.45, this.tint, 0);

    for (let i = 0; i < 4; i++) this.bands[i] = Math.min(1.5, b[i] * 5.5);

    gl.useProgram(this.prog);
    bindQuad(gl, this.prog, this.quad);
    gl.uniform2f(U.u_res, this.canvas.width, this.canvas.height);
    gl.uniform1f(U.u_time, now);
    gl.uniform1f(U.u_level, Math.min(1.15, frame.level * 1.3 + 0.14));
    gl.uniform1f(U.u_beat, frame.beat);
    gl.uniform1f(U.u_rot, this.rot);
    gl.uniform1f(U.u_flow, this.flow);
    gl.uniform1f(U.u_n0, n0);
    gl.uniform1f(U.u_nmix, m);
    gl.uniform1f(U.u_hue, this.hue + 0.022 * Math.sin(now * 0.037));
    gl.uniform1f(U.u_warp, this.warp);
    gl.uniform1f(U.u_detail, this.detail);
    gl.uniform1f(U.u_wave, wave);
    gl.uniform1f(U.u_wamp, wamp);
    gl.uniform1f(U.u_conf, frame.chord ? frame.chordConf : 0);
    gl.uniform3f(U.u_tint, c[0], c[1], c[2]);
    gl.uniform1fv(U['u_band[0]'], this.bands);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose() {
    if (!this.ok) return;
    this.gl.deleteBuffer(this.quad);
    this.gl.deleteProgram(this.prog);
    this.ok = false;
  }
}
