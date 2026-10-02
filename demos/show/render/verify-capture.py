#!/usr/bin/env python3
"""Is the screenshot taken for frame k a picture of frame k?

render.mjs --debug-frames DIR saves, per frame, the page screenshot and the
scene canvas as read back inside the same step (before any compositing). This
scores each screenshot against the canvases of frames k-1, k and k+1; a capture
that lagged or led the render by a frame shows up as the wrong one winning.

    verify-capture.py DIR
"""
import glob, os, sys
import numpy as np
from PIL import Image

d = sys.argv[1]
ks = sorted(int(os.path.basename(p).split('-')[0]) for p in glob.glob(os.path.join(d, '*-shot.png')))
load = lambda k, kind, size=None: np.asarray(
    (lambda im: im.resize(size, Image.BILINEAR) if size else im)(
        Image.open(os.path.join(d, '%07d-%s.png' % (k, kind))).convert('L')), dtype=np.float32)
wins = {-1: 0, 0: 0, 1: 0}
ident = 0
for k in ks[1:-1]:
    cv = {o: load(k + o, 'canvas') for o in (-1, 0, 1)}
    h, w = cv[0].shape
    shot = load(k, 'shot', (w, h))
    # the CRT overlay darkens the screenshot, so compare shape, not level
    def score(a, b):
        a = a - a.mean(); b = b - b.mean()
        den = np.sqrt((a * a).sum() * (b * b).sum())
        return float((a * b).sum() / den) if den else 0.0
    sc = {o: score(shot, cv[o]) for o in cv}
    if abs(sc[0] - sc[-1]) < 1e-6 and abs(sc[0] - sc[1]) < 1e-6:
        ident += 1
        continue
    wins[max(sc, key=sc.get)] += 1
print('frames scored: %d  (skipped %d with no frame-to-frame change)' % (sum(wins.values()), ident))
print('screenshot k best matches canvas  k-1: %d   k: %d   k+1: %d' % (wins[-1], wins[0], wins[1]))
sys.exit(0 if wins[0] and wins[-1] == 0 and wins[1] == 0 else 1)
