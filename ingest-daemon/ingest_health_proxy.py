#!/usr/bin/env python3
"""
ingest_health_proxy.py — GIL-independent /health front for ingest_daemon.py
(2026-07-28, Design_RTSP_Capture_Backend.md §6.41).

Why this exists: ingest_daemon.py's own HTTP server was observed going
unresponsive for tens of seconds at a time under a real multi-camera fleet on
a busy shared host, even though (confirmed empirically, §6.41 — synthetic
concurrent-demux and concurrent-decode+PIL tests) no single PyAV call was
found holding the GIL pathologically. A live SIGUSR1 stack dump caught during
an actual unresponsive window showed the accept-loop thread idle in
select() — not deadlocked, just starved of a scheduling turn under the
process's own thread count (100+ OS threads: per-camera io/app_rtp/AI-decode
threads, libav's own native decode threads, shared executor pools). Whatever
the exact mix of GIL round-robin overhead and OS-level CPU contention on this
shared host, the practical effect is the same: ingest_daemon.py's watchdog
(server/src/utils/ingestDaemonWatchdog.js) sees /health fail, restarts a
daemon that wasn't actually dead, and the resulting mass camera reconnect adds
more of exactly the same load.

This process is a structural fix, not a diagnosis of the exact mechanism: it
runs in a completely separate OS process with nothing else competing for its
own (separate) GIL, so /health is answered from a lightweight heartbeat file
that ingest_daemon.py's _stats_sampler() thread writes once a second,
regardless of how busy the real daemon's decode/io threads are. Every other
endpoint is transparently forwarded to the real daemon (now listening on
127.0.0.1:<internal-port> instead of the external address) — those calls can
still be slow/timeout if the real daemon is genuinely overloaded, which is
fine: they aren't what the watchdog uses to decide "restart or not", and a
slow POST /cameras is not a new problem this introduces.

If the real daemon is not just busy but actually gone (crashed, SIGKILLed,
normal restart), the heartbeat file simply stops updating — after
HEARTBEAT_STALE_S with no fresh tick, /health starts returning 503, and the
existing Node-side watchdog+restart logic (unchanged) takes over exactly as
it did before this file existed. This process also exits on its own within a
couple of seconds of noticing its parent PID is gone (--parent-pid), so a
killed/crashed ingest_daemon.py doesn't leave an orphaned proxy holding the
external port.
"""

import argparse
import http.client
import json
import os
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

HEARTBEAT_STALE_S = 5.0   # generous vs. the 1s heartbeat-write interval
PROXY_TIMEOUT_S   = 10.0  # for non-/health requests forwarded to the real daemon
PARENT_POLL_S     = 2.0

_heartbeat_file = None
_internal_port  = None


def _read_heartbeat():
    try:
        with open(_heartbeat_file) as f:
            return json.load(f)
    except Exception:
        return None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _json(self, status, body):
        data = json.dumps(body).encode()
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _handle_health(self):
        hb = _read_heartbeat()
        if hb is None:
            self._json(503, {"status": "unhealthy", "error": "no heartbeat file yet"})
            return
        age = time.monotonic() - hb.get("ts", 0)
        if age > HEARTBEAT_STALE_S:
            self._json(503, {"status": "unhealthy", "error": f"heartbeat stale ({age:.1f}s)"})
            return
        # Same shape as ingest_daemon.py's own /health always returned —
        # callers (ingestDaemonWatchdog.js, admin API) don't need to change.
        self._json(200, {"status": "ok", "cameras": hb.get("cameras", 0)})

    def _proxy(self, method):
        body = None
        length = self.headers.get("Content-Length")
        if length:
            body = self.rfile.read(int(length))
        try:
            conn = http.client.HTTPConnection("127.0.0.1", _internal_port, timeout=PROXY_TIMEOUT_S)
            headers = {k: v for k, v in self.headers.items() if k.lower() not in ("host", "connection")}
            conn.request(method, self.path, body=body, headers=headers)
            resp = conn.getresponse()
            resp_body = resp.read()
            conn.close()
            self.send_response(resp.status)
            for k, v in resp.getheaders():
                # content-length is re-derived from resp_body below (the
                # internal server's own value is always correct too, but
                # copying both it and ours produces two Content-Length
                # headers in the outgoing response -- a bare RFC 7230
                # violation that curl tolerates but Node's HTTP parser
                # (http.request and fetch/undici alike) rejects outright as
                # "Parse Error: Duplicate Content-Length", surfacing as
                # ECONNRESET/"fetch failed" on every single call. Confirmed
                # live (2026-07-28): curl against this proxy always worked,
                # masking the bug during initial testing; a Node repro
                # script reproduced it on the very first request.
                if k.lower() in ("connection", "transfer-encoding", "content-length"):
                    continue
                self.send_header(k, v)
            self.send_header("Content-Length", str(len(resp_body)))
            self.end_headers()
            self.wfile.write(resp_body)
        except Exception as e:
            self._json(502, {"error": f"internal daemon unreachable: {e}"})

    def do_GET(self):
        if urlparse(self.path).path == "/health":
            self._handle_health()
        else:
            self._proxy("GET")

    def do_POST(self):
        self._proxy("POST")

    def do_DELETE(self):
        self._proxy("DELETE")


def _watch_parent(parent_pid):
    """Exits this process shortly after the real ingest_daemon.py process
    (parent_pid) disappears for any reason (crash, SIGKILL, pkill), so a
    killed daemon doesn't leave this proxy stuck holding the external port —
    see module docstring."""
    while True:
        time.sleep(PARENT_POLL_S)
        try:
            os.kill(parent_pid, 0)
        except OSError:
            print(f"[ingest-health-proxy] parent pid {parent_pid} is gone — exiting", flush=True)
            os._exit(0)
        except Exception:
            pass  # e.g. platforms where signal 0 isn't meaningful — just don't self-exit


def main():
    global _heartbeat_file, _internal_port

    parser = argparse.ArgumentParser()
    parser.add_argument("--external-host", required=True)
    parser.add_argument("--external-port", type=int, required=True)
    parser.add_argument("--internal-port", type=int, required=True)
    parser.add_argument("--heartbeat-file", required=True)
    parser.add_argument("--parent-pid", type=int, required=True)
    args = parser.parse_args()

    _heartbeat_file = args.heartbeat_file
    _internal_port  = args.internal_port

    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

    threading.Thread(target=_watch_parent, args=(args.parent_pid,), daemon=True).start()

    server = ThreadingHTTPServer((args.external_host, args.external_port), Handler)
    print(f"[ingest-health-proxy] listening on {args.external_host}:{args.external_port} "
          f"→ forwarding to 127.0.0.1:{args.internal_port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
