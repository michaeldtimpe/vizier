/* vizier demo — SYN_FLAME (Synesthesia stock scene "Dynamical Flame")
   A reaction-diffusion flame by cornusammonis: a two-buffer ping-pong
   simulation (BuffA integrates, BuffA2 mirrors it) rendered through a normal-
   mapped glassy surface. Pure feedback — no script.js — so what it tests is the
   runtime's buffer semantics and the bass/presence uniforms that stoke it.
   ========================================================================== */
'use strict';
import { SynScene } from './syn/syn-runtime.js';

export default class SynFlame extends SynScene {
  constructor(canvas) {
    super(canvas, {
      dir: './demos/syn/scenes/dynamical_flame.synScene',
      maxDim: 640,   // a per-pixel sim: cost is quadratic in buffer size
    });
  }
}
