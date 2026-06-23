'use strict';

const { v4: uuidv4 } = require('uuid');
const dbModule = require('../db');

const SIMILARITY_THRESHOLD = 0.75;
const CONFIDENCE_THRESHOLD = 0.80;
const CACHE_DURATION_MS = 60 * 60 * 1000;

class MissingPersonService {
  constructor() {
    this.missingPersonsCache = [];
    this.cacheTimestamp = 0;
    this.embeddingCache = new Map();
  }

  _db() {
    return dbModule.getDB();
  }

  _seededEmbedding(seed) {
    const safe = String(seed || 'missing-person');
    const out = new Array(512);
    let x = 2166136261;
    for (let i = 0; i < safe.length; i++) {
      x ^= safe.charCodeAt(i);
      x = (x * 16777619) >>> 0;
    }
    for (let i = 0; i < 512; i++) {
      x ^= (i + 31);
      x = (x * 16777619) >>> 0;
      out[i] = ((x % 2000) / 1000) - 1;
    }
    return out;
  }

  async initialize() {
    await this.reloadCache();
  }

  async reloadCache() {
    const db = this._db();
    this.missingPersonsCache = db.all('missing_persons');
    this.cacheTimestamp = Date.now();

    this.embeddingCache.clear();
    for (const person of this.missingPersonsCache) {
      if (Array.isArray(person.faceEmbedding) && person.faceEmbedding.length === 512) {
        this.embeddingCache.set(person.id, new Float32Array(person.faceEmbedding));
      }
    }
  }

  _isCacheExpired() {
    return Date.now() - this.cacheTimestamp > CACHE_DURATION_MS;
  }

  async _refreshCacheIfNeeded() {
    if (this._isCacheExpired()) await this.reloadCache();
  }

  validateMissingPersonInput(data) {
    if (!data || typeof data !== 'object') {
      throw new Error('Invalid input: payload is required');
    }
    if (!data.name || typeof data.name !== 'string' || !data.name.trim()) {
      throw new Error('Invalid input: name is required');
    }
    if (typeof data.age !== 'number' || data.age < 0 || data.age > 150) {
      throw new Error('Invalid input: age must be between 0 and 150');
    }
    if (!['M', 'F', 'OTHER'].includes(data.gender)) {
      throw new Error('Invalid input: gender must be one of M/F/OTHER');
    }
    if (!data.description || typeof data.description !== 'string' || !data.description.trim()) {
      throw new Error('Invalid input: description is required');
    }
    if (!data.photoUrl || typeof data.photoUrl !== 'string' || !data.photoUrl.trim()) {
      throw new Error('Invalid input: photoUrl is required');
    }
    if (!data.contacts || !data.contacts.phone) {
      throw new Error('Invalid input: contacts.phone is required');
    }
    if (data.faceEmbedding !== undefined) {
      if (!Array.isArray(data.faceEmbedding) || data.faceEmbedding.length !== 512) {
        throw new Error('Invalid input: faceEmbedding must be an array of 512 numbers');
      }
    }
  }

  async registerMissingPerson(data) {
    this.validateMissingPersonInput(data);

    const faceEmbedding = Array.isArray(data.faceEmbedding) && data.faceEmbedding.length === 512
      ? data.faceEmbedding
      : this._seededEmbedding(`${data.name}|${data.photoUrl}`);

    const record = {
      id: uuidv4(),
      name: data.name,
      age: data.age,
      gender: data.gender,
      description: data.description,
      photoUrl: data.photoUrl,
      faceEmbedding,
      reportedDate: data.reportedDate || new Date().toISOString(),
      status: 'MISSING',
      priority: data.priority || 'MEDIUM',
      contacts: data.contacts,
      metadata: {
        createdBy: data.createdBy || 'system',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tags: Array.isArray(data.tags) ? data.tags : [],
      },
    };

    this._db().insert('missing_persons', record);
    this.missingPersonsCache.push(record);
    this.embeddingCache.set(record.id, new Float32Array(record.faceEmbedding));

    return record;
  }

  async searchMissingPerson(criteria = {}) {
    await this._refreshCacheIfNeeded();
    const { query, age, gender, limit = 10, status = 'MISSING', name } = criteria;

    let results = this.missingPersonsCache.filter(p => (status ? p.status === status : true));

    if (query) {
      const q = query.toLowerCase();
      results = results.filter(p =>
        String(p.name || '').toLowerCase().includes(q) ||
        String(p.description || '').toLowerCase().includes(q)
      );
    }

    if (name) {
      const q = String(name).toLowerCase();
      results = results.filter(p => String(p.name || '').toLowerCase().includes(q));
    }

    if (typeof age === 'number') {
      results = results.filter(p => Math.abs(Number(p.age || 0) - age) <= 5);
    }

    if (gender) {
      results = results.filter(p => p.gender === gender);
    }

    const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    results.sort((a, b) => {
      const p = (order[a.priority] ?? 99) - (order[b.priority] ?? 99);
      if (p !== 0) return p;
      return new Date(b.reportedDate).getTime() - new Date(a.reportedDate).getTime();
    });

    return results.slice(0, limit);
  }

  calculateCosineSimilarity(vec1, vec2) {
    let dot = 0;
    let n1 = 0;
    let n2 = 0;
    const len = Math.min(vec1.length, vec2.length);

    for (let i = 0; i < len; i++) {
      dot += vec1[i] * vec2[i];
      n1 += vec1[i] * vec1[i];
      n2 += vec2[i] * vec2[i];
    }

    if (n1 === 0 || n2 === 0) return 0;
    return dot / (Math.sqrt(n1) * Math.sqrt(n2));
  }

