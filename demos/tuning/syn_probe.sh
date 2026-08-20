#!/usr/bin/env bash
# demos/tuning/syn_probe.sh — compile/render triage for the imported .synScene
# roster. Drives demos/tuning/syn_probe.html in headless Chrome on the real GPU
# and writes one JSON line per scene.
#
# Usage:
#   syn_probe.sh OUTPUT.jsonl [EXTRA_QUERY]
#
# Examples:
#   demos/tuning/syn_probe.sh /tmp/probe.jsonl
#   demos/tuning/syn_probe.sh /tmp/one.jsonl 'only=HEXTUNNEL&media=1'
#
# Requires `python3 -m http.server 8123` running from the repo root.
#
# --mute-audio is NOT optional. The probe page instantiates the same
# AnalysisEngine the gallery does; a run without it can start playing sound out
# of the speakers of whoever is at the machine.

set -euo pipefail

OUT="${1:?usage: syn_probe.sh OUTPUT.jsonl [EXTRA_QUERY]}"
EXTRA="${2:-}"

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE_URL="http://localhost:8123/demos/tuning/syn_probe.html"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IDLE_TIMEOUT="${IDLE_TIMEOUT:-90}"

[ -x "$CHROME" ] || { echo "error: Chrome not found at $CHROME" >&2; exit 1; }
curl -sf -o /dev/null "$PROBE_URL" || {
  echo "error: $PROBE_URL unreachable — is 'python3 -m http.server 8123' running from the repo root?" >&2
  exit 1
}

python3 "$SCRIPT_DIR/probe_server.py" "$OUT" "$IDLE_TIMEOUT" &
SERVER_PID=$!
CHROME_PID=""
cleanup() {
  [ -n "$CHROME_PID" ] && kill "$CHROME_PID" >/dev/null 2>&1 || true
  kill "$SERVER_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

for i in $(seq 1 50); do
  curl -sf -o /dev/null "http://localhost:8125/" && break
  sleep 0.1
done

URL="$PROBE_URL${EXTRA:+?$EXTRA}"
PROFILE="$(mktemp -d)"
echo "[syn_probe] $URL"
# no --disable-gpu: these are real shaders and SwiftShader takes minutes on the
# raymarchers. headless=new gets the Metal backend.
"$CHROME" \
  --headless=new \
  --mute-audio \
  --autoplay-policy=no-user-gesture-required \
  --window-size=1280,800 \
  --no-first-run --no-default-browser-check \
  --user-data-dir="$PROFILE" \
  "$URL" > "${OUT%.jsonl}.chrome.log" 2>&1 &
CHROME_PID=$!

while kill -0 "$SERVER_PID" 2>/dev/null; do sleep 0.5; done
kill "$CHROME_PID" >/dev/null 2>&1 || true
CHROME_PID=""
rm -rf "$PROFILE"
echo "[syn_probe] results: $OUT ($(wc -l < "$OUT" | tr -d ' ') lines)"
