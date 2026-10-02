# Offline show render

Renders what the TV showed for a show stage — scenes, cues, palettes, logo,
video inserts — against that stage's audio, frame by frame, into an mp4 with
the original audio on it. No real-time playback, no screen recording, no
dropped frames.

```sh
npm install                                   # once: playwright-core (uses the installed Google Chrome)
./run-all.sh                                  # opener + main, unattended, resumable
node render.mjs --stage main --workers 4      # one stage
node render.mjs --stage main --from 1650 --to 1685 --out /tmp/moon.mp4   # a clip
node render.mjs --stage main --workers 4 --plan                          # show the chunk/worker split
```

Output lands in `~/Movies/party-mountain-2026/pm-2026-<stage>.mp4` (1080p60
H.264 CRF 17, AAC 320k) unless `--out` says otherwise. Intermediate chunks and
the decoded pcm live in `work/` (gitignored, safe to delete once the mp4 exists).

## How it works

The page being rendered is the show's own `demos.html?show=1`: same gallery,
same `show-client.js`, same analysis engine, same scenes. Three things are
swapped out underneath it, all in `shim.js`:

| real thing | replaced by |
|---|---|
| wall clock (`performance.now`, rAF, timers) | a virtual clock that advances exactly 1/60 s per `step()` |
| the deck + `AnalyserNode` | the stage wav's own samples run through the Web Audio spec's analyser maths (Blackman window → FFT → smoothing → dB) at the virtual playhead |
| the follower (`/show/status`, `/show/events`) | a timeline resolved ahead of time by `make_timeline.py`, which imports `follower_server.Box` and runs the **real** cue engine over every frame position |

`render.mjs` serves the repo, steps the page one frame at a time, screenshots
each frame (so the CRT overlay, logo layer and insert `<video>` are all in the
picture, composited by Chrome exactly as on the TV) and pipes them to ffmpeg.

A stage is rendered as **chunks that start on scene cues**, concatenated
losslessly at the end. That is what makes it resumable (`--resume`) and
splittable across `--workers`. A chunk that does not start the stage warms the
analysis engine on the preceding 45 s of audio with the screen BLACK, then lands
the scene on its cue frame as a fresh instance — which is what a scene's first
appearance was on the night too.

## What it is and is not

It is a **faithful re-render, not a recording**:

* scene choice, cue timing, palettes, logo and inserts are the cue files as
  they stand on disk;
* audio reactivity is computed from the same audio by the same engine;
* `Math.random` is seeded, so two renders are the same picture — but not the
  picture the TV happened to draw that night (palette picks, animation phase);
* anything done live on the console (CTRL-tab tweaks without SAVE PRESET,
  manual scene overrides, stage holds) was never logged and is not in it;
* each stage starts with the stage cued at 0 and the deck starting on frame 0.

## Verification

* `node verify-analyser.mjs work/main 300 8` — the stand-in analyser against
  Chrome's real `AnalyserNode` (in an `OfflineAudioContext`) on show audio.
  Measured: worst bin 0.00007 dB apart, both engine configurations.
* `node render.mjs … --debug-frames DIR` then `python3 verify-capture.py DIR` —
  each screenshot scored against the scene canvas read back inside the same
  step, for frames k-1, k, k+1. Measured: 58/58 on k.
* every chunk gets a `.frames.md5` (one hash per captured frame). Re-rendering
  a chunk reproduces it hash for hash; that is how the capture settings below
  were chosen.

## Capture notes (measured on the M1 Max)

* Screenshots are JPEG q95 by default (`--shot png` for lossless): PNG encode
  costs ~100 ms on a busy 1080p frame against ~26 ms, and after the x264 encode
  the two are indistinguishable.
* `step()` waits two real animation frames before returning, so the screenshot
  can never be of a half-committed frame. Without the wait, Chrome's default
  vsync-throttled compositor gave ~7% differing screenshots in a 600-frame
  test, and the unthrottled one glitched in 1 run of 13; with the wait, 10 of
  10 runs were identical, including six running at once.
* `--run-all-compositor-stages-before-draw` hangs headless Chrome on macOS.
  Do not add it.
* Workers scale poorly past ~4 (they share one GPU): one worker ran 32 fps on
  NEBULA, six ran 9 fps each.
* `--max-active-webgl-contexts=64` is set because a whole stage is 30+ scenes
  in one page; Chrome's default drops the oldest GL context past 16.
