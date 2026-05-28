'use strict';
/**
 * snapshotService.js — Detection Snapshot Storage
 *
 * Crops bbox regions from JPEG frame buffers and persists them to the
 * detectionSnapshots DB table. Non-blocking; safe to call from the
 * pipeline via setImmediate.
 *
 * Trigger strategy (saves when ANY condition is true):
 *   1. isLoitering === true
 *   2. First appearance of this objectId on this camera (in-session)
 *   3. Face recognition match (face.matchScore > 0)
 *   4. className is 'fire' or 'smoke'
 *   5. ≥ SNAPSHOT_INTERVAL_SEC elapsed since last save for this track
 *
 * When SNAPSHOT_ENABLED=false, the module is disabled entirely.
 */

const { v4: uuidv4 } = require('uuid');

// ── Lazy-load sharp (optional dependency) ─────────────────────────────────────
let sharp = null;
try {
  sharp = require('sharp');
} catch {
  console.warn('[Snapshot] sharp not found — snapshot saving disabled. Run: npm install sharp --save');
}

// ── Config (read once on module load) ────────────────────────────────────────
const ENABLED       = process.env.SNAPSHOT_ENABLED !== 'false';
const INTERVAL_SEC  = parseInt(process.env.SNAPSHOT_INTERVAL_SEC    || '30',  10);
const MAX_DIM       = parseInt(process.env.SNAPSHOT_MAX_DIMENSION   || '320', 10);
const JPEG_QUALITY  = parseInt(process.env.SNAPSHOT_JPEG_QUALITY    || '70',  10);
const MAX_PER_CAM_DAY = parseInt(process.env.SNAPSHOT_MAX_PER_CAMERA_DAY || '500', 10);

// ── In-session state (reset on process restart) ───────────────────────────────
/** Map<'cameraId:objectId', lastSaveTimestampMs> */
const _lastSave = new Map();
/** Set<'cameraId:objectId'> — tracks seen since server start */
const _seen     = new Set();

// ── Public API ────────────────────────────────────────────────────────────────

/** Returns true if snapshot saving is configured and sharp is available */
function isEnabled() {
  return ENABLED && sharp !== null;
}

/**
 * Determines whether a snapshot should be saved for this detection.
 *
 * @param {string} cameraId
 * @param {number|string} objectId
 * @param {object} opts
 * @param {boolean} opts.isLoitering
 * @param {boolean} opts.hasFaceMatch
 * @param {boolean} opts.isFireSmoke
 * @param {number}  opts.timestamp  — Unix ms
 * @returns {boolean}
 */
function shouldSave(cameraId, objectId, { isLoitering, hasFaceMatch, isFireSmoke, timestamp }) {
  if (!isEnabled()) return false;

  const key        = `${cameraId}:${objectId}`;
  const isFirstSeen = !_seen.has(key);
  _seen.add(key);

  if (isLoitering || isFirstSeen || hasFaceMatch || isFireSmoke) return true;

  const last = _lastSave.get(key) || 0;
  return (timestamp - last) / 1000 >= INTERVAL_SEC;
}

/**
 * Crops a JPEG region defined by bbox from the given frame buffer.
 *
 * @param {Buffer}  jpegBuffer
 * @param {{x:number,y:number,width:number,height:number}} bbox  — pixel coords
 * @param {number}  frameWidth
 * @param {number}  frameHeight
 * @returns {Promise<{data:Buffer, width:number, height:number}>}
 */
async function cropJpeg(jpegBuffer, bbox, frameWidth, frameHeight) {
  // Clamp to valid frame boundaries
  const left   = Math.max(0, Math.round(bbox.x));
  const top    = Math.max(0, Math.round(bbox.y));
  const right  = Math.min(frameWidth,  Math.round(bbox.x + bbox.width));
  const bottom = Math.min(frameHeight, Math.round(bbox.y + bbox.height));
  const width  = right  - left;
  const height = bottom - top;

  if (width < 4 || height < 4) {
    throw new Error(`Bbox too small: ${width}×${height}`);
  }

  let img = sharp(jpegBuffer).extract({ left, top, width, height });

  if (width > MAX_DIM || height > MAX_DIM) {
    img = img.resize(MAX_DIM, MAX_DIM, { fit: 'inside', withoutEnlargement: true });
  }

  const data = await img.jpeg({ quality: JPEG_QUALITY }).toBuffer();
  const meta = await sharp(data).metadata();
  return { data, width: meta.width, height: meta.height };
}

