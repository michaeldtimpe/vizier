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
       pal    palette hue drift             PAL_DRIFT, default one turn/5.5 min

     Brightness ranges are untouched — this is more motion, not more light.

   palette
     The iq cosine gradient's four coefficient vectors used to be literals in
     the shader. They are uniforms now, fed from a `controls[]` array of the
     same shape a Synesthesia scene exposes — which is what buys this scene the
     gallery's control panel, its preset store and the show console's CTRL tab
     without a line of special-casing in any of them (demos.html synInst()).
     Every default reproduces the old literals exactly, so a page that never
     touches a palette renders what it always did.

     setPalette() is the show's door in: a `palette` cue hands over a whole
     coefficient set and a fade time, and the scene eases from whatever is on
     screen to the new set. The fade TARGET is the live control values, not a
     frozen copy, so dragging a slider mid-fade retargets it smoothly instead
     of fighting it. */

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
/* iq cosine gradient coefficients, interpolated on the CPU: one effective set
   is uploaded per frame, so a palette fade costs the shader nothing. */
uniform vec3 u_palBias;
uniform vec3 u_palAmp;
uniform vec3 u_palFreq;
uniform vec3 u_palPhase;
${GLSL_NOISE}
${GLSL_CHROMA}

/* iq cosine gradient. The DEFAULT coefficients are deliberately narrow: a wide
   rainbow makes plasma look like a screensaver, so the stock hue span is about
   a third of the circle and the chord root slides the whole band. A palette cue
   is free to disagree — some of the opener's tracks want a much wider span. */
