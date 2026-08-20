# demo tuning + scene triage

Three harnesses, all driving `demos.html`'s engine from headless Chrome. All
require `python3 -m http.server 8123` already running from the repo root.

**Every Chrome launch here passes `--mute-audio`, and must keep doing so.** The
harnesses play the local deck for real so the demos have something to react to;
without that flag the mix comes out of the speakers of whoever is at the
machine. Muting only silences the output device — the Web Audio analyser still
receives every sample, so nothing about the capture changes.

## capture.sh — screenshots of one demo

`./capture.sh DEMO_NAME FRAME_COUNT INTERVAL_SEC OUTPUT_DIR [DELAY_SEC]` grabs N
PNG frames of one demo from real, playing audio — e.g.

    demos/tuning/capture.sh NEBULA 6 1.5 /tmp/nebula-shots
    CAPTURE_GPU=1 demos/tuning/capture.sh KIFS_FLYTHROUGH 3 1.2 /tmp/kifs

It drives `demos.html?capture=N&every=SEC&delay=SEC&play=1#NAME`, which posts
each frame to `capture_server.py` (started automatically) on `:8124`.

Playback and rendering happen in real time on purpose (no
`--virtual-time-budget`) — the demos react to actual audio, so capture has to
run at the same speed the audio plays.

Rendering defaults to SwiftShader, which needs no GPU and is reproducible.
`CAPTURE_GPU=1` drops `--disable-gpu` and uses the real one: the imported
Synesthesia raymarchers run at well under 1 fps in software, so anything from
`syn-manifest.js` wants the GPU path.

A demo whose gallery name carries a trailing `*` (media-gated scenes) is
addressed by its bare name — `HEXTUNNEL`, not `HEXTUNNEL*`.

## bench.sh — frame-time sweep over (scene x quality)

`./bench.sh SCENES QUALITIES SECS OUTPUT_DIR` measures what each scene costs per
frame at each setting of the gallery's quality slider — e.g.

    demos/tuning/bench.sh ALIEN_CAVERN,MOLTEN,NEBULA 0.75,1.5 6 /tmp/bench
    BENCH_WINDOW=2560,1600 demos/tuning/bench.sh ALL 1 5 /tmp/bench-all

`SCENES` takes manifest names or `ALL`; `QUALITIES` are multipliers on each
scene's `maxDim` from `syn-manifest.js`. It drives
`demos.html?bench=1&scenes=...&quality=...&secs=N&out=8124&play=1`, which warms
each pair up for 1.5 s, records raw rAF frame deltas for `SECS`, and POSTs the
whole sweep to `capture_server.py`'s `/bench` as `OUTPUT_DIR/bench.json`. A
summary table is printed at the end. The real GPU and real playing audio are
both non-negotiable here: the point is the cost under the load the gallery
actually runs under.

**Read frame time, not fps.** Headless rAF free-runs against the host refresh,
so `fps_from_mean` is context, nothing more — and it puts a floor under the
measurement. On the M-series dev machine at a 1280x800 window *every* scene
reports mean 8.33 ms (= 1/120 s) because nothing comes close to saturating the
GPU at those buffer sizes; that run measured the clock, not the scenes.
`BENCH_WINDOW=3200,2000` raises the buffers enough for the heavy raymarchers to
separate (ALIEN_CAVERN at 2.5x / 1920x1148 went to 9.95 ms mean while the
lighter scenes stayed pinned at the floor). A weaker machine falls off the floor
on its own — which is the case these numbers exist for.

## syn_probe.sh — batch triage of the imported .synScene roster

`./syn_probe.sh OUTPUT.jsonl [EXTRA_QUERY]` walks every entry in
`demos/syn/syn-manifest.js` in one browser session and answers, per scene, the
two questions a bulk import can answer mechanically: does it compile, and does
it put moving, non-black pixels on screen.

    demos/tuning/syn_probe.sh /tmp/probe.jsonl 'audio=1&shots=1'
    demos/tuning/syn_probe.sh /tmp/one.jsonl 'only=HEXTUNNEL&media=1'

One JSON line per scene lands in `OUTPUT.jsonl` as it finishes (via
`probe_server.py` on `:8125`), so a scene that wedges the GPU still leaves every
earlier verdict on disk. Each line carries `status` — `ok`, `black`, `flat`,
`failed`, `timeout`, `render-threw` — plus mean/max luma, non-black fraction,
spatial variance, frame-to-frame motion, and any console output the scene
produced (a shader compile log included, with its offending source lines).

Query parameters, all optional:

| param | meaning |
| --- | --- |
| `only=NAME,NAME` | probe just these manifest names |
| `from=N&count=M` | probe a slice of the roster |
| `audio=1` | play the local deck for the whole run instead of the idle sim |
| `media=1` | force the generated media stand-in on for every scene |
| `shots=1` | also write each scene's final frame to `shots/` beside the output |
| `warmup=N&frames=N` | frames before / across the two samples (default 90 / 30) |
| `timeout=SEC` | per-scene load budget (default 20) |

`audio=1` matters for classification: the idle sim carries no chroma and modest
band levels, so a scene gated on a snare hit reads as black without it.
