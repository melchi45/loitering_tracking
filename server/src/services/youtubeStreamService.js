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

const { spawn, execFile }  = require('child_process');
const { v4: uuidv4 } = require('uuid');
const { validateChannelSlot, nextFreeChannelSlot } = require('./channelSlotService');

// Kill a process and every descendant it spawned. Needed because yt-dlp spawns
// its own internal ffmpeg subprocess for live-only HLS sources (see the
// --downloader-args comment in _startStream()) — that grandchild has no
// Node-side handle, so ChildProcess#kill() on the yt-dlp process only
// terminates yt-dlp itself and orphans the ffmpeg it spawned. Signals don't
// cascade to children on Windows at all, and even on POSIX a parent killed
// with SIGKILL has no chance to clean up after itself — either way the
// grandchild survives as a zombie unless something walks the tree explicitly.
function killProcessTree(pid) {
  if (!pid) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve());
    });
  }
  return new Promise((resolve) => {
    execFile('pgrep', ['-P', String(pid)], (_err, stdout) => {
      const children = String(stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
      Promise.all(children.map((childPid) => killProcessTree(childPid))).then(() => {
        try { process.kill(pid, 'SIGKILL'); } catch (_) { /* already dead */ }
        resolve();
      });
    });
  });
}

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
// Force IPv4-only connections to YouTube/Google endpoints. On hosts where IPv6
// has a route but is actually unreachable (common on cloud/VPN networks with
// a stale IPv6 default route), yt-dlp's dual-stack resolver still tries every
// AAAA address first and eats ~20s per dead address before falling back to
// IPv4 — easily blowing past START_TIMEOUT and failing every "Add" attempt
// with STREAM_TIMEOUT even though the URL itself resolves fine over IPv4.
const YTDLP_FORCE_IPV4 = process.env.YTDLP_FORCE_IPV4 === 'true';
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
// Skip expensive binary detection and startup logs in analysis-only mode —
// this module is required by index.js unconditionally, but analysis mode never
// spawns yt-dlp or FFmpeg.
const _isAnalysis = process.env.SERVER_MODE === 'analysis';
const NODE_BIN_FOR_YTDLP = _isAnalysis ? null : findNodeBin();
if (!_isAnalysis) {
  console.log(`[YouTubeStream] Node bin for yt-dlp JS runtime: ${NODE_BIN_FOR_YTDLP || '(not found, using config file)'}`);
}

function findYtDlp() {
  const isWindows = process.platform === 'win32';
  // 1. OS-specific override takes precedence on the matching runtime.
  const osKey = isWindows ? process.env.YTDLP_BIN_WINDOWS : process.env.YTDLP_BIN_LINUX;
  if (osKey) return osKey;
  // 2. Explicit single-path override
  if (process.env.YTDLP_BIN) return process.env.YTDLP_BIN;

  const candidates = [];
  if (isWindows) {
    const localAppData = process.env.LOCALAPPDATA || '';
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    candidates.push(
      path.join(localAppData, 'Microsoft', 'WinGet', 'Packages', 'yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe', 'yt-dlp.exe'),
      path.join(programFiles, 'yt-dlp', 'yt-dlp.exe'),
      path.join(programFilesX86, 'yt-dlp', 'yt-dlp.exe'),
      'yt-dlp.exe',
      'yt-dlp'
    );
  } else {
    candidates.push(
      '/home/' + (process.env.USER || require('os').userInfo().username) + '/.local/bin/yt-dlp',
      '/usr/local/bin/yt-dlp',
      '/usr/bin/yt-dlp',
      'yt-dlp'
    );
  }

  for (const p of candidates) {
    try { execFileSync(p, ['--version'], { stdio: 'pipe', timeout: 3000 }); return p; } catch { /* try next */ }
  }

  const pathEntries = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathEntries) {
    const binName = isWindows ? 'yt-dlp.exe' : 'yt-dlp';
    const candidate = path.join(dir, binName);
    try { execFileSync(candidate, ['--version'], { stdio: 'pipe', timeout: 3000 }); return candidate; } catch { /* try next */ }
  }

  return isWindows ? 'yt-dlp.exe' : 'yt-dlp';
}
const YTDLP_BIN = _isAnalysis ? 'yt-dlp' : findYtDlp();
if (!_isAnalysis) {
  console.log(`[YouTubeStream] yt-dlp binary: ${YTDLP_BIN}`);
  console.log(`[YouTubeStream] SSL check: ${YTDLP_NO_CHECK_CERT ? 'disabled (--no-check-certificate)' : 'enabled'}`);
  console.log(`[YouTubeStream] IPv4-only: ${YTDLP_FORCE_IPV4 ? 'enabled (--force-ipv4)' : 'disabled'}`);
}

