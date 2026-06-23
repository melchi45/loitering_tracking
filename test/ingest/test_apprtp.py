"""
TC-APPRTP-001 ~ TC-APPRTP-010
Regression tests for ingest_daemon.py _app_rtp_ingest_once / _app_rtp_loop.

Regression (2026-06-23):
  Newer PyAV removed the writable `read_timeout` property on Container objects.
  Setting `inp.read_timeout = N` after `av.open()` raised:
    AttributeError: attribute 'read_timeout' of 'av.container.core.Container'
    objects is not writable
  This caused the App RTP loop to fail on every attempt, accumulating zombie
  RTSP sessions in MediaMTX until maxReaders (default 10) was exceeded, then
  producing "Server returned 400 Bad Request" on subsequent connect attempts.

Fix:
  Pass `{"timeout": str(int(APP_RTP_READ_TIMEOUT * 1_000_000))}` inside the
  `options` dict given to `av.open()` at open time — the FFmpeg "timeout"
  option maps to AVFormatContext.io_timeout and is thread-safe.

Run:
  cd /data6/youngho/workspace/loitering_tracking
  python -m pytest test/ingest/test_apprtp.py -v
"""

import base64
import importlib.util
import json
import sys
import threading
import time
from pathlib import Path
from unittest.mock import MagicMock, patch, call

import pytest

# ── Mock heavy dependencies before loading the module ────────────────────────

_av_mock = MagicMock()
_av_mock.logging.CRITICAL = 48

_pil_mock = MagicMock()
_pil_image_mock = MagicMock()
_pil_image_mock.BILINEAR = 1

sys.modules.setdefault("av", _av_mock)
sys.modules.setdefault("PIL", _pil_mock)
sys.modules.setdefault("PIL.Image", _pil_image_mock)

# ── Load ingest_daemon module ─────────────────────────────────────────────────

_DAEMON_PATH = Path(__file__).parent.parent.parent / "ingest-daemon" / "ingest_daemon.py"
_spec = importlib.util.spec_from_file_location("ingest_daemon", _DAEMON_PATH)
_daemon_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_daemon_mod)

CameraSession = _daemon_mod.CameraSession
APP_RTP_READ_TIMEOUT = _daemon_mod.APP_RTP_READ_TIMEOUT
_RTSP_OPTIONS = _daemon_mod._RTSP_OPTIONS


# ── Helpers ───────────────────────────────────────────────────────────────────

class _NoReadTimeoutContainer:
    """
    Simulates a newer PyAV Container where read_timeout is not a writable
    attribute — setting it raises AttributeError, reproducing the original bug.
    """
    def __init__(self, streams=None):
        object.__setattr__(self, "_streams", streams if streams is not None else [])
        object.__setattr__(self, "_closed", False)
        object.__setattr__(self, "_demux_iter", iter([]))

    @property
    def streams(self):
        return object.__getattribute__(self, "_streams")

    def demux(self, stream):
        return object.__getattribute__(self, "_demux_iter")

    def close(self):
        object.__setattr__(self, "_closed", True)

    @property
    def closed(self):
        return object.__getattribute__(self, "_closed")

    def __setattr__(self, name, value):
        if name == "read_timeout":
            raise AttributeError(
                "attribute 'read_timeout' of 'av.container.core.Container' "
                "objects is not writable"
            )
        object.__setattr__(self, name, value)


def _make_session(stop_threads=True):
    """
    Create a CameraSession without actually starting background threads.
    Threads are patched to no-ops so the test controls execution directly.
    """
    cfg = {
        "id": "test-0000-0000-0000",
        "rtspUrl": "rtsp://127.0.0.1:8554/test",
        "callbackUrl": "http://127.0.0.1:3080/api/internal/frame/test",
        "appRtpCallbackUrl": "http://127.0.0.1:3080/api/internal/apprtp/test",
    }
    if stop_threads:
        with patch("threading.Thread") as mock_thread:
            mock_thread.return_value = MagicMock()
            session = CameraSession(cfg)
    else:
        session = CameraSession(cfg)
    return session


def _make_mock_stream(type_="data"):
    stream = MagicMock()
    stream.type = type_
    stream.index = 2
    try:
        stream.codec_context.name = "unknown"
    except Exception:
        pass
    return stream


class _MockPacket:
    """Minimal RTP packet mock that supports bytes() conversion without breaking urllib."""
    def __init__(self, raw: bytes, pts: int = 0):
        self.pts = pts
        self.size = len(raw)
        self._raw = raw

    def __bytes__(self):
        return self._raw


# ── TC-APPRTP-001 / TC-APPRTP-002 ────────────────────────────────────────────

