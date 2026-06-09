'use strict';

const http  = require('http');
const https = require('https');
const { URL } = require('url');

// 2 s is aggressive enough to detect a dead server quickly while still allowing
// a slow inference pass to complete. Override via ANALYSIS_REQUEST_TIMEOUT_MS.
const DEFAULT_TIMEOUT_MS     = 2_000;
// Each camera uses one concurrent slot (per-camera pending-slot pattern).
// Set high enough to cover typical camera counts without artificial back-pressure.
const DEFAULT_MAX_CONCURRENT = 16;

// Circuit breaker: open after this many consecutive failures.
// 3 × 2 s = 6 s total before the circuit trips and all frame traffic stops.
const CIRCUIT_OPEN_THRESHOLD = 3;
// How long the circuit stays open before a health probe is attempted (ms).
const CIRCUIT_RETRY_INTERVAL = 15_000;
// Health probe timeout — always longer than the per-frame timeout so that
// a slow TLS handshake after reconnect does not prevent the circuit from closing.
const HEALTH_PROBE_TIMEOUT_MS = 8_000;
// Log at most one error line per camera per this interval (ms).
const ERROR_LOG_INTERVAL_MS  = 10_000;

/**
 * HTTP client used by a streaming-mode server to forward JPEG frames to a
 * remote AI analysis server and receive detection / tracking / behavior results.
 *
 * Back-pressure strategy: when `_inflight` reaches `maxConcurrent`, incoming
 * frames are silently dropped.
 *
 * Circuit breaker: after CIRCUIT_OPEN_THRESHOLD consecutive failures the client
 * stops forwarding frames and logs a single warning. It retries the health
 * endpoint every CIRCUIT_RETRY_INTERVAL ms and resumes automatically when
 * the analysis server comes back.
 */
class AnalysisClient {
  constructor(baseUrl) {
    if (!baseUrl) throw new Error('[AnalysisClient] ANALYSIS_SERVER_URL is required');
    this._url     = new URL(baseUrl);
    this._timeout = parseInt(process.env.ANALYSIS_REQUEST_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10);
    this._maxConc = parseInt(process.env.ANALYSIS_MAX_CONCURRENT     || String(DEFAULT_MAX_CONCURRENT), 10);
    this._inflight  = 0;
    this._dropped   = 0;
    this._total     = 0;
    this._errors    = 0;

    // Circuit breaker state
    this._consecutive = 0;      // consecutive failures
    this._open        = false;  // true = circuit is open (paused)
    this._retryTimer  = null;

    // Per-camera error log throttle: cameraId → last log timestamp
    this._lastErrLog = new Map();

    // Keep-alive agents reuse TCP/TLS connections across requests, avoiding
    // per-request handshake overhead when forwarding frames at high fps.
    const isProd = process.env.NODE_ENV === 'production';
    this._httpAgent  = new http.Agent({ keepAlive: true, maxSockets: this._maxConc + 2 });
    this._httpsAgent = new https.Agent({
      keepAlive:          true,
      maxSockets:         this._maxConc + 2,
      rejectUnauthorized: isProd,
    });
  }

  /**
   * Send a JPEG frame to the analysis server.
   * Returns null immediately if the circuit is open or back-pressure limit hit.
   *
   * Transport: raw JPEG binary body + JSON metadata in X-LTS-Meta header.
   * This avoids base64 encoding (+33 % size) and a large JSON.stringify call
   * on the Node.js main thread, both of which would briefly block the event loop
   * and delay Socket.IO frame delivery to the browser.
   */
  async analyzeFrame({ cameraId, cameraName, frameId, timestamp, jpegBuffer, zones = [] }) {
    if (this._open) return null;
    if (this._inflight >= this._maxConc) { this._dropped++; return null; }

    this._total++;
    this._inflight++;
    try {
      // Metadata is small (< 4 KB typically); JPEG travels as binary body.
      const meta   = JSON.stringify({ cameraId, cameraName, frameId, timestamp, zones });
      const result = await this._postJpeg('/api/analysis/frame', jpegBuffer, meta);
      const wasNearOpen = this._consecutive >= CIRCUIT_OPEN_THRESHOLD - 1;
      this._consecutive = 0;
      if (wasNearOpen) {
        console.log(`[AnalysisClient][${cameraId?.slice(0, 8)}] reconnected to analysis server`);
      }
      return result;
    } catch (err) {
      this._errors++;
      this._consecutive++;
      this._logError(cameraId, frameId, err.message);
      if (this._consecutive >= CIRCUIT_OPEN_THRESHOLD && !this._open) {
        this._openCircuit();
      }
      return null;
    } finally {
      this._inflight--;
    }
  }

  /** GET /api/analysis/health */
  async healthCheck() {
    try {
      return await this._get('/api/analysis/health', HEALTH_PROBE_TIMEOUT_MS);
    } catch (err) {
      return { status: 'unreachable', error: err.message };
    }
  }

