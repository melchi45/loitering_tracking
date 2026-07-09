'use strict';

const { QdrantClient } = require('@qdrant/js-client-rest');

// Circuit breaker: open after this many consecutive failures (mirrors analysisClient.js).
const CIRCUIT_OPEN_THRESHOLD = 5;
const CIRCUIT_RETRY_INTERVAL = 15_000;

const FACE_COLLECTION        = 'face_embeddings';
const FACE_VECTOR_SIZE       = 512; // ArcFace ResNet50
const APPEARANCE_COLLECTION  = 'appearance_embeddings';
const APPEARANCE_VECTOR_SIZE = 256; // OSNet retail-0287 embedding dim

/**
 * Vector DB client — AI-05 Phase-3 / CrossCamera Face Tracking Phase-2 (Proposed).
 * See docs/design/Design_AI_AppearanceReID.md §12.3 and MRD_LTS2026.md §6.4 Phase 12b/12b-3.
 *
 * Optional dependency: disabled unless QDRANT_ENABLED=true. All callers must treat
 * every method here as best-effort — on failure or when disabled, they resolve to
 * null so the caller (pipelineManager.js) falls back to the existing in-memory gallery.
 */
class QdrantService {
  constructor(options = {}) {
    this._enabled = options.enabled ?? (process.env.QDRANT_ENABLED === 'true');
    this._url     = options.url || process.env.QDRANT_URL || 'http://localhost:6333';
    this._client  = null;
    this._ready   = false;

    // Circuit breaker state
    this._consecutive = 0;
    this._open         = false;
    this._retryTimer   = null;
  }

  get ready()  { return this._enabled && this._ready && !this._open; }
  get status() {
    if (!this._enabled) return 'disabled';
    if (!this._ready)   return 'not_started';
    if (this._open)     return 'circuit_open';
    return 'loaded';
  }

  async init() {
    if (!this._enabled) {
      console.log('[QdrantService] QDRANT_ENABLED not set — Appearance/Face vector search disabled (in-memory gallery fallback active)');
      return;
    }
    try {
      this._client = new QdrantClient({ url: this._url });
      await this._ensureCollection(FACE_COLLECTION, FACE_VECTOR_SIZE);
      await this._ensureCollection(APPEARANCE_COLLECTION, APPEARANCE_VECTOR_SIZE);
      this._ready = true;
      console.log(`[QdrantService] connected — collections ready (${this._url})`);
    } catch (err) {
      console.warn('[QdrantService] init failed — falling back to in-memory gallery:', err.message);
      this._ready = false;
    }
  }

  async _ensureCollection(name, size) {
    try {
      await this._client.getCollection(name);
    } catch {
      await this._client.createCollection(name, { vectors: { size, distance: 'Cosine' } });
      console.log(`[QdrantService] created collection '${name}' (dim=${size})`);
    }
  }

  /** Best-effort upsert of an appearance (clothing) embedding. Never throws. */
  async upsertAppearance(id, vector, payload) {
    return this._call(() => this._client.upsert(APPEARANCE_COLLECTION, {
      wait: false,
      points: [{ id, vector, payload }],
    }));
  }

  /** Top-K appearance similarity search, optionally filtered by payload (e.g. color). */
  async queryAppearance(vector, { limit = 5, filter } = {}) {
    const res = await this._call(() => this._client.query(APPEARANCE_COLLECTION, {
      query: vector,
      limit,
      filter,
      with_payload: true,
    }));
    return res?.points ?? [];
  }

  /** Color-prefiltered listing with no query vector — FR-CCFR-066. */
  async scrollAppearanceByFilter(filter, limit = 50) {
    const res = await this._call(() => this._client.scroll(APPEARANCE_COLLECTION, {
      filter,
      limit,
      with_payload: true,
    }));
    return res?.points ?? [];
  }

  /** Best-effort upsert of a face embedding (MRD Phase 12b — face Re-ID). */
  async upsertFace(id, vector, payload) {
    return this._call(() => this._client.upsert(FACE_COLLECTION, {
      wait: false,
      points: [{ id, vector, payload }],
    }));
  }

  getStats() {
    return {
      enabled:     this._enabled,
      ready:       this._ready,
      circuitOpen: this._open,
      url:         this._url,
    };
  }

  destroy() {
    if (this._retryTimer) { clearInterval(this._retryTimer); this._retryTimer = null; }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  async _call(fn) {
    if (!this.ready) return null;
    try {
      const result = await fn();
      this._consecutive = 0;
      return result;
    } catch (err) {
      this._consecutive++;
      console.warn('[QdrantService] operation failed:', err.message);
      if (this._consecutive >= CIRCUIT_OPEN_THRESHOLD && !this._open) this._openCircuit();
      return null;
    }
  }

  _openCircuit() {
    this._open = true;
    console.warn(
      `[QdrantService] Circuit open after ${this._consecutive} failures — ` +
      `pausing Qdrant calls for ${CIRCUIT_RETRY_INTERVAL / 1000}s (${this._url})`
    );
    if (!this._retryTimer) {
      this._retryTimer = setInterval(() => this._retryHealth(), CIRCUIT_RETRY_INTERVAL);
    }
  }

  async _retryHealth() {
    try {
      await this._client.getCollections();
      console.log('[QdrantService] Qdrant back online — resuming');
      this._open = false;
      this._consecutive = 0;
      if (this._retryTimer) { clearInterval(this._retryTimer); this._retryTimer = null; }
    } catch {
      // still down — keep circuit open, timer will retry again
    }
  }
}

module.exports = { QdrantService, FACE_COLLECTION, APPEARANCE_COLLECTION };
