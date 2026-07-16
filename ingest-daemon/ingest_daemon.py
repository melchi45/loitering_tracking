#!/usr/bin/env python3
"""
LTS-2026 Ingest Daemon — Python implementation.

Single-RTSP-connection-per-camera fan-out (2026-07-15 redesign — see
docs/design/Design_RTSP_Capture_Backend.md §6.8):
  One "io" thread opens exactly ONE av.open(rtspUrl) container and demuxes
  video + audio (+ data, when it lives on the same URL) together:
    - video packets are muxed to RTP → UDP:{mediasoupPort} immediately (no
      decode — passthrough only, so this stays fast/low-latency)
    - video packets are also handed off (raw bytes, non-blocking, drop-if-full)
      to a dedicated AI worker thread that owns its own independent
      CodecContext and decodes + JPEG-encodes + POSTs to Node.js
    - audio packets are muxed straight through when already Opus, or handed
      off to a dedicated transcode worker thread (own CodecContext + resampler)
      otherwise
    - data/subtitle (ONVIF metadata) packets are POSTed to Node.js via the
      shared push thread pool (non-blocking)
  This replaces the previous design of 4 independent RTSP sessions per camera
  (AI/video/audio/appRTP each opening their own av.open()), which multiplied
  concurrent RTSP session pressure on the camera 4× (8× when a camera has two
  channel registrations) and was found to be the dominant cause of connection
  instability on resource-constrained encoders (e.g. TID-A800) — see design
  doc §6.8 for the live-measured evidence.  A same-thread "everything inline"
  merge was tried first and reverted (see design doc §6.7) because decode()
  head-of-line-blocked the time-critical RTP mux; routing decode onto its own
  thread via a raw-bytes queue (this design) avoids that specific failure.

  App RTP (ONVIF metadata) stays on its own separate connection ONLY when
  appRtpRtspUrl differs from rtspUrl (MediaMTX-loopback deployments, where the
  ONVIF data track lives on the original camera URL, not the republished one)
  — in the common case (mediasoup mode, direct-camera) the two URLs are equal
  and the data track is folded into the single combined connection above.

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
  AI_DECODE_THREADS — libav internal decode threads per camera's AI CodecContext (default: 4).
                      Fixed cap, not "0 = auto-size to all cores" — see §6.10 in
                      docs/design/Design_RTSP_Capture_Backend.md for why an unbounded
                      per-camera thread count (scaling with nproc) made the daemon's
                      own HTTP server unresponsive under a real multi-camera fleet.

AI frames are sent at native/decoded resolution (no resize) — this is the sole
source buffer for both AI inference and detectionSnapshots crop extraction on
the Node.js side. Node.js downscales its own copy (env AI_MAX_WIDTH, read by
pipelineManager.js) before forwarding to a remote analysis server in streaming
mode, so that hop stays cheap while crops stay full-resolution.
"""

import argparse
import base64
import faulthandler
import io
import json
import logging
import os
import queue
import re
import signal
import ssl
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
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

# SIGUSR1 → dump every thread's real Python stack to a file (2026-07-16).
# When the daemon goes fully unresponsive (all threads futex-blocked, 0%
# CPU) py-spy/gdb can't attach without ptrace permissions (denied in this
# environment, no sudo). faulthandler.register runs entirely inside this
# process — no ptrace needed — and prints every thread's current frame,
# which is enough to tell "waiting on a Lock/queue.get() that never wakes"
# apart from "genuinely idle". Trigger with `kill -USR1 <pid>`, read
# /tmp/ingest-daemon-stacks.log.
_faulthandler_file = open("/tmp/ingest-daemon-stacks.log", "a")
faulthandler.register(signal.SIGUSR1, file=_faulthandler_file, all_threads=True, chain=False)

# ── Configuration ─────────────────────────────────────────────────────────────
AI_FRAME_INTERVAL  = int(os.environ.get("AI_FRAME_INTERVAL", "3"))
JPEG_QUALITY       = int(os.environ.get("JPEG_QUALITY", "85"))
IDR_WAIT_TIMEOUT   = float(os.environ.get("IDR_WAIT_TIMEOUT", "2"))
# Per-camera libav internal decode thread cap (see _ai_decode_worker) — fixed
# instead of "0 = auto-size to all cores" so fleet-wide native thread count
# scales with camera count × this cap, not camera count × nproc.
_AI_DECODE_THREADS = int(os.environ.get("AI_DECODE_THREADS", "4"))
# Idle timeout (seconds) for the AI / video RTP RTSP sessions, applied as the
# libav "stimeout" socket I/O option (µs). All ingest loops (AI, video RTP,
# audio, App RTP) now use stimeout exclusively — a prior per-camera background
# watchdog thread that called container.close() concurrently with the
# foreground demux() thread was removed after it was found to crash the whole
# process (STATUS_HEAP_CORRUPTION on Windows; segfault on Linux), since libav
# is not thread-safe for that kind of cross-thread close. stimeout fires inside
# libav's own I/O layer on the same thread that is blocked reading, which is
# always safe. Trade-off: like any socket-level timeout it is reset by RTSP
# keepalives (OPTIONS / GET_PARAMETER) even when no video/audio data is
# flowing, so a "keepalives-only" stall takes longer to detect than the old
# watchdog — accepted since correctness beats that edge case.
RTSP_READ_TIMEOUT     = float(os.environ.get("RTSP_READ_TIMEOUT", "5"))
# App RTP carries sparse ONVIF metadata (events may be minutes apart).
# Use a much longer idle timeout than video/audio tracks.
APP_RTP_READ_TIMEOUT  = float(os.environ.get("APP_RTP_READ_TIMEOUT", "60"))
# Bound on the raw-bytes hand-off queues from the combined io thread to the AI
# decode / audio transcode worker threads. ~2s of video at typical fleet frame
# rates; if a worker falls behind, older packets are dropped (put_nowait) so
# the io thread — which owns the single RTSP connection and the time-critical
# RTP mux — is never blocked waiting on a slow decode.
_WORKER_QUEUE_MAXSIZE = int(os.environ.get("INGEST_WORKER_QUEUE_MAXSIZE", "60"))

