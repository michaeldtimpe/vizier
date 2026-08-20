#!/usr/bin/env python3
"""Dev capture server for vizier demo tuning (stdlib only).

Serves two harnesses on the same port, both of which drive demos.html from
headless Chrome and both of which end by making this process exit, so a
driver script can simply wait on it:

  /frame + /done   demos.html?capture=N&every=SEC&delay=SEC POSTs one PNG per
                   shot to /frame (binary body; demo name / frame index /
                   elapsed time in the query string), then /done once it has
                   sent every frame it was asked for. Frames are written into
                   the output directory given as argv[1]. See capture.sh.

  /bench           demos.html?bench=1&scenes=...&quality=... POSTs one JSON
                   document with the whole frame-time sweep in it, once, at the
                   end of the run. It is written to <output-dir>/bench.json
                   (override with argv[3]). See bench.sh.

Either way an idle timeout also ends the process, in case the page never got
as far as posting anything (bad scene name, Chrome failed to launch, ...).

Usage: capture_server.py <output-dir> [idle-timeout-seconds] [bench-json-path]
"""
import os
import re
import sys
import time
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT = 8124
OUTDIR = sys.argv[1] if len(sys.argv) > 1 else '.'
IDLE_TIMEOUT = float(sys.argv[2]) if len(sys.argv) > 2 else 120.0
BENCH_PATH = sys.argv[3] if len(sys.argv) > 3 else os.path.join(OUTDIR, 'bench.json')

os.makedirs(OUTDIR, exist_ok=True)

done_event = threading.Event()
lock = threading.Lock()
last_activity = time.time()


def touch():
    global last_activity
    with lock:
        last_activity = time.time()


def safe(s):
    return re.sub(r'[^A-Za-z0-9_.-]+', '_', s or '') or 'x'


class Handler(BaseHTTPRequestHandler):
    server_version = 'VizierCapture/1.0'

    def log_message(self, fmt, *args):
        sys.stderr.write('[capture] ' + (fmt % args) + '\n')

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def do_OPTIONS(self):
        # the browser preflights the /frame POST because it carries a
        # Content-Type: image/png body, which isn't a "simple" request.
        touch()
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        # liveness probe for capture.sh, polling until the server is up
        self.send_response(200)
        self._cors()
        self.end_headers()
        self.wfile.write(b'ok')

    def do_POST(self):
        touch()
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)

        if parsed.path == '/frame':
            length = int(self.headers.get('Content-Length', 0) or 0)
            body = self.rfile.read(length) if length else b''
            demo = safe((qs.get('demo') or ['demo'])[0])
            frame = safe((qs.get('frame') or ['0'])[0])
            elapsed = safe((qs.get('elapsed') or ['0'])[0])
            try:
                frame_n = int(frame)
            except ValueError:
                frame_n = 0
            fname = '%s_%04d_%ss.png' % (demo, frame_n, elapsed)
            path = os.path.join(OUTDIR, fname)
            with open(path, 'wb') as fh:
                fh.write(body)
            print('[capture] wrote %s (%d bytes)' % (path, len(body)))
            self.send_response(200)
            self._cors()
            self.end_headers()

        elif parsed.path == '/bench':
            length = int(self.headers.get('Content-Length', 0) or 0)
            body = self.rfile.read(length) if length else b''
            # the page has already serialized this; store it verbatim so a
            # malformed run is still inspectable rather than silently dropped
            with open(BENCH_PATH, 'wb') as fh:
                fh.write(body)
            print('[capture] wrote %s (%d bytes)' % (BENCH_PATH, len(body)))
            self.send_response(200)
            self._cors()
            self.end_headers()
            # a bench run posts exactly once, at the very end
            done_event.set()

        elif parsed.path == '/done':
            print('[capture] done signal received')
            self.send_response(200)
            self._cors()
            self.end_headers()
            done_event.set()

        else:
            self.send_response(404)
            self._cors()
            self.end_headers()


def watchdog():
    while not done_event.is_set():
        if time.time() - last_activity > IDLE_TIMEOUT:
            print('[capture] idle timeout (%.0fs), exiting' % IDLE_TIMEOUT, file=sys.stderr)
            os._exit(1)
        time.sleep(0.25)
    time.sleep(0.5)   # let the /done HTTP response flush before we die
    os._exit(0)


def main():
    httpd = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    threading.Thread(target=watchdog, daemon=True).start()
    print('[capture] listening on :%d, writing frames to %s (bench -> %s)'
          % (PORT, OUTDIR, BENCH_PATH))
    httpd.serve_forever()


if __name__ == '__main__':
    main()
