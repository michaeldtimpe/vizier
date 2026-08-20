#!/usr/bin/env python3
"""vizier show follower — static gallery + show control, stdlib only.

One process, one port. It replaces `python3 -m http.server 8123` on the
machine driving the TV ("neo"): everything the gallery already needed is
still served from the repo root, and a small /show/* control surface is
bolted on beside it.

    m1 (leader)                       neo (follower)
    show-view :8090  --- LAN --->     follower_server.py :8123
    browser page                        |  desired-state box + long poll
    POSTs /show/stage, /show/sync       v
                                      demos.html?show=1 in kiosk Chrome

The leader's BROWSER talks to this server directly (show-view's python
backend is not involved), so every response carries permissive CORS
headers. The gallery page can't be pushed to without a websocket, so it
long-polls GET /show/events?since=SEQ instead: the request parks until the
desired state changes or ~25 s elapse. That same request is the liveness
signal both ways — the server knows the page is alive because it is
polling, and the page knows the leader is alive because sync commands keep
arriving.

Endpoints (all CORS-open, all JSON except /show/audio):

    GET  /show/status              everything: desired state, stage map,
                                   what the page last reported, ages
    GET  /show/scenes              scene roster from the manifests, each
                                   flagged with whether its assets exist here
    GET  /show/config              demos/show/config.json as served
    GET  /show/cues                the loaded cue list, verbatim
    GET  /show/presets             demos/show/scene_presets.json
    GET  /show/events?since=N      long poll; returns as soon as seq > N
    POST /show/scene   {name}      operator override, sticks until the next
                                   stage command or {name: null} to release
    POST /show/logo    {on}        force the logo layer, same lifetime
    POST /show/stage   {stage}     resolve stage -> scene+logo via stage_map
    POST /show/sync    {track, position, playing, duration}
    POST /show/page    {...}       the gallery page reporting its own state
    POST /show/preset  {scene, controls, grade?, quality?} | {scene, clear}
                                   save/erase one scene's saved look
    GET  /show/audio/<basename>    a show wav from config.audio_dir (Range
                                   supported — the main set is a ~1 h wav)

Everything else falls through to the repo's static files.

The stage -> scene map lives HERE (demos/show/stage_map.json), not in
show-view: one source of truth, edited in this repo, and show-view's
VISUALS menu displays whatever /show/status reports.

THE MAIN SET IS DIFFERENT: it is one continuous 78-minute wav, so a single
stage->scene row cannot describe it. Its stage_map entry names a CUE FILE
(demos/show/cues-pm-2026.json) instead, and the cue engine below resolves
scene / logo / video-insert from the SYNCED TRANSPORT POSITION rather than
from wall clock — pause, seek back, seek forward all stay correct because
position is the only input. See Box._eval_cues.

Usage:  demos/show/follower_server.py [--port 8123] [--config PATH]
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))

CONFIG_PATH = os.path.join(HERE, 'config.json')
STAGE_MAP_PATH = os.path.join(HERE, 'stage_map.json')
PRESETS_PATH = os.path.join(HERE, 'scene_presets.json')

# how long a long poll parks before answering with the current state anyway
POLL_TIMEOUT = 25.0

# The cue engine re-evaluates at this rate off the extrapolated position, so a
# cue lands within ~50 ms of its beat even though the leader only syncs at 4 Hz.
CUE_HZ = 20.0

# A position jump larger than this between two evaluations is a SEEK, not
# playback. Video inserts only arm on a continuous crossing of their start.
SEEK_GAP = 1.0

DEFAULT_CONFIG = {
    'port': 8123,
    'audio_dir': 'waveloop/audio',
    'audible': False,
    'drift_seconds': 0.25,
    'logo': {'src': 'arche-logos/Arche_A-Logo_17.png',
             'scale': 0.34, 'opacity': 0.9, 'breathe': True},
}


def load_json(path, default):
    try:
        with open(path, encoding='utf-8') as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        print('[follower] %s: %s — using defaults' % (path, exc), file=sys.stderr)
        return default


def write_json_atomic(path, obj):
    """Presets are written from a request handler while the show is running —
    a half-written file after a crash would take the saved look down with it,
    so build it beside the target and rename over."""
    tmp = path + '.tmp'
    try:
        with open(tmp, 'w', encoding='utf-8') as fh:
            json.dump(obj, fh, indent=2, sort_keys=True)
            fh.write('\n')
        os.replace(tmp, path)
        return True
    except OSError as exc:
        print('[follower] could not write %s: %s' % (path, exc), file=sys.stderr)
        try:
            os.unlink(tmp)
        except OSError:
            pass
        return False


class Box:
    """The desired-state box: what the TV should be showing right now.

    `seq` is bumped by every mutation, and the long poll blocks on the
    condition variable until it moves past what the caller last saw. Every
    field is plain JSON so /show/status and /show/events can hand the whole
    thing over verbatim.
    """

    def __init__(self, stage_map, cues=None, presets=None):
        self.lock = threading.Condition()
        self.seq = 1
        self.stage_map = stage_map
        d = stage_map.get('default', {})
        self.scene = d.get('scene', 'TEST_CARD')
        self.logo = bool(d.get('logo', False))
        self.stage = None
        self.source = 'boot'          # boot | stage | cue | override
        self.override = None          # operator's scene pick, or None
        self.transport = {'track': None, 'position': 0.0,
                          'playing': False, 'duration': 0.0}
        self.sync_at = 0.0            # last /show/sync (leader liveness)
        self.page = None              # last /show/page report
        self.page_at = 0.0            # last poll or report (page liveness)

        # ---- cue engine -------------------------------------------------
        self.cue_doc = cues or {}
        self.cues = sorted(self.cue_doc.get('cues', []),
                           key=lambda c: (float(c.get('at') or 0),
                                          0 if c.get('type') != 'video' else 1))
        self.scene_cues = [c for c in self.cues if c.get('type') != 'video']
        self.video_cues = [c for c in self.cues if c.get('type') == 'video']
        self.cue_index = -1           # index into scene_cues, -1 = before the first
        self.cue_pos = None           # position at the last evaluation
        self.video = None             # {video, at, duration, return_scene}
        # per video cue: 'armed' | 'active' | 'skipped'
        self.video_state = ['armed'] * len(self.video_cues)

        # ---- per-scene presets ------------------------------------------
        self.presets = presets if isinstance(presets, dict) else {}
        self.presets_rev = 1          # bumped on every save, so pages refetch

    # ---- helpers ---------------------------------------------------------
    def _stage_entry(self, stage=None):
        s = self.stage if stage is None else stage
        return (self.stage_map.get('stages', {}).get(s or '')
                or self.stage_map.get('default', {}))

    def _cue_stage(self, stage=None):
        """Does this stage hand the wheel to the cue engine?"""
        return bool(self._stage_entry(stage).get('cues')) and bool(self.cues)

    # ---- mutations -------------------------------------------------------
    def _bump(self):
        self.seq += 1
        self.lock.notify_all()

    def apply_stage(self, stage):
        stage = str(stage or '').strip()
        with self.lock:
            self.stage = stage
            self.override = None      # a stage command clears an override
            entry = self._stage_entry()
            if self._cue_stage():
                # arriving on a cue stage: resolve from wherever the playhead
                # already is, and do not replay a video insert we landed inside
                self.cue_index = -1
                self.cue_pos = None
                self.video = None
                self.video_state = ['armed'] * len(self.video_cues)
                self.source = 'cue'
                self._eval_cues(self._position(), force=True)
            else:
                self.scene = entry.get('scene', self.scene)
                self.logo = bool(entry.get('logo', False))
                self.source = 'stage'
            self._bump()
        return {'stage': stage, 'scene': self.scene, 'logo': self.logo,
                'mapped': stage in self.stage_map.get('stages', {}),
                'cues': self._cue_stage()}

    def apply_scene(self, name, logo=None):
        with self.lock:
            if name is None:
                # Release the override. On a cue stage that means handing the
                # wheel back to the cue list at wherever the playhead is now —
                # NOT replaying anything it stepped over while overridden.
                self.override = None
                if self._cue_stage():
                    self.source = 'cue'
                    self.cue_index = -1
                    self._eval_cues(self._position(), force=True)
                else:
                    entry = self._stage_entry()
                    self.scene = entry.get('scene', self.scene)
                    self.logo = bool(entry.get('logo', False))
                    self.source = 'stage'
            else:
                self.override = str(name).strip().upper()
                self.scene = self.override
                self.video = None     # an override also takes the video down
                if logo is not None:
                    self.logo = bool(logo)
                self.source = 'override'
            self._bump()
        return {'scene': self.scene, 'logo': self.logo, 'source': self.source}

    def apply_logo(self, on):
        """Operator forcing the logo layer up or down. Holds until the next
        stage command, which re-asserts whatever the map says."""
        with self.lock:
            self.logo = bool(on)
            self._bump()
        return {'logo': self.logo}

    def apply_sync(self, body):
        with self.lock:
            t = self.transport
            new = {
                'track': body.get('track') or None,
                'position': float(body.get('position') or 0.0),
                'playing': bool(body.get('playing')),
                'duration': float(body.get('duration') or 0.0),
            }
            changed = (new['track'] != t['track']
                       or new['playing'] != t['playing']
                       or abs(new['position'] - t['position']) > 0.01)
            self.transport = new
            self.sync_at = time.time()
            if self._eval_cues(new['position']):
                changed = True
            if changed:
                self._bump()
        return new

    # ---- cue engine ------------------------------------------------------
    def _position(self):
        """The leader's playhead right now — call with the lock held.

        Between syncs (the leader sends at 4 Hz) a playing transport is
        extrapolated from wall clock, which is the ONLY use of wall clock here:
        the cue times themselves are compared against track position, so a
        pause or a seek needs no special case at all."""
        t = self.transport
        pos = t['position']
        if t['playing'] and self.sync_at:
            pos += max(0.0, time.time() - self.sync_at)
        return pos

    def tick(self):
        """Called ~CUE_HZ times a second by the cue thread."""
        with self.lock:
            if self._eval_cues(self._position()):
                self._bump()

    def _eval_cues(self, pos, force=False):
        """Resolve scene / logo / video from the transport position.

        Returns True if anything the page cares about moved. Never called for
        its side effects alone — the caller owns the seq bump.

        Rules, in order:
          * an operator override outranks the whole cue list (and suspends it,
            including the video inserts, until POST /show/scene {name:null})
          * the ACTIVE SCENE is the last scene cue with at <= pos. That single
            line is what makes seeking work in both directions: there is no
            "next cue" pointer to get out of step, only a lookup.
          * a video insert plays only while pos is inside [at, at+duration)
            AND the playhead ENTERED that window by playing through its start.
            Seeking into the middle marks it skipped (no half-clip), seeking
            past it never plays it, and rewinding to before `at` re-arms it.
        """
        if self.override is not None or not self._cue_stage():
            return False

        prev = self.cue_pos
        self.cue_pos = pos
        continuous = prev is not None and 0 <= (pos - prev) < SEEK_GAP

        # --- video inserts ------------------------------------------------
        video = None
        for i, c in enumerate(self.video_cues):
            at = float(c.get('at') or 0)
            end = at + float(c.get('duration') or 0)
            if not (at <= pos < end):
                self.video_state[i] = 'armed'      # outside: re-arm for a rewind
                continue
            if self.video_state[i] == 'armed':
                entered = continuous and prev < at
                self.video_state[i] = 'active' if entered else 'skipped'
            if self.video_state[i] == 'active':
                video = {'video': c.get('video'), 'at': at,
                         'duration': float(c.get('duration') or 0),
                         'return_scene': c.get('return_scene')}
                break

        # --- scene --------------------------------------------------------
        idx = -1
        for i, c in enumerate(self.scene_cues):
            if float(c.get('at') or 0) <= pos:
                idx = i
            else:
                break
        scene = self.scene
        logo = self.logo
        if idx >= 0:
            scene = self.scene_cues[idx].get('scene', scene)
            if idx != self.cue_index or force:
                # the logo is re-asserted only when the cue itself changes, so
                # an operator's POST /show/logo survives until the next cue
                logo = bool(self.scene_cues[idx].get('logo', False))
        if video and video.get('return_scene'):
            # the insert names what is underneath it and what to come back to
            scene = video['return_scene']

        changed = (scene != self.scene or logo != self.logo
                   or video != self.video or idx != self.cue_index)
        self.cue_index = idx
        self.scene = scene
        self.logo = logo
        self.video = video
        self.source = 'cue'
        return changed

    def cue_status(self):
        """Small, for /show/status — the whole list is at /show/cues."""
        if not self._cue_stage():
            return None
        cur = self.scene_cues[self.cue_index] if self.cue_index >= 0 else None
        nxt = None
        pos = self.cue_pos if self.cue_pos is not None else 0.0
        for c in self.cues:
            if float(c.get('at') or 0) > pos:
                nxt = c
                break
        return {
            'file': self.cue_doc.get('_file'),
            'count': len(self.cues),
            'position': round(pos, 3),
            'index': self.cue_index,
            'current': ({'scene': cur.get('scene'), 'at': cur.get('at'),
                         'track': cur.get('track')} if cur else None),
            'next': ({'type': nxt.get('type'), 'at': nxt.get('at'),
                      'scene': nxt.get('scene') or nxt.get('video'),
                      'in': round(float(nxt.get('at') or 0) - pos, 2)}
                     if nxt else None),
            'video_state': list(self.video_state),
        }

    # ---- per-scene presets ----------------------------------------------
    def save_preset(self, body):
        scene = str(body.get('scene') or '').strip().upper()
        if not scene:
            return {'error': 'no scene'}, 400
        with self.lock:
            if body.get('clear'):
                self.presets.pop(scene, None)
                entry = None
            else:
                entry = {}
                if isinstance(body.get('controls'), dict):
                    entry['controls'] = body['controls']
                if isinstance(body.get('grade'), dict):
                    entry['grade'] = body['grade']
                if body.get('quality') is not None:
                    entry['quality'] = float(body['quality'])
                self.presets[scene] = entry
            self.presets_rev += 1
            snap = dict(self.presets)
            self._bump()          # so every following page refetches
        write_json_atomic(PRESETS_PATH, snap)
        return {'ok': True, 'scene': scene, 'preset': entry,
                'rev': self.presets_rev}, 200

    def note_page(self, body, addr=''):
        # more than one page may be following (a second screen, or someone
        # checking from a laptop) — they all get the same commands, and the
        # last report wins. `from` says which one you are looking at.
        with self.lock:
            self.page = dict(body, **{'from': addr})
            self.page_at = time.time()

    def touch_page(self):
        with self.lock:
            self.page_at = time.time()

    # ---- reads -----------------------------------------------------------
    def snapshot(self, cfg):
        now = time.time()
        with self.lock:
            return {
                'seq': self.seq,
                'scene': self.scene,
                'logo': self.logo,
                'stage': self.stage,
                'source': self.source,
                'override': self.override,
                'video': dict(self.video) if self.video else None,
                'cue': self.cue_status(),
                'presets_rev': self.presets_rev,
                'transport': dict(self.transport),
                'sync_age': round(now - self.sync_at, 2) if self.sync_at else None,
                'page': self.page,
                'page_age': round(now - self.page_at, 2) if self.page_at else None,
                'page_connected': bool(self.page_at and now - self.page_at < 6.0),
                'stage_map': self.stage_map,
                'audible': bool(cfg.get('audible', False)),
                'drift_seconds': float(cfg.get('drift_seconds', 0.25)),
                'logo_style': cfg.get('logo', DEFAULT_CONFIG['logo']),
                'server_time': round(now, 3),
            }

    def wait_past(self, since, cfg):
        """Block until seq > since, or POLL_TIMEOUT. Always returns a state.

        A `since` from the future means this server restarted under a page
        that is still polling — answer at once so the TV re-syncs to the new
        box instead of parking for 25 s on every poll until the seq catches up.
        """
        deadline = time.time() + POLL_TIMEOUT
        with self.lock:
            if since > self.seq:
                return self.snapshot(cfg)
            while self.seq <= since:
                left = deadline - time.time()
                if left <= 0:
                    break
                self.lock.wait(left)
        return self.snapshot(cfg)


# --------------------------------------------------------------- scene roster
NAME_RE = re.compile(r"name:\s*'([A-Z0-9_]+)'")


def scene_roster():
    """Every gallery entry, in gallery order, flagged for local availability.

    Read straight off the two manifests the page itself imports, so this can
    never drift from what demos.html will actually accept as a hash/override.
    """
    out, seen = [], set()

    def add(name, kind, folder=None):
        if name in seen:
            return
        seen.add(name)
        avail = True
        if folder:
            avail = os.path.isdir(os.path.join(REPO, 'demos', 'syn', 'scenes', folder))
        out.append({'name': name, 'kind': kind, 'available': avail})

    try:
        with open(os.path.join(REPO, 'demos.html'), encoding='utf-8') as fh:
            html = fh.read()
        block = re.search(r'const DEMOS = \[(.*?)\.\.\.SYN_SCENES', html, re.S)
        if block:
            for nm in NAME_RE.findall(block.group(1)):
                add(nm, 'native')
    except OSError:
        pass

    try:
        with open(os.path.join(REPO, 'demos', 'syn', 'syn-manifest.js'),
                  encoding='utf-8') as fh:
            man = fh.read()
        for m in re.finditer(
                r"name:\s*'([A-Z0-9_]+)',\s*scene:\s*'([^']+)'", man):
            add(m.group(1), 'syn', m.group(2))
    except OSError:
        pass
    return out


# ------------------------------------------------------------------- handler
class Handler(SimpleHTTPRequestHandler):
    server_version = 'VizierFollower/1.0'
    # keep-alive matters here: the leader syncs at 4 Hz and the page reports at
    # 2 Hz, which is a lot of TCP setup to pay for on HTTP/1.0. Every response
    # below sets Content-Length (or is 204/304), so this is safe.
    protocol_version = 'HTTP/1.1'
    box: Box = None          # set in main()
    cfg: dict = None
    audio_dir: str = ''

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=REPO, **kw)

    def log_message(self, fmt, *args):
        # a 2-5 Hz sync + a parked long poll would otherwise bury the log
        if '/show/events' in (self.path or '') or '/show/sync' in (self.path or ''):
            return
        sys.stderr.write('[follower] %s %s\n'
                         % (self.client_address[0], fmt % args))

    # --- helpers ----------------------------------------------------------
    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Max-Age', '600')

    def end_headers(self):
        # covers the static branch too: the page is same-origin with this
        # server, but the leader's page at :8090 is not
        self._cors()
        # SimpleHTTPRequestHandler sends no cache directives, so Chrome
        # heuristically caches. On a show rig a kiosk that quietly kept
        # yesterday's show-client.js is a bug that only shows up at the worst
        # moment — revalidation costs nothing over a LAN.
        if not self.path.startswith('/show/'):
            self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass   # the poller navigated away mid-request

    def _body(self):
        try:
            n = int(self.headers.get('Content-Length', 0) or 0)
            return json.loads(self.rfile.read(n) or b'{}')
        except (ValueError, json.JSONDecodeError):
            return {}

    # --- verbs ------------------------------------------------------------
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        p = urlparse(self.path)
        if p.path.startswith('/show/'):
            return self._show_get(p)
        return super().do_GET()

    def do_HEAD(self):
        # the page HEADs /show/audio/<file> to tell "missing wav" apart from
        # "wav that failed to decode" before it ever touches the deck
        p = urlparse(self.path)
        if p.path.startswith('/show/audio/'):
            path = self._find_audio(unquote(p.path[len('/show/audio/'):]))
            if not path:
                self.send_response(404)
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
            self.send_response(200)
            self.send_header('Content-Type',
                             mimetypes.guess_type(path)[0] or 'application/octet-stream')
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Content-Length', str(os.path.getsize(path)))
            self.end_headers()
            return
        if p.path.startswith('/show/'):
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        return super().do_HEAD()

    def do_POST(self):
        p = urlparse(self.path)
        if not p.path.startswith('/show/'):
            return self._json({'error': 'not found'}, 404)
        body = self._body()
        if p.path == '/show/stage':
            r = self.box.apply_stage(body.get('stage'))
            print('[follower] stage %(stage)s -> %(scene)s logo=%(logo)s'
                  '%(m)s' % dict(r, m='' if r['mapped'] else ' (unmapped, default)'))
            return self._json(self.box.snapshot(self.cfg))
        if p.path == '/show/scene':
            name = body.get('name')
            r = self.box.apply_scene(name, body.get('logo'))
            print('[follower] scene override -> %s (%s)' % (r['scene'], r['source']))
            return self._json(self.box.snapshot(self.cfg))
        if p.path == '/show/logo':
            r = self.box.apply_logo(body.get('on'))
            print('[follower] logo %s' % ('on' if r['logo'] else 'off'))
            return self._json(self.box.snapshot(self.cfg))
        if p.path == '/show/sync':
            self.box.apply_sync(body)
            return self._json({'ok': True, 'seq': self.box.seq})
        if p.path == '/show/page':
            self.box.note_page(body, self.client_address[0])
            return self._json({'ok': True})
        if p.path == '/show/preset':
            r, code = self.box.save_preset(body)
            if code == 200:
                print('[follower] preset %s %s'
                      % (r['scene'], 'cleared' if r['preset'] is None
                         else 'saved (%d controls)'
                              % len((r['preset'].get('controls') or {}))))
            return self._json(r, code)
        return self._json({'error': 'not found'}, 404)

    def _show_get(self, p):
        qs = parse_qs(p.query)
        if p.path == '/show/status':
            return self._json(self.box.snapshot(self.cfg))
        if p.path == '/show/scenes':
            return self._json({'scenes': scene_roster()})
        if p.path == '/show/config':
            return self._json(self.cfg)
        if p.path == '/show/cues':
            return self._json(self.box.cue_doc)
        if p.path == '/show/presets':
            return self._json({'rev': self.box.presets_rev,
                               'presets': self.box.presets})
        if p.path == '/show/events':
            try:
                since = int((qs.get('since') or ['0'])[0])
            except ValueError:
                since = 0
            self.box.touch_page()
            state = self.box.wait_past(since, self.cfg)
            self.box.touch_page()
            return self._json(state)
        if p.path.startswith('/show/audio/'):
            return self._audio(unquote(p.path[len('/show/audio/'):]))
        return self._json({'error': 'not found'}, 404)

    # --- show audio, with Range (the main set is a ~1 h wav) ---------------
    def _find_audio(self, name):
        base = os.path.basename(name)
        if not base or base.startswith('.'):
            return None
        low = base.lower()
        for root, _dirs, files in os.walk(self.audio_dir):
            for f in files:
                if f.lower() == low:
                    return os.path.join(root, f)
        return None

    def _audio(self, name):
        path = self._find_audio(name)
        if not path:
            return self._json(
                {'error': 'not found', 'looked_in': self.audio_dir,
                 'wanted': os.path.basename(name)}, 404)
        size = os.path.getsize(path)
        ctype = mimetypes.guess_type(path)[0] or 'application/octet-stream'
        start, end = 0, size - 1
        status = 200
        rng = self.headers.get('Range')
        m = re.match(r'bytes=(\d*)-(\d*)$', rng or '')
        if m and (m.group(1) or m.group(2)):
            if m.group(1):
                start = int(m.group(1))
                if m.group(2):
                    end = min(int(m.group(2)), size - 1)
            else:                                  # suffix range: bytes=-N
                start = max(0, size - int(m.group(2)))
            if start >= size:
                self.send_response(416)
                self.send_header('Content-Range', 'bytes */%d' % size)
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
            status = 206
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Length', str(end - start + 1))
        if status == 206:
            self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, size))
        self.end_headers()
        remaining = end - start + 1
        try:
            with open(path, 'rb') as fh:
                fh.seek(start)
                while remaining > 0:
                    chunk = fh.read(min(262144, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass   # Chrome abandons a range the moment the operator seeks


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--port', type=int, default=None)
    ap.add_argument('--config', default=CONFIG_PATH)
    ap.add_argument('--host', default='0.0.0.0')
    ap.add_argument('--audio-dir', default=None,
                    help='override config.audio_dir — the one thing that '
                         'genuinely differs per machine, so the LaunchAgent '
                         'can set it without the config file forking')
    args = ap.parse_args()

    cfg = dict(DEFAULT_CONFIG)
    cfg.update(load_json(args.config, {}))
    stage_map = load_json(STAGE_MAP_PATH, {'default': {'scene': 'TEST_CARD',
                                                       'logo': False},
                                           'stages': {}})
    port = args.port or int(cfg.get('port', 8123))

    # the cue file is named by whichever stage rows use one (only `main` today)
    cue_doc = {}
    cue_names = {e.get('cues') for e in stage_map.get('stages', {}).values()
                 if isinstance(e, dict) and e.get('cues')}
    for name in sorted(cue_names):
        path = name if os.path.isabs(name) else os.path.join(HERE, name)
        cue_doc = load_json(path, {})
        cue_doc['_file'] = os.path.basename(path)
        break
    presets = load_json(PRESETS_PATH, {}) if os.path.exists(PRESETS_PATH) else {}

    audio_dir = os.path.expanduser(
        args.audio_dir or cfg.get('audio_dir') or 'waveloop/audio')
    if not os.path.isabs(audio_dir):
        audio_dir = os.path.join(REPO, audio_dir)
    audio_dir = os.path.normpath(audio_dir)

    box = Box(stage_map, cue_doc, presets)
    Handler.box = box
    Handler.cfg = cfg
    Handler.audio_dir = audio_dir

    # The cue clock. The leader syncs at 4 Hz, which would quantise every cue
    # to a 250 ms grid — plenty for a stage change, far too coarse for a cut
    # that is supposed to land on a beat. This re-evaluates off the
    # extrapolated position instead, and costs a dict comparison per tick.
    def cue_clock():
        while True:
            time.sleep(1.0 / CUE_HZ)
            try:
                box.tick()
            except Exception as exc:                    # never take the server down
                print('[follower] cue tick: %r' % (exc,), file=sys.stderr)
    threading.Thread(target=cue_clock, daemon=True).start()

    httpd = ThreadingHTTPServer((args.host, port), Handler)
    httpd.daemon_threads = True
    print('[follower] serving %s on %s:%d' % (REPO, args.host, port))
    print('[follower] audio dir: %s (%s)'
          % (audio_dir, 'present' if os.path.isdir(audio_dir) else 'MISSING'))
    print('[follower] cues: %s (%d) · presets: %d scene(s)'
          % (cue_doc.get('_file') or 'none', len(box.cues), len(presets)))
    print('[follower] audible=%s · gallery: http://localhost:%d/demos.html?show=1'
          % (cfg.get('audible', False), port))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