# Shared JPEG/App-RTP push pool (2026-07-15) — was previously one
# ThreadPoolExecutor(max_workers=4) PER CAMERA (up to 4 × camera-count threads,
# e.g. 52 for a 13-camera fleet, on top of every camera's own io/AI-decode
# threads). A fleet-wide daemon HTTP responsiveness stall (GET /health taking
# minutes, Node.js's own re-registration calls timing out) was traced to the
# process running with several hundred live threads at once — sharing one
# bounded pool across all cameras keeps push concurrency the same in spirit
# (still bounded, still non-blocking/drop-on-full for the decode thread) while
# capping the daemon's total thread count regardless of fleet size. See
# docs/design/Design_RTSP_Capture_Backend.md §6.8.
_PUSH_WORKERS          = int(os.environ.get("INGEST_PUSH_WORKERS", "16"))
_SHARED_PUSH_EXECUTOR  = ThreadPoolExecutor(max_workers=_PUSH_WORKERS, thread_name_prefix="push")
_SHARED_PUSH_SEMAPHORE = threading.Semaphore(_PUSH_WORKERS)

# Shared "stopper" pool (2026-07-16) — CameraManager.add()/remove() used to
# spawn a brand-new threading.Thread(...) per old-session teardown so the HTTP
# response could return immediately (see CameraManager.add() below). Under
# heavy churn (a flaky camera or YouTube source reconnecting every few
# seconds) that meant one throwaway thread per churn event with no cap,
# stacking on top of the shared push pool and every live session's own
# threads. Routing teardown through a small bounded executor keeps the same
# fire-and-forget behaviour (submit() returns immediately, callers never wait
# on the Future) while capping how many stop() calls can be in flight at once.
_STOP_WORKERS         = int(os.environ.get("INGEST_STOP_WORKERS", "8"))
_SHARED_STOP_EXECUTOR = ThreadPoolExecutor(max_workers=_STOP_WORKERS, thread_name_prefix="stopper")

# Connection-establishment gate (2026-07-16, see _combined_ingest_once) — caps
# how many cameras can be inside av.open()+probe+worker-thread-startup at the
# same time. Confirmed live that letting the whole fleet do this simultaneously
# (daemon restart, or a network blip hitting several cameras at once) freezes
# the entire process — zero frames decoded, /health fully unresponsive — even
# though the main HTTP accept thread stays idle. See docs/design/
# Design_RTSP_Capture_Backend.md §6.10.
_INGEST_SETUP_CONCURRENCY = int(os.environ.get("INGEST_SETUP_CONCURRENCY", "5"))
_INGEST_SETUP_SEMAPHORE   = threading.Semaphore(_INGEST_SETUP_CONCURRENCY)

_RTSP_OPTIONS = {
    "rtsp_transport": "tcp",
    "stimeout":       "30000000", # socket I/O timeout 30s (fallback for hard network hang)
    "max_delay":      "100000",   # 500ms → 100ms: reduces initial buffering lag
    "flags":          "low_delay",
}


# Must match VIDEO_SSRC / AUDIO_SSRC / VIDEO_PT / AUDIO_PT in
# server/src/services/webrtc/mediasoupEngine.js.
# mediasoup PlainTransport (comedia=true) matches incoming RTP by both SSRC and payload type;
# packets with mismatched SSRC or PT are silently discarded by the Producer.
_MEDIASOUP_VIDEO_SSRC = 573785173   # 0x22334455
_MEDIASOUP_AUDIO_SSRC = 860116326   # 0x33445566
_MEDIASOUP_VIDEO_PT   = 96          # must match VIDEO_PT constant in mediasoupEngine.js
_MEDIASOUP_AUDIO_PT   = 111         # must match AUDIO_PT constant in mediasoupEngine.js

# Reusable SSL context for loopback HTTPS callbacks (self-signed cert OK).
_SSL_CTX_NOVERIFY = ssl.create_default_context()
_SSL_CTX_NOVERIFY.check_hostname = False
_SSL_CTX_NOVERIFY.verify_mode    = ssl.CERT_NONE


