#!/usr/bin/env bash
# demos/show/deploy-neo.sh — push this repo to the TV machine and restart it.
#
#   demos/show/deploy-neo.sh [host]        default host: neo
#
# WHY THERE IS A SECOND COPY ON THAT MACHINE
# ------------------------------------------
# macOS TCC protects ~/Downloads, ~/Documents and ~/Desktop from processes
# launchd spawns: a LaunchAgent reading ~/Downloads/vizier does not get a
# denial it can report, it BLOCKS on a consent dialog nobody is in front of.
# Measured on neo (macOS 26.5): the follower died with
# "[Errno 1] Operation not permitted", and a probe agent hung outright.
#
# So the runtime lives at ~/arche/vizier, which is not TCC-protected, and the
# show wavs are HARD LINKED into ~/arche/show-audio — same bytes on disk, a
# path launchd is allowed to open. ~/Downloads/vizier on that machine stays as
# a plain mirror for editing/inspection; nothing runs out of it.
#
# Re-run this after changing wavs: a replaced wav is a new inode, and the old
# hard link would still point at the file it replaced.
set -euo pipefail

HOST="${1:-neo}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "[deploy] repo mirror  -> $HOST:Downloads/vizier"
rsync -a --exclude '.git/' --exclude '__pycache__/' --exclude '.DS_Store' \
      "$SRC/" "$HOST:Downloads/vizier/"

echo "[deploy] runtime copy -> $HOST:arche/vizier  (waveloop/ not needed there)"
rsync -a --exclude '.git/' --exclude '__pycache__/' --exclude '.DS_Store' \
      --exclude 'waveloop/' "$SRC/" "$HOST:arche/vizier/"

ssh "$HOST" 'bash -s' <<'REMOTE'
set -euo pipefail
chmod +x "$HOME/arche/vizier/demos/show/follower_server.py"

# --- show audio: hard links out of the TCC-protected Downloads tree ---------
SRC_WAVS="$HOME/Downloads/show-view/party-mountain-2026-tracks"
DST="$HOME/arche/show-audio"
mkdir -p "$DST"
if [ -d "$SRC_WAVS" ]; then
  find "$SRC_WAVS" -name '*.wav' -print0 | while IFS= read -r -d '' f; do
    b="$DST/$(basename "$f")"
    # relink unless it is already the same inode
    if [ ! -e "$b" ] || [ "$(stat -f %i "$f")" != "$(stat -f %i "$b")" ]; then
      rm -f "$b"; ln "$f" "$b"
    fi
  done
  echo "[deploy] show audio: $(ls -1 "$DST" | wc -l | tr -d ' ') wavs linked"
else
  echo "[deploy] WARNING: $SRC_WAVS not found — the TV will report missing wavs"
fi

# --- LaunchAgents -----------------------------------------------------------
mkdir -p "$HOME/Library/LaunchAgents"
cp "$HOME/arche/vizier/demos/show/com.arche.vizier-follower.plist" \
   "$HOME/arche/vizier/demos/show/com.arche.vizier-kiosk.plist" \
   "$HOME/Library/LaunchAgents/"
# bootout + bootstrap, never kickstart: launchd keeps the plist it loaded, so
# a kickstart would restart the OLD command line after the file changed
for L in com.arche.vizier-follower com.arche.vizier-kiosk; do
  launchctl bootout "gui/$(id -u)/$L" 2>/dev/null || true
done
sleep 1
for L in com.arche.vizier-follower com.arche.vizier-kiosk; do
  launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$L.plist"
  echo "[deploy] loaded $L"
done
REMOTE

echo "[deploy] done — http://$HOST.local:8123/show/status"
