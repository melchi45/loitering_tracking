#!/usr/bin/env python3
"""
LTS-2026 Ingest Daemon — Python implementation (AI-only path).

Per-camera: one RTSP connection for AI.
  AI thread: RTSP → PyAV H264 decode → resize 640 → JPEG → HTTP POST to Node.js

HTTP API (default :7070):
  POST   /cameras   { "id", "rtspUrl", "callbackUrl" }
  DELETE /cameras/:id
  GET    /cameras   → { "count": N }
  GET    /health    → { "status": "ok", "cameras": N }

Environment:
  AI_FRAME_INTERVAL — push every Nth decoded frame to AI (default: 3, ~3 fps AI at 10 fps input)
  JPEG_QUALITY      — JPEG encode quality 1-95 (default: 85)
  AI_MAX_WIDTH      — resize AI frames to at most this width (default: 640)
  IDR_WAIT_TIMEOUT  — seconds to wait for first IDR keyframe (default: 10)
"""

import argparse
import io
import json
import logging
import os
import ssl
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse
from urllib.request import urlopen, Request

import av
from PIL import Image

# Suppress libav/ffmpeg internal decoder messages (H264 reference-frame errors
# during the initial GOP are noisy but harmless — Python-level exceptions still fire).
av.logging.set_level(av.logging.CRITICAL)

logging.basicConfig(
    level=logging.INFO,
    format="[Ingest] %(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("ingest")

# ── Configuration ─────────────────────────────────────────────────────────────
AI_FRAME_INTERVAL  = int(os.environ.get("AI_FRAME_INTERVAL", "3"))   # AI every N packets
JPEG_QUALITY       = int(os.environ.get("JPEG_QUALITY", "85"))
AI_MAX_WIDTH       = int(os.environ.get("AI_MAX_WIDTH", "640"))
IDR_WAIT_TIMEOUT   = float(os.environ.get("IDR_WAIT_TIMEOUT", "10")) # seconds

# Reusable SSL context for loopback HTTPS callbacks (self-signed cert OK).
_SSL_CTX_NOVERIFY = ssl.create_default_context()
_SSL_CTX_NOVERIFY.check_hostname = False
_SSL_CTX_NOVERIFY.verify_mode = ssl.CERT_NONE


def _resize_frame(img: Image.Image, max_width: int) -> Image.Image:
    """Resize PIL image so width ≤ max_width, preserving aspect ratio."""
    if img.width <= max_width:
        return img
    ratio  = max_width / img.width
    new_h  = int(img.height * ratio)
    return img.resize((max_width, new_h), Image.BILINEAR)


# ── Camera session ────────────────────────────────────────────────────────────

class CameraSession:
    """Manages one camera: AI path only (PyAV in-process decode → JPEG → HTTP POST)."""

    def __init__(self, cfg: dict):
        self.id           = cfg["id"]
        self.rtsp_url     = cfg["rtspUrl"]
        self.callback_url = cfg["callbackUrl"]

        self._stop_event  = threading.Event()
        self._ai_thread   = threading.Thread(
            target=self._ai_loop, daemon=True, name=f"ai-{self.id[:8]}")
        self._ai_thread.start()

    def stop(self):
        self._stop_event.set()
        self._ai_thread.join(timeout=5)
        log.info("[%s] Stopped", self.id[:8])

    # ── AI path: PyAV in-process ──────────────────────────────────────────────

    def _ai_loop(self):
        log.info("[%s] AI loop starting → %s", self.id[:8], self.rtsp_url[:50])
        retry_delay = 2.0

        while not self._stop_event.is_set():
            try:
                self._ai_ingest_once()
                retry_delay = 2.0
            except Exception as exc:
                if self._stop_event.is_set():
                    break
                log.warning("[%s] AI RTSP error: %s — retry in %.0fs",
                            self.id[:8], exc, retry_delay)
                self._stop_event.wait(retry_delay)
                retry_delay = min(retry_delay * 1.5, 30.0)

    def _ai_ingest_once(self):
        options = {
            "rtsp_transport": "tcp",
            "stimeout":       "5000000",
            "max_delay":      "500000",
        }
        container = av.open(self.rtsp_url, options=options, timeout=10)
        try:
            video_stream = next(
                (s for s in container.streams if s.type == "video"), None)
            if video_stream is None:
                raise RuntimeError("No video stream in RTSP source")

            # Single-thread decoding reduces "reference frame unavailable" errors
            # on high-resolution streams (2K/4K cameras).
            video_stream.codec_context.thread_type = "NONE"
            video_stream.codec_context.thread_count = 1

            log.info("[%s] AI stream: %s %dx%d",
                     self.id[:8],
                     video_stream.codec_context.name,
                     video_stream.codec_context.width,
                     video_stream.codec_context.height)

            # Wait for the first IDR (keyframe) before decoding P/B frames.
            # Without this, the decoder produces corrupt frames and log spam until
            # the first clean reference frame arrives.
            idr_seen     = False
            idr_deadline = time.monotonic() + IDR_WAIT_TIMEOUT

            # Count OUTPUT frames (not input packets) for rate-limiting.
            # IMPORTANT: decode() must be called for EVERY packet — the H264 decoder
            # needs all packets to maintain B-frame reference state.  Skipping input
            # packets breaks the decoder for cameras with B-frames, causing decode()
            # to return no frames at all.  Rate-limiting is applied to the decoded
            # output instead.
            frame_counter = 0
            for packet in container.demux(video_stream):
                if self._stop_event.is_set():
                    break
                if packet.size == 0:
                    continue

                if not idr_seen:
                    if packet.is_keyframe:
                        idr_seen = True
                    elif time.monotonic() > idr_deadline:
                        # Camera rarely sends IDR — give up waiting and decode anyway.
                        idr_seen = True
                    else:
                        continue

                try:
                    for frame in packet.decode():
                        frame_counter += 1
                        if frame_counter % AI_FRAME_INTERVAL == 0:
                            self._push_jpeg(frame)
                        break  # one frame per decode call is enough
                except Exception as dec_err:
                    log.debug("[%s] decode: %s", self.id[:8], dec_err)
        finally:
            container.close()

    def _push_jpeg(self, frame: "av.VideoFrame"):
        try:
            img = frame.to_image()
            img = _resize_frame(img, AI_MAX_WIDTH)
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=JPEG_QUALITY)
            jpeg_bytes = buf.getvalue()

            req = Request(
                self.callback_url,
                data=jpeg_bytes,
                headers={"Content-Type": "image/jpeg"},
                method="POST",
            )

            # Disable SSL verification for loopback HTTPS (self-signed cert).
            ctx = _SSL_CTX_NOVERIFY if self.callback_url.startswith("https://") else None
            with urlopen(req, timeout=3, context=ctx) as resp:
                code = resp.getcode()

            if not hasattr(self, '_push_count'):
                self._push_count = 0
            self._push_count += 1
            if self._push_count == 1 or self._push_count % 100 == 0:
                log.info("[%s] AI frame #%d: %dx%d → %dB → HTTP %d",
                         self.id[:8], self._push_count,
                         img.width, img.height, len(jpeg_bytes), code)
        except Exception as e:
            log.warning("[%s] push_jpeg failed: %s", self.id[:8], e)


