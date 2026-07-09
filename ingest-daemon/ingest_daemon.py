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
                      "appRtpCallbackUrl"?,  # App RTP → server → DataChannel
                      "captureFps"?          # target AI frame rate (default: AI_FRAME_INTERVAL)
                    }
  DELETE /cameras/:id
  GET    /cameras   → { "count": N }
  GET    /health    → { "status": "ok", "cameras": N }

Environment:
  AI_FRAME_INTERVAL — push every Nth decoded frame to AI (default: 3, overridden per-camera by captureFps)
  JPEG_QUALITY      — JPEG encode quality 1-95 (default: 85)
  IDR_WAIT_TIMEOUT  — seconds to wait for first IDR keyframe (default: 2)

AI frames are sent at native/decoded resolution (no resize) — this is the sole
source buffer for both AI inference and detectionSnapshots crop extraction on
the Node.js side. Node.js downscales its own copy (env AI_MAX_WIDTH, read by
pipelineManager.js) before forwarding to a remote analysis server in streaming
mode, so that hop stays cheap while crops stay full-resolution.
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
IDR_WAIT_TIMEOUT   = float(os.environ.get("IDR_WAIT_TIMEOUT", "2"))
# Frame watchdog timeout (seconds).  _Watchdog closes the container from a
# background thread after this many seconds with no RTP packet.  RTSP keepalive
# responses (OPTIONS / GET_PARAMETER) do NOT call wd.reset(), so the watchdog
# correctly detects "keepalives alive but no video" — unlike stimeout which is
# reset by any socket data including keepalives.
RTSP_READ_TIMEOUT     = float(os.environ.get("RTSP_READ_TIMEOUT", "5"))
# App RTP carries sparse ONVIF metadata (events may be minutes apart).
# Use a much longer idle timeout than video/audio tracks.
APP_RTP_READ_TIMEOUT  = float(os.environ.get("APP_RTP_READ_TIMEOUT", "60"))

_RTSP_OPTIONS = {
    "rtsp_transport": "tcp",
    "stimeout":       "30000000", # socket I/O timeout 30s (fallback for hard network hang)
    "max_delay":      "100000",   # 500ms → 100ms: reduces initial buffering lag
    "flags":          "low_delay",
}


class _Watchdog:
    """
    Background thread that closes a PyAV container when no RTP packet arrives
    within timeout_sec.  Works with PyAV 11.x (no interrupt_callback needed).

    Usage:
        wd = _Watchdog(RTSP_READ_TIMEOUT, label, stop_event)
        container = av.open(rtsp_url, options=...)
        wd.arm(container)
        try:
            for pkt in container.demux(...):
                if pkt.size == 0: continue
                wd.reset()   # actual RTP data → keep alive
                ...
        finally:
            wd.disarm()
            container.close()

    When the watchdog fires it closes the container from this background thread,
    which causes container.demux() in the main thread to raise av.AVError or
    OSError (Linux: EBADF on the closed socket fd).  The demux loop exits,
    _*_ingest_once() raises, and _*_loop() reconnects after retry_delay.

    RTSP control traffic (OPTIONS / GET_PARAMETER keep-alives) does NOT call
    reset(), so the watchdog correctly detects "keep-alives but no video" freeze.
    """

    __slots__ = ("_timeout", "_label", "_stop_ev", "_last", "_container",
                 "_disarmed", "_thread")

    def __init__(self, timeout_sec: float, label: str,
                 stop_event: threading.Event):
        self._timeout  = timeout_sec
        self._label    = label
        self._stop_ev  = stop_event
        self._last     = time.monotonic()
        self._container = None
        self._disarmed  = threading.Event()
        self._thread    = threading.Thread(
            target=self._run, daemon=True, name=f"wd-{label}"
        )

    def arm(self, container) -> None:
        """Attach container and start watchdog thread."""
        self._container = container
        self._last      = time.monotonic()
        self._thread.start()

    def reset(self) -> None:
        """Call after each successfully demuxed RTP packet."""
        self._last = time.monotonic()

    def disarm(self) -> None:
        """Stop the watchdog thread (call from finally block)."""
        self._disarmed.set()

    def _run(self) -> None:
        while not self._disarmed.wait(timeout=0.25):
            if self._stop_ev.is_set():
                try:
                    self._container.close()
                except Exception:
                    pass
                return
            elapsed = time.monotonic() - self._last
            if elapsed > self._timeout:
                log.warning("%s watchdog: no RTP for %.1fs — closing container",
                            self._label, elapsed)
                try:
                    self._container.close()
                except Exception:
                    pass
                return

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