def _parse_h264_sps_pps(extradata: bytes):
    """
    Split Annex-B extradata (NAL units prefixed with 00 00 01 / 00 00 00 01 start
    codes, as PyAV's RTSP demuxer exposes H.264 codec_context.extradata) into
    individual NAL units, keep only SPS (type 7) and PPS (type 8), and return
    (sprop_parameter_sets, profile_level_id):
      - sprop_parameter_sets: comma-separated base64 NAL units per RFC 6184
        (each unit base64-encoded WITHOUT its start code), "" if none found.
      - profile_level_id: 6 hex chars (profile_idc + constraint_flags + level_idc,
        the 3 bytes right after the SPS NAL header — RFC 6184 §8.1), taken from
        the ACTUAL camera stream rather than a fixed guess. Confirmed live
        (2026-07-16, §6.13) that hardcoding "42e01f" (Baseline) while real
        cameras send High Profile (profile_idc 0x64) left the browser's decoder
        never producing a single decoded frame despite healthy RTP delivery —
        None if no SPS was found or it's too short to read.
    Returns ("", None) for non-H.264 extradata (e.g. HEVC, whose NAL type
    numbering and 2-byte header differ — never mistake it for usable H.264 sprop).
    """
    if not extradata:
        return "", None
    # Split on start codes, keeping the first byte of each unit (NAL header) so
    # the type check below can inspect it.
    parts = re.split(rb"\x00\x00\x01", extradata.replace(b"\x00\x00\x00\x01", b"\x00\x00\x01"))
    units = []
    profile_level_id = None
    for p in parts:
        if not p:
            continue
        nal_type = p[0] & 0x1F
        if nal_type in (7, 8):  # SPS, PPS
            units.append(base64.b64encode(p).decode("ascii"))
            if nal_type == 7 and profile_level_id is None and len(p) >= 4:
                profile_level_id = p[1:4].hex()
    return ",".join(units), profile_level_id


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

        # Populated once the RTSP stream's SPS/PPS are probed (see
        # _combined_ingest_once) — exposed via GET /cameras/:id/video-params so
        # mediasoupEngine.js can inject sprop-parameter-sets into the WHEP SDP
        # answer. Pure RTP passthrough (no transcode) can't guarantee every late-
        # joining WebRTC viewer sees in-band SPS/PPS NAL units, and the mediasoup
        # Producer is created (with only static profile-level-id) before this
        # daemon has even connected to the camera — so the only reliable way to
        # get the browser's H.264 decoder the parameter sets it needs is via the
        # SDP's sprop-parameter-sets, fetched here after the fact. See
        # docs/design/Design_RTSP_Capture_Backend.md §6.13.
        self.video_codec_name       = None
        self.sprop_parameter_sets   = None
        self.profile_level_id       = None

        # JPEG/App-RTP push uses the module-level _SHARED_PUSH_EXECUTOR /
        # _SHARED_PUSH_SEMAPHORE (bounded pool shared by the whole daemon, not
        # one per camera — see their definitions for why).

        self._threads: list[threading.Thread] = []

        # Single-RTSP-connection redesign (2026-07-15) — see module docstring and
        # docs/design/Design_RTSP_Capture_Backend.md §6.8. A same-thread "everything
        # inline" merge was tried earlier and reverted (§6.7) because decode()
        # head-of-line-blocked the time-critical RTP mux on the same thread. This
        # design keeps that lesson: the io thread below never calls decode() itself —
        # it only demuxes and does fast passthrough muxing; AI decode (and audio
        # transcode, when needed) run on their own dedicated worker threads fed via
        # bounded, drop-if-full queues of raw packet bytes, so a slow decode can never
        # delay the RTP passthrough path.
        #
        # App RTP (ONVIF metadata) is folded into the same connection only when it
        # reads from the same URL as video/audio (appRtpRtspUrl == rtspUrl — the
        # common case in mediasoup/direct-camera mode). When they differ (MediaMTX
        # loopback mode, where the ONVIF data track only exists on the original
        # camera URL) App RTP necessarily needs its own connection to that different
        # source — that one case still uses the legacy independent thread below.
        self._app_rtp_merged = bool(self.app_rtp_callback_url) and (self.app_rtp_rtsp_url == self.rtsp_url)
        self._start_thread("io", self._combined_loop)
        if self.app_rtp_callback_url and not self._app_rtp_merged:
            self._start_thread("apprtp", self._app_rtp_loop)

    def _start_thread(self, label: str, target) -> None:
        t = threading.Thread(
            target=target, daemon=True,
            name=f"{label}-{self.id[:8]}"
        )
        t.start()
        self._threads.append(t)

    def _signal_stop(self):
        """Phase 1 — set stop flag. The push executor is shared daemon-wide
        (_SHARED_PUSH_EXECUTOR) and is not owned by any single camera, so it is
        not shut down here — only the daemon process exit tears it down."""
        self._stop.set()

    def _join_threads(self, timeout: float = 8.0):
        """
        Phase 2 — wait for the io thread to exit after _signal_stop().

        8s default (was 3s pre-single-connection-redesign): the io thread's own
        cleanup is now nested — it must first signal+join its AI decode worker
        and (when transcoding) its audio worker (up to ~2s combined, since both
        only poll their queue with a 0.5s timeout) before it can close the RTP
        muxers/container and return. It can also be blocked inside libav's own
        demux() for up to RTSP_READ_TIMEOUT (default 5s) if _stop was signalled
        while mid-read. 8s covers that worst case with margin. Under the old
        4-independent-threads design each thread got its own 3s budget (up to
        12s total worst case), so this is not a regression — see
        docs/design/Design_RTSP_Capture_Backend.md §6.8.
        """
        leaked = []
        for t in self._threads:
            try:
                t.join(timeout=timeout)
            except KeyboardInterrupt:
                pass  # second SIGINT during shutdown — ignore
            if t.is_alive():
                leaked.append(t.name)
        if leaked:
            # This thread (almost always the "io" thread, blocked inside
            # libav's demux() past the join timeout) is now a zombie: still
            # holding its RTSP session open on the *camera's* side, still
            # decoding/pushing frames through the shared pools, indefinitely
            # — nothing forcibly kills it (safe forced-close from another
            # thread is not possible, see _combined_ingest_once's docstring).
            # Confirmed live (2026-07-16) as a compounding cause of session
            # exhaustion on session-limited cameras (TID-A800) and inflated
            # daemon thread counts after repeated restarts — previously this
            # was 100% silent, indistinguishable from a clean stop.
            log.warning("[%s] Stopped with %d thread(s) still alive after %.0fs: %s — leaked (camera-side RTSP session likely still open)",
                        self.id[:8], len(leaked), timeout, ", ".join(leaked))
        else:
            log.info("[%s] Stopped", self.id[:8])

    def stop(self):
        self._signal_stop()
        self._join_threads()

    # ── Combined io path (single RTSP connection → video RTP passthrough +
    #    audio RTP passthrough/transcode + AI decode handoff + App RTP) ────────

    def _combined_loop(self):
        log.info("[%s] Combined RTSP loop starting → %s", self.id[:8], self.rtsp_url[:50])
        retry_delay = 0.5
        while not self._stop.is_set():
            t0 = time.monotonic()
            try:
                self._combined_ingest_once()
                retry_delay = 0.5  # clean stop → reset
            except Exception as exc:
                if self._stop.is_set():
                    break
                # Session ran >10s → it was healthy, not a persistent failure
                if time.monotonic() - t0 > 10.0:
                    retry_delay = 0.5
                log.warning("[%s] Combined RTSP error: %s — retry in %.1fs",
                            self.id[:8], exc, retry_delay)
                self._stop.wait(retry_delay)
                retry_delay = min(retry_delay * 1.5, 5.0)

    def _combined_ingest_once(self):
        # stimeout (socket I/O timeout, µs) instead of _Watchdog — closing the
        # container from a background thread while demux() runs on the foreground
        # thread is not thread-safe in libav and can crash the whole process
        # (observed as STATUS_HEAP_CORRUPTION on Windows).
        _opts = {**_RTSP_OPTIONS, "stimeout": str(int(RTSP_READ_TIMEOUT * 1_000_000))}

        # Connection-establishment gate (2026-07-16) — av.open() + stream probing
        # + worker-thread startup is CPU/parsing-heavy and was found to hold the
        # GIL far longer per-camera than the steady-state demux loop. When many
        # cameras reconnect at once (daemon restart re-registering the whole
        # fleet, or a network blip hitting several cameras together), every io
        # thread does this heavy phase simultaneously — confirmed live (SIGUSR1
        # stack dump, §6.10) as a total daemon freeze: 10+ io threads stuck at
        # the same setup line, zero frames processed for 4+ minutes, /health
        # completely unresponsive despite the main accept thread being idle in
        # select(). Bounding how many cameras can be inside this phase at once
        # spreads the burst out. Released as soon as the steady-state demux loop
        # is entered — never held for a connection's full lifetime.
        #
        # Poll with a timeout instead of a plain blocking acquire() (2026-07-16,
        # §6.12) — a plain acquire() never checks self._stop while waiting, so a
        # session superseded by CameraManager.add()/remove() while still queued
        # for a permit would wait FOREVER, permanently occupying a place in line.
        # Under the fleet's actual restart cadence (every camera cycling roughly
        # every 45-56s) this accumulated one permanently-stuck waiter per
        # superseded session, and since only _INGEST_SETUP_CONCURRENCY (3)
        # permits exist total, the queue eventually backed up badly enough that
        # every real camera's *live* registration also started missing Node's 8s
        # addCameraStream() timeout — confirmed live: all 7 real cameras showed
        # near-equal counts of "mediasoup re-registration failed" in the logs,
        # not just the one camera (TID-A800) that was the original suspect.
        while not self._stop.is_set():
            if _INGEST_SETUP_SEMAPHORE.acquire(timeout=0.5):
                break
        else:
            return  # superseded/removed while still waiting for a permit
        _setup_sem_released = False
        try:
            container = av.open(self.rtsp_url, options=_opts)

            ai_queue = ai_worker_stop = ai_worker_thread = None
            audio_out = audio_out_stream = None
            audio_queue = audio_worker_stop = audio_worker_thread = None
            audio_mode = None
            video_out = video_out_vs = None

            try:
                vs = next((s for s in container.streams if s.type == "video"), None)
                if vs is None:
                    raise RuntimeError("No video stream in RTSP source")

                as_ = None
                if self.mediasoup_audio_port:
                    as_ = next((s for s in container.streams if s.type == "audio"), None)

                # Only claim the data/subtitle (ONVIF) stream on this connection when
                # App RTP is configured to read from this same URL — see __init__.
                app_stream = None
                if self._app_rtp_merged:
                    app_stream = next((s for s in container.streams if s.type not in ("video", "audio")), None)

                log.info("[%s] Combined stream: video=%s %dx%d audio=%s app=%s",
                         self.id[:8], vs.codec_context.name,
                         vs.codec_context.width, vs.codec_context.height,
                         (as_.codec_context.name if as_ else "none"),
                         ("yes" if app_stream is not None else "no"))

                # Confirmed live (2026-07-16, §6.13): browser framesDecoded stayed
                # at 0 on every camera despite substantial bytesReceived — the
                # camera's SPS/PPS reach PyAV only via the RTSP SDP (parsed into
                # codec_context.extradata), not repeated in-band in the RTP
                # payload, so a pure-passthrough WebRTC viewer never receives
                # parameter sets its H.264 decoder needs. Extract them here and
                # expose via GET /cameras/:id/video-params so mediasoupEngine.js
                # can inject sprop-parameter-sets into the WHEP SDP answer.
                self.video_codec_name = vs.codec_context.name
                if vs.codec_context.name == "h264":
                    self.sprop_parameter_sets, self.profile_level_id = _parse_h264_sps_pps(vs.codec_context.extradata)
                    if self.sprop_parameter_sets and self.profile_level_id:
                        log.info("[%s] sprop-parameter-sets ready (%d NAL unit(s), profile-level-id=%s)",
                                 self.id[:8], self.sprop_parameter_sets.count(",") + 1, self.profile_level_id)
                    else:
                        log.warning("[%s] no SPS/PPS found in extradata — WebRTC viewers may never decode video", self.id[:8])
                else:
                    self.sprop_parameter_sets = None
                    self.profile_level_id = None
                    log.warning("[%s] video codec is %s, not h264 — mediasoup Producer is H.264-only, WebRTC playback for this camera cannot work", self.id[:8], vs.codec_context.name)

                # Video RTP passthrough output — no decode here, this stays on the io
                # thread so it is never delayed by the (potentially slow) AI decode.
                if self.mediasoup_video_port:
                    # payload_type must be explicit — mediasoup's video Producer
                    # (mediasoupEngine.js) is configured to only accept PT=96
                    # (VIDEO_PT) and silently discards anything else. Without this
                    # option ffmpeg's rtp muxer picks its own default dynamic PT,
                    # which is not guaranteed to match (unlike the audio branch
                    # below, which already sets this explicitly).
                    video_out = av.open(
                        f"rtp://127.0.0.1:{self.mediasoup_video_port}",
                        "w", format="rtp",
                        options={"ssrc": str(_MEDIASOUP_VIDEO_SSRC), "payload_type": str(_MEDIASOUP_VIDEO_PT)},
                    )
                    video_out_vs = video_out.add_stream(template=vs)
                    log.info("[%s] Video RTP: %s → rtp://127.0.0.1:%d (ssrc=0x%08x pt=%d) time_base in=%s out=%s",
                             self.id[:8], vs.codec_context.name,
                             self.mediasoup_video_port, _MEDIASOUP_VIDEO_SSRC, _MEDIASOUP_VIDEO_PT,
                             vs.time_base, video_out_vs.time_base)

                # AI decode worker — owns an independent CodecContext (seeded with the
                # extradata/SPS-PPS this container already probed) and receives raw
                # packet bytes via a bounded, drop-if-full queue. A slow/large-frame
                # decode (e.g. TID-A800's 2560x1920 @30fps thermal stream) can only
                # ever fall behind on AI/JPEG output — it can never block the video
                # RTP passthrough above, which is what the earlier same-thread merge
                # (reverted — see module docstring) got wrong.
                ai_queue = queue.Queue(maxsize=_WORKER_QUEUE_MAXSIZE)
                ai_worker_stop = threading.Event()
                ai_worker_thread = threading.Thread(
                    target=self._ai_decode_worker,
                    args=(ai_queue, ai_worker_stop, vs.codec_context.name, vs.codec_context.extradata),
                    daemon=True, name=f"aiw-{self.id[:8]}",
                )
                ai_worker_thread.start()

                # Audio: passthrough (already Opus) is cheap pure mux, kept inline on
                # the io thread like video. Transcoding needs decode+resample+encode —
                # real CPU work — so it gets its own worker thread, same pattern as AI.
                if as_ is not None:
                    codec_name = as_.codec_context.name
                    if codec_name == "opus":
                        audio_mode = "passthrough"
                        audio_out = av.open(
                            f"rtp://127.0.0.1:{self.mediasoup_audio_port}",
                            "w", format="rtp",
                            options={"ssrc": str(_MEDIASOUP_AUDIO_SSRC), "payload_type": str(_MEDIASOUP_AUDIO_PT)},
                        )
                        audio_out_stream = audio_out.add_stream(template=as_)
                        log.info("[%s] Audio RTP passthrough opus → rtp://127.0.0.1:%d",
                                 self.id[:8], self.mediasoup_audio_port)
                    else:
                        audio_mode = "transcode"
                        audio_queue = queue.Queue(maxsize=_WORKER_QUEUE_MAXSIZE)
                        audio_worker_stop = threading.Event()
                        audio_worker_thread = threading.Thread(
                            target=self._audio_transcode_worker,
                            args=(audio_queue, audio_worker_stop, codec_name),
                            daemon=True, name=f"artpw-{self.id[:8]}",
                        )
                        audio_worker_thread.start()

                idr_seen       = False
                idr_deadline   = time.monotonic() + IDR_WAIT_TIMEOUT
                video_last_dts = None
                audio_last_dts = None

                demux_streams = [s for s in (vs, as_, app_stream) if s is not None]

                # Setup is done — release the gate before entering the steady-state
                # loop below, which can run for the connection's entire lifetime.
                _INGEST_SETUP_SEMAPHORE.release()
                _setup_sem_released = True

                for packet in container.demux(*demux_streams):
                    if self._stop.is_set():
                        break
                    if packet.size == 0:
                        continue

                    if packet.stream is vs:
                        if not idr_seen:
                            if packet.is_keyframe:
                                idr_seen = True
                            elif time.monotonic() > idr_deadline:
                                raise RuntimeError(
                                    f"No IDR within {IDR_WAIT_TIMEOUT}s — reconnecting"
                                )
                            else:
                                continue

                        # Snapshot raw bytes BEFORE any mutation from the passthrough
                        # mux below — the AI worker gets its own independent copy, so
                        # it is never affected by, and can never block, that path.
                        raw = bytes(packet)
                        if video_out is not None:
                            video_last_dts = self._mux_passthrough(packet, video_out, video_out_vs, video_last_dts)
                        try:
                            ai_queue.put_nowait(raw)
                        except queue.Full:
                            pass  # AI decode behind — drop; self-heals at next IDR

                    elif as_ is not None and packet.stream is as_:
                        if audio_mode == "passthrough":
                            audio_last_dts = self._mux_passthrough(packet, audio_out, audio_out_stream, audio_last_dts)
                        elif audio_mode == "transcode":
                            try:
                                audio_queue.put_nowait(bytes(packet))
                            except queue.Full:
                                pass  # transcode worker behind — drop this packet

                    elif app_stream is not None and packet.stream is app_stream:
                        self._submit_app_rtp(bytes(packet), packet.pts)

            finally:
                if ai_worker_stop is not None:
                    ai_worker_stop.set()
                if ai_worker_thread is not None:
                    ai_worker_thread.join(timeout=2)
                if audio_worker_stop is not None:
                    audio_worker_stop.set()
                if audio_worker_thread is not None:
                    audio_worker_thread.join(timeout=2)
                if video_out is not None:
                    try:
                        video_out.close()
                    except Exception:
                        pass
                if audio_out is not None:
                    try:
                        audio_out.close()
                    except Exception:
                        pass
                try:
                    container.close()
                except Exception:
                    pass
        finally:
            if not _setup_sem_released:
                _INGEST_SETUP_SEMAPHORE.release()

    def _mux_passthrough(self, packet, out, out_stream, last_dts):
        """Forward one demuxed packet to an RTP output muxer, no decode involved."""
        # Rescale PTS/DTS from the SOURCE stream's time_base to the RTP output
        # stream's time_base (2026-07-16, §6.13) — av.Packet has no rescale_ts()
        # helper in this PyAV version, and neither add_stream(template=vs) nor
        # container.mux() rescale timestamps for you; ffmpeg's muxer writes
        # packet.pts/dts as-is, interpreted in whatever time_base the packet
        # currently carries. RTP's rtpenc_h264 forces its own clock-rate-derived
        # time_base (90000Hz) regardless of the source RTSP stream's demuxer
        # time_base, so skipping this silently produced badly-scaled RTP
        # timestamps — confirmed as the actual cause of browsers' framesDecoded
        # staying at 0 forever despite healthy byte/packet delivery (mediasoup's
        # own Producer score showed 10/10 — packets looked structurally fine at
        # the RTP layer; only the *decoder*, which relies on RTP timestamps to
        # reassemble/order frames, ever saw the corruption).
        # out_stream.time_base reads as None until ffmpeg finalizes it (observed
        # live: still None immediately after add_stream(template=vs), only
        # populated after the muxer processes its first packet) — guard against
        # it, since dividing by None crashed every single video packet mux
        # attempt on this camera the moment this code first ran. Skipping the
        # rescale for that one edge case is safe (matches the pre-fix
        # behavior); it only matters before out_stream.time_base is known.
        if out_stream.time_base is not None and packet.time_base != out_stream.time_base:
            if packet.pts is not None:
                packet.pts = int(packet.pts * packet.time_base / out_stream.time_base)
            if packet.dts is not None:
                packet.dts = int(packet.dts * packet.time_base / out_stream.time_base)
            packet.time_base = out_stream.time_base
        if packet.dts is not None:
            if last_dts is not None and packet.dts <= last_dts:
                packet.dts = last_dts + 1
                if packet.pts is not None and packet.pts < packet.dts:
                    packet.pts = packet.dts
            last_dts = packet.dts
        packet.stream = out_stream
        try:
            out.mux(packet)
        except av.AVError:
            pass  # Skip malformed packet; keep stream alive
        return last_dts

    def _ai_decode_worker(self, q: "queue.Queue", stop_evt: threading.Event,
                           codec_name: str, extradata):
        """
        Runs on its own thread with its own CodecContext — entirely isolated from
        the io thread's container/streams (no PyAV object is ever shared across
        threads; only immutable raw bytes cross the queue). Falling behind here
        only drops AI/JPEG frames; it can never delay video RTP delivery.
        """
        ctx = av.CodecContext.create(codec_name, "r")
        if extradata:
            ctx.extradata = extradata
        # Multi-threaded decode: large-frame encoders (e.g. TID-A800's 2560x1920
        # @30fps thermal/radiometric stream) could not keep single-threaded H.264
        # decode in real time. "AUTO" lets libav pick frame/slice threading, but
        # thread_count=0 auto-sizes to *available cores per CodecContext* — on a
        # 40-core box, 13 cameras' AI decode contexts could each spawn up to 40
        # native libav threads (520 in the worst case). These are real OS threads
        # created by libav's own threading, invisible to Python's threading
        # module/faulthandler, and were confirmed (2026-07-16, SIGUSR1 stack dump
        # showing only ~50 Python-visible threads against 400+ in /proc) to be
        # the actual source of the fleet-wide thread-count blowup that made the
        # daemon's HTTP server unresponsive — not GIL contention, not the
        # "stopper" cleanup threads. A fixed per-camera cap still gives large
        # frames real frame/slice-level parallelism without scaling with core
        # count fleet-wide (13 cameras × cap, not 13 × nproc).
        ctx.thread_type  = "AUTO"
        ctx.thread_count = _AI_DECODE_THREADS
        packet_counter = 0  # counts all packets handed to this worker, decoded or not
        while not stop_evt.is_set():
            try:
                raw = q.get(timeout=0.5)
            except queue.Empty:
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
                pkt = av.Packet(raw)
                for frame in ctx.decode(pkt):
                    if _should_push:
                        if self._ai_push_interval > 0:
                            self._ai_last_push = time.monotonic()
                        self._push_jpeg(frame)
                    break  # only first frame per packet needed
            except Exception as dec_err:
                log.debug("[%s] AI decode: %s", self.id[:8], dec_err)

    def _audio_transcode_worker(self, q: "queue.Queue", stop_evt: threading.Event, codec_name: str):
        """Own thread, own CodecContext/resampler/output muxer — isolated from the io thread."""
        ctx = av.CodecContext.create(codec_name, "r")
        out = av.open(
            f"rtp://127.0.0.1:{self.mediasoup_audio_port}",
            "w", format="rtp",
            options={"ssrc": str(_MEDIASOUP_AUDIO_SSRC), "payload_type": str(_MEDIASOUP_AUDIO_PT)},
        )
        try:
            out_as = out.add_stream("libopus", rate=48000)
            out_as.codec_context.channels = 2
            out_as.codec_context.layout   = "stereo"
            resampler = av.AudioResampler(format="s16", layout="stereo", rate=48000)
            log.info("[%s] Audio RTP transcode %s → opus → rtp://127.0.0.1:%d",
                     self.id[:8], codec_name, self.mediasoup_audio_port)

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

            while not stop_evt.is_set():
                try:
                    raw = q.get(timeout=0.5)
                except queue.Empty:
                    continue
                try:
                    pkt = av.Packet(raw)
                    for frame in ctx.decode(pkt):
                        for resampled in resampler.resample(frame):
                            for out_pkt in out_as.encode(resampled):
                                _mux_enc(out_pkt)
                except Exception as e:
                    log.debug("[%s] audio transcode: %s", self.id[:8], e)

            # Flush encoder on clean stop
            for frame in resampler.resample(None):
                for out_pkt in out_as.encode(frame):
                    _mux_enc(out_pkt)
            for out_pkt in out_as.encode(None):
                _mux_enc(out_pkt)
        finally:
            try:
                out.close()
            except Exception:
                pass

    def _submit_app_rtp(self, raw_bytes: bytes, pts):
        """Async POST of one App RTP (ONVIF metadata) packet — never blocks the io thread."""
        if not hasattr(self, "_app_rtp_seq"):
            self._app_rtp_seq = 0
            self._app_rtp_push_count = 0
        seq = self._app_rtp_seq
        self._app_rtp_seq += 1

        url = self.app_rtp_callback_url
        ctx = _SSL_CTX_NOVERIFY if url.startswith("https://") else None
        payload_b64 = base64.b64encode(raw_bytes).decode("ascii")
        body = json.dumps({
            "pt":        0,
            "timestamp": int(pts or 0),
            "seq":       seq,
            "payload":   payload_b64,
        }).encode("utf-8")

        def _post():
            try:
                req = Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
                urlopen(req, timeout=1, context=ctx)
                self._app_rtp_push_count += 1
                if self._app_rtp_push_count == 1 or self._app_rtp_push_count % 500 == 0:
                    log.debug("[%s] App RTP #%d: %dB payload",
                              self.id[:8], self._app_rtp_push_count, len(payload_b64))
            except Exception as e:
                log.debug("[%s] App RTP callback failed: %s", self.id[:8], e)

        _SHARED_PUSH_EXECUTOR.submit(_post)

    def _push_jpeg(self, frame: "av.VideoFrame"):
        """
        Capture raw pixel data from the decoded frame (cheap memcopy), then
        submit JPEG encoding + HTTP POST entirely to the thread pool so the
        decode loop is never blocked by slow encoding or network latency.

        Flow: decode thread captures ndarray → semaphore check → thread pool
              (encode JPEG → POST /api/internal/frame → release semaphore).
        Both the semaphore and the thread pool are shared daemon-wide
        (_SHARED_PUSH_SEMAPHORE / _SHARED_PUSH_EXECUTOR) — see their
        definitions for why this changed from one-per-camera.
        """
        if not hasattr(self, "_push_count"):
            self._push_count = 0
        self._push_count += 1
        count = self._push_count

        # Semaphore check happens in the decode thread — fast, no I/O.
        if not _SHARED_PUSH_SEMAPHORE.acquire(blocking=False):
            log.debug("[%s] AI busy — dropping frame #%d", self.id[:8], count)
            return

        # Capture raw pixels now (frame object may be recycled after this call
        # returns).  to_ndarray() is a fast C-level memcopy, not an encode.
        try:
            raw = frame.to_ndarray(format="rgb24")
            orig_w, orig_h = frame.width, frame.height
        except Exception as e:
            _SHARED_PUSH_SEMAPHORE.release()
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
                _SHARED_PUSH_SEMAPHORE.release()

        _SHARED_PUSH_EXECUTOR.submit(_encode_and_post)

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
            # Fire-and-forget: old.stop() can block up to _join_threads'
            # timeout (8s) waiting for the io thread's nested cleanup. With
            # ThreadingHTTPServer that only ever held up THIS request's own
            # thread — but during a churn burst (a flaky camera reconnecting
            # every ~30-60s) each blocked stop() still occupied a full request
            # thread for seconds, and requests can arrive faster than that
            # drains. Submitting to the bounded _SHARED_STOP_EXECUTOR lets the
            # HTTP response return immediately without spawning an unbounded
            # thread per churn event; the DB-of-truth (self._cameras) is
            # already updated by the time the caller sees "ok", so nothing
            # observes the old session as still-registered.
            _SHARED_STOP_EXECUTOR.submit(old.stop)
        sess = CameraSession(cfg)
        with self._lock:
            self._cameras[cid] = sess
        return True

    def remove(self, cid: str) -> bool:
        with self._lock:
            sess = self._cameras.pop(cid, None)
        if sess:
            _SHARED_STOP_EXECUTOR.submit(sess.stop)
            return True
        return False

    def count(self) -> int:
        with self._lock:
            return len(self._cameras)

    def get(self, cid: str):
        with self._lock:
            return self._cameras.get(cid)

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
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            # Client (usually Node, e.g. during its own shutdown) closed the
            # socket before we could write the response — harmless, the request
            # already did its job (e.g. do_DELETE already removed the camera).
            # http.server's default per-request exception handling already
            # keeps the daemon itself running when this isn't caught, but it
            # logs a full traceback for what is routine race noise during a
            # coordinated shutdown — not worth alarming about.
            log.debug("[%s] client disconnected before response was sent", self.path)

    def do_GET(self):
        p = urlparse(self.path).path
        if p == "/health":
            self._json(200, {"status": "ok", "cameras": _manager.count()})
        elif p == "/cameras":
            self._json(200, {"count": _manager.count()})
        else:
            parts = p.strip("/").split("/")
            if len(parts) == 3 and parts[0] == "cameras" and parts[2] == "video-params":
                sess = _manager.get(parts[1])
                if sess is None:
                    self._json(404, {"error": "camera not found"})
                elif sess.video_codec_name is None:
                    # RTSP not yet probed (mid-(re)connect) — caller should retry shortly.
                    self._json(202, {"ready": False})
                else:
                    self._json(200, {
                        "ready":               True,
                        "codec":               sess.video_codec_name,
                        "spropParameterSets":  sess.sprop_parameter_sets or "",
                        "profileLevelId":      sess.profile_level_id,
                    })
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

