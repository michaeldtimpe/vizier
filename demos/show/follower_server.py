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
    GET  /show/events?since=N      long poll; returns as soon as seq > N
    POST /show/scene   {name}      operator override, sticks until the next
                                   stage command or {name: null} to release
    POST /show/logo    {on}        force the logo layer, same lifetime
    POST /show/stage   {stage}     resolve stage -> scene+logo via stage_map
    POST /show/sync    {track, position, playing, duration}
    POST /show/page    {...}       the gallery page reporting its own state
    GET  /show/audio/<basename>    a show wav from config.audio_dir (Range
                                   supported — the main set is a ~1 h wav)

Everything else falls through to the repo's static files.

The stage -> scene map lives HERE (demos/show/stage_map.json), not in
show-view: one source of truth, edited in this repo, and show-view's
VISUALS menu displays whatever /show/status reports. Editing the cue list
is a JSON edit + rsync, never a code change on either side.

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

# how long a long poll parks before answering with the current state anyway
POLL_TIMEOUT = 25.0

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


class Box:
    """The desired-state box: what the TV should be showing right now.

    `seq` is bumped by every mutation, and the long poll blocks on the
    condition variable until it moves past what the caller last saw. Every
    field is plain JSON so /show/status and /show/events can hand the whole
    thing over verbatim.
    """

    def __init__(self, stage_map):
        self.lock = threading.Condition()
        self.seq = 1
        self.stage_map = stage_map
        d = stage_map.get('default', {})
        self.scene = d.get('scene', 'TEST_CARD')
        self.logo = bool(d.get('logo', False))
        self.stage = None
        self.source = 'boot'          # boot | stage | override
        self.override = None          # operator's scene pick, or None
        self.transport = {'track': None, 'position': 0.0,
                          'playing': False, 'duration': 0.0}
        self.sync_at = 0.0            # last /show/sync (leader liveness)
        self.page = None              # last /show/page report
        self.page_at = 0.0            # last poll or report (page liveness)

    # ---- mutations -------------------------------------------------------
    def _bump(self):
        self.seq += 1
        self.lock.notify_all()

    def apply_stage(self, stage):
        stage = str(stage or '').strip()
        entry = (self.stage_map.get('stages', {}).get(stage)
                 or self.stage_map.get('default', {}))
        with self.lock:
            self.stage = stage
            self.override = None      # a stage command clears an override
            self.scene = entry.get('scene', self.scene)
            self.logo = bool(entry.get('logo', False))
            self.source = 'stage'
            self._bump()
        return {'stage': stage, 'scene': self.scene, 'logo': self.logo,
                'mapped': stage in self.stage_map.get('stages', {})}

    def apply_scene(self, name, logo=None):
        with self.lock:
            if name is None:
                # release the override: fall back to the current stage's map
                self.override = None
                entry = (self.stage_map.get('stages', {}).get(self.stage or '')
                         or self.stage_map.get('default', {}))
                self.scene = entry.get('scene', self.scene)
                self.logo = bool(entry.get('logo', False))
                self.source = 'stage'
            else:
                self.override = str(name).strip().upper()
                self.scene = self.override
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
            if changed:
                self._bump()
        return new

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
        return self._json({'error': 'not found'}, 404)

    def _show_get(self, p):
        qs = parse_qs(p.query)
        if p.path == '/show/status':
            return self._json(self.box.snapshot(self.cfg))
        if p.path == '/show/scenes':
            return self._json({'scenes': scene_roster()})
        if p.path == '/show/config':
            return self._json(self.cfg)
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

    audio_dir = os.path.expanduser(
        args.audio_dir or cfg.get('audio_dir') or 'waveloop/audio')
    if not os.path.isabs(audio_dir):
        audio_dir = os.path.join(REPO, audio_dir)
    audio_dir = os.path.normpath(audio_dir)

    Handler.box = Box(stage_map)
    Handler.cfg = cfg
    Handler.audio_dir = audio_dir

    httpd = ThreadingHTTPServer((args.host, port), Handler)
    httpd.daemon_threads = True
    print('[follower] serving %s on %s:%d' % (REPO, args.host, port))
    print('[follower] audio dir: %s (%s)'
          % (audio_dir, 'present' if os.path.isdir(audio_dir) else 'MISSING'))
    print('[follower] audible=%s · gallery: http://localhost:%d/demos.html?show=1'
          % (cfg.get('audible', False), port))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
