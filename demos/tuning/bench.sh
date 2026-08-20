#!/usr/bin/env bash
# demos/tuning/bench.sh — frame-time sweep over (scene x quality) for the
# vizier demo gallery, rendered by headless Chrome on the real GPU with the
# deck actually playing.
#
# Usage:
#   bench.sh SCENES QUALITIES SECS OUTPUT_DIR
#
#     SCENES     comma-separated demo names, or ALL for every manifest row
#     QUALITIES  comma-separated multipliers on each scene's manifest maxDim
#     SECS       measurement window per (scene, quality) pair
#
# Example:
#   demos/tuning/bench.sh SYN_ALIEN_CAVERN,SYN_MOLTEN,NEBULA 0.75,1.5 6 /tmp/bench
#
# Requires the gallery served at http://localhost:8123 (this repo's
# `python3 -m http.server 8123`, run from the repo root).
#
# Two things that are deliberate and should stay that way:
#
#   --mute-audio is NOT optional. ?play=1 starts the local deck for real, so
#   that measurement happens under the same audio + FFT load the gallery runs
#   under in use — and without the mute that is audible on the machine.
#
#   The GPU is real (no --disable-gpu / SwiftShader). Benchmarking the software
#   rasterizer would rank shader complexity, not what any of this costs on the
#   hardware the gallery runs on.
#
# What comes back is FRAME TIME, not fps. Headless Chrome's rAF free-runs
# against the host refresh rather than a real vsync, so the fps that falls out
# of these numbers is not a frame rate anyone will see; the per-frame cost is
# the comparable number, and the JSON carries fps_from_mean only as context.
#
# A FLOOR COMES WITH THAT. Measured on the M-series dev machine every scene
# reports mean 8.33 ms — exactly 1/120 s — because at a 1280x800 window no syn
# scene comes close to saturating the GPU, and rAF will not deliver faster than
# the host's 120 Hz. A run where every row reads 8.3 ms has not measured the
# scenes, it has measured the clock. Two ways past it:
#
#   BENCH_WINDOW=2560,1600 demos/tuning/bench.sh ...
#
# raises the render buffers (a scene's maxDim cap only bites once the canvas is
# bigger than it), which is what puts real load on the GPU. And a weaker
# machine will fall off the floor on its own, which is the case these numbers
# are actually for.

set -euo pipefail

SCENES="${1:?usage: bench.sh SCENES QUALITIES SECS OUTPUT_DIR}"
QUALITIES="${2:?qualities required, e.g. 0.75,1,1.5}"
SECS="${3:?measurement seconds required}"
OUTDIR="${4:?output dir required}"

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
CAPTURE_PORT=8124
GALLERY_URL="http://localhost:8123/demos.html"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WARMUP=1.5
WINDOW="${BENCH_WINDOW:-1280,800}"

mkdir -p "$OUTDIR"
BENCH_JSON="$OUTDIR/bench.json"
rm -f "$BENCH_JSON"

if [ ! -x "$CHROME" ]; then
  echo "error: Chrome not found at $CHROME" >&2
  exit 1
fi

if ! curl -sf -o /dev/null "$GALLERY_URL"; then
  echo "error: $GALLERY_URL is not reachable — is 'python3 -m http.server 8123' running from the repo root?" >&2
  exit 1
fi

# --- how long the whole sweep can possibly take ------------------------------
# one pair costs warmup + secs, plus scene load; ALL is resolved by the page, so
# budget generously and let the /bench POST end things early in the normal case.
N_SCENES=$(python3 -c "
import sys
s = sys.argv[1]
print(60 if s.upper() == 'ALL' else len([x for x in s.split(',') if x.strip()]))
" "$SCENES")
N_QUAL=$(python3 -c "
import sys
print(max(1, len([x for x in sys.argv[1].split(',') if x.strip()])))
" "$QUALITIES")
BUDGET=$(python3 -c "
print(int(${N_SCENES} * ${N_QUAL} * (${SECS} + ${WARMUP} + 6) + 30))
")

# --- capture/bench server ----------------------------------------------------
python3 "$SCRIPT_DIR/capture_server.py" "$OUTDIR" "$BUDGET" "$BENCH_JSON" &
SERVER_PID=$!

CHROME_PID=""
CHROME_PROFILE=""
cleanup() {
  [ -n "$CHROME_PID" ] && kill "$CHROME_PID" >/dev/null 2>&1 || true
  kill "$SERVER_PID" >/dev/null 2>&1 || true
  [ -n "$CHROME_PROFILE" ] && rm -rf "$CHROME_PROFILE" || true
}
trap cleanup EXIT

for _ in $(seq 1 50); do
  curl -sf -o /dev/null "http://localhost:${CAPTURE_PORT}/" && break
  sleep 0.1
done

# --- headless chrome ---------------------------------------------------------
URL="${GALLERY_URL}?bench=1&scenes=${SCENES}&quality=${QUALITIES}&secs=${SECS}&warm=${WARMUP}&out=${CAPTURE_PORT}&play=1"
echo "[bench.sh] $N_SCENES scene(s) x $N_QUAL quality step(s), ${SECS}s each, window ${WINDOW}; budget ${BUDGET}s"
echo "[bench.sh] $URL"

CHROME_PROFILE="$(mktemp -d)"
"$CHROME" \
  --headless=new \
  --autoplay-policy=no-user-gesture-required \
  --mute-audio \
  --window-size="$WINDOW" \
  --no-first-run --no-default-browser-check \
  --user-data-dir="$CHROME_PROFILE" \
  "$URL" \
  > "$OUTDIR/chrome-bench.log" 2>&1 &
CHROME_PID=$!

# --- wait for the /bench POST (server exits on it), or the budget ------------
SECONDS=0
while kill -0 "$SERVER_PID" 2>/dev/null; do
  if [ "$SECONDS" -ge "$BUDGET" ]; then
    echo "[bench.sh] budget exhausted with no /bench POST" >&2
    break
  fi
  sleep 0.5
done

kill "$CHROME_PID" >/dev/null 2>&1 || true
wait "$CHROME_PID" 2>/dev/null || true
CHROME_PID=""
kill "$SERVER_PID" >/dev/null 2>&1 || true

if [ -s "$BENCH_JSON" ]; then
  echo "[bench.sh] results: $BENCH_JSON"
  python3 -c "
import json, sys
d = json.load(open(sys.argv[1]))
print('%-32s %6s %11s %8s %8s %8s' % ('scene', 'qual', 'buffer', 'mean', 'p95', 'max'))
for r in d['results']:
    if 'error' in r:
        print('%-32s %6s  %s' % (r['scene'], r.get('quality', '-'), r['error']))
        continue
    print('%-32s %6.2f %11s %7.2fms %6.2fms %6.2fms' % (
        r['scene'], r['quality'], '%dx%d' % (r['buffer_w'], r['buffer_h']),
        r['mean_ms'], r['p95_ms'], r['max_ms']))
" "$BENCH_JSON"
else
  echo "[bench.sh] no results written — see $OUTDIR/chrome-bench.log" >&2
  exit 1
fi
