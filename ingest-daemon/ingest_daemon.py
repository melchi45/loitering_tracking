#!/usr/bin/env python3
"""
LTS-2026 Ingest Daemon — Python implementation.

Per-camera fan-out from a single MediaMTX RTSP loopback connection:
  ① AI  thread : RTSP → PyAV H264 decode → resize 640 → JPEG → HTTP POST to Node.js
  ② vRTP thread: RTSP → PyAV H264 passthrough → RTP → UDP:{mediasoupPort}  (optional)
  ③ aRTP thread: RTSP → PyAV audio → Opus RTP → UDP:{mediasoupAudioPort}    (optional)

HTTP API (default :7070):
  POST   /cameras   { "id", "rtspUrl", "callbackUrl",
                      "mediasoupPort"?,      # H264 RTP → mediasoup video PlainTransport
                      "mediasoupAudioPort"?, # Opus RTP → mediasoup audio PlainTransport
                      "appRtpCallbackUrl"?   # App RTP forwarding (future use)
                    }
  DELETE /cameras/:id
  GET    /cameras   → { "count": N }
  GET    /health    → { "status": "ok", "cameras": N }

Environment:
  AI_FRAME_INTERVAL — push every Nth decoded frame to AI (default: 3)
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

# Suppress libav/ffmpeg internal decoder messages (noisy but harmless H264 reference-
# frame errors during the initial GOP still fire as Python-level exceptions).
av.logging.set_level(av.logging.CRITICAL)

logging.basicConfig(
    level=logging.INFO,
    format="[Ingest] %(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("ingest")

# ── Configuration ─────────────────────────────────────────────────────────────
AI_FRAME_INTERVAL = int(os.environ.get("AI_FRAME_INTERVAL", "3"))
JPEG_QUALITY      = int(os.environ.get("JPEG_QUALITY", "85"))
AI_MAX_WIDTH      = int(os.environ.get("AI_MAX_WIDTH", "640"))
IDR_WAIT_TIMEOUT  = float(os.environ.get("IDR_WAIT_TIMEOUT", "10"))

_RTSP_OPTIONS = {
    "rtsp_transport": "tcp",
    "stimeout":       "5000000",
    "max_delay":      "500000",
}

# Must match VIDEO_SSRC / AUDIO_SSRC in server/src/services/webrtc/mediasoupEngine.js.
# mediasoup PlainTransport (comedia=true) filters incoming RTP by SSRC; packets with
# a different SSRC are silently discarded.
_MEDIASOUP_VIDEO_SSRC = 573785173   # 0x22334455
_MEDIASOUP_AUDIO_SSRC = 860116326   # 0x33445566

# Reusable SSL context for loopback HTTPS callbacks (self-signed cert OK).
_SSL_CTX_NOVERIFY = ssl.create_default_context()
_SSL_CTX_NOVERIFY.check_hostname = False
_SSL_CTX_NOVERIFY.verify_mode    = ssl.CERT_NONE


def _resize_frame(img: Image.Image, max_width: int) -> Image.Image:
    if img.width <= max_width:
        return img
    ratio = max_width / img.width
    return img.resize((max_width, int(img.height * ratio)), Image.BILINEAR)


# ── Camera session ────────────────────────────────────────────────────────────

class CameraSession:
    """
    Per-camera fan-out.

    Required: id, rtspUrl, callbackUrl  (AI JPEG path)
    Optional: mediasoupPort             (H264 RTP → mediasoup video)
              mediasoupAudioPort        (Opus RTP → mediasoup audio)
              appRtpCallbackUrl         (App RTP forwarding — future)
    """

    def __init__(self, cfg: dict):
        self.id                    = cfg["id"]
        self.rtsp_url              = cfg["rtspUrl"]
        self.callback_url          = cfg["callbackUrl"]
        self.mediasoup_video_port  = cfg.get("mediasoupPort")
        self.mediasoup_audio_port  = cfg.get("mediasoupAudioPort")
        self.app_rtp_callback_url  = cfg.get("appRtpCallbackUrl")

        self._stop = threading.Event()

        self._threads: list[threading.Thread] = []

        self._start_thread("ai",   self._ai_loop)
        if self.mediasoup_video_port:
            self._start_thread("vrtp", self._video_rtp_loop)
        if self.mediasoup_audio_port:
            self._start_thread("artp", self._audio_rtp_loop)

    def _start_thread(self, label: str, target) -> None:
        t = threading.Thread(
            target=target, daemon=True,
            name=f"{label}-{self.id[:8]}"
        )
        t.start()
        self._threads.append(t)

    def stop(self):
        self._stop.set()
        for t in self._threads:
            t.join(timeout=5)
        log.info("[%s] Stopped", self.id[:8])

    # ── AI path ───────────────────────────────────────────────────────────────

    def _ai_loop(self):
        log.info("[%s] AI loop starting → %s", self.id[:8], self.rtsp_url[:50])
        retry_delay = 2.0
        while not self._stop.is_set():
            try:
                self._ai_ingest_once()
                retry_delay = 2.0
            except Exception as exc:
                if self._stop.is_set():
                    break
                log.warning("[%s] AI RTSP error: %s — retry in %.0fs",
                            self.id[:8], exc, retry_delay)
                self._stop.wait(retry_delay)
                retry_delay = min(retry_delay * 1.5, 30.0)

    def _ai_ingest_once(self):
        container = av.open(self.rtsp_url, options=_RTSP_OPTIONS, timeout=10)
        try:
            vs = next((s for s in container.streams if s.type == "video"), None)
            if vs is None:
                raise RuntimeError("No video stream in RTSP source")

            vs.codec_context.thread_type  = "NONE"
            vs.codec_context.thread_count = 1
            log.info("[%s] AI stream: %s %dx%d",
                     self.id[:8],
                     vs.codec_context.name,
                     vs.codec_context.width,
                     vs.codec_context.height)

            idr_seen     = False
            idr_deadline = time.monotonic() + IDR_WAIT_TIMEOUT
            frame_counter = 0

            for packet in container.demux(vs):
                if self._stop.is_set():
                    break
                if packet.size == 0:
                    continue

                if not idr_seen:
                    if packet.is_keyframe:
                        idr_seen = True
                    elif time.monotonic() > idr_deadline:
                        idr_seen = True
                    else:
                        continue

                try:
                    for frame in packet.decode():
                        frame_counter += 1
                        if frame_counter % AI_FRAME_INTERVAL == 0:
                            self._push_jpeg(frame)
                        break
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
            ctx = _SSL_CTX_NOVERIFY if self.callback_url.startswith("https://") else None
            with urlopen(req, timeout=3, context=ctx) as resp:
                code = resp.getcode()

            if not hasattr(self, "_push_count"):
                self._push_count = 0
            self._push_count += 1
            if self._push_count == 1 or self._push_count % 100 == 0:
                log.info("[%s] AI frame #%d: %dx%d → %dB → HTTP %d",
                         self.id[:8], self._push_count,
                         img.width, img.height, len(jpeg_bytes), code)
        except Exception as e:
            log.warning("[%s] push_jpeg failed: %s", self.id[:8], e)

    # ── Video RTP path (H.264 → mediasoup PlainTransport) ─────────────────────

    def _video_rtp_loop(self):
        log.info("[%s] Video RTP loop starting → UDP:%d",
                 self.id[:8], self.mediasoup_video_port)
        retry_delay = 2.0
        while not self._stop.is_set():
            try:
                self._video_rtp_ingest_once()
                retry_delay = 2.0
            except Exception as exc:
                if self._stop.is_set():
                    break
                log.warning("[%s] Video RTP error: %s — retry in %.0fs",
                            self.id[:8], exc, retry_delay)
                self._stop.wait(retry_delay)
                retry_delay = min(retry_delay * 1.5, 30.0)

    def _video_rtp_ingest_once(self):
        inp = av.open(self.rtsp_url, options=_RTSP_OPTIONS, timeout=10)
        try:
            vs = next((s for s in inp.streams if s.type == "video"), None)
            if vs is None:
                raise RuntimeError("No video stream")

            out = av.open(
                f"rtp://127.0.0.1:{self.mediasoup_video_port}",
                "w", format="rtp",
                options={"ssrc": str(_MEDIASOUP_VIDEO_SSRC)},
            )
            out_vs = out.add_stream(template=vs)
            log.info("[%s] Video RTP: %s → rtp://127.0.0.1:%d (ssrc=0x%08x)",
                     self.id[:8], vs.codec_context.name,
                     self.mediasoup_video_port, _MEDIASOUP_VIDEO_SSRC)
            try:
                idr_seen     = False
                idr_deadline = time.monotonic() + IDR_WAIT_TIMEOUT

                for pkt in inp.demux(vs):
                    if self._stop.is_set():
                        break
                    if pkt.size == 0:
                        continue

                    if not idr_seen:
                        if pkt.is_keyframe:
                            idr_seen = True
                        elif time.monotonic() > idr_deadline:
                            idr_seen = True
                        else:
                            continue

                    pkt.stream = out_vs
                    out.mux(pkt)
            finally:
                out.close()
        finally:
            inp.close()

    # ── Audio RTP path (camera audio → Opus → mediasoup PlainTransport) ───────

    def _audio_rtp_loop(self):
        log.info("[%s] Audio RTP loop starting → UDP:%d",
                 self.id[:8], self.mediasoup_audio_port)
        retry_delay = 2.0
        while not self._stop.is_set():
            try:
                self._audio_rtp_ingest_once()
                retry_delay = 2.0
            except RuntimeError as exc:
                if "No audio stream" in str(exc):
                    # Camera has no audio — stop thread silently
                    log.info("[%s] No audio stream — audio RTP thread exiting", self.id[:8])
                    return
                raise
            except Exception as exc:
                if self._stop.is_set():
                    break
                log.warning("[%s] Audio RTP error: %s — retry in %.0fs",
                            self.id[:8], exc, retry_delay)
                self._stop.wait(retry_delay)
                retry_delay = min(retry_delay * 1.5, 30.0)

    def _audio_rtp_ingest_once(self):
        inp = av.open(self.rtsp_url, options=_RTSP_OPTIONS, timeout=10)
        try:
            as_ = next((s for s in inp.streams if s.type == "audio"), None)
            if as_ is None:
                raise RuntimeError("No audio stream")

            out    = av.open(
                f"rtp://127.0.0.1:{self.mediasoup_audio_port}",
                "w", format="rtp",
                options={"ssrc": str(_MEDIASOUP_AUDIO_SSRC)},
            )

            # Pass through if already Opus; transcode everything else.
            if as_.codec_context.name == "opus":
                out_as = out.add_stream(template=as_)
                log.info("[%s] Audio RTP passthrough opus → rtp://127.0.0.1:%d",
                         self.id[:8], self.mediasoup_audio_port)
                try:
                    for pkt in inp.demux(as_):
                        if self._stop.is_set():
                            break
                        if pkt.size == 0:
                            continue
                        pkt.stream = out_as
                        out.mux(pkt)
                finally:
                    out.close()
            else:
                out_as     = out.add_stream("opus", rate=48000)
                out_as.layout = "stereo"
                resampler  = av.AudioResampler(format="fltp", layout="stereo", rate=48000)
                log.info("[%s] Audio RTP transcode %s → opus → rtp://127.0.0.1:%d",
                         self.id[:8], as_.codec_context.name, self.mediasoup_audio_port)
                try:
                    for pkt in inp.demux(as_):
                        if self._stop.is_set():
                            break
                        if pkt.size == 0:
                            continue
                        for frame in pkt.decode():
                            for resampled in resampler.resample(frame):
                                for out_pkt in out_as.encode(resampled):
                                    out.mux(out_pkt)
                    # Flush encoder
                    for frame in resampler.resample(None):
                        for out_pkt in out_as.encode(frame):
                            out.mux(out_pkt)
                    for out_pkt in out_as.encode(None):
                        out.mux(out_pkt)
                finally:
                    out.close()
        finally:
            inp.close()


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
            mode_parts = ["AI"]
            if body.get("mediasoupPort"):
                mode_parts.append(f"vRTP:{body['mediasoupPort']}")
            if body.get("mediasoupAudioPort"):
                mode_parts.append(f"aRTP:{body['mediasoupAudioPort']}")
            log.info("Camera added: %s [%s]", body["id"][:8], "+".join(mode_parts))
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
