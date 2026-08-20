#!/usr/bin/env python3
"""Collector for demos/tuning/syn_probe.html (stdlib only).

With ?shots=1 the page also POSTs each scene's final frame to /shot; those land
in a `shots/` directory beside the output file, one PNG per scene.

The probe page POSTs one JSON object per scene to /result as it finishes it,
then /done at the end. Every result is appended to the output file as a JSON
line the moment it arrives, so a scene that wedges the GPU or crashes the tab
still leaves every earlier verdict on disk. Exits on /done, or after an idle
timeout if the page never got going.

Usage: probe_server.py <output.jsonl> [idle-timeout-seconds]
"""
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = 8125
OUT = sys.argv[1] if len(sys.argv) > 1 else 'probe.jsonl'
IDLE_TIMEOUT = float(sys.argv[2]) if len(sys.argv) > 2 else 120.0

done_event = threading.Event()
lock = threading.Lock()
last_activity = time.time()
count = 0


class Handler(BaseHTTPRequestHandler):
    server_version = 'VizierProbe/1.0'

    def log_message(self, fmt, *args):
        pass

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        self.send_response(200)
        self._cors()
        self.end_headers()
        self.wfile.write(b'ok')

    def do_POST(self):
        global last_activity, count
        with lock:
            last_activity = time.time()
        parsed = urlparse(self.path)
        if parsed.path == '/result':
            n = int(self.headers.get('Content-Length', 0) or 0)
            body = self.rfile.read(n) if n else b'{}'
            try:
                rec = json.loads(body)
            except Exception:
                rec = {'status': 'unparseable', 'raw': body[:200].decode('utf8', 'replace')}
            with lock:
                with open(OUT, 'a') as fh:
                    fh.write(json.dumps(rec) + '\n')
                count += 1
            print('[probe] %3d %-34s %s' % (count, rec.get('name', '?'), rec.get('status', '?')),
                  flush=True)
        elif parsed.path == '/shot':
            name = (parse_qs(parsed.query).get('name') or ['scene'])[0]
            name = ''.join(c if c.isalnum() or c in '_-' else '_' for c in name)
            n = int(self.headers.get('Content-Length', 0) or 0)
            body = self.rfile.read(n) if n else b''
            d = os.path.join(os.path.dirname(os.path.abspath(OUT)) or '.', 'shots')
            os.makedirs(d, exist_ok=True)
            with open(os.path.join(d, name + '.png'), 'wb') as fh:
                fh.write(body)
        elif parsed.path == '/done':
            print('[probe] done: %d results -> %s' % (count, OUT), flush=True)
            done_event.set()
        self.send_response(200)
        self._cors()
        self.end_headers()


def watchdog():
    while not done_event.is_set():
        if time.time() - last_activity > IDLE_TIMEOUT:
            print('[probe] idle timeout (%.0fs) after %d results' % (IDLE_TIMEOUT, count),
                  file=sys.stderr, flush=True)
            os._exit(1)
        time.sleep(0.25)
    time.sleep(0.5)
    os._exit(0)


def main():
    open(OUT, 'w').close()
    httpd = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    threading.Thread(target=watchdog, daemon=True).start()
    print('[probe] listening on :%d, writing %s' % (PORT, OUT), flush=True)
    httpd.serve_forever()


if __name__ == '__main__':
    main()
