#!/usr/bin/env python3
"""
LTS-2026 Ingest Daemon — Python implementation (Pattern C-hybrid).

Per-camera: one RTSP connection for AI + one ffmpeg subprocess for WebRTC RTP.
  AI thread   : RTSP → PyAV H264 decode → resize 640 → JPEG → HTTP POST to Node.js
  WebRTC proc : ffmpeg subprocess rtsp → rtp://127.0.0.1:{mediasoupPort}

HTTP API (default :7070):
  POST   /cameras   { "id", "rtspUrl", "mediasoupPort", "callbackUrl" }
  DELETE /cameras/:id
  GET    /cameras   → { "count": N }
  GET    /health    → { "status": "ok", "cameras": N }

Environment:
  FFMPEG_BIN   — path to ffmpeg binary (default: ffmpeg)
  AI_FRAME_INTERVAL — decode every Nth packet for AI (default: 3, ~3 fps AI at 10 fps input)
  JPEG_QUALITY      — JPEG encode quality 1-95 (default: 85)
  AI_MAX_WIDTH      — resize AI frames to at most this width (default: 640)
"""

import argparse
import io
import json
import logging
import os
import queue
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse
from urllib.request import urlopen, Request

import av
from PIL import Image

logging.basicConfig(
    level=logging.INFO,
    format="[Ingest] %(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("ingest")

# ── Configuration ─────────────────────────────────────────────────────────────
FFMPEG_BIN         = os.environ.get("FFMPEG_BIN", "ffmpeg")
AI_FRAME_INTERVAL  = int(os.environ.get("AI_FRAME_INTERVAL", "3"))   # AI every N packets
JPEG_QUALITY       = int(os.environ.get("JPEG_QUALITY", "85"))
AI_MAX_WIDTH       = int(os.environ.get("AI_MAX_WIDTH", "640"))


def _resize_frame(img: Image.Image, max_width: int) -> Image.Image:
    """Resize PIL image so width ≤ max_width, preserving aspect ratio."""
    if img.width <= max_width:
        return img
    ratio  = max_width / img.width
    new_h  = int(img.height * ratio)
    return img.resize((max_width, new_h), Image.BILINEAR)


# ── Camera session ────────────────────────────────────────────────────────────

class CameraSession:
    """Manages one camera: AI (PyAV in-process) + WebRTC (ffmpeg subprocess)."""

    def __init__(self, cfg: dict):
        self.id             = cfg["id"]
        self.rtsp_url       = cfg["rtspUrl"]
        self.mediasoup_port = int(cfg["mediasoupPort"])
        self.callback_url   = cfg["callbackUrl"]

        self._stop_event     = threading.Event()
        self._ai_thread      = threading.Thread(
            target=self._ai_loop, daemon=True, name=f"ai-{self.id[:8]}")
        self._ffmpeg_proc    = None
        self._ffmpeg_thread  = threading.Thread(
            target=self._ffmpeg_loop, daemon=True, name=f"rtp-{self.id[:8]}")

        self._ai_thread.start()
        self._ffmpeg_thread.start()

    def stop(self):
        self._stop_event.set()
        self._kill_ffmpeg()
        self._ai_thread.join(timeout=5)
        self._ffmpeg_thread.join(timeout=5)
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

            # Force single-thread decoding: reduces "reference frame unavailable"
            # errors on high-resolution streams (2K/4K cameras) at the cost of
            # slightly higher per-frame latency. Multi-threaded H264 decode often
            # produces cascading errors when the initial GOP is received mid-stream.
            video_stream.codec_context.thread_type = "NONE"
            video_stream.codec_context.thread_count = 1

            log.info("[%s] AI stream: %s %dx%d",
                     self.id[:8],
                     video_stream.codec_context.name,
                     video_stream.codec_context.width,
                     video_stream.codec_context.height)

            idx = 0
            for packet in container.demux(video_stream):
                if self._stop_event.is_set():
                    break
                if packet.size == 0:
                    continue

                idx += 1
                if idx % AI_FRAME_INTERVAL != 0:
                    continue

                try:
                    for frame in packet.decode():
                        self._push_jpeg(frame)
                        break  # one frame per packet is enough
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
            with urlopen(req, timeout=3) as resp:
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

    # ── WebRTC path: ffmpeg subprocess ────────────────────────────────────────

    def _ffmpeg_loop(self):
        """Keep ffmpeg alive for WebRTC RTP forwarding to mediasoup."""
        retry_delay = 2.0
        while not self._stop_event.is_set():
            self._run_ffmpeg_once()
            if self._stop_event.is_set():
                break
            log.warning("[%s] ffmpeg exited — retry in %.0fs", self.id[:8], retry_delay)
            self._stop_event.wait(retry_delay)
            retry_delay = min(retry_delay * 1.5, 30.0)

    def _run_ffmpeg_once(self):
        """
        ffmpeg command: RTSP → RTP/H264 → UDP → mediasoup PlainTransport
        Uses SSRC 0x22334455 (573522005) and PT 96 to match mediasoupEngine.js.
        """
        cmd = [
            FFMPEG_BIN,
            "-loglevel",   "warning",
            "-rtsp_transport", "tcp",
            "-i",          self.rtsp_url,
            # Video only: H264 stream-copy, no re-encode
            "-vn",         "-an",           # disable audio first
            "-map",        "0:v:0",
            "-c:v",        "copy",
            # RTP output
            "-f",          "rtp",
            "-payload_type", "96",
            "-ssrc",       "573522005",     # 0x22334455
            f"rtp://127.0.0.1:{self.mediasoup_port}?localrtcpport={self.mediasoup_port + 1}",
        ]
        log.info("[%s] ffmpeg RTP → UDP ::%d  cmd: %s",
                 self.id[:8], self.mediasoup_port, " ".join(cmd[4:8]))
        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
            self._ffmpeg_proc = proc
            # Stream stderr for warnings
            for line in proc.stderr:
                if self._stop_event.is_set():
                    break
                line = line.decode(errors="replace").rstrip()
                if line:
                    log.debug("[%s] ffmpeg: %s", self.id[:8], line)
            proc.wait()
        except FileNotFoundError:
            log.error("[%s] ffmpeg not found at '%s' — WebRTC disabled", self.id[:8], FFMPEG_BIN)
            self._stop_event.wait()  # don't retry if binary missing
        except Exception as e:
            log.warning("[%s] ffmpeg error: %s", self.id[:8], e)
        finally:
            self._ffmpeg_proc = None

    def _kill_ffmpeg(self):
        proc = self._ffmpeg_proc
        if proc and proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=3)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        self._ffmpeg_proc = None


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
            for k in ("id", "rtspUrl", "mediasoupPort", "callbackUrl"):
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
