#!/usr/bin/env bash
# demos/show/deploy-neo.sh — push this repo to the TV machine and restart it.
#
#   demos/show/deploy-neo.sh [host]        default host: neo
#
# WHY THERE IS A SECOND COPY ON THAT MACHINE
# ------------------------------------------
# macOS TCC protects ~/Downloads, ~/Documents and ~/Desktop from processes
# launchd spawns: a LaunchAgent reading ~/Downloads/live-show/vizier does not get a
# denial it can report, it BLOCKS on a consent dialog nobody is in front of.
# Measured on neo (macOS 26.5): the follower died with
# "[Errno 1] Operation not permitted", and a probe agent hung outright.
#
# So the runtime lives at ~/arche/vizier, which is not TCC-protected, and the
# show wavs are HARD LINKED into ~/arche/show-audio — same bytes on disk, a
# path launchd is allowed to open. ~/Downloads/live-show/vizier on that machine stays as
# a plain mirror for editing/inspection; nothing runs out of it.
#
# Re-run this after changing wavs: a replaced wav is a new inode, and the old
# hard link would still point at the file it replaced.
set -euo pipefail

HOST="${1:-neo}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# --- presets travel the OTHER way first ------------------------------------
# scene_presets.json is the one file in this repo the TV machine writes: the
# panel's SAVE PRESET posts to the follower, which persists it there. A plain
# push would throw that away. --update copies it back only when neo's copy is
# the newer one, so a look dialled in on the TV survives (and lands in git),
# while an edit made here still wins if it is more recent.
if rsync -a --update "$HOST:arche/vizier/demos/show/scene_presets.json" \
         "$SRC/demos/show/scene_presets.json" 2>/dev/null; then
  echo "[deploy] presets: pulled back from $HOST (commit if it changed)"
fi

echo "[deploy] repo mirror  -> $HOST:Downloads/live-show/vizier"
rsync -a --exclude '.git/' --exclude '__pycache__/' --exclude '.DS_Store' \
      "$SRC/" "$HOST:Downloads/live-show/vizier/"

echo "[deploy] runtime copy -> $HOST:arche/vizier  (waveloop/ not needed there)"
rsync -a --exclude '.git/' --exclude '__pycache__/' --exclude '.DS_Store' \
      --exclude 'waveloop/' "$SRC/" "$HOST:arche/vizier/"

# Both rsyncs above are whole-tree, so demos/show/cues-pm-2026.json,
# scene_presets.json and demos/show/media/*.mp4 ride along with everything
# else. Named here only because they are the files a show depends on and the
# ones worth checking after a deploy:
echo "[deploy] cue list + presets + insert clips:"
for f in demos/show/cues-pm-2026.json demos/show/scene_presets.json; do
  [ -f "$SRC/$f" ] && echo "           $f ($(wc -c <"$SRC/$f" | tr -d ' ') bytes)" \
                   || echo "           $f  MISSING"
done
ls "$SRC/demos/show/media"/*.mp4 >/dev/null 2>&1 \
  && echo "           media: $(ls -1 "$SRC/demos/show/media"/*.mp4 | wc -l | tr -d ' ') clip(s)" \
  || echo "           media: NO CLIPS — video inserts will be skipped on the TV"

ssh "$HOST" 'bash -s' <<'REMOTE'
set -euo pipefail
chmod +x "$HOME/arche/vizier/demos/show/follower_server.py"

# --- show audio: hard links out of the TCC-protected Downloads tree ---------
SRC_WAVS="$HOME/Downloads/live-show/show-view/party-mountain-2026-tracks"
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
