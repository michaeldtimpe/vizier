/* vizier demo — SYN_NOVA (Synesthesia stock scene "Nova")
   A radial mandala burst over three half-res buffers. It reads more of the
   syn_* surface than any other scene here — Bass/Mid/High level, presence and
   hits, BeatTime, OnBeat, RandomOnBeat, ToggleOnBeat, BPMTri2, BPMTwitcher and
   BPMConfidence — which makes it the best single check on the audio shim.
   ========================================================================== */
'use strict';
import { SynScene } from './syn/syn-runtime.js';

export default class SynNova extends SynScene {
  constructor(canvas) {
    super(canvas, {
      dir: './demos/syn/scenes/nova.synScene',
      maxDim: 900,
    });
  }
}