class TestAppRtpOptions:
    """FR-ONVIF-APPRTP-002: av.open() timeout option portability."""

    def test_timeout_in_av_open_options(self):
        """
        TC-APPRTP-001: av.open() must include 'timeout' in its options dict.
        Regression guard: ensures timeout is set at open time, not as an
        attribute after open (which fails in newer PyAV versions).
        """
        session = _make_session()
        container = _NoReadTimeoutContainer(streams=[])  # triggers RuntimeError

        with patch.object(_daemon_mod.av, "open", return_value=container) as mock_open:
            with pytest.raises(RuntimeError, match="No application stream"):
                session._app_rtp_ingest_once()

        mock_open.assert_called_once()
        _args, kwargs = mock_open.call_args
        options = kwargs.get("options", {})
        assert "timeout" in options, (
            "av.open() must include 'timeout' in options dict — "
            "setting inp.read_timeout after open fails in newer PyAV"
        )
        expected = str(int(APP_RTP_READ_TIMEOUT * 1_000_000))
        assert options["timeout"] == expected, (
            f"timeout value must be {expected} µs, got {options['timeout']!r}"
        )

    def test_no_read_timeout_attribute_set(self):
        """
        TC-APPRTP-002: Must not set inp.read_timeout as attribute after av.open().
        Uses a container that raises AttributeError on read_timeout assignment,
        simulating newer PyAV behaviour.
        """
        session = _make_session()
        container = _NoReadTimeoutContainer(streams=[])

        with patch.object(_daemon_mod.av, "open", return_value=container):
            try:
                session._app_rtp_ingest_once()
            except AttributeError as exc:
                pytest.fail(
                    f"Must not set read_timeout attribute after av.open(): {exc}"
                )
            except RuntimeError as exc:
                # "No application stream" is expected — acceptable
                assert "No application stream" in str(exc)
            except Exception:
                pass  # other exceptions not under test here

    def test_rtsp_options_merged(self):
        """
        _RTSP_OPTIONS keys (rtsp_transport, stimeout, etc.) must still be
        present alongside the 'timeout' key — not replaced by it.
        """
        session = _make_session()
        container = _NoReadTimeoutContainer(streams=[])

        with patch.object(_daemon_mod.av, "open", return_value=container) as mock_open:
            with pytest.raises(RuntimeError):
                session._app_rtp_ingest_once()

        _, kwargs = mock_open.call_args
        options = kwargs.get("options", {})
        for key in _RTSP_OPTIONS:
            assert key in options, f"_RTSP_OPTIONS key '{key}' missing from av.open() options"


# ── TC-APPRTP-003 ─────────────────────────────────────────────────────────────

class TestAppRtpCleanup:
    """FR-ONVIF-APPRTP-006: inp.close() must always be called."""

    def test_close_called_on_no_app_stream(self):
        """TC-APPRTP-003a: close() called even when RuntimeError raised."""
        session = _make_session()
        container = MagicMock()
        container.streams = []  # no app streams

        with patch.object(_daemon_mod.av, "open", return_value=container):
            with pytest.raises(RuntimeError, match="No application stream"):
                session._app_rtp_ingest_once()

        container.close.assert_called_once()

    def test_close_called_after_normal_demux(self):
        """TC-APPRTP-003b: close() called after successful demux exhaustion."""
        session = _make_session()
        container = MagicMock()
        container.streams = [_make_mock_stream("data")]
        container.demux.return_value = iter([])  # empty — loop exits immediately

        with patch.object(_daemon_mod.av, "open", return_value=container):
            with patch("urllib.request.urlopen"):
                session._app_rtp_ingest_once()

        container.close.assert_called_once()

    def test_close_called_on_unexpected_exception(self):
        """TC-APPRTP-003c: close() called even when demux raises unexpectedly."""
        session = _make_session()
        container = MagicMock()
        container.streams = [_make_mock_stream("data")]
        container.demux.side_effect = RuntimeError("unexpected demux failure")

        with patch.object(_daemon_mod.av, "open", return_value=container):
            with pytest.raises(RuntimeError, match="unexpected demux failure"):
                session._app_rtp_ingest_once()

        container.close.assert_called_once()


# ── TC-APPRTP-004 ─────────────────────────────────────────────────────────────

