#!/usr/bin/env python3
"""
LTS-2026 Ingest Daemon — Python implementation.

Per-camera fan-out from a single MediaMTX RTSP loopback connection:
  ① AI    thread : RTSP → PyAV H264 decode → resize 640 → JPEG → HTTP POST to Node.js
  ② vRTP  thread: RTSP → PyAV H264 passthrough → RTP → UDP:{mediasoupPort}  (optional)
  ③ aRTP  thread: RTSP → PyAV audio → Opus RTP → UDP:{mediasoupAudioPort}    (optional)
  ④ apprtp thread: RTSP → PyAV data/subtitle track → JSON → HTTP POST to Node.js (optional)
                   Payload forwarded as base64 → mediasoup DataProducer → browser DataChannel

HTTP API (default :7070):
  POST   /cameras   { "id", "rtspUrl", "callbackUrl",
                      "mediasoupPort"?,      # H264 RTP → mediasoup video PlainTransport
                      "mediasoupAudioPort"?, # Opus RTP → mediasoup audio PlainTransport
                      "appRtpCallbackUrl"?   # App RTP → server → DataChannel
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
import base64
import io
import json
import logging
import os
import ssl
import threading
import time
from concurrent.futures import ThreadPoolExecutor
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
AI_FRAME_INTERVAL  = int(os.environ.get("AI_FRAME_INTERVAL", "3"))
JPEG_QUALITY       = int(os.environ.get("JPEG_QUALITY", "85"))
AI_MAX_WIDTH       = int(os.environ.get("AI_MAX_WIDTH", "640"))
IDR_WAIT_TIMEOUT   = float(os.environ.get("IDR_WAIT_TIMEOUT", "10"))
# Frame/packet watchdog timeout (seconds).
# If no RTP packet is demuxed within this window the interrupt_callback fires,
# raising AVError so _*_loop reconnects after retry_delay.
# Uses PyAV's interrupt_callback mechanism (checked per av_read_frame() call)
# rather than the per-I/O-op stimeout, so RTSP keepalive responses
# (OPTIONS / GET_PARAMETER) do NOT reset this timer — only actual RTP data does.
RTSP_READ_TIMEOUT  = float(os.environ.get("RTSP_READ_TIMEOUT", "5"))

_RTSP_OPTIONS = {
    "rtsp_transport": "tcp",
    "stimeout":       "30000000", # socket I/O timeout 30s (fallback for hard network hang)
    "max_delay":      "100000",   # 500ms → 100ms: reduces initial buffering lag
    "flags":          "low_delay",
}


def _make_watchdog_cb(stop_event: threading.Event, timeout_sec: float, label: str):
    """
    Returns (interrupt_cb, reset_fn).

    interrupt_cb — pass to av.open(interrupt_callback=...).
        Returns True (abort current I/O) if:
          • stop_event is set, OR
          • no reset_fn() call has occurred for timeout_sec seconds.
        The callback is invoked by libavformat between every socket-level read,
        making it immune to RTSP keepalive traffic keeping the socket "live"
        while no actual video packets are being forwarded.

    reset_fn — call after each successfully demuxed RTP packet to prevent the
        watchdog from firing during normal operation (IDR wait, slow cameras, etc).
    """
    _last = [time.monotonic()]

    def interrupt_cb():
        if stop_event.is_set():
            return True
        elapsed = time.monotonic() - _last[0]
        if elapsed > timeout_sec:
            log.warning("%s watchdog: no RTP packet for %.1fs — interrupting RTSP",
                        label, elapsed)
            return True
        return False

    def reset():
        _last[0] = time.monotonic()

    return interrupt_cb, reset

# Must match VIDEO_SSRC / AUDIO_SSRC / AUDIO_PT in server/src/services/webrtc/mediasoupEngine.js.
# mediasoup PlainTransport (comedia=true) matches incoming RTP by both SSRC and payload type;
# packets with mismatched SSRC or PT are silently discarded by the Producer.
_MEDIASOUP_VIDEO_SSRC = 573785173   # 0x22334455
_MEDIASOUP_AUDIO_SSRC = 860116326   # 0x33445566
_MEDIASOUP_AUDIO_PT   = 111         # must match AUDIO_PT constant in mediasoupEngine.js

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

        # Async HTTP push: bounded thread pool + semaphore prevent queue overflow
        # when the AI server is slower than the capture rate.
        # max_workers=4: each camera may have ≥1 encode+POST in-flight; 4 workers
        # allows 4 concurrent encodes across all cameras without blocking each other.
        self._push_executor  = ThreadPoolExecutor(max_workers=4, thread_name_prefix=f"push-{self.id[:8]}")
        self._push_semaphore = threading.Semaphore(4)  # max 4 in-flight POST requests

        self._threads: list[threading.Thread] = []

        self._start_thread("ai",   self._ai_loop)
        if self.mediasoup_video_port:
            self._start_thread("vrtp", self._video_rtp_loop)
        if self.mediasoup_audio_port:
            self._start_thread("artp", self._audio_rtp_loop)
        if self.app_rtp_callback_url:
            self._start_thread("apprtp", self._app_rtp_loop)

    def _start_thread(self, label: str, target) -> None:
        t = threading.Thread(
            target=target, daemon=True,
            name=f"{label}-{self.id[:8]}"
        )
        t.start()
        self._threads.append(t)

    def stop(self):
        self._stop.set()
        self._push_executor.shutdown(wait=False)
        for t in self._threads:
            t.join(timeout=5)
        log.info("[%s] Stopped", self.id[:8])

    # ── AI path ───────────────────────────────────────────────────────────────

    def _ai_loop(self):
        log.info("[%s] AI loop starting → %s", self.id[:8], self.rtsp_url[:50])
        retry_delay = 0.5
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
        cb, reset_wd = _make_watchdog_cb(self._stop, RTSP_READ_TIMEOUT, f"[{self.id[:8]}] ai")
        container = av.open(self.rtsp_url, options=_RTSP_OPTIONS, interrupt_callback=cb)
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

                reset_wd()  # RTP packet arrived → reset frame watchdog

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
        """
        Capture raw pixel data from the decoded frame (cheap memcopy), then
        submit JPEG encoding + HTTP POST entirely to the thread pool so the
        decode loop is never blocked by slow encoding or network latency.

        Flow: decode thread captures ndarray → semaphore check → thread pool
              (encode JPEG → POST /api/internal/frame → release semaphore).
        """
        if not hasattr(self, "_push_count"):
            self._push_count = 0
        self._push_count += 1
        count = self._push_count

        # Semaphore check happens in the decode thread — fast, no I/O.
        if not self._push_semaphore.acquire(blocking=False):
            log.debug("[%s] AI busy — dropping frame #%d", self.id[:8], count)
            return

        # Capture raw pixels now (frame object may be recycled after this call
        # returns).  to_ndarray() is a fast C-level memcopy, not an encode.
        try:
            raw = frame.to_ndarray(format="rgb24")
            orig_w, orig_h = frame.width, frame.height
        except Exception as e:
            self._push_semaphore.release()
            log.warning("[%s] frame capture failed: %s", self.id[:8], e)
            return

        url      = self.callback_url
        is_https = url.startswith("https://")

        def _encode_and_post():
            try:
                img = Image.fromarray(raw)
                img = _resize_frame(img, AI_MAX_WIDTH)
                buf = io.BytesIO()
                img.save(buf, format="JPEG", quality=JPEG_QUALITY)
                jpeg_bytes = buf.getvalue()
                w, h = img.width, img.height

                req = Request(url, data=jpeg_bytes,
                              headers={"Content-Type": "image/jpeg"}, method="POST")
                ctx = _SSL_CTX_NOVERIFY if is_https else None
                with urlopen(req, timeout=3, context=ctx) as resp:
                    code = resp.getcode()
                if count == 1 or count % 100 == 0:
                    log.info("[%s] AI frame #%d: %dx%d → %dB → HTTP %d",
                             self.id[:8], count, w, h, len(jpeg_bytes), code)
            except Exception as e:
                log.warning("[%s] push_jpeg failed: %s", self.id[:8], e)
            finally:
                self._push_semaphore.release()

        self._push_executor.submit(_encode_and_post)

    # ── Video RTP path (H.264 → mediasoup PlainTransport) ─────────────────────

    def _video_rtp_loop(self):
        log.info("[%s] Video RTP loop starting → UDP:%d",
                 self.id[:8], self.mediasoup_video_port)
        retry_delay = 0.5
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
        cb, reset_wd = _make_watchdog_cb(self._stop, RTSP_READ_TIMEOUT, f"[{self.id[:8]}] vrtp")
        inp = av.open(self.rtsp_url, options=_RTSP_OPTIONS, interrupt_callback=cb)
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
                last_dts     = None

                for pkt in inp.demux(vs):
                    if self._stop.is_set():
                        break
                    if pkt.size == 0:
                        continue

                    reset_wd()  # RTP packet arrived → reset watchdog

                    if not idr_seen:
                        if pkt.is_keyframe:
                            idr_seen = True
                        elif time.monotonic() > idr_deadline:
                            idr_seen = True
                        else:
                            continue

                    # Enforce monotonically increasing DTS — RTP muxer requires it.
                    if pkt.dts is not None:
                        if last_dts is not None and pkt.dts <= last_dts:
                            pkt.dts = last_dts + 1
                            if pkt.pts is not None and pkt.pts < pkt.dts:
                                pkt.pts = pkt.dts
                        last_dts = pkt.dts

                    pkt.stream = out_vs
                    try:
                        out.mux(pkt)
                    except av.AVError:
                        pass  # Skip malformed packet; keep stream alive
            finally:
                out.close()
        finally:
            inp.close()

    # ── Audio RTP path (camera audio → Opus → mediasoup PlainTransport) ───────

    def _audio_rtp_loop(self):
        log.info("[%s] Audio RTP loop starting → UDP:%d",
                 self.id[:8], self.mediasoup_audio_port)
        retry_delay = 0.5
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
        cb, reset_wd = _make_watchdog_cb(self._stop, RTSP_READ_TIMEOUT, f"[{self.id[:8]}] artp")
        inp = av.open(self.rtsp_url, options=_RTSP_OPTIONS, interrupt_callback=cb)
        try:
            as_ = next((s for s in inp.streams if s.type == "audio"), None)
            if as_ is None:
                raise RuntimeError("No audio stream")

            out    = av.open(
                f"rtp://127.0.0.1:{self.mediasoup_audio_port}",
                "w", format="rtp",
                options={
                    "ssrc":         str(_MEDIASOUP_AUDIO_SSRC),
                    "payload_type": str(_MEDIASOUP_AUDIO_PT),
                },
            )

            # Pass through if already Opus; transcode everything else.
            if as_.codec_context.name == "opus":
                out_as = out.add_stream(template=as_)
                log.info("[%s] Audio RTP passthrough opus → rtp://127.0.0.1:%d",
                         self.id[:8], self.mediasoup_audio_port)
                try:
                    last_dts = None
                    for pkt in inp.demux(as_):
                        if self._stop.is_set():
                            break
                        if pkt.size == 0:
                            continue
                        reset_wd()  # RTP packet arrived → reset watchdog
                        if pkt.dts is not None:
                            if last_dts is not None and pkt.dts <= last_dts:
                                pkt.dts = last_dts + 1
                                if pkt.pts is not None and pkt.pts < pkt.dts:
                                    pkt.pts = pkt.dts
                            last_dts = pkt.dts
                        pkt.stream = out_as
                        try:
                            out.mux(pkt)
                        except av.AVError:
                            pass
                finally:
                    out.close()
            else:
                out_as     = out.add_stream("libopus", rate=48000)
                out_as.codec_context.channels = 2
                out_as.codec_context.layout   = "stereo"
                # libopus on this system requires s16 (signed 16-bit integer), not fltp.
                resampler  = av.AudioResampler(format="s16", layout="stereo", rate=48000)
                log.info("[%s] Audio RTP transcode %s → opus → rtp://127.0.0.1:%d",
                         self.id[:8], as_.codec_context.name, self.mediasoup_audio_port)
                try:
                    last_out_dts = None

                    def _mux_enc(pkt):
                        nonlocal last_out_dts
                        if pkt.dts is not None:
                            if last_out_dts is not None and pkt.dts <= last_out_dts:
                                pkt.dts = last_out_dts + 1
                                if pkt.pts is not None and pkt.pts < pkt.dts:
                                    pkt.pts = pkt.dts
                            last_out_dts = pkt.dts
                        try:
                            out.mux(pkt)
                        except av.AVError:
                            pass

                    for pkt in inp.demux(as_):
                        if self._stop.is_set():
                            break
                        if pkt.size == 0:
                            continue
                        reset_wd()  # RTP packet arrived → reset watchdog
                        for frame in pkt.decode():
                            for resampled in resampler.resample(frame):
                                for out_pkt in out_as.encode(resampled):
                                    _mux_enc(out_pkt)
                    # Flush encoder
                    for frame in resampler.resample(None):
                        for out_pkt in out_as.encode(frame):
                            _mux_enc(out_pkt)
                    for out_pkt in out_as.encode(None):
                        _mux_enc(out_pkt)
                finally:
                    out.close()
        finally:
            inp.close()

    # ── App RTP path (RTSP data/subtitle track → server HTTP callback → DataChannel) ──

    def _app_rtp_loop(self):
        log.info("[%s] App RTP loop starting → %s",
                 self.id[:8], self.app_rtp_callback_url[:60])
        retry_delay = 0.5
        while not self._stop.is_set():
            try:
                self._app_rtp_ingest_once()
                retry_delay = 2.0
            except RuntimeError as exc:
                if "No application stream" in str(exc):
                    log.info("[%s] No application stream — app RTP thread exiting", self.id[:8])
                    return
                raise
            except Exception as exc:
                if self._stop.is_set():
                    break
                log.warning("[%s] App RTP error: %s — retry in %.0fs",
                            self.id[:8], exc, retry_delay)
                self._stop.wait(retry_delay)
                retry_delay = min(retry_delay * 1.5, 30.0)

    def _app_rtp_ingest_once(self):
        cb, reset_wd = _make_watchdog_cb(self._stop, RTSP_READ_TIMEOUT, f"[{self.id[:8]}] apprtp")
        inp = av.open(self.rtsp_url, options=_RTSP_OPTIONS, interrupt_callback=cb)
        try:
            # Find non-video, non-audio streams (data, subtitle, application tracks).
            # Samsung / ONVIF metadata is typically exposed as a "data" or "subtitle"
            # stream by FFmpeg's RTSP demuxer.
            app_streams = [s for s in inp.streams if s.type not in ("video", "audio")]
            if not app_streams:
                raise RuntimeError("No application stream")

            ds = app_streams[0]
            try:
                codec_name = ds.codec_context.name
            except Exception:
                codec_name = "unknown"
            log.info("[%s] App RTP stream: type=%s codec=%s",
                     self.id[:8], ds.type, codec_name)

            ctx   = _SSL_CTX_NOVERIFY if self.app_rtp_callback_url.startswith("https://") else None
            seq   = 0
            push_count = 0

            for pkt in inp.demux(ds):
                if self._stop.is_set():
                    break
                if pkt.size == 0:
                    continue
                reset_wd()  # RTP packet arrived → reset watchdog

                payload_b64 = base64.b64encode(bytes(pkt)).decode("ascii")
                body = json.dumps({
                    "pt":        ds.index,          # stream index as surrogate PT
                    "timestamp": int(pkt.pts or 0),
                    "seq":       seq,
                    "payload":   payload_b64,
                }).encode("utf-8")
                seq += 1

                req = Request(
                    self.app_rtp_callback_url,
                    data=body,
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                try:
                    urlopen(req, timeout=1, context=ctx)
                    push_count += 1
                    if push_count == 1 or push_count % 500 == 0:
                        log.info("[%s] App RTP #%d: %dB payload",
                                 self.id[:8], push_count, len(payload_b64))
                except Exception as e:
                    log.debug("[%s] App RTP callback failed: %s", self.id[:8], e)
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
            if body.get("appRtpCallbackUrl"):
                mode_parts.append("appRTP")
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