// ── URL-expiry refresh: if FFmpeg stderr contains HTTP 403 re-resolve ─────────
const HTTP_403_RE = /Server returned 4XX Client Error reply to.*403|403 Forbidden/i;
// Detect successful RTSP publish start in FFmpeg output
// frame= / size= lines mean ffmpeg is actually encoding → more reliable than Output #0
const RTSP_LIVE_RE = /Output #0[^\n]*rtsp|frame=\s*[1-9]|size=\s*\d+kB/i;
// Detect stream being actively pushed (in case Output #0 line is split across chunks)
const RTSP_OUTPUT_RE = RTSP_LIVE_RE;  // kept for compatibility
// Detect URL expiry on ytdlp side
const URL_EXPIRED_RE = /HTTP Error 403|Sign in to confirm|age.*restricted/i;

// A single 403 is transient and already handled by -reconnect_on_http_error (the
// segment retries automatically). But when the resolved playback URL itself has
// expired/been invalidated by YouTube, EVERY subsequent segment request 403s
// forever — reconnect flags keep the process alive but it never produces new
// video data again, which is exactly the "noise until restart" symptom this
// guards against (2026-07-14). N consecutive 403s within a short window can only
// mean the URL is dead, not a one-off blip — only re-invoking yt-dlp (which
// re-resolves a fresh signed URL) can recover from this, not more reconnects.
const CONSECUTIVE_403_THRESHOLD  = 3;
const CONSECUTIVE_403_WINDOW_MS  = 15000;

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
        webrtcEnabled:  cam.webrtcEnabled !== false, // default true for restored streams
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
  async createStream({ youtubeUrl, name, resolution = '1080p', bitrate = 2000, repeatPlayback = false, webrtcEnabled = true, channelSlot }) {
    // Validate URL
    if (!YOUTUBE_URL_REGEX.test(youtubeUrl)) {
      const err = new Error('INVALID_YOUTUBE_URL');
      err.code  = 'INVALID_YOUTUBE_URL';
      throw err;
    }

    // channelSlot: global dashboard grid position (1..MAX_CHANNEL_NUM), shares the
    // same numbering space as RTSP cameras. Auto-assigned when omitted — see
    // docs/design/Design_Channel_Slot.md.
    let resolvedChannelSlot = channelSlot;
    if (resolvedChannelSlot === undefined || resolvedChannelSlot === null || resolvedChannelSlot === '') {
      resolvedChannelSlot = nextFreeChannelSlot(this.db);
    } else {
      resolvedChannelSlot = parseInt(resolvedChannelSlot, 10);
    }
    const slotCheck = validateChannelSlot(this.db, resolvedChannelSlot);
    if (!slotCheck.ok) {
      const err = new Error(slotCheck.error);
      err.code  = slotCheck.status === 409 ? 'CHANNEL_SLOT_CONFLICT' : 'CHANNEL_SLOT_INVALID';
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
      webrtcEnabled:  !!webrtcEnabled,
      channelSlot:    resolvedChannelSlot,
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
      type:           'youtube',
      youtubeUrl,
      resolution,
      bitrate:        bitrate * 1000, // store as bps
      repeatPlayback: !!repeatPlayback,
      webrtcEnabled:  !!webrtcEnabled,
      channelSlot:    resolvedChannelSlot,
      status:         'offline',
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

    // channelSlot: global Dashboard Channel Slot (1..MAX_CHANNEL_NUM) — a pure
    // grid-position change, never restarts the stream. See Design_Channel_Slot.md.
    if (updates.channelSlot !== undefined) {
      const slot = parseInt(updates.channelSlot, 10);
      const slotCheck = validateChannelSlot(this.db, slot, id);
      if (!slotCheck.ok) {
        const err = new Error(slotCheck.error);
        err.code  = slotCheck.status === 409 ? 'CHANNEL_SLOT_CONFLICT' : 'CHANNEL_SLOT_INVALID';
        throw err;
      }
      entry.channelSlot = slot;
      this.db.update('cameras', id, { channelSlot: slot });
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

    // webrtcEnabled change only needs a pipeline restart (no YouTube source restart).
    // Separating this avoids the 30-60s yt-dlp/FFmpeg respawn when just toggling WebRTC.
    let needPipelineOnly = false;
    if (updates.webrtcEnabled !== undefined) {
      entry.webrtcEnabled = !!updates.webrtcEnabled;
      this.db.update('cameras', id, { webrtcEnabled: !!updates.webrtcEnabled });
      if (!needRestart) {
        needPipelineOnly = true;
      }
    }

    if (needRestart) {
      // Full restart: source URL / resolution / bitrate changed.
      // Restart asynchronously so the API response returns immediately.
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
    } else if (needPipelineOnly && entry.status === 'live') {
      // webrtcEnabled changed while stream is live — restart pipeline only.
      // The YouTube source (yt-dlp + FFmpeg) keeps running; only the ingest-daemon
      // registration and mediasoup transports are rebuilt with the new setting.
      const camRecord = this.db.findOne('cameras', { id });
      if (camRecord && this.pipelineManager) {
        this.pipelineManager.stopCamera(id)
          .then(() => this.pipelineManager.startCamera(camRecord))
          .catch((err) => {
            console.error(`[YouTubeStream] Pipeline restart error for ${id}:`, err.message);
          });
      }
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
    return [
      // -re: read input at native playback rate, creating backpressure on the pipe.
      // Without this, FFmpeg drains the pipe at 43x speed (HLS segments burst in);
      // yt-dlp interprets an empty pipe as "download complete" and exits after ~7s,
      // causing a restart gap where the stream freezes until yt-dlp relaunches.
      // With -re the pipe fills up, yt-dlp's writes block, keeping both processes alive.
      '-re',
      // yt-dlp's internal segment fetches from googlevideo CDN aren't perfectly
      // smooth — brief stalls (CDN jitter, segment re-requests) followed by bursts
      // once data resumes. FFmpeg's default pipe read queue (8 packets) is too small
      // to absorb these bursts, causing "Resumed reading at pts ... after a lag of
      // Xs" warnings and, downstream, MediaMTX readers discarding frames while they
      // catch up. A larger queue smooths this out without adding real latency (it's
      // headroom for bursts, not a fixed buffering delay).
      '-thread_queue_size', '4096',
      '-i', 'pipe:0',
      // Copy H.264 video as-is — no libx264 re-encoding (eliminates >90% CPU usage).
      // yt-dlp format selector already enforces vcodec^=avc so the source is H.264.
      '-c:v', 'copy',
      // Re-encode audio to AAC.
      // HLS (m3u8) combined streams deliver AAC in ADTS format (no global headers).
      // The RTSP muxer rejects ADTS at av_write_header() time — before any BSF runs.
      // Re-encoding produces MPEG-4 AAC with proper AudioSpecificConfig headers,
      // which RTSP requires. For DASH streams (already MPEG-4 AAC), re-encoding is
      // harmless extra CPU but ensures compatibility for all input types.
      '-c:a', 'aac', '-b:a', '128k',
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
      // Strict H.264 (avc) only — we use -c:v copy so source MUST be H.264.
      // VP9/AV1 would be copied as-is and MediaMTX/mediasoup would reject them.
      //
      // Fallback order:
      //   1. DASH (separate video+audio) — highest quality, most VOD videos
      //   2. HLS combined (m3u8)         — live streams, age-restricted, some VODs
      //   3. Any H.264 combined          — last resort
      const fmtH264 = [
        // DASH: separate video+audio streams
        `bestvideo[ext=mp4][vcodec^=avc][height<=${entry.maxHeight}]+bestaudio[ext=m4a]`,
        `bestvideo[vcodec^=avc][height<=${entry.maxHeight}]+bestaudio[ext=m4a]`,
        `bestvideo[vcodec^=avc][height<=${entry.maxHeight}]+bestaudio`,
        `bestvideo[vcodec^=avc]+bestaudio`,
        // HLS: combined video+audio (live streams only have these)
        `best[vcodec^=avc][height<=${entry.maxHeight}]`,
        `best[vcodec^=avc]`,
        `best[height<=${entry.maxHeight}]`,
        `best`,
      ].join('/');
      const ytArgs = [
        '--no-playlist',
        '--format', fmtH264,
        '--merge-output-format', 'mkv',  // mkv is naturally streamable; mp4 needs seeking
        // Live-only formats (HLS fallback) are always fetched by yt-dlp's internal
        // ffmpeg downloader, not the native Python one — `--downloader m3u8:native`
        // does NOT override this for is_live sources (verified empirically). That
        // internal ffmpeg has no retry of its own: one segment request rejected with
        // 403 and it gives up, eventually killing the whole input and our RTSP pipe.
        // Reconnect flags on the input make ffmpeg itself retry instead — verified
        // empirically to eliminate the 403s entirely over a 60s continuous capture
        // that previously died within seconds without this.
        //
        // -reconnect_on_network_error / -http_persistent 0 (2026-07-14): production
        // logs showed recurring "[hls] keepalive request failed for
        // https://...googlevideo.com/videoplayback/..." on long-lived captures — a
        // TCP/TLS-level failure reusing a persistent connection for the next segment,
        // NOT accompanied by an HTTP status code, so -reconnect_on_http_error above
        // never catches it. The outer ffmpeg does -c:v copy (no re-encode), so any
        // frame(s) lost/truncated at that segment boundary pass straight through as
        // visible macroblock noise until the next I-frame. -http_persistent 0 removes
        // the failure mode entirely (every segment gets a fresh connection, no
        // keep-alive reuse to fail); -reconnect_on_network_error 1 is a safety net for
        // any other connect-time TCP/TLS error.
        '--downloader-args', 'ffmpeg_i:-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 -reconnect_on_http_error 403,404,5xx -reconnect_on_network_error 1 -http_persistent 0',
        '-o', '-',           // output binary stream to stdout
        '--no-progress',     // suppress progress bars (keep errors/warnings visible)
        '--newline',         // one status line per update (easier parsing)
      ];
      if (NODE_BIN_FOR_YTDLP) ytArgs.push('--js-runtimes', `node:${NODE_BIN_FOR_YTDLP}`);
      if (NODE_BIN_FOR_YTDLP && YTDLP_REMOTE_COMPONENTS) ytArgs.push('--remote-components', YTDLP_REMOTE_COMPONENTS);
      if (YTDLP_NO_CHECK_CERT) ytArgs.push('--no-check-certificate');
      if (YTDLP_FORCE_IPV4) ytArgs.push('--force-ipv4');
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
      const _403Timestamps = [];
      let _forcingRestart = false;

      // Persistent 403s mean the resolved playback URL is dead — kill both
      // processes so the existing ffProc 'close' → _scheduleRestart() path
      // re-spawns yt-dlp from scratch (fresh URL resolution). Reconnect flags
      // alone cannot recover from this since they retry the same dead URL forever.
      const _checkForExpiredUrl = () => {
        if (_forcingRestart) return;
        const now = Date.now();
        _403Timestamps.push(now);
        while (_403Timestamps.length && now - _403Timestamps[0] > CONSECUTIVE_403_WINDOW_MS) {
          _403Timestamps.shift();
        }
        if (_403Timestamps.length < CONSECUTIVE_403_THRESHOLD) return;
        _forcingRestart = true;
        console.warn(
          `[YouTubeStream] ${entry.id}: ${_403Timestamps.length} consecutive HTTP 403s within ` +
          `${CONSECUTIVE_403_WINDOW_MS / 1000}s — playback URL expired, forcing full restart ` +
          `(re-resolving a fresh URL) instead of continuing to reconnect against a dead one`
        );
        ffProc.kill('SIGTERM');
        ytProc.kill('SIGTERM');
      };

      // ── Buffer FFmpeg stderr line-by-line to avoid chunk-boundary mismatches ──
      // Split on \r\n, \r (ffmpeg progress), or \n to handle all line endings.
      let ffStderrBuf = '';
      const onFfStderr = (data) => {
        if (entry.status === 'stopping' || entry.status === 'removed') return;
        ffStderrBuf += data.toString();
        const lines = ffStderrBuf.split(/\r\n|\r|\n/);
        ffStderrBuf = lines.pop();  // hold last (possibly incomplete) line
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (entry.status === 'stopping' || entry.status === 'removed') break;
          // Check live status before filtering (RTSP_LIVE_RE includes frame=1 pattern)
          if (!started && RTSP_LIVE_RE.test(trimmed)) {
            started = true;
            clearTimeout(entry.startTimer);
            entry.startTimer = null;
            this._setLive(entry);
          }
          // Suppress ffmpeg encoding progress noise (frame= fps= size= time= bitrate=)
          // These use \r to overwrite the terminal line and are not actionable log events.
          if (/^frame=\s*\d/.test(trimmed)) continue;
          if (/\b(error|failed|failure)\b/i.test(trimmed)) {
            console.error(`[YouTubeStream] ffmpeg[${entry.id}]: ${trimmed.slice(0, 300)}`);
          } else {
            console.log(`[YouTubeStream] ffmpeg[${entry.id}]: ${trimmed.slice(0, 300)}`);
          }
        }
      };
      ffProc.stdout.on('data', onFfStderr);
      ffProc.stderr.on('data', onFfStderr);

      // Log yt-dlp stderr (errors / warnings — --no-progress keeps these visible)
      let ytStderrBuf = '';
      ytProc.stderr.on('data', (d) => {
        if (entry.status === 'stopping' || entry.status === 'removed') return;
        ytStderrBuf += d.toString();
        const lines = ytStderrBuf.split('\n');
        ytStderrBuf = lines.pop();
        for (const line of lines) {
          const msg = line.trim();
          if (!msg) continue;
          if (entry.status === 'stopping' || entry.status === 'removed') break;
          if (HTTP_403_RE.test(msg)) _checkForExpiredUrl();
          if (/^ERROR:/i.test(msg) || /\b(error|failed|failure)\b/i.test(msg)) {
            console.error(`[YouTubeStream] yt-dlp[${entry.id}]: ${msg.slice(0, 300)}`);
          } else {
            console.debug(`[YouTubeStream] yt-dlp[${entry.id}]: ${msg.slice(0, 300)}`);
          }
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
        // Ensure yt-dlp also stops when ffmpeg exits. This "natural" reconnect
        // path (googlevideo hiccup, watchdog restart, etc.) happens far more
        // often than an explicit delete, so it's the dominant source of
        // orphaned ffmpeg processes if it doesn't sweep the tree the same way
        // _stopEntry() does — see killProcessTree() comment for why a plain
        // .kill() never reaches yt-dlp's internal ffmpeg subprocess.
        if (entry.ytdlpProcess) {
          const ytdlpPid = entry.ytdlpProcess.pid;
          entry.ytdlpProcess.kill('SIGTERM');
          entry.ytdlpProcess = null;
          killProcessTree(ytdlpPid).catch(() => {});
        }

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

    // Guard: if the camera no longer exists in DB (e.g., deleted while running),
    // clean up and stop retrying rather than becoming a zombie stream.
    if (!this.db.findOne('cameras', { id: entry.id })) {
      console.warn(`[YouTubeStream] Camera ${entry.id} no longer in DB — stopping restart loop`);
      entry.status = 'removed';
      this.streams.delete(entry.id);
      return;
    }

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
      // Double-check DB existence before actually restarting
      if (!this.db.findOne('cameras', { id: entry.id })) {
        console.warn(`[YouTubeStream] Camera ${entry.id} deleted during restart delay — aborting`);
        entry.status = 'removed';
        this.streams.delete(entry.id);
        return;
      }
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
      const ytdlpPid = entry.ytdlpProcess.pid;
      entry.ytdlpProcess.kill('SIGTERM');
      await new Promise((res) => {
        const t = setTimeout(() => { entry.ytdlpProcess && entry.ytdlpProcess.kill('SIGKILL'); res(); }, 3000);
        entry.ytdlpProcess.once('close', () => { clearTimeout(t); res(); });
      });
      entry.ytdlpProcess = null;
      // Sweep yt-dlp's own subprocess tree (its internal ffmpeg downloader) —
      // see killProcessTree() comment above for why the .kill() calls above
      // never reach it.
      await killProcessTree(ytdlpPid);
    }

    // Kill FFmpeg (the outer process reading pipe:0 and publishing RTSP)
    if (entry.ffmpegProcess) {
      const ffmpegPid = entry.ffmpegProcess.pid;
      entry.ffmpegProcess.kill('SIGTERM');
      await new Promise((res) => {
        const t = setTimeout(() => { entry.ffmpegProcess && entry.ffmpegProcess.kill('SIGKILL'); res(); }, 5000);
        entry.ffmpegProcess.once('close', () => { clearTimeout(t); res(); });
      });
      entry.ffmpegProcess = null;
      await killProcessTree(ffmpegPid);
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
      webrtcEnabled:  entry.webrtcEnabled !== false,
      channelSlot:    entry.channelSlot ?? null,
      status:         entry.status,
      restartCount:   entry.restartCount,
      uptimeSeconds:  uptime,
      createdAt:      entry.createdAt,
    };
  }
}

module.exports = YouTubeStreamService;
