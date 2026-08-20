/* vizier demos — tiny WebGL1 helper
   ============================================================================
   The only shared code between the demo modules: context creation, shader
   compilation, a fullscreen triangle, textures / render targets, canvas fitting
   and a couple of ChromaFrame reductions every demo wants (per-band energy,
   dominant pitch angle). No dependencies, no state of its own.

   Everything here fails soft: a missing context or a shader that will not
   compile returns null and logs, so a demo can put a message on the canvas
   instead of throwing and taking the gallery down with it.
   ========================================================================== */

'use strict';

import { REG_LUT } from '../vizier-analysis.js';

/* --------------------------------------------------------------- context */

export function getGL(canvas, opts) {
  const attrs = Object.assign({
    antialias: false, alpha: false, depth: false,
    premultipliedAlpha: false, preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  }, opts || {});
  try {
    return canvas.getContext('webgl', attrs)
        || canvas.getContext('experimental-webgl', attrs)
        || null;
  } catch (e) {
    return null;
  }
}

/* Paint a message straight onto the canvas with the 2D context. Safe to call
   only when no WebGL context was obtained (a canvas keeps the first context
   type it hands out). */
export function canvasMessage(canvas, lines) {
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.clientWidth || 640, h = canvas.clientHeight || 360;
    canvas.width = w; canvas.height = h;
    ctx.fillStyle = '#04070a';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#ffb13d';
    ctx.font = '14px "IBM Plex Mono", monospace';
    ctx.textAlign = 'center';
    const arr = Array.isArray(lines) ? lines : [lines];
    arr.forEach((s, i) => ctx.fillText(s, w / 2, h / 2 + (i - (arr.length - 1) / 2) * 22));
  } catch (e) { /* nothing else we can do */ }
}

/* --------------------------------------------------------------- programs */

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error('[vizier-demos] shader:', gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

export function makeProgram(gl, vsrc, fsrc) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsrc);
  if (!vs || !fs) return null;
  const p = gl.createProgram();
  gl.attachShader(p, vs); gl.attachShader(p, fs);
  gl.linkProgram(p);
  gl.deleteShader(vs); gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.error('[vizier-demos] link:', gl.getProgramInfoLog(p));
    gl.deleteProgram(p);
    return null;
  }
  return p;
}

// uniform-location map: uniforms(gl, prog, ['u_res','u_time']) -> {u_res: loc, ...}
export function uniforms(gl, prog, names) {
  const U = {};
  for (const n of names) U[n] = gl.getUniformLocation(prog, n);
  return U;
}

/* One oversized triangle covering the viewport; cheaper than a quad and needs
   no index buffer. Bind with bindQuad() before drawArrays(TRIANGLES, 0, 3). */
export const QUAD_VERT = `
attribute vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }
`;

export function makeQuad(gl) {
  const b = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, b);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  return b;
}

export function bindQuad(gl, prog, buf, name) {
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  const loc = gl.getAttribLocation(prog, name || 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
}

/* ------------------------------------------------------ textures / targets */

export function createTexture(gl, w, h, opts) {
  const o = opts || {};
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, o.format || gl.RGBA, w, h, 0,
    o.format || gl.RGBA, o.type || gl.UNSIGNED_BYTE, o.data || null);
  const f = o.filter || gl.LINEAR, wrap = o.wrap || gl.CLAMP_TO_EDGE;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  return tex;
}

// {tex, fbo} pair for ping-pong feedback; null if the FBO is not complete
export function createTarget(gl, w, h, opts) {
  const tex = createTexture(gl, w, h, opts);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (!ok) { gl.deleteFramebuffer(fbo); gl.deleteTexture(tex); return null; }
  return { tex, fbo, w, h };
}

/* ------------------------------------------------------------ canvas fit
   Size the backing store to CSS pixels * DPR (capped). Returns true when the
   backing store actually changed, so callers only reset viewports on change.
   A hidden canvas (display:none) measures 0 — fall back to the stage element
   that still has a box, and if even that is 0, keep the current size rather
   than allocating a 1x1 buffer we would have to rebuild on the next frame.

   maxDim, if given, additionally caps the backing store's LONG side to that
   many device pixels — the CSS box is untouched, so the browser upscales the
   smaller buffer to fill it, same as the syn scenes' own maxDim downscale.
   Only demos with no headroom at 4K (mandala, nebula) pass this; everyone
   else keeps the plain DPR-capped behaviour. */
