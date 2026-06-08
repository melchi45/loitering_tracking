'use strict';

const http  = require('http');
const https = require('https');
const { URL } = require('url');

const DEFAULT_TIMEOUT_MS    = 5_000;
const DEFAULT_MAX_CONCURRENT = 4;

/**
 * HTTP client used by a streaming-mode server to forward JPEG frames to a
 * remote AI analysis server and receive detection / tracking / behavior results.
 *
 * Back-pressure strategy: when `_inflight` reaches `maxConcurrent`, incoming
 * frames are silently dropped (returns null).  This prevents queue build-up
 * when the analysis server is temporarily slow and keeps the streaming loop
 * non-blocking.
 */
class AnalysisClient {
  /**
   * @param {string} baseUrl  e.g. "http://192.168.1.50:3001"
   */
  constructor(baseUrl) {
    if (!baseUrl) throw new Error('[AnalysisClient] ANALYSIS_SERVER_URL is required');
    this._url        = new URL(baseUrl);
    this._timeout    = parseInt(process.env.ANALYSIS_REQUEST_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10);
    this._maxConc    = parseInt(process.env.ANALYSIS_MAX_CONCURRENT     || String(DEFAULT_MAX_CONCURRENT), 10);
    this._inflight   = 0;
    this._dropped    = 0;
    this._total      = 0;
    this._errors     = 0;
  }

  /**
   * Send a JPEG frame to the analysis server.
   *
   * @param {object} params
   * @param {string} params.cameraId
   * @param {number} params.frameId
   * @param {string} params.timestamp  ISO-8601
   * @param {Buffer} params.jpegBuffer
   * @param {Array}  params.zones       Active zone objects for this camera
   * @param {object} params.analyticsConfig  Current analytics feature flags
   *
   * @returns {Promise<object|null>}  Analysis result JSON, or null if dropped / error
   */
  async analyzeFrame({ cameraId, frameId, timestamp, jpegBuffer, zones = [], analyticsConfig = {} }) {
    if (this._inflight >= this._maxConc) {
      this._dropped++;
      return null;
    }

    this._total++;
    this._inflight++;
    try {
      const body = JSON.stringify({
        cameraId,
        frameId,
        timestamp,
        frame: jpegBuffer.toString('base64'),
        zones,
        analyticsConfig,
      });
      const result = await this._post('/api/analysis/frame', body);
      return result;
    } catch (err) {
      this._errors++;
      // Non-fatal: log and drop — streaming continues without this frame's analysis
      console.warn(`[AnalysisClient][${cameraId?.slice(0, 8)}] frame ${frameId} error: ${err.message}`);
      return null;
    } finally {
      this._inflight--;
    }
  }

  /** GET /api/analysis/health — verify reachability of the analysis server. */
  async healthCheck() {
    try {
      return await this._get('/api/analysis/health');
    } catch (err) {
      return { status: 'unreachable', error: err.message };
    }
  }

  /** Diagnostic counters for /health and logging. */
  getStats() {
    return {
      total:    this._total,
      inflight: this._inflight,
      dropped:  this._dropped,
      errors:   this._errors,
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

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
      timeout: this._timeout,
      // Allow self-signed certs in development
      rejectUnauthorized: process.env.NODE_ENV === 'production',
    };
  }

  _post(pathname, body) {
    return new Promise((resolve, reject) => {
      const mod = this._httpModule();
      const opts = this._requestOptions('POST', pathname, Buffer.byteLength(body));
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
      req.write(body);
      req.end();
    });
  }

  _get(pathname) {
    return new Promise((resolve, reject) => {
      const mod = this._httpModule();
      const opts = this._requestOptions('GET', pathname, 0);
      delete opts.headers['Content-Type'];
      delete opts.headers['Content-Length'];
      const req = mod.request(opts, (res) => {
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
