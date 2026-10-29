#!/usr/bin/env python3
"""Snap the hand-entered PM-2026 visual cue times onto the nearest real beat
change in the main-set wav, and emit demos/show/cues-pm-2026.json plus a
human-readable report.

Method (numpy only, same family as show_view/analyze.py):

  * read a +-3.0 s context window around each cue at the wav's native 44.1 kHz,
    mono, and take an STFT (n_fft 2048, hop 256 -> 5.8 ms grid)
  * onset strength = positive spectral flux of log magnitude, computed twice:
    full band, and low band (< 200 Hz, the kick) -- each z-scored over the
    context window, then summed. A DJ transition lands on a downbeat kick, so
    the low band deserves the extra vote.
  * candidates = local maxima of that curve inside +-1.2 s of the user's time
  * each candidate is scored strength * gaussian(delta, sigma 0.8 s): the user
    typed to +-1 s, so a neighbouring beat (~0.47 s away at 128 BPM) has to be
    clearly stronger to win rather than merely a hair stronger
  * confidence = winner's z-score folded with how far it stands above the
    median candidate. Below the floor the window is flat (no clear beat) and
    the user's own time is kept, flagged.
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
# needs numpy + soundfile: run it with show-view's venv, which has both —
#   ~/Downloads/live-show/show-view/.venv/bin/python demos/show/snap_cues.py
WAV = os.environ.get('PM_WAV') or os.path.expanduser(
    '~/Downloads/live-show/show-view/party-mountain-2026-tracks/dj-set/'
    'party-mountain-16bit-release.wav')
OUT_JSON = os.path.join(HERE, 'cues-pm-2026.json')
OUT_REPORT = os.path.join(HERE, 'cues-snap-report.txt')

CONTEXT = 3.0        # seconds either side, for normalisation
MAX_SHIFT = 1.2      # hard cap on any correction, per the brief
SIGMA = 0.8          # proximity prior width
N_FFT = 2048
HOP = 256
CONF_FLOOR = 0.35    # below this the window has no beat worth snapping to


def hms(t: str) -> float:
    p = [float(x) for x in t.split(':')]
    while len(p) < 3:
        p.insert(0, 0.0)
    return p[0] * 3600 + p[1] * 60 + p[2]


def fmt(t: float) -> str:
    h = int(t // 3600)
    m = int((t - h * 3600) // 60)
    s = t - h * 3600 - m * 60
    return '%02d:%02d:%06.3f' % (h, m, s)


# ---------------------------------------------------------------- cue list
# Transposed verbatim from show-view/pm-2026-dj-set-visual-cues-list.txt.
# (track, scene, time) in main-set position; the wav is one continuous file.
SCENE_CUES = [
    ('Vincent Antone - Extraordinary Lengths', 'PLUS', '00:00:00'),
    ('RL Grime - Aurora (NGHTMRE Remix)', 'CIRCLES5', '00:03:19'),
    ('who we are - messwave', 'COMPOUND_IRIS', '00:06:44'),
    ('Artemas - I Like The Way You Kiss Me (YDG Remix)', 'REPLIK8', '00:09:02'),
    ('Levity - Flip It', 'MIN_MAX_HEX', '00:11:34'),
    ('Porter Robinson, Amy Millan - Divinity (ODESZA Remix)', 'FUZZY_SIGNAL', '00:13:30'),
    ("Phantogram - You Don't Get Me High Anymore (ATTLAS Remix)", 'BEAMERS', '00:16:43'),
    ('Ark Patrol - Hex (new version)', 'LATTIX', '00:20:39'),
    ('LSDREAM - SHADOW SELF', 'SQUARE_SHOALS', '00:23:36'),
    ('ISOxo - MOONSPELL', 'HEXOPLANET', '00:27:22'),
    ('G Jones & Eprom - R.A.V.E', 'HILLS_EELS', '00:29:55'),
    ('Vanic - Human', 'WATERLY', '00:32:22'),
    ('Belladonna - Gold Geisha', 'SCAFFOLD_FRACTAL', '00:34:20'),
    ('Rome in Silver - Fool', 'FLAME', '00:36:58'),
    ('Big Data - Dangerous (Oliver remix)', 'TUNNEL_BEAUTY_6', '00:40:20'),
    ('Tame Impala - Dracula (JENNIE Remix)', 'ALIEN_CAVERN', '00:43:15'),
    ('The Dare - Girls', 'PARTY_DOODAD', '00:46:26'),
    ('Odd Mob - Intrinsic', 'KIFS_FLYTHROUGH', '00:48:15'),
    ('Black V Neck - Talk (Extended Mix) [ACAPELLA]', 'INKSHOT', '00:50:45'),
    ('Ed Sheeran - Bad Habits (MEDUZA Extended Remix)', 'HEXTUNNEL', '00:52:15'),
    ('SIDEPIECE - Together', 'DISPERSION', '00:54:22'),
    ('BORNS - Electric Love (Oliver Remix) [ACAPPELA]', 'GLOB', '00:57:19'),
    ('Tinashe & Disco Lines - No Broke Boys (Extended)', 'KALEIDOWHOA_MAN', '00:57:48'),
    ('Umek - Once Again (Original Mix)', 'SHROUDED', '01:00:43'),
    ('CAZZETTE - Beam Me Up [ACAPELLA]', 'NOVA', '01:03:37'),
    ('Chrystal - The Days (NOTION remix)', 'MANDALA', '01:05:33'),
    ('Nate Band - Drugs I Like (Extended Mix)', 'TRACED_TUNNEL', '01:08:48'),
    ('Arche - La Lune X Wildest Dreams', 'GLASSIER', '01:12:03'),
    ('Sail - Schepetkov', 'SQUARE_SHOALS', '01:15:24'),
    ('OUTRO', 'NEBULA', '01:18:20'),
]
LOGO_SCENES = {29}          # index into SCENE_CUES: "ARCHE NEBULA" = logo on

VIDEO_CUES = [
    # (video, at, duration, return_scene, note)
    ('moon.mp4', '00:27:33', 26.0, 'HEXOPLANET', 'ISOxo - MOONSPELL'),
    ('dracula.mp4', '00:43:35', 34.0, 'ALIEN_CAVERN', 'Tame Impala - Dracula (JENNIE Remix)'),
]


# ------------------------------------------------------------------- DSP
def read_window(f, centre, half):
    sr = f.samplerate
    start = max(0, int((centre - half) * sr))
    n = int(2 * half * sr)
    n = min(n, f.frames - start)
    f.seek(start)
    x = f.read(n, dtype='float32', always_2d=True).mean(axis=1)
    return x, start / sr, sr


def onset_curve(x, sr):
    """(strength, fps, t0_offset) — z-scored full+low band spectral flux."""
    if len(x) < N_FFT * 2:
        return None, None
    win = np.hanning(N_FFT).astype(np.float32)
    n_frames = 1 + (len(x) - N_FFT) // HOP
    idx = np.arange(N_FFT)[None, :] + HOP * np.arange(n_frames)[:, None]
    S = np.abs(np.fft.rfft(x[idx] * win, axis=1))
    freqs = np.fft.rfftfreq(N_FFT, 1.0 / sr)
    L = np.log1p(20 * S)
    d = np.maximum(np.diff(L, axis=0), 0)
    full = d.sum(axis=1)
    low = d[:, freqs <= 200].sum(axis=1)

    def z(v):
        return (v - v.mean()) / (v.std() + 1e-9)

    curve = z(full) + z(low)
    fps = sr / HOP
    # frame k covers samples [k*HOP, k*HOP+N_FFT); the flux at diff index k
    # describes the transition into frame k+1, whose centre is here:
    t_off = (N_FFT * 0.5 + HOP) / sr
    return curve, (fps, t_off)


def local_maxima(v):
    """Peaks of a lightly smoothed curve, keeping only above-average ones.

    Raw 5.8 ms flux is noisy enough to produce a local maximum every few
    frames; a 3-frame boxcar plus a z>0 floor leaves the transients."""
    s = np.convolve(v, np.ones(3) / 3.0, mode='same')
    m = np.zeros(len(s), bool)
    m[1:-1] = (s[1:-1] >= s[:-2]) & (s[1:-1] > s[2:]) & (s[1:-1] > 0)
    return np.flatnonzero(m)


def snap(f, want):
    x, wav_t0, sr = read_window(f, want, CONTEXT)
    curve, meta = onset_curve(x, sr)
    if curve is None:
        return want, 0.0, 'window too short'
    fps, t_off = meta
    times = wav_t0 + t_off + np.arange(len(curve)) / fps

    inwin = np.abs(times - want) <= MAX_SHIFT
    peaks = local_maxima(curve)
    peaks = peaks[inwin[peaks]]
    if len(peaks) == 0:
        return want, 0.0, 0.0, 0.0, 'silent/flat window — kept user time'

    strength = curve[peaks]
    delta = times[peaks] - want
    score = strength * np.exp(-0.5 * (delta / SIGMA) ** 2)
    best = int(np.argmax(score))
    z_best = float(strength[best])
    t_best = float(times[peaks[best]])

    # margin: how decisively the winner beat the next candidate that is a
    # genuinely different moment (>150 ms away). Near zero means the window
    # holds several equally strong beats — the snap still lands ON a beat, it
    # just cannot know which one the operator meant.
    others = score[np.abs(times[peaks] - t_best) > 0.15]
    runner = float(others.max()) if len(others) else 0.0
    s_best = float(score[best])
    margin = 0.0 if s_best <= 0 else max(0.0, (s_best - runner) / s_best)

    conf_z = min(1.0, max(0.0, z_best / 3.0))          # is it a real transient?
    conf_m = min(1.0, margin / 0.35)                    # is it THE transient?
    conf = round(0.5 * conf_z + 0.5 * conf_m, 3)
    if conf_z < CONF_FLOOR:
        return (want, conf, z_best, margin,
                'no clear onset (z=%.2f) — kept user time' % z_best)
    flag = ''
    if conf_m < 0.25:
        # Several beats scored within a hair of each other: the analysis cannot
        # say which one the operator meant, so defer to them and take the
        # near-equal candidate CLOSEST to the time they typed. Still on a beat,
        # and never further from their intent than it has to be.
        near = np.flatnonzero(score >= 0.85 * s_best)
        pick = near[int(np.argmin(np.abs(times[peaks][near] - want)))]
        t_best = float(times[peaks[pick]])
        z_best = float(strength[pick])
        flag = ('ambiguous: %d beats of similar strength in the window — took '
                'the one nearest the typed time' % len(near))
    return t_best, conf, z_best, margin, flag


def main():
    # The table below is the ORIGINAL input, not the current one. Times get
    # dragged in the timeline editor and saved through POST /show/cues, and
    # rerunning this would silently throw all of that away.
    if os.path.exists(OUT_JSON) and '--force' not in sys.argv:
        sys.exit('cues-pm-2026.json is the live source of truth (timeline '
                 'editor / POST /show/cues edits it); rerun with --force to '
                 'regenerate from the hardcoded table')
    if not os.path.exists(WAV):
        sys.exit('missing wav: ' + WAV)
    rows = []
    with sf.SoundFile(WAV) as f:
        total = f.frames / f.samplerate
        for i, (track, scene, t) in enumerate(SCENE_CUES):
            want = hms(t)
            if want <= 0.5:                       # the opening cue is t=0
                rows.append(dict(kind='scene', i=i, track=track, scene=scene,
                                 orig=want, snapped=0.0, conf=1.0, z=0.0, margin=0.0,
                                 flag='set start — not snapped'))
                continue
            got, conf, z, margin, flag = snap(f, want)
            rows.append(dict(kind='scene', i=i, track=track, scene=scene,
                             orig=want, snapped=got, conf=conf, z=z, margin=margin,
                             flag=flag))
        for (vid, t, dur, ret, note) in VIDEO_CUES:
            want = hms(t)
            got, conf, z, margin, flag = snap(f, want)
            rows.append(dict(kind='video', track=note, scene=vid, video=vid,
                             duration=dur, return_scene=ret,
                             orig=want, snapped=got, conf=conf, z=z, margin=margin,
                             flag=flag))

    # ---------------------------------------------------------- cue json
    cues = []
    for r in rows:
        if r['kind'] != 'scene':
            continue
        c = {
            'type': 'scene',
            'at': round(r['snapped'], 3),
            'at_original': round(r['orig'], 3),
            'at_original_hms': fmt(r['orig']).split('.')[0],
            'scene': r['scene'],
            'track': r['track'],
            'snap': {'delta_ms': int(round((r['snapped'] - r['orig']) * 1000)),
                     'confidence': r['conf'],
                     'onset_z': round(r['z'], 2),
                     'margin': round(r['margin'], 3),
                     'flag': r['flag'] or None},
        }
        if r['i'] in LOGO_SCENES:
            c['logo'] = True
        cues.append(c)
    for r in rows:
        if r['kind'] != 'video':
            continue
        cues.append({
            'type': 'video',
            'at': round(r['snapped'], 3),
            'at_original': round(r['orig'], 3),
            'at_original_hms': fmt(r['orig']).split('.')[0],
            'video': r['video'],
            'duration': r['duration'],
            'return_scene': r['return_scene'],
            'track': r['track'],
            'snap': {'delta_ms': int(round((r['snapped'] - r['orig']) * 1000)),
                     'confidence': r['conf'],
                     'onset_z': round(r['z'], 2),
                     'margin': round(r['margin'], 3),
                     'flag': r['flag'] or None},
        })
    cues.sort(key=lambda c: (c['at'], 0 if c['type'] == 'scene' else 1))

    doc = {
        '_note': (
            'PARTY MOUNTAIN 2026 main-set visual cues. Times are MAIN-SET '
            'TRACK POSITION in seconds against '
            'party-mountain-16bit-release.wav (one continuous file), NOT wall '
            'clock — the follower evaluates them against the synced transport '
            'position, so pausing and seeking stay correct. Source of truth '
            'for the list: show-view/pm-2026-dj-set-visual-cues-list.txt; '
            '`at_original` is what the operator typed (+-1 s by hand) and `at` '
            'is that time snapped onto the nearest real beat change by '
            'demos/show/cues-snap-report.txt. Edit `at` freely; nothing '
            'regenerates this file.'),
        'audio': 'party-mountain-16bit-release.wav',
        'duration': round(total, 3),
        'generated': 'spectral-flux snap, max shift %.1f s' % MAX_SHIFT,
        'cues': cues,
    }
    with open(OUT_JSON, 'w', encoding='utf-8') as fh:
        json.dump(doc, fh, indent=2)
        fh.write('\n')

    # ------------------------------------------------------------ report
    L = []
    L.append('PM-2026 main-set visual cues — beat snap report')
    L.append('=' * 78)
    L.append('wav      : %s (%s)' % (os.path.basename(WAV), fmt(total)))
    L.append('method   : full-band + low-band (<200 Hz) spectral flux, n_fft %d /'
             ' hop %d @ 44.1 kHz' % (N_FFT, HOP))
    L.append('           (5.8 ms grid), z-scored over a +-%.1f s context, peaks'
             ' inside +-%.1f s,' % (CONTEXT, MAX_SHIFT))
    L.append('           scored strength * gaussian(delta, sigma %.1f s).'
             ' Confidence < %.2f = flat window,' % (SIGMA, CONF_FLOOR))
    L.append('           user time kept.')
    L.append('')
    L.append('conf = 0.5*min(z/3,1) + 0.5*min(margin/0.35,1).  z is the winning '
             'peak\'s onset')
    L.append('strength in sigmas above the local mean; margin is how far it beat '
             'the next')
    L.append('candidate >150 ms away (low margin = a steady groove, several '
             'equal beats).')
    L.append('')
    L.append('%-3s %-6s %-9s %-13s %9s %5s %5s %6s  %s'
             % ('#', 'kind', 'original', 'snapped', 'delta', 'conf', 'z', 'margin',
                'scene / video'))
    L.append('-' * 78)
    n = 0
    for r in sorted(rows, key=lambda r: r['orig']):
        n += 1
        d = (r['snapped'] - r['orig']) * 1000
        L.append('%-3d %-6s %-9s %-13s %+8.0fms %5.2f %5.1f %6.2f  %s%s'
                 % (n, r['kind'], fmt(r['orig']).split('.')[0], fmt(r['snapped']),
                    d, r['conf'], r['z'], r['margin'], r['scene'],
                    ('   <-- ' + r['flag']) if r['flag'] else ''))
    L.append('-' * 78)
    moved = [r for r in rows if 'kept user time' not in r['flag']
             and 'not snapped' not in r['flag']]
    deltas = [abs(r['snapped'] - r['orig']) for r in moved]
    flagged = [r for r in rows if r['flag'] and 'not snapped' not in r['flag']]
    L.append('cues       : %d (%d scene changes, %d video inserts)'
             % (len(rows), len(SCENE_CUES), len(VIDEO_CUES)))
    if deltas:
        L.append('|delta|    : mean %.0f ms, median %.0f ms, max %.0f ms'
                 % (1000 * np.mean(deltas), 1000 * np.median(deltas),
                    1000 * np.max(deltas)))
    L.append('flagged    : %d %s'
             % (len(flagged), '(' + ', '.join(r['scene'] for r in flagged) + ')'
                if flagged else '(none)'))
    big = sorted(rows, key=lambda r: -abs(r['snapped'] - r['orig']))[:6]
    L.append('')
    L.append('biggest corrections:')
    for r in big:
        L.append('  %-16s %s -> %s  (%+.0f ms, conf %.2f)'
                 % (r['scene'], fmt(r['orig']).split('.')[0], fmt(r['snapped']),
                    1000 * (r['snapped'] - r['orig']), r['conf']))
    txt = '\n'.join(L) + '\n'
    with open(OUT_REPORT, 'w', encoding='utf-8') as fh:
        fh.write(txt)
    print(txt)


if __name__ == '__main__':
    main()
