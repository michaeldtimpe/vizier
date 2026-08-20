/* vizier demo — SYN_MAGNETISMIC (Synesthesia marketplace scene "Magnetismic")
   A swirling sphere of raymarched fractal noise — glass marble one moment,
   solar flare the next. One persistent backbuffer; script.js integrates two
   clocks from syn_Intensity and syn_BassLevel that set how fast the field
   churns, so the scene stalls in silence and boils when the track opens up.
   ========================================================================== */
'use strict';
import { SynScene } from './syn/syn-runtime.js';

export default class SynMagnetismic extends SynScene {
  constructor(canvas) {
    super(canvas, {
      dir: './demos/syn/scenes/magnetismic.synScene',
      maxDim: 720,   // GPU:4 raymarcher
    });
  }
}