vec3 pal(float t, float ph) {
  return u_palBias + u_palAmp * cos(TAU * (u_palFreq * t + u_palPhase + ph));
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

/* One control row in the shape every consumer already understands: the gallery
   panel builds its widget straight off `spec` (demos.html addSceneControl —
   glsl 'vec3' takes the colour-picker branch before TYPE is even read), the
   preset store round-trips `value`, and `def` is what "reset scene" restores.
   `spec` is scene.json-shaped for exactly that reason, even though no JSON was
   ever involved here. */
function ctl(name, glsl, value, spec) {
  return {
    name, glsl, value,
    def: Array.isArray(value) ? value.slice() : value,
    spec: Object.assign({ NAME: name, UI_GROUP: 'palette' }, spec),
  };
}

/* HSL -> RGB, every component in 0..1. The bound that matters downstream:
   a = s * min(l, 1-l) <= min(l, 1-l), so every channel lands in [l-a, l+a] and
   therefore inside [0,1] whatever s and l are. That is what lets swapPalette()
   promise the gradient never clips — see the note there. */
function hsl2rgb(h, s, l) {
  h -= Math.floor(h);                      // wrap into [0,1)
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

export default class NebulaViz {
  /* opts.paletteStep — starting index into the hue rotation, for a caller that
     wants to pin the opening palette. Normally left alone: the gallery calls
     onActivate() instead, once per time this scene comes up. */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = opts;
    this.ok = false;
    /* ready/failed are the GALLERY's contract, distinct from `ok` (this
       scene's own internal render guard). demos.html's applyPreset retries on
       a 120 ms timer for as long as BOTH are false, waiting for an async
       SynScene to compile — a scene that never sets either one spins that
       timer forever. This one is synchronous, so both are resolved before the
       constructor returns; they are set anyway, on every exit path. */
    this.ready = false;
    this.failed = false;
    /* Numeric maxDim is the other half of the duck-type demos.html uses to
       tell a controllable scene from a native demo (synInst()); once it is
       here the QUALITY slider drives this scene for free, through
       applyQualityTo's __baseMaxDim memo. */
    this.maxDim = 2048;
    /* opts.fixedSize [w,h] — a detached instance (the hidden backdrop nebula)
       that is never in the document and so has no layout box to measure. */
    this.fixedSize = (Array.isArray(opts.fixedSize) && opts.fixedSize.length === 2)
      ? [Math.max(1, opts.fixedSize[0] | 0), Math.max(1, opts.fixedSize[1] | 0)] : null;

    const gl = getGL(canvas);
    if (!gl) {
      canvasMessage(canvas, ['WebGL unavailable', 'nebula needs a GL context']);
      this.failed = true; return;
    }
    const prog = makeProgram(gl, QUAD_VERT, FRAG);
    if (!prog) {
      canvasMessage(canvas, ['nebula: shader failed to compile']);
      this.failed = true; return;
    }

    this.gl = gl;
    this.prog = prog;
    this.quad = makeQuad(gl);
    gl.useProgram(prog);
    bindQuad(gl, prog, this.quad);
    this.U = uniforms(gl, prog, ['u_res', 'u_time', 'u_level', 'u_beat',
      'u_warp', 'u_detail', 'u_phase', 'u_flow', 'u_spin', 'u_drift',
      'u_surge', 'u_tint', 'u_chroma[0]',
      'u_palBias', 'u_palAmp', 'u_palFreq', 'u_palPhase']);

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
    this.palStep = Number.isFinite(opts.paletteStep)
      ? opts.paletteStep : -1;   // -1 so the first onActivate() lands on step 0
    this.palOffset = this.palStep < 0 ? 0 : this.palStep * PAL_STEP;

    this._buildControls();
    this.ok = true;
    this.ready = true;
    if (this.fixedSize) {
      this.canvas.width = this.fixedSize[0];
      this.canvas.height = this.fixedSize[1];
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    } else {
      this.resize();
    }
  }

  /* The palette surface. Freq/phase are three float sliders each rather than
     one vec3 apiece precisely BECAUSE the panel renders a vec3 as a colour
     picker — right for bias and amp, meaningless for a frequency. */
  _buildControls() {
    const sl = (name, v, min, max, desc) => ctl(name, 'float', v,
      { TYPE: 'slider', MIN: min, MAX: max, DEFAULT: v, DESCRIPTION: desc });

    this.cBias = ctl('PAL_BIAS', 'vec3', [0.5, 0.5, 0.5],
      { TYPE: 'color', DEF_COLOR: [0.5, 0.5, 0.5],
        DESCRIPTION: 'Centre of the cosine gradient — the colour the cloud '
          + 'tends to when the wave is at zero. Lift it for a hazier, '
          + 'less black-anchored nebula.' });
    this.cAmp = ctl('PAL_AMP', 'vec3', [0.5, 0.5, 0.5],
      { TYPE: 'color', DEF_COLOR: [0.5, 0.5, 0.5],
        DESCRIPTION: 'Swing of the cosine gradient about the bias. Per-channel: '
          + 'zeroing one channel drops it out of the palette entirely.' });
    this.cFreq = [
      sl('PAL_FREQ_R', 0.52, 0, 1.5, 'Red cycles across the density ramp. The '
        + 'three freq values together set how wide a hue span the cloud covers.'),
      sl('PAL_FREQ_G', 0.46, 0, 1.5, 'Green cycles across the density ramp.'),
      sl('PAL_FREQ_B', 0.38, 0, 1.5, 'Blue cycles across the density ramp.'),
    ];
    this.cPhase = [
      sl('PAL_PHASE_R', 0.00, 0, 1, 'Red phase offset, in turns. Spreading the '
        + 'three phases is what makes the gradient traverse hues at all.'),
      sl('PAL_PHASE_G', 0.16, 0, 1, 'Green phase offset, in turns.'),
      sl('PAL_PHASE_B', 0.34, 0, 1, 'Blue phase offset, in turns.'),
    ];
    this.cRoot = sl('PAL_ROOT', 1, 0, 1, 'How hard the chord root drags the '
      + 'whole palette round the hue circle. 1 is the stock behaviour; 0 pins '
      + 'the cloud to the designed colours whatever the music is doing.');
    this.cDrift = sl('PAL_DRIFT', 0.182, 0, 1, 'Slow hue wander, in full turns '
      + 'per MINUTE. The default 0.182 is one turn per ~5.5 minutes; 0 holds '
      + 'the palette exactly where a cue put it.');
    this.cStep = ctl('PAL_STEP', 'float', 1,
      { TYPE: 'toggle', MIN: 0, MAX: 1, DEFAULT: 1,
        DESCRIPTION: 'Step the palette a golden angle round the hue circle on '
          + 'every activation, so a return visit is a different colour of '
          + 'cloud. A palette cue pins the colours and suppresses this too.' });

    this.cSwap = ctl('PAL_SWAP', 'float', 0,
      { TYPE: 'bang counter', MIN: 0, MAX: 1, DEFAULT: 0,
        DESCRIPTION: 'Random complementary palette swap — two near-opposite '
          + 'anchor colours, faded in over a second. Press again for another. '
          + 'A counter rather than a momentary bang so the console can press '
          + 'it from the other end of the room.' });

    this.controls = [this.cBias, this.cAmp, ...this.cFreq, ...this.cPhase,
      this.cRoot, this.cDrift, this.cStep, this.cSwap];
    this._palSwapSeen = undefined;   // adopted, not fired, on the first frame

    /* Effective (post-fade) coefficients, uploaded once per frame. Scratch,
       like everything else in the render path — nothing here allocates. */
    this.effBias = new Float32Array(3);
    this.effAmp = new Float32Array(3);
    this.effFreq = new Float32Array(3);
    this.effPhase = new Float32Array(3);
    this.effRoot = 1;
    this.fadeFrom = null;    // non-null only while a setPalette fade is running
    this.fadeT = 0;
    this.fadeDur = 0;
    this.palPinned = false;  // a cue has taken the colours; stop stepping them
  }

  /* Resolve the control values (the fade TARGET) and, if a fade is running,
     the eased position between where the palette was and where it is going.
     Called once per frame from render(), and once by setPalette() to find out
     what is currently on screen. */
  _effective(dt) {
    const F = this.fadeFrom;
    if (!F) {
      for (let i = 0; i < 3; i++) {
        this.effBias[i] = this.cBias.value[i];
        this.effAmp[i] = this.cAmp.value[i];
        this.effFreq[i] = this.cFreq[i].value;
        this.effPhase[i] = this.cPhase[i].value;
      }
      this.effRoot = this.cRoot.value;
      return;
    }
    this.fadeT += dt;
    const x = Math.min(1, this.fadeT / this.fadeDur);
    const k = x * x * (3 - 2 * x);            // smoothstep, no ease-in jolt
    for (let i = 0; i < 3; i++) {
      this.effBias[i] = F.bias[i] + (this.cBias.value[i] - F.bias[i]) * k;
      this.effAmp[i] = F.amp[i] + (this.cAmp.value[i] - F.amp[i]) * k;
      this.effFreq[i] = F.freq[i] + (this.cFreq[i].value - F.freq[i]) * k;
      this.effPhase[i] = F.phase[i] + (this.cPhase[i].value - F.phase[i]) * k;
    }
    this.effRoot = F.root + (this.cRoot.value - F.root) * k;
    if (x >= 1) this.fadeFrom = null;
  }

  /* A show palette cue. `palette` is {bias,amp,freq,phase} (arrays of 3) plus
     optional `root` and `drift`; any key it leaves out keeps the value the
     control already holds, so a cue can carry just a bias shift.

     Targets go into the CONTROL values immediately — the panel then shows
     where the palette is heading, and _effective() reads those same values
     every frame, which is what makes a mid-fade slider drag retarget the fade
     instead of being overwritten by it. `drift` is a rate, not a colour, so it
     lands whole rather than being interpolated. */
  setPalette(palette, fadeSec) {
    if (!this.ok || !palette || typeof palette !== 'object') return;

    // snapshot what is on screen RIGHT NOW — mid-fade included, so a cue
    // landing on top of a running cue continues from it and never jumps back
    this._effective(0);
    const F = this.fadeFrom || (this.fadeFrom = {
      bias: new Float32Array(3), amp: new Float32Array(3),
      freq: new Float32Array(3), phase: new Float32Array(3), root: 1,
    });
    F.bias.set(this.effBias); F.amp.set(this.effAmp);
    F.freq.set(this.effFreq); F.phase.set(this.effPhase);
    F.root = this.effRoot;

    // this arrives off the network: treat every field as suspect
    const vec = (src, write) => {
      if (!Array.isArray(src) || src.length < 3) return;
      for (let i = 0; i < 3; i++) write(i, Number(src[i]) || 0);
    };
    vec(palette.bias, (i, v) => { this.cBias.value[i] = v; });
    vec(palette.amp, (i, v) => { this.cAmp.value[i] = v; });
    vec(palette.freq, (i, v) => { this.cFreq[i].value = v; });
    vec(palette.phase, (i, v) => { this.cPhase[i].value = v; });
    if (Number.isFinite(palette.root)) this.cRoot.value = palette.root;
    if (Number.isFinite(palette.drift)) this.cDrift.value = palette.drift;

    // 0.001 rather than 0: one divide that can never be by zero, and a
    // one-millisecond fade is a snap by any measure
    this.fadeDur = Math.max(Number(fadeSec) || 0, 0.001);
    this.fadeT = 0;
    /* A cued palette IS the look, so the activation rotation goes with it —
       otherwise the same cue would land on a different hue depending on how
       many times NEBULA happened to have come up earlier in the night, which
       is the one thing a designed per-track palette cannot tolerate. The slow
       drift stays (PAL_DRIFT is the cue's own to zero if it wants a hard pin).
       palStep goes with it: leaving the counter at 4 while the offset it is
       supposed to describe reads 0 is a lie waiting to be believed, and it
       would make the first PALETTE SWAP after a cue jump five golden angles
       instead of one. The cued look IS step 0 now. */
    this.palStep = 0;
    this.palOffset = 0;
    this.palPinned = true;
  }

  /* Random palette, built on a COMPLEMENTARY PAIR. The iq form has a property
     worth exploiting: with bias = (c1+c2)/2 and amp = (c1-c2)/2 the cosine
     oscillates exactly between the two anchor colours, because cos spans
     [-1,1] and bias +/- amp is precisely c1 and c2. So instead of dialling
     eight coefficients and hoping, pick two colours and let the algebra place
     the gradient between them.

     Two anchors near-opposite on the hue circle is what makes a swap read as a
     DIFFERENT nebula rather than a shifted one — the eye is reading the
     contrast between the cloud's lit and shadowed regions, and complementary
     anchors maximise it. The +/-0.08 turn of jitter on the partner keeps it
     off the sterile exact-opposite, and per-channel freq and phase jitter stop
     consecutive swaps from all looking like the same two-tone ramp: the
     channels drift out of step, so the gradient sweeps THROUGH colours on its
     way between the anchors instead of crossfading between them.

     Nothing here can clip. Every anchor channel is in [0,1] (see hsl2rgb), and
     bias +/- |amp| stays inside [min(c1,c2), max(c1,c2)] channel by channel.
     amp is deliberately SIGNED — a negative channel is a phase flip, which is
     half of what the two-anchor form is doing. (The panel's PAL_AMP colour
     picker clamps a negative channel to 0 in its swatch; the value itself is
     untouched until someone actually drags it.)

     `drift` is left alone on purpose: how fast the palette wanders is the
     operator's setting, not a property of the colours. */
  swapPalette(fadeSec = 1.0) {
    const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
    const h1 = Math.random();
    const h2 = h1 + 0.5 + rnd(-0.08, 0.08);
    const c1 = hsl2rgb(h1, rnd(0.65, 1.0), rnd(0.42, 0.62));
    const c2 = hsl2rgb(h2, rnd(0.65, 1.0), rnd(0.42, 0.62));
    const three = (f) => [f(0), f(1), f(2)];
    this.setPalette({
      bias: three((i) => (c1[i] + c2[i]) / 2),
      amp: three((i) => (c1[i] - c2[i]) / 2),
      freq: three(() => rnd(0.35, 0.7)),
      phase: three(() => rnd(-0.06, 0.06)),
      // a light chord-root response: the cloud still answers the music, but
      // the designed contrast is what the eye reads
      root: rnd(0.05, 0.3),
    }, fadeSec);
  }

  /* An explicit operator "give me a different colour" — the backdrop scenes'
     PALETTE SWAP button, and the same button pushed from the console.

     Unconditional, unlike onActivate(): it ignores palPinned and PAL_STEP
     because both of those exist to stop the scene changing colour BY ITSELF,
     and neither is an argument against someone asking for it out loud. A
     golden-angle turn of whatever coefficient set is loaded is the one
     rotation guaranteed to land in a different colour family however many
     times it is pressed, which is exactly what the button promises. */
  stepPalette() {
    /* max(0, ...) skips the -1 sentinel. palStep starts at -1 so that the
       FIRST onActivate() lands on step 0 — the authored colours, unrotated —
       but that makes step 0 the look already on screen, so stepping into it
       from the sentinel would be a button press that visibly does nothing.
       The first press goes straight to step 1. */
    this.palStep = Math.max(0, this.palStep) + 1;
    this.palOffset = this.palStep * PAL_STEP;
  }

  /* Called by the gallery every time this scene becomes the active one — both
     the manual/hash path and the show client's stage changes funnel through
     demos.html's select(). Each activation advances the palette a golden angle
     round the hue circle, so the nebula that comes back after a trip through
     the rest of the gallery is recognisably a different colour of nebula. The
     chord-root response is untouched; this is an offset added on top of it. */
  onActivate() {
    /* Two ways to switch the rotation off: the operator clears PAL_STEP, or a
       show palette cue has taken the colours (palPinned) — in which case the
       cued palette IS the look, and stepping it a golden angle on every stage
       change would be the scene arguing with the cue list. */
    if (this.palPinned || this.cStep.value <= 0.5) return;
    this.palStep += 1;
    this.palOffset = this.palStep * PAL_STEP;
  }

  resize() {
    if (!this.ok) return;
    /* A fixed-size instance has no layout box at all — it is not in the
       document — so fitCanvas would measure 0 and bail on every frame. Its
       drawing buffer was set once in the constructor and stays put. */
    if (this.fixedSize) return;
    // Passed the 4K bench with no margin (no maxDim cap of its own, unlike the
    // syn scenes). Same 2048 long-side cap as mandala as a safety margin — the
    // fbm field is resolution-independent so the upscale is visually free.
    // Read from this.maxDim, not the literal, so the quality slider reaches it.
    if (fitCanvas(this.canvas, 2, this.maxDim)) {
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

    // slow hue wander, in turns per minute (0.182 -> one turn per ~5.5 min,
    // which is the rate this was hard-coded to before it became a control)
    this.palDrift += dt * this.cDrift.value / 60;

    /* PAL_SWAP is a bang COUNTER, watched here rather than wired up outside:
       the panel's button, a console CTRL push and a live-control write all do
       nothing but increment it, so the scene watching its own number move
       serves all three with no host code at all. The first frame ADOPTS
       whatever the counter reads — a preset or a live write that landed before
       this scene ever drew must not fire a swap nobody asked for — and after
       that any increase fires exactly once, however far the number jumped. */
    const sv = Number(this.cSwap.value) || 0;
    const swapSeen = this._palSwapSeen;
    this._palSwapSeen = sv;
    if (swapSeen !== undefined && sv > swapSeen) this.swapPalette(1.0);

    // resolve this frame's palette coefficients (and advance any running fade)
    this._effective(dt);

    // palette phase: chord root when we have one, else the chroma centroid,
    // scaled by PAL_ROOT, then offset by this activation's slot in the hue
    // rotation and the slow drift
    const root = frame.chord ? frame.chord.root / 12 : chromaAngle(frame.chroma);
    const phase = this.effRoot * root + this.palOffset + this.palDrift;

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
    gl.uniform3fv(U.u_palBias, this.effBias);
    gl.uniform3fv(U.u_palAmp, this.effAmp);
    gl.uniform3fv(U.u_palFreq, this.effFreq);
    gl.uniform3fv(U.u_palPhase, this.effPhase);
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