  calculateConfidence(similarity) {
    const normalized = Math.max(0, Math.min(1, similarity));
    const uplift = Math.max(0, normalized - SIMILARITY_THRESHOLD);
    return Math.max(0, Math.min(1, normalized * 0.9 + uplift * 0.1));
  }

  async matchFaces(detectedEmbedding) {
    await this._refreshCacheIfNeeded();
    const input = detectedEmbedding instanceof Float32Array
      ? detectedEmbedding
      : new Float32Array(detectedEmbedding || []);

    const matches = [];

    for (const person of this.missingPersonsCache) {
      if (person.status === 'FOUND') continue;
      const stored = this.embeddingCache.get(person.id);
      if (!stored) continue;

      const similarity = this.calculateCosineSimilarity(input, stored);
      if (similarity < SIMILARITY_THRESHOLD) continue;

      const confidence = this.calculateConfidence(similarity);
      if (confidence < CONFIDENCE_THRESHOLD) continue;

      matches.push({
        missingPersonId: person.id,
        name: person.name,
        similarity: Number(similarity.toFixed(4)),
        confidence: Number(confidence.toFixed(4)),
        priority: person.priority,
        personData: person,
      });
    }

    matches.sort((a, b) => b.confidence - a.confidence);
    return matches;
  }

  async createDetectionEvent(data) {
    const event = {
      id: uuidv4(),
      missingPersonId: data.missingPersonId,
      cameraId: data.cameraId,
      frameId: data.frameId || null,
      timestamp: data.timestamp || new Date().toISOString(),
      similarity: Number(Number(data.similarity || 0).toFixed(4)),
      boundingBox: data.boundingBox || null,
      trackingId: data.trackingId || null,
      status: 'PENDING',
      metadata: {
        alertSent: false,
        alertedAt: null,
        confirmedBy: null,
        notes: null,
      },
    };

    this._db().insert('missing_person_detections', event);
    return event;
  }

  async getDetectionsByDate(date, options = {}) {
    const { missingPersonId, status, limit = 50, cameraId } = options;

    const dateObj = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(dateObj.getTime())) {
      throw new Error('Invalid date format. Use YYYY-MM-DD');
    }

    const start = dateObj.getTime();
    const end = start + 24 * 60 * 60 * 1000;

    const detections = this._db().all('missing_person_detections');
    let filtered = detections.filter(d => {
      const ts = new Date(d.timestamp).getTime();
      return !Number.isNaN(ts) && ts >= start && ts < end;
    });

    if (missingPersonId) filtered = filtered.filter(d => d.missingPersonId === missingPersonId);
    if (status) filtered = filtered.filter(d => d.status === status);
    if (cameraId) filtered = filtered.filter(d => d.cameraId === cameraId);

    filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    const results = filtered.slice(0, limit).map(d => ({
      ...d,
      missingPerson: this.missingPersonsCache.find(p => p.id === d.missingPersonId) || null,
    }));

    return {
      detections: results,
      summary: {
        total: filtered.length,
        confirmed: filtered.filter(d => d.status === 'CONFIRMED').length,
        pending: filtered.filter(d => d.status === 'PENDING').length,
        falsePositives: filtered.filter(d => d.status === 'FALSE_POSITIVE').length,
      },
    };
  }

  async updateMissingPersonStatus(missingPersonId, newStatus, notes = null) {
    const db = this._db();
    const person = db.findOne('missing_persons', { id: missingPersonId });
    if (!person) {
      throw new Error(`Missing person not found: ${missingPersonId}`);
    }

    const metadata = { ...(person.metadata || {}), updatedAt: new Date().toISOString() };
    if (notes) metadata.notes = notes;

    db.update('missing_persons', missingPersonId, { status: newStatus, metadata });
    const updated = db.findOne('missing_persons', { id: missingPersonId });

    const i = this.missingPersonsCache.findIndex(p => p.id === missingPersonId);
    if (i >= 0) this.missingPersonsCache[i] = updated;

    return updated;
  }

  async updateDetectionStatus(detectionId, newStatus, confirmedBy = null) {
    const db = this._db();
    const detection = db.findOne('missing_person_detections', { id: detectionId });
    if (!detection) {
      throw new Error(`Detection not found: ${detectionId}`);
    }

    const metadata = { ...(detection.metadata || {}) };
    if (confirmedBy) metadata.confirmedBy = confirmedBy;

    db.update('missing_person_detections', detectionId, { status: newStatus, metadata });
    return db.findOne('missing_person_detections', { id: detectionId });
  }

  async getStatistics() {
    await this._refreshCacheIfNeeded();

    const detections = this._db().all('missing_person_detections');
    const today = new Date().toISOString().slice(0, 10);

    const todayDetections = detections.filter(d => {
      const ts = typeof d.timestamp === 'string' ? d.timestamp : new Date(d.timestamp).toISOString();
      return ts.slice(0, 10) === today;
    });

    return {
      totalRegistered: this.missingPersonsCache.length,
      totalMissing: this.missingPersonsCache.filter(p => p.status === 'MISSING').length,
      totalFound: this.missingPersonsCache.filter(p => p.status === 'FOUND').length,
      totalDetectionsAllTime: detections.length,
      totalDetectionsToday: todayDetections.length,
      confirmedToday: todayDetections.filter(d => d.status === 'CONFIRMED').length,
      pendingToday: todayDetections.filter(d => d.status === 'PENDING').length,
      byPriority: {
        HIGH: this.missingPersonsCache.filter(p => p.priority === 'HIGH').length,
        MEDIUM: this.missingPersonsCache.filter(p => p.priority === 'MEDIUM').length,
        LOW: this.missingPersonsCache.filter(p => p.priority === 'LOW').length,
      },
    };
  }
}

module.exports = new MissingPersonService();
