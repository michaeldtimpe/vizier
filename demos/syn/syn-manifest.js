/* demos/syn/syn-manifest.js — the imported Synesthesia scene roster
   ============================================================================
   One entry per .synScene folder under demos/syn/scenes/, generated from the
   scenes' own scene.json (TITLE / CREDIT / DESCRIPTION / TAGS / GPU). The
   gallery imports this statically: it is metadata only, a few KB, and no shader
   is fetched until a scene is actually selected.

     name    gallery + URL-hash id, SYN_<SLUG>. `media` entries display with a
             trailing '*', but the hash matches either spelling.
     scene   folder name under demos/syn/scenes/ (gitignored — licensed content)
     maxDim  render-buffer cap, from the scene's own GPU cost rating (1..5):

                 GPU 1 -> 1280   GPU 2 -> 1080   GPU 3 -> 960
                 GPU 4 ->  768   GPU 5 ->  640

             THIS TABLE IS THE ONE PLACE TO RETUNE. The rows below were bumped
             from the original 896/768/672/576/512 once the gallery grew a
             quality slider — the panel multiplies these by 0.5x..2.5x live
             (demos.html, QUALITY section), so these are the 1.0x reference,
             not a ceiling. A weaker machine wants the whole table scaled down
             rather than the slider parked off-centre.
     backdrop this scene is one of the pre-ATTLAS black-and-white looks, and
             reads well with NEBULA showing through its white areas. demos.html
             renders a shared hidden nebula and hands it to the runtime, which
             keys it in at the final blit; the runtime gives the scene two
             synthetic controls (BACKDROP_NEBULA / BACKDROP_MIX) so the operator
             can turn it off per scene. Nothing here reaches the scene's shader.
     media   this scene's output is gated on a media input, so the runtime binds
             its generated stand-in pattern and reports syn_MediaType = 1
     note    a caveat found by demos/tuning/syn_probe.sh — shown on the card,
             and marks it as a known-bad entry in the strip
   ========================================================================== */
'use strict';

