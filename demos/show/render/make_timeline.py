#!/usr/bin/env python3
"""Resolve one show stage's cue list into a per-frame state timeline.

The offline renderer (render.mjs) has no follower process and no leader: it
steps a virtual clock one video frame at a time. This script answers "what did
the follower tell the TV, and when" for that clock, by running the REAL cue
engine — follower_server.Box, imported, not re-implemented — over every frame
position of the stage's audio and writing down each moment its answer moved.

    make_timeline.py --stage main --fps 60 > timeline.json

Output: {stage, fps, audio, audio_path, duration, frames, logo_style,
         events: [{frame, scene, logo, video, palette}, ...]}
events[0] is frame 0: the state the stage lands on with the transport cued at
0, which is what the TV held while the operator's finger was over PLAY.
"""
import argparse
import json
import os
import sys
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
SHOW = os.path.dirname(HERE)
sys.path.insert(0, SHOW)

import follower_server as fs  # noqa: E402


def find_audio(audio_dir, name):
    for root, _dirs, files in os.walk(audio_dir):
        if name in files:
            return os.path.join(root, name)
    return None


def wav_seconds(path):
    """Duration off the file itself — the cue docs' `duration` is hand-kept."""
    try:
        with wave.open(path, 'rb') as w:
            return w.getnframes() / float(w.getframerate())
    except wave.Error:
        # WAVE_FORMAT_EXTENSIBLE (the 24-bit opener): the stdlib refuses the
        # header, so read the two chunks that matter by hand
        import struct
        with open(path, 'rb') as f:
            f.seek(12)
            rate = block = None
            while True:
                hdr = f.read(8)
                if len(hdr) < 8:
                    raise
                cid, size = struct.unpack('<4sI', hdr)
                if cid == b'fmt ':
                    fmt = f.read(size)
                    rate, = struct.unpack('<I', fmt[4:8])
                    block, = struct.unpack('<H', fmt[12:14])
                elif cid == b'data':
                    return size / float(block) / float(rate)
                else:
                    f.seek(size + (size & 1), 1)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--stage', required=True, help='a stage_map.json stage with a cue doc')
    ap.add_argument('--fps', type=float, default=60.0)
    args = ap.parse_args()

    cfg = dict(fs.DEFAULT_CONFIG)
    cfg.update(fs.load_json(fs.CONFIG_PATH, {}))
    stage_map = fs.load_json(fs.STAGE_MAP_PATH, {})
    cue_docs = {}
    for name in sorted(set(fs.stage_cue_files(stage_map).values())):
        doc = fs.load_json(os.path.join(SHOW, name), {})
        doc['_file'] = name
        cue_docs[name] = doc

    box = fs.Box(stage_map, cue_docs, {})
    if not box._cue_stage(args.stage):
        sys.exit('stage %r has no cue doc in stage_map.json' % args.stage)
    doc = cue_docs[box._stage_entry(args.stage)['cues']]

    audio_dir = cfg.get('audio_dir') or 'waveloop/audio'
    if not os.path.isabs(audio_dir):
        audio_dir = os.path.normpath(os.path.join(fs.REPO, audio_dir))
    audio = doc.get('audio')
    audio_path = find_audio(audio_dir, audio) if audio else None
    if not audio_path:
        sys.exit('audio %r not found under %s' % (audio, audio_dir))
    duration = wav_seconds(audio_path)
    frames = int(duration * args.fps)

    def state():
        return {'scene': box.scene, 'logo': box.logo,
                'video': dict(box.video) if box.video else None,
                'palette': dict(box.palette) if box.palette else None}

    # the stage arrives cued and paused at 0, exactly as a stage jump leaves it
    box.apply_sync({'track': audio, 'position': 0.0, 'playing': False,
                    'duration': duration})
    box.apply_stage(args.stage)
    events = [dict(state(), frame=0)]
    last = state()
    with box.lock:
        for k in range(1, frames):
            if box._eval_cues(k / args.fps):
                cur = state()
                if cur != last:
                    events.append(dict(cur, frame=k))
                    last = cur

    json.dump({
        'stage': args.stage, 'fps': args.fps, 'audio': audio,
        'audio_path': audio_path, 'duration': duration, 'frames': frames,
        'cue_file': doc['_file'], 'logo_style': cfg.get('logo'),
        'drift_seconds': float(cfg.get('drift_seconds', 0.25)),
        'events': events,
    }, sys.stdout, indent=1)


if __name__ == '__main__':
    main()
