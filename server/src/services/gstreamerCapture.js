'use strict';

const { spawn, spawnSync } = require('child_process');
const { EventEmitter }     = require('events');

const JPEG_SOI = Buffer.from([0xff, 0xd8, 0xff]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

const RETRY_DELAY = 1000;

// Hardware acceleration preference order for auto-detect
// GSTREAMER_HW_ACCEL: auto | nvdec | vaapi | software
const HW_ACCEL_MODE = (process.env.GSTREAMER_HW_ACCEL || 'auto').toLowerCase();

// Detect available GStreamer hardware decoder once at startup
function _detectHwDecoder() {
  if (HW_ACCEL_MODE === 'software') return 'software';

  const candidates = HW_ACCEL_MODE === 'auto'
    ? ['nvdec', 'vaapi']
    : [HW_ACCEL_MODE];

  for (const plugin of candidates) {
    const r = spawnSync('gst-inspect-1.0', [plugin], { encoding: 'utf8' });
    if (r.status === 0) return plugin;
  }
  return 'software';
}

// Check gst-launch-1.0 is available
function _gstAvailable() {
  try {
    const r = spawnSync('gst-launch-1.0', ['--version'], { encoding: 'utf8' });
    return r.status === 0;
  } catch (_) {
    return false;
  }
}

const GST_AVAILABLE = _gstAvailable();
const HW_DECODER    = GST_AVAILABLE ? _detectHwDecoder() : 'software';

if (GST_AVAILABLE) {
  console.log(`[GStreamerCapture] GStreamer available — hw decoder: ${HW_DECODER}`);
} else {
  console.warn('[GStreamerCapture] gst-launch-1.0 not found');
}

/**
 * Captures JPEG frames from an RTSP stream using GStreamer.
 *
 * Pipeline (software):
 *   rtspsrc ! decodebin ! videorate ! videoscale ! videoconvert ! jpegenc ! fdsink
 *
 * Pipeline (nvdec):
 *   rtspsrc ! rtph264depay ! nvh264dec ! videorate ! videoscale ! videoconvert ! jpegenc ! fdsink
 *
 * Pipeline (vaapi):
 *   rtspsrc ! decodebin(vaapidecodebin) ! videorate ! videoscale ! vaapipostproc ! jpegenc ! fdsink
 *
 * Events: 'frame', 'started', 'reconnecting', 'stats', 'warn', 'error'
 */
class GStreamerCapture extends EventEmitter {
  constructor(cameraId, rtspUrl, opts = {}) {
    super();
    this.cameraId = cameraId;
    this.rtspUrl  = rtspUrl;
    this.fps      = opts.fps   || 10;
    this.width    = opts.width || 640;

    this._proc       = null;
    this._running    = false;
    this._frameBuf   = Buffer.alloc(0);
    this._frameCount = 0;
    this._retryCount = 0;
    this._retryTimer = null;
    this._connected  = false;
  }

  start() {
    if (this._running) return;
    if (!GST_AVAILABLE) {
      this.emit('error', new Error('gst-launch-1.0 not found. Install GStreamer to use gstreamer backend.'));
      return;
    }
    this._running    = true;
    this._retryCount = 0;
    this._connected  = false;
    this._spawn();
  }

  stop() {
    this._running = false;
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    this._kill();
    this._frameBuf = Buffer.alloc(0);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _buildArgs() {
    const rate    = `videorate max-rate=${this.fps}`;
    const scale   = `videoscale ! video/x-raw,width=${this.width}`;
    const convert = 'videoconvert';
    const encode  = 'jpegenc quality=85';
    const sink    = 'fdsink fd=1';

    // rtspsrc common options
    const src = `rtspsrc location="${this.rtspUrl}" protocols=tcp latency=200 drop-on-latency=true`;

    let pipeline;

    if (HW_DECODER === 'nvdec') {
      // NVIDIA — explicit h264/h265 path for deterministic hw decode
      pipeline = `${src} ! rtph264depay ! h264parse ! nvh264dec ! ${rate} ! ${scale} ! ${convert} ! ${encode} ! ${sink}`;
    } else if (HW_DECODER === 'vaapi') {
      // Intel/AMD VA-API — decodebin picks vaapidecodebin automatically when plugin present
      pipeline = `${src} ! decodebin ! ${rate} ! ${scale} ! vaapipostproc ! ${encode} ! ${sink}`;
    } else {
      // Software — decodebin auto-selects codec
      pipeline = `${src} ! decodebin ! ${rate} ! ${scale} ! ${convert} ! ${encode} ! ${sink}`;
    }

    // gst-launch-1.0 takes the pipeline as a single string parsed by it
    return ['-q', ...pipeline.split(' ')];
  }

  _spawn() {
    if (!this._running) return;

    const args    = this._buildArgs();
    const cmdline = `gst-launch-1.0 ${args.join(' ')}`;
    this.emit('started', { cameraId: this.cameraId, cmdline });

    const proc = spawn('gst-launch-1.0', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this._proc = proc;

    proc.stdout.on('data', (chunk) => this._onData(chunk));
    proc.stdout.on('error', () => {});

    let stderrTail = '';
    proc.stderr.on('data', (chunk) => {
      stderrTail += chunk.toString();
      const lines = stderrTail.split('\n');
      stderrTail  = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        if (/ERROR|error|WARN|warning|No such|Could not|Failed|Unauthorized|401/.test(t)) {
          this.emit('warn', { cameraId: this.cameraId, message: t });
        }
      }
    });

    proc.on('close', (code, signal) => {
      this._proc = null;
      if (!this._running) return;
      this.emit('warn', { cameraId: this.cameraId, message: `gst-launch-1.0 exited (code=${code} signal=${signal})` });
      this._scheduleRetry();
    });

    proc.on('error', (err) => {
      this._proc = null;
      if (!this._running) return;
      this.emit('warn', { cameraId: this.cameraId, message: `spawn error: ${err.message}` });
      if (err.code === 'ENOENT') {
        this._running = false;
        this.emit('error', new Error('gst-launch-1.0 not found. Install GStreamer to use gstreamer backend.'));
        return;
      }
      this._scheduleRetry();
    });
  }

  _kill() {
    if (this._proc) {
      try { this._proc.kill('SIGKILL'); } catch (_) {}
      this._proc = null;
    }
  }

  _onData(chunk) {
    if (!this._connected) {
      this._connected  = true;
      this._retryCount = 0;
    }
    this._frameBuf = Buffer.concat([this._frameBuf, chunk]);
    this._extractFrames();
  }

  _extractFrames() {
    while (true) {
      const soiIdx = this._indexOf(this._frameBuf, JPEG_SOI, 0);
      if (soiIdx === -1) {
        if (this._frameBuf.length > 2) this._frameBuf = this._frameBuf.slice(this._frameBuf.length - 2);
        break;
      }
      const eoiIdx = this._indexOf(this._frameBuf, JPEG_EOI, soiIdx + 2);
      if (eoiIdx === -1) break;

      const end   = eoiIdx + 2;
      const frame = Buffer.from(this._frameBuf.slice(soiIdx, end));
      this._frameBuf = this._frameBuf.slice(end);

      this._frameCount++;
      this.emit('frame', frame);
      if (this._frameCount % 100 === 0) {
        this.emit('stats', { cameraId: this.cameraId, frameCount: this._frameCount });
      }
    }
  }

  _indexOf(haystack, needle, offset) {
    const limit = haystack.length - needle.length;
    outer: for (let i = offset; i <= limit; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (haystack[i + j] !== needle[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  _scheduleRetry() {
    if (!this._running) return;
    this._retryCount++;
    this._connected = false;
    this.emit('reconnecting', { cameraId: this.cameraId, attempt: this._retryCount, delay: RETRY_DELAY });
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._frameBuf   = Buffer.alloc(0);
      this._spawn();
    }, RETRY_DELAY);
  }
}

module.exports = GStreamerCapture;
