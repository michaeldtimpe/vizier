# vizier

A real-time, in-browser music visualizer with a **pluggable visualization
layer**. One shared analysis engine turns audio (mic, local files, or an idle
shimmer) into a per-frame pitch/energy snapshot; any number of visualizers draw
that snapshot however they like. Ships with two: a CRT **Wheel** (pitch-class
trails) and a 3D **Grid** (an EQ / spectral cube landscape).

> Attribution: the analysis pipeline and the Wheel visualization were
> reverse-engineered from the original **waveloop** by neynt
> (`saltblock.neynt.ca/waveloop.html`). vizier splits that single page into an
> engine + swappable visualizers and adds the Grid visualizer, its FX, local
> file playback, fullscreen, and the guide/label toggles.

---

## Architecture

The split is along the natural seam between **analysis** (audio → a pitch-class
energy field) and **visualization** (that field → pixels):

| File | Role |
|------|------|
| `vizier-analysis.js` | **AnalysisEngine** — audio sources (mic / file+CQT / idle sim), dual-resolution FFT, the 6-layer audio DSP stage, the fold onto the pitch-class circle, makeup gain, per-angle AGC, display smoothing, chord detection, level/beat. Emits a `ChromaFrame` each tick. No DOM, no rendering. |
| `vizier-visualizer.js` | **WheelVisualizer** — the CRT pitch-class wheel (WebGL): amplitude-driven radial trails + a stacked-register rim. |
| `vizier-grid.js` | **GridVisualizer** — a rotating grid of cubes (Canvas2D + a tiny software-3D pipeline): an EQ / spectral landscape with layerable FX. |
| `vizier.html` | Host page: markup + CSS, wires the deck / DSP / mic / viz-switch / FX UI to the engine, and runs the loop pumping frames engine → active visualizer. |

There is one shared **AnalysisEngine** (a single audio pipeline per page) and
any number of **visualizers**, each owning its own canvas. Switching a
visualizer just toggles which canvas is shown and which one gets `render()`.

## The boundary: ChromaFrame

Every `engine.update(nowSec)` returns one frame (full field documented at the
foot of `vizier-analysis.js`):

```
{
  ang: 256, nreg: 4, rimRegs: 48,        // geometry
  fLo, fHi, octSpan, eMax,
  energy [nreg*ang],                      // smoothed, AGC-normalized energy per band/angle
  r, g, b [nreg*ang],                     // register color per band/angle
  rim [rimRegs*ang],                      // register histogram (register-major): index = reg*ang + angle
  chroma [12],                            // 12-bin chroma, index 0 = A
  chord: {name, root, pcs, conf} | null,  // detected chord (hysteresis applied)
  chordConf, level, beat, mode
}
```

Index a band/angle cell as `band * ang + angle`. Angle 0 is A at 12 o'clock,
ascending clockwise. The typed arrays are the engine's live buffers — read them
within the frame; they're overwritten on the next `update()`.

Helpers exported from `vizier-analysis.js` for visualization authors: `SPEC`
(the geometry constants), `regColor(o)` / `REG_LUT` (the register→sRGB Oklch
ramp the engine colors by), `oklchToSrgb`, `NOTE_NAMES`, `DSP_PRESETS`.

---

## The visualizers

### Wheel
Pitch-class wheel: angle = pitch class (A at top, ascending clockwise). Each
history row of energy flies outward at a speed set by its own amplitude (loud
notes shoot for the corners, quiet ones linger by the ring), colored by register
in a continuous Oklch ramp, with a leading rim that stacks simultaneous octaves
of a pitch class into a register gradient. The center shows the detected chord.

### Grid
A slowly rotating square of gap-separated cubes, driven as an EQ / spectral
surface. Two arrangements, cross-faded by the **EQ** FX:

- **default** — rows = register (BASS front → TREBLE back), columns sweep the
  pitch classes, so a note lights its column across the octaves it occupies.
- **EQ slide** — the whole log-frequency spectrum is unwrapped row-by-row across
  the grid; each row is a contiguous slice of the spectrum (low front → high
  back), so walking cell-by-cell walks up the spectrum.

Cube hue tracks the current key (chord root, or dominant pitch class); taller
cubes read brighter. Four independent **FX** layers:

- **Pulse** — beat-driven brightness / hue / height pulse, with a continuous throb.
- **Sweep** — a light band travelling across the frequency axis.
- **EQ** — the arrangement morph above (eases in/out).
- **Fog** — drifting, key-tinted haze behind and in front of the cubes.