# ── Camera manager ────────────────────────────────────────────────────────────

class CameraManager:
    def __init__(self):
        self._lock    = threading.Lock()
        self._cameras: dict[str, CameraSession] = {}

    def add(self, cfg: dict) -> bool:
        cid = cfg.get("id")
        if not cid:
            return False
        with self._lock:
            old = self._cameras.pop(cid, None)
        if old:
            old.stop()
        sess = CameraSession(cfg)
        with self._lock:
            self._cameras[cid] = sess
        return True

    def remove(self, cid: str) -> bool:
        with self._lock:
            sess = self._cameras.pop(cid, None)
        if sess:
            sess.stop()
            return True
        return False

    def count(self) -> int:
        with self._lock:
            return len(self._cameras)

    def stop_all(self):
        with self._lock:
            sessions = list(self._cameras.values())
            self._cameras.clear()
        for s in sessions:
            s.stop()


# ── HTTP API ──────────────────────────────────────────────────────────────────

_manager: CameraManager = None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _json(self, status: int, body: dict):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        p = urlparse(self.path).path
        if p == "/health":
            self._json(200, {"status": "ok", "cameras": _manager.count()})
        elif p == "/cameras":
            self._json(200, {"count": _manager.count()})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        p = urlparse(self.path).path
        if p == "/cameras":
            length = int(self.headers.get("Content-Length", 0))
            try:
                body = json.loads(self.rfile.read(length))
            except Exception:
                self._json(400, {"error": "invalid JSON"})
                return
            for k in ("id", "rtspUrl", "callbackUrl"):
                if k not in body:
                    self._json(400, {"error": f"missing field: {k}"})
                    return
            _manager.add(body)
            log.info("Camera added: %s", body["id"][:8])
            self._json(201, {"ok": True, "id": body["id"]})
        else:
            self._json(404, {"error": "not found"})

    def do_DELETE(self):
        parts = urlparse(self.path).path.strip("/").split("/")
        if len(parts) == 2 and parts[0] == "cameras":
            ok = _manager.remove(parts[1])
            log.info("Camera removed: %s (found=%s)", parts[1][:8], ok)
            self._json(200, {"ok": ok})
        else:
            self._json(404, {"error": "not found"})


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    global _manager

    parser = argparse.ArgumentParser()
    parser.add_argument("--addr", default=":7070")
    args = parser.parse_args()

    raw = args.addr
    if raw.startswith(":"):
        host, port = "0.0.0.0", int(raw[1:])
    else:
        h, p = raw.rsplit(":", 1)
        host, port = h, int(p)

    _manager = CameraManager()
    server   = HTTPServer((host, port), Handler)
    log.info("Ingest daemon listening on %s:%d", host, port)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        log.info("Shutting down…")
        _manager.stop_all()
        server.server_close()


if __name__ == "__main__":
    main()
