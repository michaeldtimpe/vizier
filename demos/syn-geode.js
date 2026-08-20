/* vizier demo — SYN_GEODE (Synesthesia stock scene "Voronoi Geode", by Shane)
   Raymarched 2nd-order Voronoi: a perspex web lattice over crystal cells, lit
   with fake environment mapping and geometric edge detection. Single pass, and
   self-contained — its colour comes from two bundled agate textures rather than
   user media, which is why it survives the port with its character intact.
   script.js integrates a BPM-stepped clock and per-band timers that drive the
   crystal gyration and the camera.
   ========================================================================== */
'use strict';
import { SynScene } from './syn/syn-runtime.js';

export default class SynGeode extends SynScene {
  constructor(canvas) {
    super(canvas, {
      dir: './demos/syn/scenes/voronoi_geode.synScene',
      maxDim: 560,   // GPU:5-class raymarcher with a 2nd-order Voronoi inner loop
    });
  }
}
