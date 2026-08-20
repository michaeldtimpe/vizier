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
     level + mid                  -> how fast the warp field advects (flow)
     level                        -> overall exposure, cloud density
     beat                         -> bloom kick, a surge in the flow, and a
                                     shove that reorganizes the warp interior

   motion
     The cloud used to animate almost entirely in AMPLITUDE: one fixed warp
     field lit brighter or dimmer by the level. Structurally it barely moved,
     so quiet passages looked like a still image. Now every clock the field
     reads is INTEGRATED here per frame rather than taken from raw wall time,
     which lets their rates respond to the audio without the time-warp jump a
     `u_time * speed` term would cause when speed changes:

       flow   advection of the warp field   base + level + mid + beat surge
       spin   whole-field rotation          very slow, faster when loud
       drift  travel through the field      on a heading that itself turns
       pal    palette hue drift             one full turn per ~5.5 minutes

     Brightness ranges are untouched — this is more motion, not more light. */

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
uniform float u_phase;     // palette phase: chord root + activation + drift
uniform float u_flow;      // advection clock, integrated at an audio-led rate
uniform float u_spin;      // whole-field rotation (radians)
uniform vec2 u_drift;      // whole-field translation, a slow orbit
uniform float u_surge;     // beat swell, a slower tail than u_beat
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
  float t = u_flow;

  /* The field is sampled through a slowly turning, slowly wandering frame.
     Both are far too gradual to read as "spinning" — over a few seconds they
     just keep the composition from ever settling, which is what stops the
     cloud looking like a still. uv itself stays untransformed below, so the
     pitch veins and the vignette keep their true screen anchoring. */
  float cs = cos(u_spin), sn = sin(u_spin);
  vec2 p = mat2(cs, -sn, sn, cs) * uv * 2.7 + u_drift;

  // two levels of domain warp; the second offset is kicked by the beat
  vec2 q = vec2(fbm(p + vec2(0.0, t)),
                fbm(p + vec2(5.2, 1.3) - t * 0.8));
  /* The inner warp used to creep at 0.13*t, so the cloud's interior was
     effectively frozen relative to its outline. Giving it a rate comparable
     to the outer layer plus its own slow orbit (sw) makes the structure
     churn and reorganize instead of sliding past as one rigid field. */
  vec2 sw = vec2(sin(t * 0.29), cos(t * 0.23)) * 0.85;
  vec2 r = vec2(fbm(p + u_warp * q + vec2(1.7, 9.2) + sw + 0.52 * t + 0.55 * u_surge),
                fbm(p + u_warp * q + vec2(8.3, 2.8) - sw.yx - 0.44 * t));
  float f = fbm(p + u_warp * r + 0.22 * u_surge);

  // pitch veins: the chroma vector drawn as radial density at its own angles
  float pc = pitchAngle(uv);
  float rad = length(uv);
  // the ring travels outward on a beat, so a hit reads as a pulse leaving the core
  float vein = chromaAt(pc + 0.02 * (q.x - 0.5))
             * exp(-rad * 1.35)
             * (0.6 + 0.5 * sin(rad * 22.0 - u_time * 1.7 - 3.0 * u_surge));

  float d = f + 0.30 * vein + 0.18 * length(q);

  // gas density: a hard gamma keeps the voids black, so this reads as clouds
  // in space instead of a flat wash of color
  float dens = pow(clamp(d * 1.25 - 0.18, 0.0, 1.0), 2.4);
  vec3 col = pal(d * 1.9 + 0.35 * rad, u_phase);
  col = mix(vec3(dot(col, vec3(0.333))), col, 2.2);   // the narrow palette needs
  col = mix(max(col, 0.0), u_tint, 0.25) * dens * 2.9;   // its saturation back

  /* Filaments: the ridges of the warp field, sharpened by treble. Pulled a
     little further toward the tint than it used to be (0.45 -> 0.60). With the
     field now moving properly it sweeps through far more configurations, and
     the widest peaks were washing a third of the frame to flat white — losing
     exactly the hue discipline that makes this scene look like gas and not
     like a bloom filter. Biasing the highlight toward the register colour
     keeps the bright cores reading as cream and ice rather than as paper. */
  float fil = pow(clamp(1.0 - abs(f - 0.56) * 3.4, 0.0, 1.0), 3.0 + 7.0 * (1.0 - u_detail));
  col += fil * mix(vec3(1.0), u_tint, 0.60) * (0.30 + 1.2 * u_detail + 0.85 * u_beat);

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

/* Golden angle, in turns. Successive activations step the palette by this much,
   which is the largest rotation that never revisits a hue family: 0.382 turns
   apart every time, and the sequence takes many appearances to come near a
   repeat. A random offset would sometimes land twice in the same blue. */
const PAL_STEP = 0.381966;