export function fitCanvas(canvas, dprCap, maxDim) {
  const dpr = Math.min(window.devicePixelRatio || 1, dprCap || 2);
  let cw = canvas.clientWidth, ch = canvas.clientHeight;
  if (!cw || !ch) {
    const host = canvas.parentElement;
    if (host) { cw = cw || host.clientWidth; ch = ch || host.clientHeight; }
  }
  if (!cw || !ch) return false;
  let w = Math.max(1, Math.round(cw * dpr));
  let h = Math.max(1, Math.round(ch * dpr));
  if (maxDim) {
    const long = Math.max(w, h);
    if (long > maxDim) {
      const s = maxDim / long;
      w = Math.max(1, Math.round(w * s));
      h = Math.max(1, Math.round(h * s));
    }
  }
  if (canvas.width === w && canvas.height === h) return false;
  canvas.width = w;
  canvas.height = h;
  return true;
}

/* ------------------------------------------------- ChromaFrame reductions */

/* Allocation-free regColor(): the engine's exported regColor() builds a fresh
   3-element array on every call, which in a render loop is thousands of dead
   objects a second. Same LUT, written into a buffer you own. */
export function regColorInto(o, out, off) {
  const i = Math.min(255, Math.max(0, (o * 255) | 0)) * 3;
  const k = off || 0;
  out[k] = REG_LUT[i]; out[k + 1] = REG_LUT[i + 1]; out[k + 2] = REG_LUT[i + 2];
  return out;
}

/* Mean energy of each register band (low -> high), normalized to ~0..1.
   Writes into `out` (Float32Array(4)) — no allocation per frame. */
export function bandLevels(frame, out) {
  const ang = frame.ang, n = frame.nreg, e = frame.energy;
  for (let b = 0; b < n; b++) {
    let s = 0;
    const base = b * ang;
    for (let a = 0; a < ang; a++) s += e[base + a];
    out[b] = s / (ang * frame.eMax);
  }
  return out;
}

/* Total energy per angular bin, summed over registers, into `out`
   (Float32Array(frame.ang)). Returns the peak value found. */
export function angleTotals(frame, out) {
  const ang = frame.ang, n = frame.nreg, e = frame.energy;
  let peak = 0;
  for (let a = 0; a < ang; a++) {
    let s = 0;
    for (let b = 0; b < n; b++) s += e[b * ang + a];
    out[a] = s;
    if (s > peak) peak = s;
  }
  return peak;
}

/* Loudest pitch class as a 0..1 position on the circle (0 = A at 12 o'clock),
   computed from the 12-bin chroma with a circular-mean so it moves smoothly
   instead of snapping between neighbours. */
export function chromaAngle(chroma) {
  let sx = 0, sy = 0;
  for (let i = 0; i < 12; i++) {
    const th = i / 12 * Math.PI * 2;
    sx += chroma[i] * Math.sin(th);
    sy += chroma[i] * Math.cos(th);
  }
  if (sx === 0 && sy === 0) return 0;
  const a = Math.atan2(sx, sy) / (Math.PI * 2);
  return a < 0 ? a + 1 : a;
}

// max of the 12 chroma bins, for normalizing a chroma uniform
export function chromaMax(chroma) {
  let m = 1e-6;
  for (let i = 0; i < 12; i++) if (chroma[i] > m) m = chroma[i];
  return m;
}

/* Shared GLSL: value noise + fbm + the pitch-angle helpers. Concatenated into
   fragment shaders that want them, so the demos read as just their own idea. */
export const GLSL_NOISE = `
const float TAU = 6.28318530718;
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * vnoise(p);
    p = p * 2.02 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return v;
}
// pitch-class position (0..1, 0 = A straight up, ascending clockwise)
float pitchAngle(vec2 uv) {
  float a = atan(uv.x, uv.y) / TAU;
  return fract(a);
}
`;

/* Smooth circular lookup into a 12-bin chroma uniform (declare
   `uniform float u_chroma[12];` alongside). x is 0..1 around the circle. */
export const GLSL_CHROMA = `
float chromaAt(float pc01) {
  float x = pc01 * 12.0;
  float s = 0.0;
  for (int i = 0; i < 12; i++) {
    float d = abs(float(i) - x);
    d = min(d, 12.0 - d);
    s += u_chroma[i] * exp(-d * d * 1.6);
  }
  return s;
}
`;