# ── Camera session ────────────────────────────────────────────────────────────

class CameraSession:
    """
    Per-camera fan-out.

    Required: id, rtspUrl, callbackUrl  (AI JPEG path)
    Optional: mediasoupPort             (H264 RTP → mediasoup video)
              mediasoupAudioPort        (Opus RTP → mediasoup audio)
              appRtpCallbackUrl         (App RTP forwarding — ONVIF metadata)
              appRtpRtspUrl             (RTSP URL for App RTP; defaults to rtspUrl.
                                         Use to point App RTP at the original camera
                                         when rtspUrl is a MediaMTX re-publish URL
                                         that strips ONVIF data tracks.)
    """

    def __init__(self, cfg: dict):
        self.id                    = cfg["id"]
        self.rtsp_url              = cfg["rtspUrl"]
        self.callback_url          = cfg["callbackUrl"]
        self.mediasoup_video_port  = cfg.get("mediasoupPort")
        self.mediasoup_audio_port  = cfg.get("mediasoupAudioPort")
        self.app_rtp_callback_url  = cfg.get("appRtpCallbackUrl")
        # When the server uses MediaMTX as a proxy, rtsp_url points to the MediaMTX
        # re-publish URL which carries only video/audio.  appRtpRtspUrl (if set)
        # points to the original camera URL where ONVIF data tracks live.
        self.app_rtp_rtsp_url      = cfg.get("appRtpRtspUrl", cfg["rtspUrl"])
        # Per-camera target AI FPS.  When > 0, time-based throttling replaces
        # the global AI_FRAME_INTERVAL counter so different cameras can run at
        # different rates regardless of their native stream FPS.
        _fps = cfg.get("captureFps", 0)
        self._ai_push_interval = (1.0 / float(_fps)) if _fps and float(_fps) > 0 else 0.0
        self._ai_last_push     = 0.0

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

    def _signal_stop(self):
        """Phase 1 — set stop flag and shut down the push executor immediately."""
        self._stop.set()
        self._push_executor.shutdown(wait=False)

    def _join_threads(self, timeout: float = 3.0):
        """Phase 2 — wait for threads to exit after _signal_stop()."""
        for t in self._threads:
            try:
                t.join(timeout=timeout)
            except KeyboardInterrupt:
                pass  # second SIGINT during shutdown — ignore
        log.info("[%s] Stopped", self.id[:8])

    def stop(self):
        self._signal_stop()
        self._join_threads()

    # ── AI path ───────────────────────────────────────────────────────────────

    def _ai_loop(self):
        log.info("[%s] AI loop starting → %s", self.id[:8], self.rtsp_url[:50])
        retry_delay = 0.5
        while not self._stop.is_set():
            t0 = time.monotonic()
            try:
                self._ai_ingest_once()
                retry_delay = 0.5  # clean stop → reset
            except Exception as exc:
                if self._stop.is_set():
                    break
                # Session ran >10s → it was healthy, not a persistent failure
                if time.monotonic() - t0 > 10.0:
                    retry_delay = 0.5
                log.warning("[%s] AI RTSP error: %s — retry in %.1fs",
                            self.id[:8], exc, retry_delay)
                self._stop.wait(retry_delay)
                retry_delay = min(retry_delay * 1.5, 5.0)

    def _ai_ingest_once(self):
        wd = _Watchdog(RTSP_READ_TIMEOUT, f"[{self.id[:8]}] ai", self._stop)
        container = av.open(self.rtsp_url, options=_RTSP_OPTIONS)
        wd.arm(container)
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

            idr_seen      = False
            idr_deadline  = time.monotonic() + IDR_WAIT_TIMEOUT
            packet_counter = 0  # counts all IDR-past packets, decoded or not

            for packet in container.demux(vs):
                if self._stop.is_set():
                    break
                if packet.size == 0:
                    continue

                wd.reset()  # RTP packet arrived → keep watchdog alive

                if not idr_seen:
                    if packet.is_keyframe:
                        idr_seen = True
                    elif time.monotonic() > idr_deadline:
                        raise RuntimeError(
                            f"No IDR within {IDR_WAIT_TIMEOUT}s — reconnecting"
                        )
                    else:
                        continue

                # H264 decoder state must advance through every packet — skipping
                # decode() on P-frames causes the codec context to lose reference
                # frames, producing corrupted output when the next decode() is called.
                # We always decode but only push the resulting JPEG every N frames.
                packet_counter += 1
                if self._ai_push_interval > 0:
                    _now = time.monotonic()
                    _should_push = (_now - self._ai_last_push >= self._ai_push_interval)
                else:
                    _should_push = (packet_counter % AI_FRAME_INTERVAL == 0)

                try:
                    for frame in packet.decode():
                        if _should_push:
                            if self._ai_push_interval > 0:
                                self._ai_last_push = time.monotonic()
                            self._push_jpeg(frame)
                        break  # only first frame per packet needed
                except Exception as dec_err:
                    log.debug("[%s] decode: %s", self.id[:8], dec_err)
        finally:
            wd.disarm()
            try:
                container.close()
            except Exception:
                pass

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
                # Sent at native/decoded resolution — this is the sole source buffer
                # for both AI inference and detectionSnapshots crop extraction on the
                # Node.js side. Node.js (pipelineManager.js) downscales its own copy
                # before forwarding to a remote analysis server (streaming mode) so
                # that hop stays cheap while crops stay full-resolution.
                img = Image.fromarray(raw)
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
            t0 = time.monotonic()
            try:
                self._video_rtp_ingest_once()
                retry_delay = 0.5
            except Exception as exc:
                if self._stop.is_set():
                    break
                if time.monotonic() - t0 > 10.0:
                    retry_delay = 0.5
                log.warning("[%s] Video RTP error: %s — retry in %.1fs",
                            self.id[:8], exc, retry_delay)
                self._stop.wait(retry_delay)
                retry_delay = min(retry_delay * 1.5, 5.0)

    def _video_rtp_ingest_once(self):
        wd = _Watchdog(RTSP_READ_TIMEOUT, f"[{self.id[:8]}] vrtp", self._stop)
        inp = av.open(self.rtsp_url, options=_RTSP_OPTIONS)
        wd.arm(inp)
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

                    wd.reset()  # RTP packet arrived → keep watchdog alive

                    if not idr_seen:
                        if pkt.is_keyframe:
                            idr_seen = True
                        elif time.monotonic() > idr_deadline:
                            raise RuntimeError(
                                f"No IDR within {IDR_WAIT_TIMEOUT}s — reconnecting"
                            )
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
            wd.disarm()
            try:
                inp.close()
            except Exception:
                pass

    # ── Audio RTP path (camera audio → Opus → mediasoup PlainTransport) ───────

    def _audio_rtp_loop(self):
        log.info("[%s] Audio RTP loop starting → UDP:%d",
                 self.id[:8], self.mediasoup_audio_port)
        retry_delay = 0.5
        while not self._stop.is_set():
            t0 = time.monotonic()
            try:
                self._audio_rtp_ingest_once()
                retry_delay = 0.5
            except RuntimeError as exc:
                if "No audio stream" in str(exc):
                    # Camera has no audio — stop thread silently
                    log.info("[%s] No audio stream — audio RTP thread exiting", self.id[:8])
                    return
                raise
            except Exception as exc:
                if self._stop.is_set():
                    break
                if time.monotonic() - t0 > 10.0:
                    retry_delay = 0.5
                log.warning("[%s] Audio RTP error: %s — retry in %.1fs",
                            self.id[:8], exc, retry_delay)
                self._stop.wait(retry_delay)
                retry_delay = min(retry_delay * 1.5, 5.0)

    def _audio_rtp_ingest_once(self):
        # Probe codec with a short-lived connection first, then reopen for the
        # actual loop.  This avoids holding two simultaneous RTSP sessions.
        probe = av.open(self.rtsp_url, options=_RTSP_OPTIONS)
        try:
            as_probe = next((s for s in probe.streams if s.type == "audio"), None)
            if as_probe is None:
                raise RuntimeError("No audio stream")
            codec_name = as_probe.codec_context.name
        finally:
            try:
                probe.close()
            except Exception:
                pass

        out = av.open(
            f"rtp://127.0.0.1:{self.mediasoup_audio_port}",
            "w", format="rtp",
            options={
                "ssrc":         str(_MEDIASOUP_AUDIO_SSRC),
                "payload_type": str(_MEDIASOUP_AUDIO_PT),
            },
        )

        # Both passthrough and transcode paths use stimeout (socket-level I/O
        # timeout) instead of _Watchdog.  Calling container.close() from a
        # _Watchdog background thread while inp.demux() is blocking on a socket
        # read is not thread-safe in libav and can segfault the process even for
        # passthrough (demux+mux only, no explicit decode).  stimeout fires
        # inside libav's own I/O layer and raises an exception on the foreground
        # demux thread, which is always safe.
        _audio_opts = {**_RTSP_OPTIONS,
                       "stimeout": str(int(RTSP_READ_TIMEOUT * 1_000_000))}

        # Pass through if already Opus; transcode everything else.
        if codec_name == "opus":
            inp = av.open(self.rtsp_url, options=_audio_opts)
            try:
                as_ = next((s for s in inp.streams if s.type == "audio"), None)
                if as_ is None:
                    raise RuntimeError("No audio stream")
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
            finally:
                try:
                    inp.close()
                except Exception:
                    pass
        else:
            inp = av.open(self.rtsp_url, options=_audio_opts)
            try:
                as_ = next((s for s in inp.streams if s.type == "audio"), None)
                if as_ is None:
                    raise RuntimeError("No audio stream")
                out_as    = out.add_stream("libopus", rate=48000)
                out_as.codec_context.channels = 2
                out_as.codec_context.layout   = "stereo"
                resampler = av.AudioResampler(format="s16", layout="stereo", rate=48000)
                log.info("[%s] Audio RTP transcode %s → opus → rtp://127.0.0.1:%d",
                         self.id[:8], codec_name, self.mediasoup_audio_port)
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
                try:
                    inp.close()
                except Exception:
                    pass

    # ── App RTP path (RTSP data/subtitle track → server HTTP callback → DataChannel) ──

    def _app_rtp_loop(self):
        log.info("[%s] App RTP loop starting → %s",
                 self.id[:8], self.app_rtp_callback_url[:60])
        retry_delay   = 0.5
        addr_in_use_n = 0  # consecutive EADDRINUSE counter
        while not self._stop.is_set():
            t0 = time.monotonic()
            try:
                self._app_rtp_ingest_once()
                retry_delay   = 0.5
                addr_in_use_n = 0
            except RuntimeError as exc:
                if "No application stream" in str(exc):
                    log.info("[%s] No application stream — app RTP thread exiting", self.id[:8])
                    return
                raise
            except OSError as exc:
                if self._stop.is_set():
                    break
                # EADDRINUSE (98) or EADDRNOTAVAIL (99): address-level errors
                # that will not resolve with retries (source has no data track,
                # or the local address cannot be assigned).  Exit cleanly after
                # a few consecutive failures to avoid log spam.
                if exc.errno in (98, 99):  # EADDRINUSE / EADDRNOTAVAIL
                    addr_in_use_n += 1
                    if addr_in_use_n >= 3:
                        log.warning(
                            "[%s] App RTP: persistent address error errno=%d (%d×) on %s"
                            " — source has no data track or address unreachable; exiting",
                            self.id[:8], exc.errno, addr_in_use_n, self.app_rtp_rtsp_url,
                        )
                        return
                log.warning("[%s] App RTP error: %s — retry in %.1fs",
                            self.id[:8], exc, retry_delay)
                self._stop.wait(retry_delay)
                retry_delay = min(retry_delay * 1.5, 5.0)
            except Exception as exc:
                if self._stop.is_set():
                    break
                if time.monotonic() - t0 > 10.0:
                    retry_delay = 0.5
                log.warning("[%s] App RTP error: %s — retry in %.1fs",
                            self.id[:8], exc, retry_delay)
                self._stop.wait(retry_delay)
                retry_delay = min(retry_delay * 1.5, 5.0)

    def _app_rtp_ingest_once(self):
        # App RTP carries sparse ONVIF metadata (codec=unknown data track).
        # Do NOT use _Watchdog here: calling container.close() from a background
        # thread while demux() runs on an unknown-codec stream can segfault libav,
        # crashing the entire ingest-daemon process.
        #
        # Use stimeout= (socket I/O timeout, µs) — NOT "timeout" which is the
        # deprecated RTSP listen-mode option and triggers RTSP_FLAG_LISTEN,
        # causing FFmpeg to bind to the camera's IP address and fail with EADDRNOTAVAIL.
        # stimeout overrides the 30s value in _RTSP_OPTIONS with the longer
        # APP_RTP_READ_TIMEOUT (default 60s) to tolerate sparse ONVIF data tracks.
        _app_rtp_opts = {**_RTSP_OPTIONS, "stimeout": str(int(APP_RTP_READ_TIMEOUT * 1_000_000))}
        # Use app_rtp_rtsp_url (original camera URL) — not rtsp_url which may be a
        # MediaMTX re-publish URL that strips ONVIF data tracks.
        inp = av.open(self.app_rtp_rtsp_url, options=_app_rtp_opts)
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
            log.debug("[%s] App RTP stream: type=%s codec=%s",
                      self.id[:8], ds.type, codec_name)

            ctx        = _SSL_CTX_NOVERIFY if self.app_rtp_callback_url.startswith("https://") else None
            seq        = 0
            push_count = 0

            for pkt in inp.demux(ds):
                if self._stop.is_set():
                    break
                if pkt.size == 0:
                    continue

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
                        log.debug("[%s] App RTP #%d: %dB payload",
                                  self.id[:8], push_count, len(payload_b64))
                except Exception as e:
                    log.debug("[%s] App RTP callback failed: %s", self.id[:8], e)
        finally:
            try:
                inp.close()
            except Exception:
                pass


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
        # Phase 1: signal every session to stop before joining any thread.
        # This minimises the window where threads log "Connection refused"
        # because MediaMTX has already exited but _stop is not yet set.
        for s in sessions:
            s._signal_stop()
        # Phase 2: join threads (they are already winding down)
        for s in sessions:
            s._join_threads()


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
        try:
            _manager.stop_all()
        except KeyboardInterrupt:
            pass  # second SIGINT during stop_all — ignore
        server.server_close()
        log.info("Ingest daemon stopped")


if __name__ == "__main__":
    main()