class TestAppRtpLoop:
    """FR-ONVIF-APPRTP-003 / 005: loop exit behaviour."""

    def test_no_app_stream_exits_quietly(self):
        """
        TC-APPRTP-004: When streams contain only video/audio tracks, the loop
        must exit without retrying (RuntimeError("No application stream")).
        """
        session = _make_session()
        call_count = [0]

        def fake_ingest_once():
            call_count[0] += 1
            raise RuntimeError("No application stream")

        session._app_rtp_ingest_once = fake_ingest_once
        session._stop.clear()

        thread = threading.Thread(target=session._app_rtp_loop, daemon=True)
        thread.start()
        thread.join(timeout=2.0)

        assert not thread.is_alive(), "_app_rtp_loop thread did not exit"
        assert call_count[0] == 1, (
            f"Loop must not retry after 'No application stream' — called {call_count[0]} times"
        )

    def test_retry_backoff(self):
        """
        TC-APPRTP-005: retry_delay grows from 0.5 → max 5.0 with factor 1.5.
        Uses a patched _stop.wait() to capture delay values without real sleeping.
        """
        session = _make_session()
        session._stop.clear()

        delays_seen = []
        call_count = [0]
        MAX_CALLS = 4

        def fake_ingest_once():
            call_count[0] += 1
            if call_count[0] >= MAX_CALLS:
                session._stop.set()
            raise ConnectionError("simulated connect failure")

        def fake_wait(timeout=None):
            if timeout is not None:
                delays_seen.append(timeout)
            return session._stop.is_set()

        session._app_rtp_ingest_once = fake_ingest_once
        session._stop.wait = fake_wait

        thread = threading.Thread(target=session._app_rtp_loop, daemon=True)
        thread.start()
        thread.join(timeout=3.0)

        assert len(delays_seen) >= 3, f"Expected ≥3 retry delays, got {delays_seen}"
        assert delays_seen[0] == pytest.approx(0.5, abs=0.01)
        assert delays_seen[1] == pytest.approx(0.75, abs=0.01)
        assert delays_seen[2] == pytest.approx(1.125, abs=0.01)
        assert all(d <= 5.0 for d in delays_seen), f"Delay exceeded 5.0s: {delays_seen}"

    def test_stop_exits_within_timeout(self):
        """
        TC-APPRTP-010: After _signal_stop(), apprtp thread must exit within 3s.
        Uses _make_session() so background threads are suppressed; only the
        apprtp loop is started manually to test stop behaviour in isolation.
        """
        session = _make_session()

        def blocking_ingest_once():
            # Simulates a long-blocking demux call — waits on the stop event
            session._stop.wait(timeout=30)

        session._app_rtp_ingest_once = blocking_ingest_once

        apprtp_thread = threading.Thread(
            target=session._app_rtp_loop, daemon=True, name="apprtp-test"
        )
        apprtp_thread.start()
        time.sleep(0.05)
        session._signal_stop()
        apprtp_thread.join(timeout=3.0)
        assert not apprtp_thread.is_alive(), (
            "apprtp thread must exit within 3s after _signal_stop()"
        )


# ── TC-APPRTP-006 ─────────────────────────────────────────────────────────────

class TestAppRtpPayload:
    """FR-ONVIF-APPRTP-008: POST body format."""

    def test_post_body_format(self):
        """
        TC-APPRTP-006: Sent POST body must have pt/timestamp/seq/payload fields.
        payload must be valid base64.  Uses _MockPacket to avoid patching
        builtins.bytes (which would break urllib's isinstance checks).
        """
        session = _make_session()

        raw_bytes = b"\x80\x60\x00\x01\x00\x00\x00\x00\xde\xad\xbe\xef"
        mock_pkt = _MockPacket(raw_bytes, pts=12345)

        stream = _make_mock_stream("data")
        container = MagicMock()
        container.streams = [stream]
        container.demux.return_value = iter([mock_pkt])

        posted_bodies = []

        def fake_urlopen(req, timeout=None, context=None):
            posted_bodies.append(json.loads(req.data.decode("utf-8")))
            return MagicMock()

        # Patch urlopen in the daemon module's own namespace (imported via
        # "from urllib.request import urlopen"), not the urllib.request module.
        with patch.object(_daemon_mod.av, "open", return_value=container), \
             patch.object(_daemon_mod, "urlopen", side_effect=fake_urlopen):
            session._app_rtp_ingest_once()

        assert len(posted_bodies) == 1
        body = posted_bodies[0]
        assert "pt" in body
        assert "timestamp" in body
        assert "seq" in body
        assert "payload" in body
        assert body["seq"] == 0
        assert isinstance(body["payload"], str)
        # Must be valid base64
        base64.b64decode(body["payload"])

    def test_seq_monotonically_increasing(self):
        """seq values in consecutive packets must be 0, 1, 2, ..."""
        session = _make_session()

        n_packets = 5
        raw_bytes = b"\x00" * 8

        stream = _make_mock_stream("data")
        container = MagicMock()
        container.streams = [stream]
        container.demux.return_value = iter([
            _MockPacket(raw_bytes, pts=i * 3000) for i in range(n_packets)
        ])

        posted_bodies = []

        def fake_urlopen(req, **kw):
            posted_bodies.append(json.loads(req.data.decode("utf-8")))
            return MagicMock()

        with patch.object(_daemon_mod.av, "open", return_value=container), \
             patch.object(_daemon_mod, "urlopen", side_effect=fake_urlopen):
            session._app_rtp_ingest_once()

        seqs = [b["seq"] for b in posted_bodies]
        assert seqs == list(range(n_packets)), f"seq values not monotonic: {seqs}"
