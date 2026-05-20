'use strict';

const { spawn }        = require('child_process');
const { EventEmitter } = require('events');
const webrtcGateway    = require('./webrtcGateway');

const JPEG_SOI = Buffer.from([0xff, 0xd8, 0xff]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

// H264 payload type 96, Opus payload type 111 (forced via FFmpeg -payload_type)
const PT_H264 = 96;
const PT_OPUS = 111;

// SSRC values must fit in signed int32 (FFmpeg 3.x limitation: max 2147483647)
const SSRC_VIDEO = 1111;
const SSRC_AUDIO = 2222;

/**
 * Dual-output FFmpeg capture:
 *   Output 1 → H264 RTP → mediasoup PlainTransport (video)
 *   Output 2 → Opus RTP → mediasoup PlainTransport (audio, optional)
 *   Output 3 → JPEG image2pipe → stdout (AI inference, same as RTSPCapture)
 *
 * Events: 'frame' (jpegBuffer), 'started', 'warn', 'reconnecting', 'error'
 */
class RtpIngestion extends EventEmitter {
  constructor(cameraId, rtspUrl, opts = {}) {
    super();
    this.cameraId = cameraId;
    this.rtspUrl  = rtspUrl;
    this.fps      = opts.fps   || 10;
    this.width    = opts.width || 640;

    this._proc           = null;
    this._running        = false;
    this._frameBuf       = Buffer.alloc(0);
    this._retryTimer     = null;
    this._retryCount     = 0;

    this._videoTransport = null;
    this._audioTransport = null;
    this._videoProducer  = null;
    this._audioProducer  = null;
    this._videoPort      = 0;
    this._audioPort      = 0;
  }

  /** Async start: sets up mediasoup then spawns FFmpeg. */
  async start() {
    if (this._running) return;
    this._running = true;
    this._retryCount = 0;

    await this._setupMediasoup();
    this._spawn();
  }

  /** Stop FFmpeg and close mediasoup transports. */
  stop() {
    this._running = false;
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    this._kill();
    this._closeMediasoup();
    this._frameBuf = Buffer.alloc(0);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  async _setupMediasoup() {
    const router = await webrtcGateway.getOrCreateRouter(this.cameraId);

    // Video PlainTransport — comedia=true: mediasoup learns FFmpeg address from first packet
    this._videoTransport = await router.createPlainTransport({
      listenIp: { ip: '127.0.0.1' },
      rtcpMux:  false,
      comedia:  true,
    });
    this._videoPort = this._videoTransport.tuple.localPort;

    this._videoProducer = await this._videoTransport.produce({
      kind: 'video',
      rtpParameters: {
        codecs: [{
          mimeType:    'video/H264',
          payloadType: PT_H264,
          clockRate:   90000,
          parameters:  { 'packetization-mode': 1, 'profile-level-id': '42e01f' },
        }],
        encodings: [{ ssrc: SSRC_VIDEO }],
      },
    });

    // Audio PlainTransport
    this._audioTransport = await router.createPlainTransport({
      listenIp: { ip: '127.0.0.1' },
      rtcpMux:  false,
      comedia:  true,
    });
    this._audioPort = this._audioTransport.tuple.localPort;

    this._audioProducer = await this._audioTransport.produce({
      kind: 'audio',
      rtpParameters: {
        codecs: [{
          mimeType:    'audio/opus',
          payloadType: PT_OPUS,
          clockRate:   48000,
          channels:    2,
        }],
        encodings: [{ ssrc: SSRC_AUDIO }],
      },
    });

    webrtcGateway.registerProducers(this.cameraId, this._videoProducer, this._audioProducer);
    console.log(`[RtpIngestion][${this.cameraId}] PlainTransports ready — video:${this._videoPort} audio:${this._audioPort}`);
  }

  _closeMediasoup() {
    webrtcGateway.unregisterProducers(this.cameraId);
    for (const p of [this._videoProducer, this._audioProducer]) {
      if (p && !p.closed) p.close();
    }
    for (const t of [this._videoTransport, this._audioTransport]) {
      if (t && !t.closed) t.close();
    }
    this._videoProducer = this._audioProducer = null;
    this._videoTransport = this._audioTransport = null;
  }

  _buildArgs() {
    return [
      // Input
      '-rtsp_transport', 'tcp',
      // Replace camera-supplied timestamps with wall-clock reception time.
      // Cameras that output non-monotonous DTS (e.g. TID-A800) would otherwise
      // produce backward RTP timestamps that stall the browser's jitter buffer.
      '-use_wallclock_as_timestamps', '1',
      '-stimeout',        '5000000',
      '-analyzeduration', '1000000',
      '-probesize',       '1000000',
      '-i',               this.rtspUrl,

      // Output 1: H264 video → mediasoup PlainTransport
      '-map', '0:v:0',
      '-c:v', 'copy',
      '-payload_type', String(PT_H264),
      '-ssrc', String(SSRC_VIDEO),
      '-f', 'rtp',
      `rtp://127.0.0.1:${this._videoPort}`,

      // Output 2: Opus audio → mediasoup PlainTransport (optional — skipped when no audio)
      '-map', '0:a?',
      '-c:a', 'libopus', '-b:a', '32k', '-vbr', 'on', '-application', 'voip',
      '-payload_type', String(PT_OPUS),
      '-ssrc', String(SSRC_AUDIO),
      '-f', 'rtp',
      `rtp://127.0.0.1:${this._audioPort}`,

      // Output 3: JPEG pipe → AI inference (stdout)
      '-map', '0:v:0',
      '-vf',  `fps=${this.fps},scale=${this.width}:-2`,
      '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '5',
      'pipe:1',
    ];
  }

  _spawn() {
    if (!this._running) return;

    const args    = this._buildArgs();
    const cmdline = `ffmpeg ${args.join(' ')}`;
    this.emit('started', { cameraId: this.cameraId, cmdline });

    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
        if (/frame=|fps=|Error|error|No such|Connection refused|Authentication|401/.test(t)) {
          this.emit('warn', { cameraId: this.cameraId, message: t });
        }
      }
    });

    proc.on('close', (code, signal) => {
      this._proc = null;
      if (!this._running) return;
      this._retryCount++;
      this.emit('reconnecting', { cameraId: this.cameraId, attempt: this._retryCount });
      this.emit('warn', { cameraId: this.cameraId, message: `ffmpeg exited (code=${code} signal=${signal}) — retry #${this._retryCount}` });
      // Exponential backoff: 1s, 2s, 4s, 8s, 16s … capped at 30 s
      const delay = Math.min(1000 * Math.pow(2, this._retryCount - 1), 30_000);
      this._retryTimer = setTimeout(() => this._spawn(), delay);
    });
  }

  _kill() {
    if (this._proc) {
      try { this._proc.kill('SIGKILL'); } catch (_) {}
      this._proc = null;
    }
  }

  _onData(chunk) {
    this._frameBuf = Buffer.concat([this._frameBuf, chunk]);
    let start = 0;
    while (true) {
      const soi = this._frameBuf.indexOf(JPEG_SOI, start);
      if (soi < 0) { this._frameBuf = Buffer.alloc(0); break; }
      const eoi = this._frameBuf.indexOf(JPEG_EOI, soi + 3);
      if (eoi < 0) { this._frameBuf = this._frameBuf.slice(soi); break; }
      this.emit('frame', this._frameBuf.slice(soi, eoi + 2));
      start = eoi + 2;
    }
    if (start > 0 && start < this._frameBuf.length) {
      this._frameBuf = this._frameBuf.slice(start);
    } else if (start >= this._frameBuf.length) {
      this._frameBuf = Buffer.alloc(0);
    }
  }
}

module.exports = RtpIngestion;