  getStats() {
    return {
      total:      this._total,
      inflight:   this._inflight,
      dropped:    this._dropped,
      errors:     this._errors,
      circuitOpen: this._open,
    };
  }

  destroy() {
    if (this._retryTimer) { clearInterval(this._retryTimer); this._retryTimer = null; }
    this._httpAgent.destroy();
    this._httpsAgent.destroy();
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _openCircuit() {
    this._open = true;
    console.warn(
      `[AnalysisClient] Circuit open after ${this._consecutive} failures — ` +
      `pausing frame forwarding for ${CIRCUIT_RETRY_INTERVAL / 1000}s. ` +
      `Ensure analysis server is running at ${this._url.href}`
    );
    if (!this._retryTimer) {
      this._retryTimer = setInterval(() => this._retryHealth(), CIRCUIT_RETRY_INTERVAL);
    }
  }

  async _retryHealth() {
    const result = await this.healthCheck();
    if (result?.status === 'ok' || result?.status === 'ready') {
      console.log(`[AnalysisClient] Analysis server back online — resuming frame forwarding`);
      this._open = false;
      this._consecutive = 0;
      this._lastErrLog.clear();
      if (this._retryTimer) { clearInterval(this._retryTimer); this._retryTimer = null; }
    } else {
      console.warn(`[AnalysisClient] Retry health: still unreachable (${result?.error ?? result?.status})`);
    }
  }

  _logError(cameraId, frameId, message) {
    const key = cameraId ?? 'unknown';
    const now = Date.now();
    const last = this._lastErrLog.get(key) ?? 0;
    if (now - last >= ERROR_LOG_INTERVAL_MS) {
      this._lastErrLog.set(key, now);
      console.warn(`[AnalysisClient][${key.slice(0, 8)}] frame ${frameId} error: ${message}`);
    }
  }

  _httpModule() {
    return this._url.protocol === 'https:' ? https : http;
  }

  _requestOptions(method, pathname, contentLength) {
    return {
      hostname: this._url.hostname,
      port:     this._url.port || (this._url.protocol === 'https:' ? 443 : 80),
      path:     pathname,
      method,
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': contentLength,
      },
      timeout:            this._timeout,
      rejectUnauthorized: process.env.NODE_ENV === 'production',
      agent:              this._url.protocol === 'https:' ? this._httpsAgent : this._httpAgent,
    };
  }

  /**
   * POST raw JPEG binary to pathname.
   * metaJson is a small JSON string sent in the X-LTS-Meta header.
   * Avoids base64 encoding and large JSON.stringify on the main thread.
   */
  _postJpeg(pathname, jpegBuffer, metaJson) {
    return new Promise((resolve, reject) => {
      const mod  = this._httpModule();
      const opts = {
        hostname: this._url.hostname,
        port:     this._url.port || (this._url.protocol === 'https:' ? 443 : 80),
        path:     pathname,
        method:   'POST',
        headers: {
          'Content-Type':   'image/jpeg',
          'Content-Length': jpegBuffer.byteLength,
          'X-LTS-Meta':     Buffer.from(metaJson).toString('base64'),
        },
        timeout:            this._timeout,
        rejectUnauthorized: process.env.NODE_ENV === 'production',
        agent:              this._url.protocol === 'https:' ? this._httpsAgent : this._httpAgent,
      };
      const req = mod.request(opts, (res) => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 120)}`));
          }
          try { resolve(JSON.parse(raw)); }
          catch { reject(new Error(`Invalid JSON from analysis server: ${raw.slice(0, 120)}`)); }
        });
      });
      req.on('timeout', () => { req.destroy(); reject(new Error(`Request timeout (${this._timeout}ms)`)); });
      req.on('error', reject);
      req.write(jpegBuffer);
      req.end();
    });
  }

  _post(pathname, body) {
    return new Promise((resolve, reject) => {
      const mod  = this._httpModule();
      const opts = this._requestOptions('POST', pathname, Buffer.byteLength(body));
      const req  = mod.request(opts, (res) => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 120)}`));
          }
          try { resolve(JSON.parse(raw)); }
          catch { reject(new Error(`Invalid JSON from analysis server: ${raw.slice(0, 120)}`)); }
        });
      });
      req.on('timeout', () => { req.destroy(); reject(new Error(`Request timeout (${this._timeout}ms)`)); });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  _get(pathname, timeoutOverride) {
    return new Promise((resolve, reject) => {
      const mod  = this._httpModule();
      const opts = this._requestOptions('GET', pathname, 0);
      if (timeoutOverride) opts.timeout = timeoutOverride;
      delete opts.headers['Content-Type'];
      delete opts.headers['Content-Length'];
      const req  = mod.request(opts, (res) => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(raw)); }
          catch { resolve({ raw: raw.slice(0, 200) }); }
        });
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('Health check timeout')); });
      req.on('error', reject);
      req.end();
    });
  }
}

module.exports = AnalysisClient;