export default class NebulaViz {
  /* opts.paletteStep — starting index into the hue rotation, for a caller that
     wants to pin the opening palette. Normally left alone: the gallery calls
     onActivate() instead, once per time this scene comes up. */
  constructor(canvas, opts) {
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
      'u_warp', 'u_detail', 'u_phase', 'u_flow', 'u_spin', 'u_drift',
      'u_surge', 'u_tint', 'u_chroma[0]']);

    // per-frame scratch — nothing is allocated inside render()
    this.bands = new Float32Array(4);
    this.chroma = new Float32Array(12);
    this.tint = new Float32Array(3);
    this.smWarp = 1.0;
    this.smDetail = 0.2;

    // integrated clocks (see the motion note at the top of this file)
    this.flow = 0;        // warp advection
    this.spin = 0;        // whole-field rotation, radians
    this.dclk = 0;        // phase of the bounded wander through the field
    this.surge = 0;       // beat swell envelope
    this.palDrift = 0;    // minutes-scale hue wander, in turns

    // hue rotation across activations
    this.palStep = (opts && Number.isFinite(opts.paletteStep))
      ? opts.paletteStep : -1;   // -1 so the first onActivate() lands on step 0
    this.palOffset = this.palStep < 0 ? 0 : this.palStep * PAL_STEP;

    this.ok = true;
    this.resize();
  }

  /* Called by the gallery every time this scene becomes the active one — both
     the manual/hash path and the show client's stage changes funnel through
     demos.html's select(). Each activation advances the palette a golden angle
     round the hue circle, so the nebula that comes back after a trip through
     the rest of the gallery is recognisably a different colour of nebula. The
     chord-root response is untouched; this is an offset added on top of it. */
  onActivate() {
    this.palStep += 1;
    this.palOffset = this.palStep * PAL_STEP;
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

    /* Beat swell. frame.beat already decays (3.2/s, ~0.3 s); this rides on top
       with a ~0.9 s tail so a hit pushes the field forward and then eases off
       instead of snapping back, which is what makes the surge read as the
       cloud lurching rather than as a flicker. */
    const lvl = Math.min(1, frame.level);
    this.surge = Math.max(this.surge * Math.exp(-dt / 0.42), frame.beat);

    /* Advection rate. The base term is what keeps a silent room alive; the
       level and mid terms are the part the music is actually driving. */
    const flowVel = 0.16 + 0.40 * lvl + 0.55 * mid + 1.5 * this.surge;
    this.flow += dt * flowVel;

    /* Slow rotation of the sampling frame. Deliberately an order of magnitude
       under the flow rate — it never reads as camera movement, it just keeps
       the composition from ever settling into one arrangement. */
    this.spin += dt * (0.030 + 0.075 * lvl);

    /* Travel through the noise field. This is the term that matters most in a
       quiet passage: u_flow only enters via the warp offsets, which the mid
       energy gates, so with the music down the base fbm(p) was left standing
       still and the cloud looked like a photograph.

       The path is a pair of incommensurate sinusoids rather than an integrated
       heading: it wanders without repeating on any obvious cycle, but it stays
       BOUNDED (|drift| <= 1.4). An unbounded walk works too and looks the same
       over a few minutes, but it keeps pushing |p| up, and gl-util's hash21
       degrades as its input grows — fbm multiplies p by 2.02 an octave, so the
       top octaves are the first to go. Staying near the origin costs nothing
       and removes the question entirely. */
    this.dclk += dt * (0.45 + 0.80 * lvl);
    const dc = this.dclk;

    // one full turn of hue per ~5.5 minutes, on top of everything else
    this.palDrift += dt / 330;

    // palette phase: chord root when we have one, else the chroma centroid,
    // offset by this activation's slot in the hue rotation and the slow drift
    const root = frame.chord ? frame.chord.root / 12 : chromaAngle(frame.chroma);
    const phase = root + this.palOffset + this.palDrift;

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
    /* Exposure ceiling trimmed 1.2 -> 1.05. The clamp only binds above about
       level 0.59, so quiet and mid passages are pixel-identical to before —
       this pulls back the loudest peaks only, where the newly mobile field
       reaches high-density configurations often enough to wash out the dark
       anchor that the composition is built on. */
    gl.uniform1f(U.u_level, Math.min(1.05, frame.level * 1.6 + 0.10));
    gl.uniform1f(U.u_beat, frame.beat);
    gl.uniform1f(U.u_warp, this.smWarp);
    gl.uniform1f(U.u_detail, this.smDetail);
    gl.uniform1f(U.u_phase, phase);
    gl.uniform1f(U.u_flow, this.flow);
    gl.uniform1f(U.u_spin, this.spin);
    gl.uniform2f(U.u_drift,
      0.90 * Math.sin(dc * 0.73) + 0.50 * Math.sin(dc * 1.31 + 1.7),
      0.90 * Math.cos(dc * 0.61) + 0.50 * Math.cos(dc * 1.19 + 0.4));
    gl.uniform1f(U.u_surge, this.surge);
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
