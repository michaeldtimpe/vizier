/* vizier demo — NEBULA
   ============================================================================
   Domain-warped plasma. One fullscreen fragment shader: fbm feeding an fbm
   domain warp (Inigo Quilez's q/r trick), shaded through a cosine-gradient
   palette. The warp is the audio's: it breathes on mid-register energy and
   snaps on beats, while a slow clock keeps the cloud evolving in silence.

   audio map
     chord root / dominant pitch  -> palette phase (hue of the whole cloud)
     chroma (12-float uniform)    -> ring of veins at their true pitch angles
     mid + high band energy       -> domain-warp strength, filament contrast
     level                        -> overall exposure, cloud density
     beat                         -> bloom kick + a shove in the warp offset
   ========================================================================== */

'use strict';

import {
  getGL, makeProgram, makeQuad, bindQuad, uniforms, fitCanvas, canvasMessage,
  bandLevels, chromaAngle, chromaMax, regColorInto,
  QUAD_VERT, GLSL_NOISE, GLSL_CHROMA,
} from './gl-util.js';

const FRAG = `
precision highp float;
uniform vec2 u_res;
uniform float u_time;
uniform float u_level;
uniform float u_beat;
uniform float u_warp;      // domain-warp strength, from mid energy
uniform float u_detail;    // filament contrast, from high energy
uniform float u_phase;     // palette phase, from chord root
uniform float u_chroma[12];
uniform vec3 u_tint;       // register color of the loudest band
${GLSL_NOISE}
${GLSL_CHROMA}

/* iq cosine gradient, deliberately narrow: a wide rainbow makes plasma look
   like a screensaver, so the hue span is about a third of the circle and the
   chord root slides the whole band. */
vec3 pal(float t, float ph) {
  return 0.5 + 0.5 * cos(TAU * (vec3(0.52, 0.46, 0.38) * t + vec3(0.0, 0.16, 0.34) + ph));
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / min(u_res.x, u_res.y);
  float t = u_time * 0.045;

  vec2 p = uv * 2.7;
  // two levels of domain warp; the second offset is kicked by the beat
  vec2 q = vec2(fbm(p + vec2(0.0, t)),
                fbm(p + vec2(5.2, 1.3) - t * 0.8));
  vec2 r = vec2(fbm(p + u_warp * q + vec2(1.7, 9.2) + 0.13 * t + 0.35 * u_beat),
                fbm(p + u_warp * q + vec2(8.3, 2.8) - 0.11 * t));
  float f = fbm(p + u_warp * r);

  // pitch veins: the chroma vector drawn as radial density at its own angles
  float pc = pitchAngle(uv);
  float rad = length(uv);
  float vein = chromaAt(pc + 0.02 * (q.x - 0.5))
             * exp(-rad * 1.35) * (0.6 + 0.5 * sin(rad * 22.0 - u_time * 1.7));

  float d = f + 0.30 * vein + 0.18 * length(q);

  // gas density: a hard gamma keeps the voids black, so this reads as clouds
  // in space instead of a flat wash of color
  float dens = pow(clamp(d * 1.25 - 0.18, 0.0, 1.0), 2.4);
  vec3 col = pal(d * 1.9 + 0.35 * rad, u_phase);
  col = mix(vec3(dot(col, vec3(0.333))), col, 2.2);   // the narrow palette needs
  col = mix(max(col, 0.0), u_tint, 0.25) * dens * 2.9;   // its saturation back

  // filaments: the ridges of the warp field, sharpened by treble
  float fil = pow(clamp(1.0 - abs(f - 0.56) * 3.4, 0.0, 1.0), 3.0 + 7.0 * (1.0 - u_detail));
  col += fil * mix(vec3(1.0), u_tint, 0.45) * (0.30 + 1.3 * u_detail + 1.0 * u_beat);

  // core glow follows the loudest register's color
  col += u_tint * clamp(vein, 0.0, 1.5) * 0.55 * exp(-rad * 2.2);
  col *= 0.22 + 0.95 * u_level + 0.60 * u_beat;

  // vignette, soft shoulder, and a whisper of grain so flat areas do not band
  col *= 1.0 - 0.62 * smoothstep(0.35, 1.05, rad);
  col = col / (0.85 + 0.55 * col);
  col += (hash21(gl_FragCoord.xy + fract(u_time) * 100.0) - 0.5) * 0.020;

  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

export default class NebulaViz {
  constructor(canvas) {
    this.canvas = canvas;
    this.ok = false;
    const gl = getGL(canvas);
    if (!gl) { canvasMessage(canvas, ['WebGL unavailable', 'nebula needs a GL context']); return; }
    const prog = makeProgram(gl, QUAD_VERT, FRAG);
    if (!prog) { canvasMessage(canvas, ['nebula: shader failed to compile']); return; }

    this.gl = gl;
    this.prog = prog;
    this.quad = makeQuad(gl);
    gl.useProgram(prog);
    bindQuad(gl, prog, this.quad);
    this.U = uniforms(gl, prog, ['u_res', 'u_time', 'u_level', 'u_beat',
      'u_warp', 'u_detail', 'u_phase', 'u_tint', 'u_chroma[0]']);

    // per-frame scratch — nothing is allocated inside render()
    this.bands = new Float32Array(4);
    this.chroma = new Float32Array(12);
    this.tint = new Float32Array(3);
    this.smWarp = 1.0;
    this.smDetail = 0.2;
    this.ok = true;
    this.resize();
  }

  resize() {
    if (!this.ok) return;
    // Passed the 4K bench with no margin (no maxDim cap of its own, unlike the
    // syn scenes). Same 2048 long-side cap as mandala as a safety margin — the
    // fbm field is resolution-independent so the upscale is visually free.
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

    // smooth the two shape controls so the cloud never twitches
    const k = Math.min(1, dt * 6);
    this.smWarp += (0.75 + 5.5 * mid + 1.6 * frame.beat - this.smWarp) * k;
    this.smDetail += (Math.min(1, hi * 7.0) - this.smDetail) * k;

    // palette phase: chord root when we have one, else the chroma centroid
    const phase = frame.chord ? frame.chord.root / 12 : chromaAngle(frame.chroma);

    // tint from the energy-weighted register position, same ramp the engine uses
    let wsum = 0, osum = 0;
    for (let i = 0; i < 4; i++) { wsum += b[i]; osum += b[i] * (i + 0.5) / 4; }
    const c = regColorInto(wsum > 1e-5 ? osum / wsum : 0.45, this.tint, 0);

    const cmax = chromaMax(frame.chroma);
    for (let i = 0; i < 12; i++) this.chroma[i] = frame.chroma[i] / cmax;

    gl.useProgram(this.prog);
    bindQuad(gl, this.prog, this.quad);
    gl.uniform2f(U.u_res, this.canvas.width, this.canvas.height);
    gl.uniform1f(U.u_time, now);
    gl.uniform1f(U.u_level, Math.min(1.2, frame.level * 1.6 + 0.10));
    gl.uniform1f(U.u_beat, frame.beat);
    gl.uniform1f(U.u_warp, this.smWarp);
    gl.uniform1f(U.u_detail, this.smDetail);
    gl.uniform1f(U.u_phase, phase);
    gl.uniform3f(U.u_tint, c[0], c[1], c[2]);
    gl.uniform1fv(U['u_chroma[0]'], this.chroma);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose() {
    if (!this.ok) return;
    this.gl.deleteBuffer(this.quad);
    this.gl.deleteProgram(this.prog);
    this.ok = false;
  }
}
