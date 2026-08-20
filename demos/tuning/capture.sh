#!/usr/bin/env bash
# demos/tuning/capture.sh — grab N tuning screenshots of one vizier demo,
# rendered by headless Chrome with real audio playing.
#
# Usage:
#   capture.sh DEMO_NAME FRAME_COUNT INTERVAL_SEC OUTPUT_DIR [DELAY_SEC]
#
# Example:
#   demos/tuning/capture.sh NEBULA 6 1.5 /tmp/nebula-shots
#
# Requires the gallery already served at http://localhost:8123 (this repo's
# `python3 -m http.server 8123`, run from the repo root). Chrome renders in
# real time here on purpose — the deck's audio has to actually play for the
# demos to react to it, so there is no --virtual-time-budget shortcut.

set -euo pipefail

DEMO="${1:?usage: capture.sh DEMO_NAME FRAME_COUNT INTERVAL_SEC OUTPUT_DIR [DELAY_SEC]}"
COUNT="${2:?frame count required}"
INTERVAL="${3:?interval (seconds) required}"
OUTDIR="${4:?output dir required}"
DELAY="${5:-1.5}"

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
CAPTURE_PORT=8124
GALLERY_URL="http://localhost:8123/demos.html"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$OUTDIR"

if [ ! -x "$CHROME" ]; then
  echo "error: Chrome not found at $CHROME" >&2
  exit 1
fi

if ! curl -sf -o /dev/null "$GALLERY_URL"; then
  echo "error: $GALLERY_URL is not reachable — is 'python3 -m http.server 8123' running from the repo root?" >&2
  exit 1
fi

# --- capture server ---------------------------------------------------------
IDLE_TIMEOUT=$(python3 -c "print(${DELAY} + ${COUNT} * ${INTERVAL} + 20)")
python3 "$SCRIPT_DIR/capture_server.py" "$OUTDIR" "$IDLE_TIMEOUT" &
SERVER_PID=$!

CHROME_PID=""
cleanup() {
  [ -n "$CHROME_PID" ] && kill "$CHROME_PID" >/dev/null 2>&1 || true
  kill "$SERVER_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# wait for the capture server to start listening
for i in $(seq 1 50); do
  if curl -sf -o /dev/null "http://localhost:${CAPTURE_PORT}/"; then
    break
  fi
  sleep 0.1
done

# --- headless chrome ---------------------------------------------------------
URL="${GALLERY_URL}?capture=${COUNT}&every=${INTERVAL}&delay=${DELAY}&play=1#${DEMO}"
echo "[capture.sh] launching headless chrome: $URL"

CHROME_PROFILE="$(mktemp -d)"
# SwiftShader by default (deterministic, no GPU needed) — but it is far too slow
# for the imported Synesthesia raymarchers, which drop under 1 fps on it and
# capture nothing but their first frame. CAPTURE_GPU=1 uses the real GPU
# instead, which is what the syn scenes need. --mute-audio is not optional in
# either mode: the deck really plays.
GPU_FLAGS=(--disable-gpu --enable-unsafe-swiftshader)
if [ "${CAPTURE_GPU:-0}" = "1" ]; then GPU_FLAGS=(); fi
"$CHROME" \
  --headless=new \
  "${GPU_FLAGS[@]}" \
  --autoplay-policy=no-user-gesture-required \
  --mute-audio \
  --window-size=1280,800 \
  --no-first-run --no-default-browser-check \
  --user-data-dir="$CHROME_PROFILE" \
  "$URL" \
  > "$OUTDIR/chrome.log" 2>&1 &
CHROME_PID=$!

# --- wait for completion, with a timeout -------------------------------------
TIMEOUT=$(python3 -c "print(int(${DELAY} + ${COUNT} * ${INTERVAL} + 25))")
echo "[capture.sh] waiting up to ${TIMEOUT}s for ${COUNT} frames..."
SECONDS=0
while kill -0 "$SERVER_PID" 2>/dev/null; do
  if [ "$SECONDS" -ge "$TIMEOUT" ]; then
    echo "[capture.sh] timeout waiting for capture server" >&2
    break
  fi
  sleep 0.5
done

kill "$CHROME_PID" >/dev/null 2>&1 || true
wait "$CHROME_PID" 2>/dev/null || true
CHROME_PID=""
kill "$SERVER_PID" >/dev/null 2>&1 || true
rm -rf "$CHROME_PROFILE"

echo "[capture.sh] frames in $OUTDIR:"
ls -la "$OUTDIR"/*.png 2>/dev/null || echo "  (none captured)"