def _handle_sigterm(signum, frame):
    # Python installs no default SIGTERM handler — without this, SIGTERM (what
    # `npm run ingest:restart`/`stop` actually send, not SIGINT) kills the
    # process immediately with zero cleanup: no container.close(), no RTSP
    # TEARDOWN ever sent to any camera. Every restart was silently leaking an
    # open RTSP session per camera on the *camera's own* side. Confirmed live
    # (2026-07-16) that a handful of rapid restarts during debugging left
    # TID-A800 (which has known limited concurrent-session capacity — see
    # §6.7) refusing/hanging on all new connection attempts, which then
    # deadlocked the whole daemon via the setup semaphore (§6.10) never
    # getting its permits back. Re-raising as KeyboardInterrupt reuses the
    # exact same graceful-shutdown path main() already has for SIGINT/Ctrl-C.
    raise KeyboardInterrupt()


def main():
    global _manager

    signal.signal(signal.SIGTERM, _handle_sigterm)

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
    # ThreadingHTTPServer (2026-07-15): the plain single-threaded HTTPServer
    # processes one request at a time — a slow POST/DELETE (blocked inside
    # CameraSession.stop()'s thread join, see _join_threads) stalled every
    # other request, including /health, behind it. Under a burst of camera
    # registrations (e.g. all cameras re-registering at startup) this
    # serialized queue of slow requests was found to compound into a fully
    # unresponsive daemon (TCP connections not even accepted) with hundreds of
    # threads piled up. Each request now runs on its own thread so a slow
    # stop() for one camera no longer blocks any other camera's add/remove or
    # health checks.
    server = ThreadingHTTPServer((host, port), Handler)
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
