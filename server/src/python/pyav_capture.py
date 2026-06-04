#!/usr/bin/env python3
"""
PyAV RTSP Capture Sidecar — LTS-2026
Invoked by pyavCapture.js as a child process.

Usage:
    python3 pyav_capture.py <rtsp_url> <fps> <width> <hw_accel>

hw_accel values: none | cuda | vaapi | videotoolbox
Output: continuous JPEG stream on stdout (same format as FFmpeg image2pipe / mjpeg).
Stderr: status/error lines that pyavCapture.js monitors for reconnection triggers.
"""

import sys
import io
import time
import traceback

try:
    import av
except ImportError:
    print('ERROR: PyAV not installed. Run: pip3 install av', file=sys.stderr, flush=True)
    sys.exit(1)

try:
    from PIL import Image
except ImportError:
    print('ERROR: Pillow not installed. Run: pip3 install Pillow', file=sys.stderr, flush=True)
    sys.exit(1)


def _open_container(rtsp_url: str, hw_accel: str) -> av.container.InputContainer:
    options = {
        'rtsp_transport': 'tcp',
        'fflags':         'nobuffer',
        'flags':          'low_delay',
        'analyzeduration': '1000000',
        'probesize':       '1000000',
    }
    container = av.open(rtsp_url, options=options)

    # Apply hardware acceleration to the first video stream codec context
    video_streams = [s for s in container.streams if s.type == 'video']
    if not video_streams:
        raise RuntimeError('No video stream found in RTSP source')

    if hw_accel != 'none':
        ctx = video_streams[0].codec_context
        try:
            ctx.options['hwaccel'] = hw_accel
        except Exception:
            pass  # hw_accel not supported by this codec context; fall back silently

    return container


def capture(rtsp_url: str, target_fps: int, target_width: int, hw_accel: str) -> None:
    min_frame_interval = 1.0 / max(target_fps, 1)
    last_emit_time     = 0.0

    print(f'[PyAV] Connecting: url={rtsp_url} fps={target_fps} width={target_width} hw={hw_accel}',
          file=sys.stderr, flush=True)

    container   = _open_container(rtsp_url, hw_accel)
    video_stream = next(s for s in container.streams if s.type == 'video')
    frame_count  = 0

    stdout = sys.stdout.buffer  # binary stdout

    for packet in container.demux(video_stream):
        for frame in packet.decode():
            now = time.monotonic()
            if now - last_emit_time < min_frame_interval * 0.9:
                continue  # rate-limit

            # Resize if needed (keep aspect ratio)
            if frame.width != target_width:
                new_height = max(1, int(frame.height * target_width / frame.width))
                # Ensure even dimensions (codec requirement)
                new_height = new_height + (new_height % 2)
                frame = frame.reformat(width=target_width, height=new_height)

            # Convert to JPEG bytes
            img = frame.to_image()
            buf = io.BytesIO()
            img.save(buf, format='JPEG', quality=85, optimize=False)
            jpeg_bytes = buf.getvalue()

            stdout.write(jpeg_bytes)
            stdout.flush()

            last_emit_time = now
            frame_count   += 1

            if frame_count % 100 == 0:
                print(f'[PyAV] frames={frame_count}', file=sys.stderr, flush=True)

    container.close()


def main() -> None:
    if len(sys.argv) < 2:
        print('Usage: pyav_capture.py <rtsp_url> [fps] [width] [hw_accel]', file=sys.stderr)
        sys.exit(1)

    rtsp_url    = sys.argv[1]
    target_fps  = int(sys.argv[2])   if len(sys.argv) > 2 else 10
    target_width = int(sys.argv[3])  if len(sys.argv) > 3 else 640
    hw_accel    = sys.argv[4].lower() if len(sys.argv) > 4 else 'none'

    try:
        capture(rtsp_url, target_fps, target_width, hw_accel)
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        print(f'ERROR: {exc}', file=sys.stderr, flush=True)
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
