'use strict';

/**
 * YouTubeStreamService — LTS-2026-004
 *
 * Manages the lifecycle of YouTube → yt-dlp → FFmpeg → MediaMTX RTSP virtual
 * camera channels.  Each active stream is tracked in an in-memory Map; the
 * corresponding camera record is persisted in the LTS JSON database so that
 * pipelineManager can consume it like any physical RTSP camera.
 *
 * State machine per stream:
 *   starting → live → restarting → error
 *                ↓
 *            stopping → removed
 */

const { spawn }  = require('child_process');
const { v4: uuidv4 } = require('uuid');

// ── YouTube URL validation regex ─────────────────────────────────────────────
const YOUTUBE_URL_REGEX =
  /^https?:\/\/(www\.)?(youtube\.com\/watch\?[^\s]*v=|youtu\.be\/|youtube\.com\/shorts\/)[A-Za-z0-9_\-]{11}/;

// ── Resolution → max pixel height ────────────────────────────────────────────
const RESOLUTION_MAP = { '1080p': 1080, '720p': 720, '480p': 480 };

// ── Environment-controlled tunables ──────────────────────────────────────────
const MEDIAMTX_HOST   = process.env.MEDIAMTX_HOST      || '127.0.0.1';
const MEDIAMTX_PORT   = parseInt(process.env.MEDIAMTX_PORT || '8554', 10);
const MEDIAMTX_API    = process.env.MEDIAMTX_API_URL    || 'http://127.0.0.1:9997';
const MAX_STREAMS     = parseInt(process.env.YOUTUBE_MAX_STREAMS || '4', 10);
const MAX_RESTARTS    = parseInt(process.env.YOUTUBE_MAX_RESTARTS || '5', 10);
const RESTART_DELAY   = parseInt(process.env.YOUTUBE_RESTART_DELAY_MS || '5000', 10);
const START_TIMEOUT   = parseInt(process.env.YOUTUBE_START_TIMEOUT_MS || '30000', 10);
const FFMPEG_BIN      = process.env.FFMPEG_BIN  || 'ffmpeg';
// Bypass SSL certificate verification (corporate networks with self-signed certs)
const YTDLP_NO_CHECK_CERT = process.env.YTDLP_NO_CHECK_CERT !== 'false';
// Remote EJS challenge-solver components (ejs:github or ejs:npm). Set to '' to disable.
const YTDLP_REMOTE_COMPONENTS = process.env.YTDLP_REMOTE_COMPONENTS !== undefined
  ? process.env.YTDLP_REMOTE_COMPONENTS
  : 'ejs:github';

// yt-dlp binary path — detected in order: env var > known paths > PATH
const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');

// Detect real node binary for yt-dlp JS runtime (excluding symlinks/wrappers)
function findNodeBin() {
  if (process.env.YTDLP_NODE_BIN) return process.env.YTDLP_NODE_BIN;
  const candidates = [
    '/usr/local/lib/nodejs/node-22/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
    '/usr/bin/nodejs',
  ];
  for (const p of candidates) {
    try {
      const ver = execFileSync(p, ['--version'], { stdio: 'pipe', timeout: 3000 }).toString().trim();
      if (ver.startsWith('v')) return p;
    } catch { /* try next */ }
  }
  return null;  // fallback: rely on ~/.config/yt-dlp/config
}
const NODE_BIN_FOR_YTDLP = findNodeBin();
console.log(`[YouTubeStream] Node bin for yt-dlp JS runtime: ${NODE_BIN_FOR_YTDLP || '(not found, using config file)'}`);

function findYtDlp() {
  if (process.env.YTDLP_BIN) return process.env.YTDLP_BIN;
  const candidates = [
    '/home/' + (process.env.USER || require('os').userInfo().username) + '/.local/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    'yt-dlp',
  ];
  for (const p of candidates) {
    try { execFileSync(p, ['--version'], { stdio: 'pipe', timeout: 3000 }); return p; } catch { /* try next */ }
  }
  return 'yt-dlp';  // fallback to PATH
}
const YTDLP_BIN = findYtDlp();
console.log(`[YouTubeStream] yt-dlp binary: ${YTDLP_BIN}`);
console.log(`[YouTubeStream] SSL check: ${YTDLP_NO_CHECK_CERT ? 'disabled (--no-check-certificate)' : 'enabled'}`);