export const SYN_SCENES = [
  { name: 'ALIEN_CAVERN', scene: 'alien_cavern.synScene', maxDim: 768, media: true,
    desc: 'Alien Cavern' },
  { name: 'BEAMERS', scene: 'beamers.synScene', maxDim: 1280,
    desc: 'Beamers by sheltron - 2d, media, dark, central' },
  { name: 'CIRCLES5', scene: 'circles5.synScene', maxDim: 1280, backdrop: true,
    desc: 'Circles5 by Keijiro Takahashi - 2d, grayscale, feedback, media' },
  { name: 'CIRCUIT_BENDING', scene: 'circuit_bending.synScene', maxDim: 960,
    desc: 'Circuit Bending by mojovideotech - 3d, raymarching, media, tunnel' },
  { name: 'CLOUDTEN', scene: 'cloudten.synScene', maxDim: 960,
    desc: 'Cloud Ten by nimitz - 3d, raymarching, realistic' },
  { name: 'COMPOUND_IRIS', scene: 'compound_iris.synScene', maxDim: 768, backdrop: true,
    desc: 'Compound Iris by Meebs - 2d, geometric, dark, media' },
  { name: 'DEEPER', scene: 'deeper.synScene', maxDim: 1080,
    desc: 'Deeper by Meebs - raymarching, 3d, dark, grayscale' },
  { name: 'DISPERSION', scene: 'dispersion.synScene', maxDim: 960,
    desc: 'Dispersion by cornusammonis - feedback, media, colorful, reaction-diffusion' },
  { name: 'FILTER_BLOWN', scene: 'filter_blown.synScene', maxDim: 1280, media: true,
    desc: 'Filter Blown by Meebs - 2d, dark, media, retro' },
  { name: 'FIRE_TUNNEL', scene: 'fire_tunnel.synScene', maxDim: 1080, media: true,
    desc: 'Fire Tunnel' },
  { name: 'FRACTILIAN_FOUNDATION', scene: 'fractilian_foundation.synScene', maxDim: 1280,
    desc: 'FractilianFoundation' },
  { name: 'FUZZY_SIGNAL', scene: 'fuzzy_signal.synScene', maxDim: 768, backdrop: true,
    desc: 'Fuzzy Signal by Meebs - glitchy, feedback, colorful, groovy' },
  { name: 'GLASSIER', scene: 'glassier.synScene', maxDim: 1080,
    desc: 'Glassier by Felix Woitzel - simulation, dark, reaction-diffusion, media' },
  { name: 'GLITCH', scene: 'glitch.synScene', maxDim: 1080,
    desc: 'Glitch by Meebs ft. XOR - glitch, colorful, media' },
  { name: 'GLOB', scene: 'glob.synScene', maxDim: 1080,
    desc: 'Glob by Nimitz - 3d, raymarching, dark, glitchy' },
  { name: 'HEXOPLANET', scene: 'hexoplanet.synScene', maxDim: 1080,
    desc: 'based on pattern from 104 shader https://www.shadertoy.com/view/ltlSW4 displaced on ball you can comment line 4 il you want...' },
  { name: 'HEXTUNNEL', scene: 'hextunnel.synScene', maxDim: 1080, media: true,
    desc: 'raymarch hex tunnel day3' },
  { name: 'HEX_ARRAY', scene: 'hex_array.synScene', maxDim: 1080,
    desc: 'Hex Array by sheltron - 3d, raymarching, dark, tunnel' },
  { name: 'HILLS_EELS', scene: 'hills_eels.synScene', maxDim: 960, media: true,
    desc: 'Hills, Eels by Victor S. - feedback, media, 2d, colorful' },
  { name: 'HUE_REVIEW', scene: 'hue_review.synScene', maxDim: 1080,
    desc: 'Hue Review by Meebs - feedback, media, dark, psychedelic' },
  { name: 'INKSHOT', scene: 'inkshot.synScene', maxDim: 1280,
    desc: 'Ink Shot by Meebs - glitchy, media, 2d, psychedelic' },
  { name: 'KALEIDOWHOA_MAN', scene: 'kaleidowhoa_man.synScene', maxDim: 1080,
    desc: 'kalidescopes whoa' },
  { name: 'KIFS_FLYTHROUGH', scene: 'kifs_flythrough.synScene', maxDim: 960,
    desc: 'Constructing a basic fractal object with Knighty\'s Kaleidoscopic IFS procedure.' },
  { name: 'LATTIX', scene: 'lattix.synScene', maxDim: 960,
    desc: 'lattix by Anonymous - infinite, raymarching, 3d, glitchy' },
  { name: 'LOST_IN_THE_SAUCE', scene: 'lost_in_the_sauce.synScene', maxDim: 960, media: true,
    desc: 'Lost in the Sauce by Keijiro Takahashi x Meebs - feedback, media, groovy, colorful' },
  { name: 'MANA', scene: 'mana.synScene', maxDim: 1280, media: true,
    desc: 'From the Synesthesia archive, original artist is Alex Rowe' },
  { name: 'MIN_MAX_HEX', scene: 'min_max_hex.synScene', maxDim: 1280, backdrop: true,
    desc: 'Min Max Hex by Meebs - feedback, grayscale, 2d, geometric' },
  { name: 'MOLTEN', scene: 'molten.synScene', maxDim: 960,
    desc: 'Molten by Meebs ft. Flexi - realistic, 3d, dark' },
  { name: 'MYOPLASM', scene: 'myoplasm.synScene', maxDim: 1280,
    desc: 'Myoplasm by Alex Rowe - groovy, particles, dark' },
  { name: 'PARTY_DOODAD', scene: 'party_doodad.synScene', maxDim: 640,
    desc: 'Based on "@Party Concert Visuals 2020" by the endlessly clever Blackle Mori. See Blackle\'s creations at shadertoy.com/user/blackle/' },
  { name: 'PLUS', scene: 'PLUS.synScene', maxDim: 1080, backdrop: true, note: 'very sparse output',
    desc: 'PLUS by Meebs - 2d, grayscale, media' },
  { name: 'POP', scene: 'pop.synScene', maxDim: 1080,
    desc: 'Pop by Meebs - 2d, colorful, retro' },
  { name: 'PRIMITIV_LOGIK', scene: 'primitiv_logik.synScene', maxDim: 960,
    desc: 'PRIMITIV_logik by Meebs - 2d, geometric, retro' },
  { name: 'QUICKSAND', scene: 'quicksand.synScene', maxDim: 1080,
    desc: 'Quicksand by Meebs - feedback, media, glitchy, fluid' },
  { name: 'RAYMARCHED_REFLECTIONS', scene: 'raymarched_reflections.synScene', maxDim: 640, media: true,
    desc: 'A very basic demonstration of raymarching a distance field with reflections and shadows. Definitely not cutting edge, but...' },
  { name: 'RAY_MARCHING_EXPERIMENT_62', scene: 'ray_marching_experiment_62.synScene', maxDim: 640,
    desc: 'Ray Marching Experiment 62 with another lighting try :)' },
  { name: 'REPLIK8', scene: 'replik8.synScene', maxDim: 960, backdrop: true,
    desc: 'replik8 by Meebs - 2d, geometric, grayscale, media' },
  { name: 'SCAFFOLD_FRACTAL', scene: 'scaffold_fractal.synScene', maxDim: 960,
    desc: 'Scaffold Fractal by Meebs - fractal, raymarching, dark, infinite' },
  { name: 'SHROUDED', scene: 'shrouded.synScene', maxDim: 960,
    desc: 'Shrouded by Felix Woitzel ft. Meebs - feedback, simulation, media, reaction-diffusion' },
  { name: 'SINUSOIDAL_WARP', scene: 'sinusoidal_warp.synScene', maxDim: 1280,
    desc: 'Sinusoidal warp.' },
  { name: 'SPRINKLES', scene: 'sprinkles.synScene', maxDim: 960,
    desc: 'Sprinkles by sheltron ft. Meebs - media, simulation, reaction-diffusion, dark' },
  { name: 'SQUARE_SHOALS', scene: 'square_shoals.synScene', maxDim: 1280,
    desc: 'SquareShoals by Alex Rowe - media, feedback, dark, abstract' },
  { name: 'STAINED_GLASS', scene: 'stained_glass.synScene', maxDim: 1080,
    desc: 'Stained Glass by Meebs - media, psychedelic, abstract' },
  { name: 'TEST_CARD', scene: 'test_card.synScene', maxDim: 1280,
    desc: 'Test Card by Keijiro Takahashi - utility' },
  { name: 'TRACED_TUNNEL', scene: 'traced_tunnel.synScene', maxDim: 640,
    desc: 'A multipass reflective box tunnel with some random reflective ray scattering thrown in. Basically, it\'s just a remake of W23\'s...' },
  { name: 'TRANSPARENT_ISOSLICES', scene: 'transparent_isoslices.synScene', maxDim: 768,
    desc: 'A transparent organic field partitioned horizontally into 2D isosurface slices.' },
  { name: 'TUNNEL_BEAUTY_6', scene: 'tunnel_beauty_6.synScene', maxDim: 960, media: true,
    desc: 'i have the limit of the float after a certain time, and some noise appears :) you can increase the iteration at line 86 to have...' },
  { name: 'WATERLY', scene: 'waterly.synScene', maxDim: 1280,
    desc: 'Distort media with noise.' },
];

export default SYN_SCENES;