Tunables for the Grid are grouped at the top of `vizier-grid.js`
(`GRID_N`, `MAX_STACK`, `CUBE`, `TILT`, `ROT_SPEED`, `CY_FRAC`, `FILL_FRAC`,
`PULSE_HZ`, `SWEEP_*`, `FOG_BLOBS`, `DPR_CAP`).

---

## Controls

Header buttons: **Wheel / Grid** (visualizer), **Mic**, **File**, **Guides**,
**Full**. In Grid mode the FX chips **Pulse / Sweep / EQ / Fog** appear.

- **Mic** — react to real sound through the microphone (stays in the browser).
- **File** — play audio file(s) from disk; drag-and-drop onto the page also
  works. Ad-hoc files use the live FFT analyser (no precomputed CQT sidecar).
- **Guides** — hide the wheel's guide lines + note labels + chord readout (or the
  grid's corner labels) for a clean visual.
- **Full** — fullscreen, immersive (controls hidden); Escape exits.

Keyboard: **V** switch visualizer · **G** toggle guides · **F** fullscreen ·
**Esc** exit fullscreen.

The bottom-left **DSP** panel and bottom-right **deck** are the shared audio
controls (spectral post-processing, and the track deck / transport / visual
sync). These affect the `ChromaFrame`, so they apply to whichever visualizer is
active.

## Adding your own visualization

A visualizer is any object with two methods:

```js
class MyViz {
  constructor(canvas) { /* set up your renderer on this canvas */ }
  resize() { /* fit the canvas to its CSS size */ }
  render(frame, now, dt) { /* draw one ChromaFrame */ }
}
```

Optionally add `setGuides(on)` / `getGuides()` if your viz has reference
overlays to toggle. Then, in `vizier.html`: give it a `<canvas>`, construct
it, and add it to the `VIZ` map next to `wheel` and `grid`. The render loop and
the Wheel/Grid-style switch handle the rest. Everything else — engine, deck,
DSP, mic, file loading, fullscreen — is independent of which visualizer runs.

## Running

These are ES modules and the deck fetches `waveloop/tracks.json`, so the page
must be served over `http(s)` (not opened as a `file://` URL):

```sh
python3 -m http.server 8000   # then open http://localhost:8000/vizier.html
```

Local files (via the File button / drag-drop) and mic mode work without any
server-side track data. The optional deck reads a track layout under the
directory named by the engine's `basePath` option (default `waveloop/`):
`waveloop/tracks.json`, `waveloop/audio/`, `waveloop/analysis/*.vqt.gz`.

## Show mode — following a show-view rig (`demos/show/`)

`demos.html?show=1` turns the gallery into a follower for the ARCHE show
console (`../show-view`, a separate repo) running on another machine. The
leader's browser drives it over the LAN; nothing here reaches back.

```sh
demos/show/follower_server.py          # serves this repo on :8123 + /show/*
open 'http://localhost:8123/demos.html?show=1'
demos/show/deploy-neo.sh neo           # push + (re)load both LaunchAgents
```

- **`follower_server.py`** replaces `python3 -m http.server` on the TV machine:
  same static serving, plus a desired-state box the leader POSTs to
  (`/show/stage`, `/show/scene`, `/show/sync`) and the page long-polls
  (`/show/events`). CORS-open, stdlib only. `--audio-dir` points it at the show
  wavs, which it serves by basename with Range support.
- **`stage_map.json`** is the cue list — show-view sends a STAGE NAME and this
  file decides the scene and whether the logo is up. It is the only copy:
  show-view's VISUALS menu displays whatever `/show/status` reports.
- **`config.json`** — `audible` must stay `false` on the TV machine. The mute is
  a GainNode at 0 *after* the analyser tap (`AnalysisEngine.setOutputGain`), so
  the scenes stay fully reactive while the machine is silent; `element.muted`
  would have starved the analyser instead.
- **`?show=1` is inert otherwise** — `demos/show/show-client.js` is dynamically
  imported only when the flag is present, and the logo layer is `display:none`
  without it.
- The LaunchAgents run out of `~/arche/vizier`, not `~/Downloads/vizier`: macOS
  TCC blocks launchd-spawned processes from the Downloads folder. `deploy-neo.sh`
  maintains that copy and hard-links the wavs somewhere readable.

## Notes

- The default data directory is still `waveloop/` (the engine's `basePath`
  option), kept for continuity with the source project's track layout; point it
  anywhere by passing a different `basePath` when constructing the engine.
- No build step, no dependencies — plain ES modules, WebGL1, and Canvas2D.
