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
     media   this scene's output is gated on a media input, so the runtime binds
             its generated stand-in pattern and reports syn_MediaType = 1
     note    a caveat found by demos/tuning/syn_probe.sh — shown on the card,
             and marks it as a known-bad entry in the strip
   ========================================================================== */
'use strict';

export const SYN_SCENES = [
  { name: 'SYN_ALIEN_CAVERN', scene: 'alien_cavern.synScene', maxDim: 768, media: true,
    desc: 'syn: Alien Cavern' },
  { name: 'SYN_BEAMERS', scene: 'beamers.synScene', maxDim: 1280,
    desc: 'syn: Beamers by sheltron - 2d, media, dark, central' },
  { name: 'SYN_CIRCLES5', scene: 'circles5.synScene', maxDim: 1280,
    desc: 'syn: Circles5 by Keijiro Takahashi - 2d, grayscale, feedback, media' },
  { name: 'SYN_CIRCUIT_BENDING', scene: 'circuit_bending.synScene', maxDim: 960,
    desc: 'syn: Circuit Bending by mojovideotech - 3d, raymarching, media, tunnel' },
  { name: 'SYN_CLOUDTEN', scene: 'cloudten.synScene', maxDim: 960,
    desc: 'syn: Cloud Ten by nimitz - 3d, raymarching, realistic' },
  { name: 'SYN_COMPOUND_IRIS', scene: 'compound_iris.synScene', maxDim: 768,
    desc: 'syn: Compound Iris by Meebs - 2d, geometric, dark, media' },
  { name: 'SYN_DEEPER', scene: 'deeper.synScene', maxDim: 1080,
    desc: 'syn: Deeper by Meebs - raymarching, 3d, dark, grayscale' },
  { name: 'SYN_DISPERSION', scene: 'dispersion.synScene', maxDim: 960,
    desc: 'syn: Dispersion by cornusammonis - feedback, media, colorful, reaction-diffusion' },
  { name: 'SYN_FILTER_BLOWN', scene: 'filter_blown.synScene', maxDim: 1280, media: true,
    desc: 'syn: Filter Blown by Meebs - 2d, dark, media, retro' },
  { name: 'SYN_FIRE_TUNNEL', scene: 'fire_tunnel.synScene', maxDim: 1080, media: true,
    desc: 'syn: Fire Tunnel' },
  { name: 'SYN_FRACTILIAN_FOUNDATION', scene: 'fractilian_foundation.synScene', maxDim: 1280,
    desc: 'syn: FractilianFoundation' },
  { name: 'SYN_FUZZY_SIGNAL', scene: 'fuzzy_signal.synScene', maxDim: 768,
    desc: 'syn: Fuzzy Signal by Meebs - glitchy, feedback, colorful, groovy' },
  { name: 'SYN_GLASSIER', scene: 'glassier.synScene', maxDim: 1080,
    desc: 'syn: Glassier by Felix Woitzel - simulation, dark, reaction-diffusion, media' },
  { name: 'SYN_GLITCH', scene: 'glitch.synScene', maxDim: 1080,
    desc: 'syn: Glitch by Meebs ft. XOR - glitch, colorful, media' },
  { name: 'SYN_GLOB', scene: 'glob.synScene', maxDim: 1080,
    desc: 'syn: Glob by Nimitz - 3d, raymarching, dark, glitchy' },
  { name: 'SYN_HEXOPLANET', scene: 'hexoplanet.synScene', maxDim: 1080,
    desc: 'syn: based on pattern from 104 shader https://www.shadertoy.com/view/ltlSW4 displaced on ball you can comment line 4 il you want...' },
  { name: 'SYN_HEXTUNNEL', scene: 'hextunnel.synScene', maxDim: 1080, media: true,
    desc: 'syn: raymarch hex tunnel day3' },
  { name: 'SYN_HEX_ARRAY', scene: 'hex_array.synScene', maxDim: 1080,
    desc: 'syn: Hex Array by sheltron - 3d, raymarching, dark, tunnel' },
  { name: 'SYN_HILLS_EELS', scene: 'hills_eels.synScene', maxDim: 960, media: true,
    desc: 'syn: Hills, Eels by Victor S. - feedback, media, 2d, colorful' },
  { name: 'SYN_HUE_REVIEW', scene: 'hue_review.synScene', maxDim: 1080,
    desc: 'syn: Hue Review by Meebs - feedback, media, dark, psychedelic' },
  { name: 'SYN_INKSHOT', scene: 'inkshot.synScene', maxDim: 1280,
    desc: 'syn: Ink Shot by Meebs - glitchy, media, 2d, psychedelic' },
  { name: 'SYN_KALEIDOWHOA_MAN', scene: 'kaleidowhoa_man.synScene', maxDim: 1080,
    desc: 'syn: kalidescopes whoa' },
  { name: 'SYN_KIFS_FLYTHROUGH', scene: 'kifs_flythrough.synScene', maxDim: 960,
    desc: 'syn: Constructing a basic fractal object with Knighty\'s Kaleidoscopic IFS procedure.' },
  { name: 'SYN_LATTIX', scene: 'lattix.synScene', maxDim: 960,
    desc: 'syn: lattix by Anonymous - infinite, raymarching, 3d, glitchy' },
  { name: 'SYN_LOST_IN_THE_SAUCE', scene: 'lost_in_the_sauce.synScene', maxDim: 960, media: true,
    desc: 'syn: Lost in the Sauce by Keijiro Takahashi x Meebs - feedback, media, groovy, colorful' },
  { name: 'SYN_MANA', scene: 'mana.synScene', maxDim: 1280, media: true,
    desc: 'syn: From the Synesthesia archive, original artist is Alex Rowe' },
  { name: 'SYN_MIN_MAX_HEX', scene: 'min_max_hex.synScene', maxDim: 1280,
    desc: 'syn: Min Max Hex by Meebs - feedback, grayscale, 2d, geometric' },
  { name: 'SYN_MOLTEN', scene: 'molten.synScene', maxDim: 960,
    desc: 'syn: Molten by Meebs ft. Flexi - realistic, 3d, dark' },
  { name: 'SYN_MYOPLASM', scene: 'myoplasm.synScene', maxDim: 1280,
    desc: 'syn: Myoplasm by Alex Rowe - groovy, particles, dark' },
  { name: 'SYN_PARTY_DOODAD', scene: 'party_doodad.synScene', maxDim: 640,
    desc: 'syn: Based on "@Party Concert Visuals 2020" by the endlessly clever Blackle Mori. See Blackle\'s creations at shadertoy.com/user/blackle/' },
  { name: 'SYN_PLUS', scene: 'PLUS.synScene', maxDim: 1080, note: 'very sparse output',
    desc: 'syn: PLUS by Meebs - 2d, grayscale, media' },
  { name: 'SYN_POP', scene: 'pop.synScene', maxDim: 1080,
    desc: 'syn: Pop by Meebs - 2d, colorful, retro' },
  { name: 'SYN_PRIMITIV_LOGIK', scene: 'primitiv_logik.synScene', maxDim: 960,
    desc: 'syn: PRIMITIV_logik by Meebs - 2d, geometric, retro' },
  { name: 'SYN_QUICKSAND', scene: 'quicksand.synScene', maxDim: 1080,
    desc: 'syn: Quicksand by Meebs - feedback, media, glitchy, fluid' },
  { name: 'SYN_RAYMARCHED_REFLECTIONS', scene: 'raymarched_reflections.synScene', maxDim: 640, media: true,
    desc: 'syn: A very basic demonstration of raymarching a distance field with reflections and shadows. Definitely not cutting edge, but...' },
  { name: 'SYN_RAY_MARCHING_EXPERIMENT_62', scene: 'ray_marching_experiment_62.synScene', maxDim: 640,
    desc: 'syn: Ray Marching Experiment 62 with another lighting try :)' },
  { name: 'SYN_REPLIK8', scene: 'replik8.synScene', maxDim: 960,
    desc: 'syn: replik8 by Meebs - 2d, geometric, grayscale, media' },
  { name: 'SYN_SCAFFOLD_FRACTAL', scene: 'scaffold_fractal.synScene', maxDim: 960,
    desc: 'syn: Scaffold Fractal by Meebs - fractal, raymarching, dark, infinite' },
  { name: 'SYN_SHROUDED', scene: 'shrouded.synScene', maxDim: 960,
    desc: 'syn: Shrouded by Felix Woitzel ft. Meebs - feedback, simulation, media, reaction-diffusion' },
  { name: 'SYN_SINUSOIDAL_WARP', scene: 'sinusoidal_warp.synScene', maxDim: 1280,
    desc: 'syn: Sinusoidal warp.' },
  { name: 'SYN_SPRINKLES', scene: 'sprinkles.synScene', maxDim: 960,
    desc: 'syn: Sprinkles by sheltron ft. Meebs - media, simulation, reaction-diffusion, dark' },
  { name: 'SYN_SQUARE_SHOALS', scene: 'square_shoals.synScene', maxDim: 1280,
    desc: 'syn: SquareShoals by Alex Rowe - media, feedback, dark, abstract' },
  { name: 'SYN_STAINED_GLASS', scene: 'stained_glass.synScene', maxDim: 1080,
    desc: 'syn: Stained Glass by Meebs - media, psychedelic, abstract' },
  { name: 'SYN_TEST_CARD', scene: 'test_card.synScene', maxDim: 1280,
    desc: 'syn: Test Card by Keijiro Takahashi - utility' },
  { name: 'SYN_TRACED_TUNNEL', scene: 'traced_tunnel.synScene', maxDim: 640,
    desc: 'syn: A multipass reflective box tunnel with some random reflective ray scattering thrown in. Basically, it\'s just a remake of W23\'s...' },
  { name: 'SYN_TRANSPARENT_ISOSLICES', scene: 'transparent_isoslices.synScene', maxDim: 768,
    desc: 'syn: A transparent organic field partitioned horizontally into 2D isosurface slices.' },
  { name: 'SYN_TUNNEL_BEAUTY_6', scene: 'tunnel_beauty_6.synScene', maxDim: 960, media: true,
    desc: 'syn: i have the limit of the float after a certain time, and some noise appears :) you can increase the iteration at line 86 to have...' },
  { name: 'SYN_WATERLY', scene: 'waterly.synScene', maxDim: 1280,
    desc: 'syn: Distort media with noise.' },
];

export default SYN_SCENES;
