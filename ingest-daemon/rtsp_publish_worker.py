#!/usr/bin/env python3
"""
Standalone RTSP-publish writer subprocess (2026-07-24).

Runs the actual av.open()/add_stream()/mux() calls to a local MediaMTX
RTSP-publish target in a fully separate OS process, with its own GIL —
see ingest_daemon.py's _rtsp_publish_writer() docstring for why this had
to move out of ingest_daemon.py's own process entirely: PyAV's RTSP/TCP
mux() does not release the GIL for the duration of its blocking network
write (confirmed empirically, 2026-07-24 — a pure-Python spin-counter
thread in the same process stalled completely for the whole duration of
a single mux() call to a non-draining socket), so no amount of Python
*threading* inside ingest_daemon.py could ever stop a slow/backed-up
publish from starving that camera's own RTSP read loop (and therefore
every other consumer of it — WebRTC included) of GIL time.

Wire protocol (stdin, written by ingest_daemon.py's _rtsp_publish_writer
thread — see there): repeated frames of
    [4 bytes big-endian length N][N bytes: 8s pts][8s dts]
    [4s time_base numerator][4s time_base denominator][payload...]
using struct format "!qqii" for the 24-byte header preceding payload.
EOF on stdin (parent closed the pipe) is the sole shutdown signal —
finishes any in-flight mux() and exits.

Invocation: rtsp_publish_worker.py <pub_url> <codec_name> <width> <height>
            <pix_fmt> <extradata_b64_or_->
"""
import base64
import os
import struct
import sys
from fractions import Fraction

import av

_HEADER = struct.Struct("!qqii")  # pts(8) dts(8) tb_num(4) tb_den(4)
# Same env var/default as ingest_daemon.py's RTSP_READ_TIMEOUT — bounds the
# ANNOUNCE handshake so a hung/unresponsive MediaMTX leaves an orphaned
# subprocess for at most this long instead of forever (this process no
# longer risks blocking ingest_daemon.py itself, but should still not leak).
_RTSP_STIMEOUT_SEC = float(os.environ.get("RTSP_READ_TIMEOUT", "5"))


def main() -> int:
    if len(sys.argv) != 7:
        print(f"usage: {sys.argv[0]} <pub_url> <codec_name> <width> <height> <pix_fmt> <extradata_b64_or_->",
              file=sys.stderr)
        return 2
    pub_url, codec_name, width_s, height_s, pix_fmt, extradata_b64 = sys.argv[1:]
    width, height = int(width_s), int(height_s)
    extradata = None if extradata_b64 == "-" else base64.b64decode(extradata_b64)

    try:
        out = av.open(
            pub_url, "w", format="rtsp",
            options={"rtsp_transport": "tcp", "stimeout": str(int(_RTSP_STIMEOUT_SEC * 1_000_000))},
        )
        stream = out.add_stream(codec_name, rate=30)
        stream.width, stream.height, stream.pix_fmt = width, height, pix_fmt
        # NOTE: deliberately NOT setting stream.codec_context.extradata here —
        # PyAV raises "Can only set extradata for decoders" for an add_stream()
        # (encoder-side) context (confirmed live, 2026-07-24), unlike
        # add_stream(template=vs) which apparently sidesteps this internally.
        # Relies entirely on ingest_daemon.py's existing in-band parameter-set
        # injection instead (_build_param_set_prefix() / the needsKeyframe gate
        # in the packet fan-out loop) — the same mechanism the UDP RTP fan-outs
        # already use, sent through this worker's normal packet stream as a
        # synthetic SPS/PPS packet ahead of the first keyframe.
    except Exception as e:
        print(f"[rtsp_publish_worker] open/add_stream failed: {e!r}", file=sys.stderr, flush=True)
        return 1

    stdin = sys.stdin.buffer
    last_dts = None
    try:
        while True:
            header = stdin.read(_HEADER.size)
            if len(header) < _HEADER.size:
                break  # EOF — parent closed the pipe, shut down cleanly
            pts, dts, tb_num, tb_den = _HEADER.unpack(header)
            len_bytes = stdin.read(4)
            if len(len_bytes) < 4:
                break
            (n,) = struct.unpack("!I", len_bytes)
            payload = stdin.read(n)
            if len(payload) < n:
                break

            packet = av.Packet(payload)
            packet.pts, packet.dts = pts, dts
            packet.time_base = Fraction(tb_num, tb_den) if tb_num and tb_den else stream.time_base
            if stream.time_base is not None and packet.time_base != stream.time_base:
                packet.pts = int(packet.pts * packet.time_base / stream.time_base)
                packet.dts = int(packet.dts * packet.time_base / stream.time_base)
                packet.time_base = stream.time_base
            if packet.dts is not None:
                if last_dts is not None and packet.dts <= last_dts:
                    packet.dts = last_dts + 1
                    if packet.pts is not None and packet.pts < packet.dts:
                        packet.pts = packet.dts
                last_dts = packet.dts
            packet.stream = stream
            try:
                out.mux(packet)
            except av.AVError:
                pass  # skip malformed/rejected packet, keep the stream alive
    finally:
        try:
            out.close()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