/**
 * Saves a snapshot record to the DB.
 *
 * @param {object} db            — db module
 * @param {object} camera        — { id, name }
 * @param {object} det           — detection object from pipelineManager
 * @param {Buffer} cropBuf       — JPEG buffer
 * @param {number} cropWidth
 * @param {number} cropHeight
 * @param {number} frameWidth    — original frame width
 * @param {number} frameHeight   — original frame height
 * @param {number} timestamp     — Unix ms
 */
async function saveSnapshot(db, camera, det, cropBuf, cropWidth, cropHeight, frameWidth, frameHeight, timestamp) {
  const key = `${camera.id}:${det.objectId}`;
  _lastSave.set(key, timestamp);

  // Gather enriched attributes
  const attributes = {};
  if (det.color  !== undefined) attributes.color = det.color;
  if (det.cloth  !== undefined) attributes.cloth = det.cloth;
  if (det.face)                 attributes.face  = {
    faceId:     det.face.faceId     || null,
    name:       det.face.name       || null,
    matchScore: det.face.matchScore || 0,
  };
  if (det.hat    !== undefined) attributes.hat  = det.hat;
  if (det.mask   !== undefined) attributes.mask = det.mask;

  const record = {
    id:          uuidv4(),
    cameraId:    camera.id,
    cameraName:  camera.name || camera.id,
    timestamp:   new Date(timestamp).toISOString(),
    objectId:    det.objectId,
    className:   det.className,
    confidence:  det.confidence,
    bbox:        det.bbox,
    frameWidth,
    frameHeight,
    cropData:    'data:image/jpeg;base64,' + cropBuf.toString('base64'),
    cropWidth,
    cropHeight,
    attributes,
    isLoitering: det.isLoitering || false,
    dwellTime:   det.dwellTime   || 0,
    zoneId:      det.zoneId      || null,
    zoneName:    det.zoneName    || null,
    // Behavioral tracking metrics (populated by behaviorEngine when inside a zone)
    velocity:      det.velocity      ?? null,
    riskScore:     det.riskScore     ?? null,
    circularScore: det.circularScore ?? null,
    pacingScore:   det.pacingScore   ?? null,
    revisitCount:  det.revisitCount  ?? null,
    createdAt:   new Date(timestamp).toISOString(),
    updatedAt:   new Date(timestamp).toISOString(),
  };

  db.insert('detectionSnapshots', record);
  return record.id;
}

/**
 * Prunes old snapshots exceeding MAX_PER_CAM_DAY per camera in the last 24h.
 * Runs synchronously on the in-memory store; does not block the event loop
 * significantly (in-memory sort + filter).
 *
 * @param {object} db
 */
function pruneOldSnapshots(db) {
  const now     = Date.now();
  const day24h  = 24 * 60 * 60 * 1000;
  const cutoff  = new Date(now - day24h).toISOString();

  // Group snapshots by camera for snapshots in the last 24h
  const all    = db.all('detectionSnapshots');
  const recent = all.filter(s => s.timestamp >= cutoff);

  /** @type {Map<string, object[]>} */
  const byCam = new Map();
  for (const s of recent) {
    if (!byCam.has(s.cameraId)) byCam.set(s.cameraId, []);
    byCam.get(s.cameraId).push(s);
  }

  const toDelete = [];
  for (const [, snaps] of byCam) {
    if (snaps.length <= MAX_PER_CAM_DAY) continue;
    // Sort oldest first, delete excess
    snaps.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const excess = snaps.slice(0, snaps.length - MAX_PER_CAM_DAY);
    for (const s of excess) toDelete.push(s.id);
  }

  for (const id of toDelete) {
    db.delete('detectionSnapshots', id);
  }

  if (toDelete.length > 0) {
    console.log(`[Snapshot] Pruned ${toDelete.length} old snapshots`);
  }
}

module.exports = { isEnabled, shouldSave, cropJpeg, saveSnapshot, pruneOldSnapshots };
