/* vizier demo — BLACK
   ============================================================================
   The blackout state: a screen with nothing on it, and nothing running behind
   it. This is what the follower boots into and what `idle` / `done` map to, so
   it is on the TV for hours — far longer than any actual visual — and the
   whole point is that those hours cost nothing.

   So it is not "a scene that draws black". It is a 2D canvas of 8x8 device
   pixels, painted opaque black ONCE, stretched over the display by the CSS
   that already sizes every stage canvas (#stage canvas { width:100%;
   height:100% }). render() is empty: no WebGL context, no shader, no buffer,
   no per-frame work at all. The gallery's rAF loop keeps turning (it owns the
   engine and the panel), but this demo contributes nothing to it.

   Black rather than the page background on purpose: an LED wall or an OLED TV
   showing #000 draws visibly less power and, more to the point, reads as OFF
   to the room instead of as a dark grey rectangle that looks like a fault.
   ========================================================================== */
'use strict';

export default class Black {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.resize();
  }

  resize() {
    // Deliberately not the display size. The CSS stretches whatever is here,
    // and there is no detail to lose in a flat fill.
    if (this.canvas.width !== 8) { this.canvas.width = 8; this.canvas.height = 8; }
    this.paint();
  }

  /* A canvas keeps its bitmap unless resized, but a context can be lost
     (backgrounded tab, GPU reset) — repainting on activation is one fill and
     removes the only way this could ever come back white. */
  onActivate() { this.paint(); }

  paint() {
    if (!this.ctx) return;
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  render() { /* nothing to do, once per frame */ }
}