// ── URL-expiry refresh: if FFmpeg stderr contains HTTP 403 re-resolve ─────────
const HTTP_403_RE = /Server returned 4XX Client Error reply to.*403|403 Forbidden/i;
// Detect successful RTSP publish start in FFmpeg output
// frame= / size= lines mean ffmpeg is actually encoding → more reliable than Output #0
const RTSP_LIVE_RE = /Output #0[^\n]*rtsp|frame=\s*[1-9]|size=\s*\d+kB/i;
// Detect stream being actively pushed (in case Output #0 line is split across chunks)
const RTSP_OUTPUT_RE = RTSP_LIVE_RE;  // kept for compatibility
// Detect URL expiry on ytdlp side
const URL_EXPIRED_RE = /HTTP Error 403|Sign in to confirm|age.*restricted/i;

class YouTubeStreamService {
  /**
   * @param {import('../db').db} db
   * @param {object} pipelineManager  — PipelineManager instance
   */
  constructor(db, pipelineManager) {
    this.db              = db;
    this.pipelineManager = pipelineManager;
    /** @type {Map<string, StreamEntry>} */
    this.streams         = new Map();
  }

  // ── Initialisation ──────────────────────────────────────────────────────────

  /**
   * Restore YouTube camera records from the DB into the in-memory streams Map.
   * Called once on server startup so that existing cameras can be edited /
   * restarted without needing to re-create them.
   */
  init() {
    const rows = this.db.find('cameras', { type: 'youtube' });
    for (const cam of rows) {
      if (this.streams.has(cam.id)) continue;
      const entry = {
        id:             cam.id,
        name:           cam.name,
        youtubeUrl:     cam.youtubeUrl || '',
        rtspUrl:        cam.rtspUrl    || `rtsp://${MEDIAMTX_HOST}:${MEDIAMTX_PORT}/yt/${cam.id}`,
        resolution:     cam.resolution || '1080p',
        // DB stores bps; in-memory entry uses kbps (same as createStream)
        bitrate:        cam.bitrate ? Math.round(cam.bitrate / 1000) : 2000,
        maxHeight:      RESOLUTION_MAP[cam.resolution] || 1080,
        status:         'offline',
        restartCount:   0,
        repeatPlayback: !!cam.repeatPlayback,
        createdAt:      cam.createdAt || new Date().toISOString(),
        ffmpegProcess:  null,
        ytdlpProcess:   null,
        restartTimer:   null,
        startTimer:     null,
        liveResolve:    null,
        liveReject:     null,
      };
      this.streams.set(cam.id, entry);
      // Sync status to offline in DB (processes are gone after restart)
      this.db.update('cameras', cam.id, { status: 'offline' });
      console.log(`[YouTubeStream] Restored stream ${cam.id} (${cam.name}) from DB`);
    }
    if (rows.length) {
      console.log(`[YouTubeStream] Restored ${rows.length} stream(s) from DB`);
      // Auto-start restored streams after a brief delay to let other services init
      setTimeout(() => {
        for (const cam of rows) {
          const entry = this.streams.get(cam.id);
          if (entry && entry.status === 'offline') {
            console.log(`[YouTubeStream] Auto-starting restored stream ${cam.id}`);
            this._startStream(entry).catch((err) => {
              console.error(`[YouTubeStream] Auto-start failed for ${cam.id}:`, err.message);
            });
          }
        }
      }, 2000);
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Create a new YouTube virtual camera channel.
   * Resolves the direct stream URL, spawns FFmpeg, and registers a camera record.
   *
   * @param {{ youtubeUrl: string, name: string, resolution?: string, bitrate?: number }} opts
   * @returns {Promise<object>} camera record
   */
  async createStream({ youtubeUrl, name, resolution = '1080p', bitrate = 2000, repeatPlayback = false }) {
    // Validate URL
    if (!YOUTUBE_URL_REGEX.test(youtubeUrl)) {
      const err = new Error('INVALID_YOUTUBE_URL');
      err.code  = 'INVALID_YOUTUBE_URL';
      throw err;
    }

    // Enforce stream limit
    const activeCount = Array.from(this.streams.values())
      .filter(s => s.status !== 'removed').length;
    if (activeCount >= MAX_STREAMS) {
      const err = new Error(`MAX_STREAMS_REACHED: limit is ${MAX_STREAMS}`);
      err.code  = 'MAX_STREAMS_REACHED';
      throw err;
    }

    const id       = `yt-${uuidv4().split('-')[0]}`;
    const maxHeight = RESOLUTION_MAP[resolution] || 1080;
    const rtspUrl  = `rtsp://${MEDIAMTX_HOST}:${MEDIAMTX_PORT}/yt/${id}`;

    /** @type {StreamEntry} */
    const entry = {
      id,
      name,
      youtubeUrl,
      rtspUrl,
      resolution,
      bitrate,
      maxHeight,
      status:         'starting',
      restartCount:   0,
      repeatPlayback: !!repeatPlayback,
      createdAt:      new Date().toISOString(),
      ffmpegProcess:  null,
      restartTimer:   null,
      startTimer:     null,
      liveResolve:    null,  // resolve() callback for startup promise
      liveReject:     null,  // reject() callback for startup promise
    };

    this.streams.set(id, entry);

    // Persist camera record so the pipeline manager can start consuming it
    this.db.insert('cameras', {
      id,
      name,
      rtspUrl,
      type:          'youtube',
      youtubeUrl,
      resolution,
      bitrate:       bitrate * 1000, // store as bps
      repeatPlayback: !!repeatPlayback,
      status:        'offline',
    });

    console.log(`[YouTubeStream] Creating stream ${id}: ${youtubeUrl}`);

    // Start the stream asynchronously, wait for 'live' confirmation
    try {
      await this._startStream(entry);
    } catch (err) {
      // Clean up camera record if startup failed
      this._cleanupRecord(entry);
      throw err;
    }

    return this._toPublic(entry);
  }

  /**
   * Stop and remove a YouTube stream by ID.
   * @param {string} id
   */
  async stopStream(id) {
    const entry = this.streams.get(id);
    if (!entry) {
      const err = new Error(`Stream ${id} not found`);
      err.code  = 'NOT_FOUND';
      throw err;
    }
    await this._stopEntry(entry, true);
    this.streams.delete(id);
  }

  /**
   * Manually restart a stream that is in 'error' state.
   * Resets the restart counter and re-spawns yt-dlp → FFmpeg.
   * @param {string} id
   */
  async restartStream(id) {
    const entry = this.streams.get(id);
    if (!entry) {
      const err = new Error(`Stream ${id} not found`);
      err.code  = 'NOT_FOUND';
      throw err;
    }
    if (entry.status === 'stopping' || entry.status === 'removed') {
      const err = new Error('Stream has been stopped and removed');
      err.code  = 'STREAM_STOPPED';
      throw err;
    }
    // Stop any lingering processes without removing the DB record
    await this._stopEntry(entry, false);
    entry.restartCount = 0;
    entry.status       = 'starting';
    this.db.update('cameras', id, { status: 'starting' });
    // Fire-and-forget — caller receives 'starting' state immediately
    this._startStream(entry).catch((err) => {
      console.error(`[YouTubeStream] Manual restart failed for ${id}:`, err.message);
      entry.status = 'error';
      this.db.update('cameras', id, { status: 'error' });
    });
    return this._toPublic(entry);
  }

  /**
   * Update stream name, URL, resolution, or bitrate.
   * URL / resolution / bitrate changes trigger an async stream restart.
   * @param {string} id
   * @param {{ youtubeUrl?: string, name?: string, resolution?: string, bitrate?: number }} updates
   */
  async updateStream(id, updates) {
    const entry = this.streams.get(id);
    if (!entry) {
      const err = new Error(`Stream ${id} not found`);
      err.code  = 'NOT_FOUND';
      throw err;
    }

    if (updates.name) {
      entry.name = updates.name;
      this.db.update('cameras', id, { name: updates.name });
    }

    let needRestart = false;

    if (updates.youtubeUrl) {
      if (!YOUTUBE_URL_REGEX.test(updates.youtubeUrl)) {
        const err = new Error('INVALID_YOUTUBE_URL');
        err.code  = 'INVALID_YOUTUBE_URL';
        throw err;
      }
      entry.youtubeUrl = updates.youtubeUrl;
      this.db.update('cameras', id, { youtubeUrl: updates.youtubeUrl });
      needRestart = true;
    }

    if (updates.resolution && RESOLUTION_MAP[updates.resolution]) {
      entry.resolution = updates.resolution;
      entry.maxHeight  = RESOLUTION_MAP[updates.resolution];
      this.db.update('cameras', id, { resolution: updates.resolution });
      needRestart = true;
    }

    if (updates.bitrate) {
      const b = parseInt(updates.bitrate, 10);
      if (!isNaN(b) && b >= 100 && b <= 20000) {
        entry.bitrate = b;
        this.db.update('cameras', id, { bitrate: b * 1000 });
        needRestart = true;
      }
    }

    if (updates.repeatPlayback !== undefined) {
      entry.repeatPlayback = !!updates.repeatPlayback;
      this.db.update('cameras', id, { repeatPlayback: !!updates.repeatPlayback });
    }

    if (needRestart) {
      // Restart asynchronously so the API response returns immediately
      this._stopEntry(entry, false).then(async () => {
        entry.restartCount = 0;
        entry.status       = 'starting';
        try {
          await this._startStream(entry);
        } catch (err) {
          console.error(`[YouTubeStream] Restart failed after update for ${id}:`, err.message);
          entry.status = 'error';
          this.db.update('cameras', id, { status: 'error' });
        }
      }).catch((err) => {
        console.error(`[YouTubeStream] Stop failed during update for ${id}:`, err.message);
      });
    }

    return this._toPublic(entry);
  }

  /**
   * Called by the MediaMTX webhook handler when a path publish event arrives.
   * Transitions the stream from 'starting' to 'live'.
   * @param {string} path  e.g. "/yt/yt-a1b2c3d4" or "yt/yt-a1b2c3d4"
   */
  onMediaMTXPublish(path) {
    const id = path.replace(/^\//, '').replace(/^yt\//, '');
    const fullId = id.startsWith('yt-') ? id : null;
    if (!fullId) return;
    const entry = this.streams.get(fullId);
    if (!entry) return;
    if (entry.status === 'starting' || entry.status === 'restarting') {
      this._setLive(entry);
    }
  }

  /**
   * Called by the MediaMTX webhook handler when a path unpublish event arrives.
   * @param {string} path
   */
  onMediaMTXUnpublish(path) {
    const id = path.replace(/^\//, '').replace(/^yt\//, '');
    const fullId = id.startsWith('yt-') ? id : null;
    if (!fullId) return;
    const entry = this.streams.get(fullId);
    if (!entry || entry.status === 'stopping' || entry.status === 'removed') return;
    console.log(`[YouTubeStream] MediaMTX unpublish for ${fullId} — scheduling restart`);
    this._scheduleRestart(entry, false);
  }

  /**
   * List all active streams.
   * @returns {object[]}
   */
  listStreams() {
    return Array.from(this.streams.values())
      .filter(e => e.status !== 'removed')
      .map(e => this._toPublic(e));
  }

  /**
   * Get a single stream by ID.
   * @param {string} id
   */
  getStream(id) {
    const entry = this.streams.get(id);
    if (!entry || entry.status === 'removed') return null;
    return this._toPublic(entry);
  }

  /**
   * Stop all active streams — called on server shutdown.
   */
  async stopAll() {
    const promises = Array.from(this.streams.values())
      .filter(e => e.status !== 'removed')
      .map(e => this._stopEntry(e, false).catch(() => {}));
    await Promise.allSettled(promises);
    this.streams.clear();
    console.log('[YouTubeStream] All streams stopped');
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Build the FFmpeg argument array for pipe mode (reading from stdin).
   * yt-dlp pipes MPEGTS to ffmpeg's stdin; no HTTPS required from ffmpeg.
   * @param {StreamEntry} entry
   * @returns {string[]}
   */
  _buildFFmpegArgsPipe(entry) {
    const bitrateK = entry.bitrate;
    const bufsizeK = bitrateK * 2;
    const scale    = `scale=-2:${entry.maxHeight}`;

    return [
      '-re',
      '-i', 'pipe:0',   // read from yt-dlp stdout pipe
      // Video
      '-c:v',          'libx264',
      '-profile:v',    'main',
      '-level',        '4.1',
      '-preset',       'ultrafast',
      '-tune',         'zerolatency',
      '-b:v',          `${bitrateK}k`,
      '-maxrate',      `${bitrateK}k`,
      '-bufsize',      `${bufsizeK}k`,
      '-vf',           scale,
      '-g',            '60',
      '-keyint_min',   '30',
      '-sc_threshold', '0',
      // Audio
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar',  '44100',
      // Output
      '-f',              'rtsp',
      '-rtsp_transport', 'tcp',
      entry.rtspUrl,
    ];
  }

  /**
   * Spawn yt-dlp (pipe mode) → FFmpeg and wait up to START_TIMEOUT ms for the
   * RTSP output line, indicating successful publish to MediaMTX.
   *
   * yt-dlp outputs an MPEGTS stream on stdout which ffmpeg reads via pipe:0.
   * This avoids any HTTPS handling by ffmpeg (corporate SSL bypass).
   *
   * @param {StreamEntry} entry
   * @returns {Promise<void>}
   */
  async _startStream(entry) {
    return new Promise((resolve, reject) => {
      entry.liveResolve = resolve;
      entry.liveReject  = reject;

      // ── Spawn yt-dlp in pipe mode ─────────────────────────────────────────
      // Format priority: prefer H.264 (avc) to avoid AV1/VP9 which FFmpeg 3.x cannot decode.
      // Fallback chain ensures we always get a playable stream.
      const fmtH264 = [
        `bestvideo[ext=mp4][vcodec^=avc][height<=${entry.maxHeight}]+bestaudio[ext=m4a]`,
        `bestvideo[vcodec^=avc][height<=${entry.maxHeight}]+bestaudio`,
        `best[ext=mp4][vcodec^=avc][height<=${entry.maxHeight}]`,
        `best[ext=mp4][height<=${entry.maxHeight}]`,
        `best[height<=${entry.maxHeight}]`,
      ].join('/');
      const ytArgs = [
        '--no-playlist',
        '--format', fmtH264,
        '--merge-output-format', 'mp4',
        '-o', '-',           // output binary stream to stdout
        '--no-progress',     // suppress progress bars (keep errors/warnings visible)
        '--newline',         // one status line per update (easier parsing)
      ];
      if (NODE_BIN_FOR_YTDLP) ytArgs.push('--js-runtimes', `node:${NODE_BIN_FOR_YTDLP}`);
      if (NODE_BIN_FOR_YTDLP && YTDLP_REMOTE_COMPONENTS) ytArgs.push('--remote-components', YTDLP_REMOTE_COMPONENTS);
      if (YTDLP_NO_CHECK_CERT) ytArgs.push('--no-check-certificate');
      ytArgs.push(entry.youtubeUrl);

      console.log(`[YouTubeStream] Spawning yt-dlp | ffmpeg pipe for ${entry.id}`);

      const ytProc = spawn(YTDLP_BIN, ytArgs, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      entry.ytdlpProcess = ytProc;

      // ── Spawn FFmpeg reading yt-dlp's stdout via stdin ────────────────────
      const ffArgs = this._buildFFmpegArgsPipe(entry);
      const ffProc = spawn(FFMPEG_BIN, ffArgs, {
        shell: false,
        stdio: [ytProc.stdout, 'pipe', 'pipe'],
      });
      entry.ffmpegProcess = ffProc;

      let started = false;

      // ── Buffer FFmpeg stderr line-by-line to avoid chunk-boundary mismatches ──
      let ffStderrBuf = '';
      const onFfStderr = (data) => {
        ffStderrBuf += data.toString();
        const lines = ffStderrBuf.split('\n');
        ffStderrBuf = lines.pop();  // hold last (possibly incomplete) line
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) console.log(`[YouTubeStream] ffmpeg[${entry.id}]: ${trimmed.slice(0, 300)}`);
          if (!started && RTSP_LIVE_RE.test(line)) {
            started = true;
            clearTimeout(entry.startTimer);
            entry.startTimer = null;
            this._setLive(entry);
          }
        }
      };
      ffProc.stdout.on('data', onFfStderr);
      ffProc.stderr.on('data', onFfStderr);

      // Log yt-dlp stderr (errors / warnings — --no-progress keeps these visible)
      let ytStderrBuf = '';
      ytProc.stderr.on('data', (d) => {
        ytStderrBuf += d.toString();
        const lines = ytStderrBuf.split('\n');
        ytStderrBuf = lines.pop();
        for (const line of lines) {
          const msg = line.trim();
          if (msg) console.log(`[YouTubeStream] yt-dlp[${entry.id}]: ${msg.slice(0, 300)}`);
        }
      });

      // Startup timeout
      entry.startTimer = setTimeout(() => {
        if (entry.status === 'starting') {
          console.error(`[YouTubeStream] Startup timeout for ${entry.id}`);
          entry.status = 'error';
          this.db.update('cameras', entry.id, { status: 'error' });
          ytProc.kill('SIGTERM');
          ffProc.kill('SIGTERM');
          if (entry.liveReject) {
            const err = new Error('STREAM_TIMEOUT');
            err.code  = 'STREAM_TIMEOUT';
            entry.liveReject(err);
            entry.liveReject  = null;
            entry.liveResolve = null;
          }
        }
      }, START_TIMEOUT);

      ffProc.on('close', (code, signal) => {
        clearTimeout(entry.startTimer);
        entry.startTimer    = null;
        entry.ffmpegProcess = null;
        // Ensure yt-dlp also stops when ffmpeg exits
        if (entry.ytdlpProcess) { entry.ytdlpProcess.kill('SIGTERM'); }

        if (entry.status === 'stopping' || entry.status === 'removed') return;

        console.warn(`[YouTubeStream] FFmpeg exited (code=${code}, signal=${signal}) for ${entry.id}`);

        if (entry.status === 'starting' && entry.liveReject) {
          entry.status = 'error';
          this.db.update('cameras', entry.id, { status: 'error' });
          const err = new Error('STREAM_FAILED');
          err.code  = 'STREAM_FAILED';
          entry.liveReject(err);
          entry.liveReject  = null;
          entry.liveResolve = null;
          return;
        }

        // Natural end: FFmpeg exited cleanly (code 0, no signal) — video finished
        const isNaturalEnd = code === 0 && signal === null;
        this._scheduleRestart(entry, isNaturalEnd);
      });

      ffProc.on('error', (err) => {
        console.error(`[YouTubeStream] FFmpeg spawn error for ${entry.id}:`, err.message);
        if (err.code === 'ENOENT') {
          entry.status = 'error';
          this.db.update('cameras', entry.id, { status: 'error' });
          if (entry.liveReject) {
            const e = new Error('FFMPEG_NOT_FOUND: ffmpeg binary not found in PATH');
            e.code  = 'FFMPEG_NOT_FOUND';
            entry.liveReject(e);
            entry.liveReject  = null;
            entry.liveResolve = null;
          }
        }
      });

      ytProc.on('error', (err) => {
        console.error(`[YouTubeStream] yt-dlp spawn error for ${entry.id}:`, err.message);
        if (err.code === 'ENOENT') {
          entry.status = 'error';
          this.db.update('cameras', entry.id, { status: 'error' });
          if (entry.liveReject) {
            const e = new Error('YTDLP_NOT_FOUND: yt-dlp binary not found');
            e.code  = 'YTDLP_NOT_FOUND';
            entry.liveReject(e);
            entry.liveReject  = null;
            entry.liveResolve = null;
          }
        }
      });
    });
  }

  /**
   * Transition an entry to 'live' status and start the pipeline.
   * @param {StreamEntry} entry
   */
  _setLive(entry) {
    if (entry.status === 'live') return;   // already live (webhook race)
    entry.status   = 'live';
    entry.startTimer && clearTimeout(entry.startTimer);
    this.db.update('cameras', entry.id, { status: 'live' });

    console.log(`[YouTubeStream] Stream ${entry.id} is LIVE at ${entry.rtspUrl}`);

    // Resolve the create / restart promise
    if (entry.liveResolve) {
      entry.liveResolve();
      entry.liveResolve = null;
      entry.liveReject  = null;
    }

    // Start the LTS inference pipeline for this virtual camera
    const camRecord = this.db.findOne('cameras', { id: entry.id });
    if (camRecord && this.pipelineManager) {
      this.pipelineManager.startCamera(camRecord).catch((err) => {
        console.error(`[YouTubeStream] Pipeline start error for ${entry.id}:`, err.message);
      });
    }
  }

  /**
   * Schedule an automatic restart after RESTART_DELAY ms.
   * @param {StreamEntry} entry
   */
  _scheduleRestart(entry, isNaturalEnd = false) {
    if (entry.status === 'stopping' || entry.status === 'removed') return;

    // Repeat playback: reset restart counter when video ends naturally
    if (entry.repeatPlayback && isNaturalEnd) {
      entry.restartCount = 0;
      console.log(`[YouTubeStream] Repeat playback: restarting ${entry.id} after natural end`);
    }

    if (entry.restartCount >= MAX_RESTARTS) {
      console.error(`[YouTubeStream] Max restarts (${MAX_RESTARTS}) reached for ${entry.id} — marking as error`);
      entry.status = 'error';
      this.db.update('cameras', entry.id, { status: 'error' });
      return;
    }

    entry.status = 'restarting';
    entry.restartCount++;
    console.log(`[YouTubeStream] Scheduling restart ${entry.restartCount}/${MAX_RESTARTS} for ${entry.id} in ${RESTART_DELAY}ms`);

    entry.restartTimer = setTimeout(async () => {
      entry.restartTimer = null;
      if (entry.status !== 'restarting') return;
      entry.status = 'starting';

      try {
        await this._startStream(entry);
      } catch (err) {
        console.error(`[YouTubeStream] Restart failed for ${entry.id}:`, err.message);
        this._scheduleRestart(entry);
      }
    }, RESTART_DELAY);
  }

  /**
   * Gracefully stop an entry (kill FFmpeg, stop pipeline).
   * @param {StreamEntry} entry
   * @param {boolean} deleteRecord
   */
  async _stopEntry(entry, deleteRecord) {
    entry.status = 'stopping';

    // Cancel any pending restart
    if (entry.restartTimer) {
      clearTimeout(entry.restartTimer);
      entry.restartTimer = null;
    }
    if (entry.startTimer) {
      clearTimeout(entry.startTimer);
      entry.startTimer = null;
    }

    // Stop the LTS pipeline
    if (this.pipelineManager) {
      try { await this.pipelineManager.stopCamera(entry.id); } catch { /* ignore */ }
    }

    // Kill yt-dlp first (closing its stdout triggers ffmpeg stdin EOF)
    if (entry.ytdlpProcess) {
      entry.ytdlpProcess.kill('SIGTERM');
      await new Promise((res) => {
        const t = setTimeout(() => { entry.ytdlpProcess && entry.ytdlpProcess.kill('SIGKILL'); res(); }, 3000);
        entry.ytdlpProcess.once('close', () => { clearTimeout(t); res(); });
      });
      entry.ytdlpProcess = null;
    }

    // Kill FFmpeg
    if (entry.ffmpegProcess) {
      entry.ffmpegProcess.kill('SIGTERM');
      await new Promise((res) => {
        const t = setTimeout(() => { entry.ffmpegProcess && entry.ffmpegProcess.kill('SIGKILL'); res(); }, 5000);
        entry.ffmpegProcess.once('close', () => { clearTimeout(t); res(); });
      });
      entry.ffmpegProcess = null;
    }

    entry.status = 'removed';

    // Remove camera record from DB
    if (deleteRecord) {
      this._cleanupRecord(entry);
    }
  }

  /**
   * Remove the camera record from DB.
   * @param {StreamEntry} entry
   */
  _cleanupRecord(entry) {
    try { this.db.delete('cameras', entry.id); } catch { /* ignore */ }
  }

  /**
   * Serialize an entry for API responses.
   * @param {StreamEntry} entry
   */
  _toPublic(entry) {
    const uptime = entry.status === 'live'
      ? Math.floor((Date.now() - new Date(entry.createdAt).getTime()) / 1000)
      : 0;
    return {
      id:             entry.id,
      name:           entry.name,
      type:           'youtube',
      youtubeUrl:     entry.youtubeUrl,
      rtspUrl:        entry.rtspUrl,
      resolution:     entry.resolution,
      bitrate:        entry.bitrate,
      repeatPlayback: entry.repeatPlayback || false,
      status:         entry.status,
      restartCount:   entry.restartCount,
      uptimeSeconds:  uptime,
      createdAt:      entry.createdAt,
    };
  }
}

module.exports = YouTubeStreamService;
