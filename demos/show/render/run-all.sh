#!/bin/sh
# Render both show stages back to back, unattended. Safe to re-run: finished
# chunks are kept (--resume), so a crash or a reboot costs only the chunk in flight.
cd "$(dirname "$0")" || exit 1
LOG=work/run-all.log
mkdir -p work
rm -f work/ALL_DONE work/FAILED
{
  caffeinate -i node render.mjs --stage opener --resume &&
  caffeinate -i node render.mjs --stage main --workers "${WORKERS:-4}" --resume &&
  touch work/ALL_DONE || touch work/FAILED
} >> "$LOG" 2>&1
