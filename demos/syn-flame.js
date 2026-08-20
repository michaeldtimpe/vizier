/* vizier demo — SYN_FLAME (Synesthesia stock scene "Dynamical Flame")
   A reaction-diffusion flame by cornusammonis: a two-buffer ping-pong
   simulation (BuffA integrates, BuffA2 mirrors it) rendered through a normal-
   mapped glassy surface. Pure feedback — no script.js — so what it tests is the
   runtime's buffer semantics and the bass/presence uniforms that stoke it.

   REACTION RATE (added here, not in the scene)
   -------------------------------------------
   On a big screen the stock sim churns: it integrates once per RENDERED frame
   with no dt term anywhere, so at 60 fps it boils, and the audio reaction lands
   as a flicker rather than a swell. The scene ships no control for that.

   The lever is the state update at the end of the BuffA pass. The sim is a map
   u -> F(u): every frame writes vec4(du, dv), the fully-integrated next state,
   over the old one. Mixing the new state back toward the old by `reaction_rate`

       u_next = u + rate * (F(u) - u)

   is explicit Euler with step `rate` on exactly the same map — the fixed points
   and the shapes are untouched, the dynamics simply run at `rate` times speed,
   and rate = 1.0 is bit-for-bit the original. That is why the control is a
   rate, not a gain on the audio uniforms: damping the uniforms would flatten
   the flame's response, where this slows the whole system and lets a bass hit
   bloom over a second instead of a frame.

   It is applied through SynScene's `patches` hook rather than by editing
   main.glsl, because demos/syn/scenes/ is licensed content and gitignored: a
   re-import of the scene folder would silently drop an edit made there, and
   would not touch this file.
   ========================================================================== */
'use strict';
import { SynScene } from './syn/syn-runtime.js';

/* The scene's own line, verbatim, and the same line with the mix. `u` is the
   previous state at this texel (read at the top of renderPassA); du/dv are the
   integrated new one. */
const STATE_WRITE = 'fragColor = vec4(du, dv);';
const STATE_WRITE_RATE = 'fragColor = mix(u, vec4(du, dv), reaction_rate);';

/* Presented to the panel exactly like a scene.json CONTROLS entry, because
   that is what it becomes: the runtime declares a uniform per control and
   uploads `.value` every pass, the panel builds a widget from `spec`, and the
   preset system stores it by name. DEFAULT 1.0 == stock behaviour. */
const REACTION_CONTROL = {
  NAME: 'reaction_rate',
  DESCRIPTION: 'How fast the flame simulation runs and reacts. 1.00 is the '
             + 'scene as shipped; lower makes the whole system evolve (and '
             + 'answer the music) more slowly. Costs nothing — the sim does '
             + 'the same work, it just takes smaller steps.',
  TYPE: 'slider',
  DEFAULT: 1.0,
  MIN: 0.05,
  MAX: 1.0,
  UI_GROUP: 'reactivity',
};

export default class SynFlame extends SynScene {
  constructor(canvas) {
    super(canvas, {
      dir: './demos/syn/scenes/dynamical_flame.synScene',
      maxDim: 640,   // a per-pixel sim: cost is quadratic in buffer size
      patches: [[STATE_WRITE, STATE_WRITE_RATE]],
    });
  }

  /* Runs inside _load(), before _compile() declares a uniform per control —
     which is the only reason a control the scene never authored can exist. */
  _buildControls(scene) {
    super._buildControls(scene);
    if (!this.controls.some((c) => c.name === REACTION_CONTROL.NAME)) {
      this.controls.push({
        name: REACTION_CONTROL.NAME,
        glsl: 'float',
        value: REACTION_CONTROL.DEFAULT,
        def: REACTION_CONTROL.DEFAULT,
        spec: REACTION_CONTROL,
      });
    }
  }
}
