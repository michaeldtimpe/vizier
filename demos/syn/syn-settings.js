/* demos/syn/syn-settings.js — live global knobs for the Synesthesia shim
   ============================================================================
   Two plain objects, mutated in place by whoever owns the UI (demos.html's
   control panel) and read every frame by the shim. Deliberately its own tiny
   module rather than an export off syn-runtime.js: the gallery imports this
   statically so the panel can exist before any scene is opened, while the 84 KB
   runtime stays behind the dynamic import that only fires on the first syn
   scene.

   Nothing here is per-scene. A SynScene instance's own `controls[]` (from its
   scene.json) is the per-scene surface, and the panel mutates that directly.

   Mutate the FIELDS, never the objects — syn-audio.js / syn-runtime.js hold the
   same references for the life of the page.
   ========================================================================== */
'use strict';

/* Audio gains, read at the top of SynAudio.update()/writeUniforms(). All are
   multipliers with 1 == untouched; the panel offers 0..4.

   These are applied AFTER the shim's own normalizers, not before. Scaling the
   raw band energy going in would be a no-op: the level normalizer is a running
   peak (max(peak*decay, raw)), so a 2x input just moves the peak 2x on the same
   frame and divides straight back out. Post-normalization is also what makes
   the gains mean what a VJ expects — "make the mids drive this scene harder". */
export const SYN_GAIN = {
  master: 1,           // whole-mix level: syn_Level, Presence, Time rates, ...
  band: [1, 1, 1, 1],  // bass, mid, midhigh, high — the syn_*Level families
  hits: 1,             // transient sensitivity: the syn_*Hits envelopes
};

/* Colour grade, applied in the shim's final blit pass (see BLIT_FS in
   syn-runtime.js) — so it covers every syn scene and nothing else. The two
   native WebGL demos composite themselves and are unaffected. */
export const SYN_GRADE = {
  hue: 0,        // radians, -PI..PI
  sat: 1,        // 0 == luma only, 1 == untouched, 2 == doubled chroma
  gamma: 1,      // pow() exponent; < 1 lifts shadows
  exposure: 1,   // linear multiplier before the gamma
};

/* True when the grade is a no-op, so the blit can skip the maths. */
export const gradeIsNeutral = (g) =>
  g.hue === 0 && g.sat === 1 && g.gamma === 1 && g.exposure === 1;
