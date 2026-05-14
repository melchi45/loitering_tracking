'use strict';

const { v4: uuidv4 } = require('uuid');

/**
 * Manages monitoring/exclusion zones per camera.
 * Zones are persisted in SQLite and cached in memory.
 */
class ZoneManager {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this._db = db;
    this._cache = new Map(); // cameraId → Zone[]
  }

  /**
   * Get all zones for a given camera (served from cache if available).
   * @param {string} cameraId
   * @returns {Zone[]}
   */
  getZonesForCamera(cameraId) {
    if (this._cache.has(cameraId)) return this._cache.get(cameraId);

    const rows = this._db
      .prepare('SELECT * FROM zones WHERE cameraId = ?')
      .all(cameraId);

    const zones = rows.map(this._rowToZone);
    this._cache.set(cameraId, zones);
    return zones;
  }

  /**
   * Point-in-polygon test using ray casting.
   * @param {number} px     X coordinate
   * @param {number} py     Y coordinate
   * @param {Zone}   zone   Zone with `.polygon` array of {x,y} points
   * @returns {boolean}
   */
  isPointInZone(px, py, zone) {
    const polygon = zone.polygon;
    if (!polygon || polygon.length < 3) return false;

    let inside = false;
    const n = polygon.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = polygon[i].x, yi = polygon[i].y;
      const xj = polygon[j].x, yj = polygon[j].y;

      const intersect =
        yi > py !== yj > py &&
        px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;

      if (intersect) inside = !inside;
    }
    return inside;
  }

  /**
   * Get zones that are currently active (taking schedule into account).
   * @param {string} cameraId
   * @param {Date}   [timestamp=new Date()]
   * @returns {Zone[]}
   */
  getActiveZones(cameraId, timestamp = new Date()) {
    const zones = this.getZonesForCamera(cameraId);
    return zones.filter(z => z.active && this._isScheduleActive(z.schedule, timestamp));
  }

  /**
   * Add a new zone to the camera.
   * @param {string} cameraId
   * @param {object} zoneData { name, polygon, type, dwellThreshold, minDisplacement, reentryWindow, schedule }
   * @returns {Zone}
   */
  addZone(cameraId, zoneData) {
    const id = uuidv4();
    const zone = {
      id,
      cameraId,
      name:            zoneData.name             || 'Zone',
      polygon:         zoneData.polygon          || [],
      type:            zoneData.type             || 'MONITOR',
      dwellThreshold:  zoneData.dwellThreshold   ?? parseInt(process.env.LOITERING_THRESHOLD_SEC || '30'),
      minDisplacement: zoneData.minDisplacement  ?? parseInt(process.env.MIN_DISPLACEMENT_PX     || '50'),
      reentryWindow:   zoneData.reentryWindow    ?? parseInt(process.env.REENTRY_WINDOW_SEC       || '120'),
      schedule:        zoneData.schedule         || null,
      active:          true,
    };

    this._db.prepare(`
      INSERT INTO zones (id, cameraId, name, polygon, type, dwellThreshold, minDisplacement, reentryWindow, schedule, active)
      VALUES (@id, @cameraId, @name, @polygon, @type, @dwellThreshold, @minDisplacement, @reentryWindow, @schedule, @active)
    `).run({
      ...zone,
      polygon:  JSON.stringify(zone.polygon),
      schedule: zone.schedule ? JSON.stringify(zone.schedule) : null,
      active:   zone.active ? 1 : 0,
    });

    this._invalidateCache(cameraId);
    return zone;
  }

  /**
   * Update an existing zone.
   * @param {string} id
   * @param {object} data  Partial zone fields
   * @returns {Zone|null}
   */
  updateZone(id, data) {
    const existing = this._db.prepare('SELECT * FROM zones WHERE id = ?').get(id);
    if (!existing) return null;

    const updated = {
      ...this._rowToZone(existing),
      ...data,
    };

    this._db.prepare(`
      UPDATE zones
      SET name=@name, polygon=@polygon, type=@type, dwellThreshold=@dwellThreshold,
          minDisplacement=@minDisplacement, reentryWindow=@reentryWindow,
          schedule=@schedule, active=@active
      WHERE id=@id
    `).run({
      id:              updated.id,
      name:            updated.name,
      polygon:         JSON.stringify(updated.polygon),
      type:            updated.type,
      dwellThreshold:  updated.dwellThreshold,
      minDisplacement: updated.minDisplacement,
      reentryWindow:   updated.reentryWindow,
      schedule:        updated.schedule ? JSON.stringify(updated.schedule) : null,
      active:          updated.active ? 1 : 0,
    });

    this._invalidateCache(updated.cameraId);
    return updated;
  }

  /**
   * Delete a zone by ID.
   * @param {string} id
   * @returns {boolean}
   */
  deleteZone(id) {
    const row = this._db.prepare('SELECT cameraId FROM zones WHERE id = ?').get(id);
    if (!row) return false;
    this._db.prepare('DELETE FROM zones WHERE id = ?').run(id);
    this._invalidateCache(row.cameraId);
    return true;
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  _rowToZone(row) {
    return {
      id:              row.id,
      cameraId:        row.cameraId,
      name:            row.name,
      polygon:         JSON.parse(row.polygon || '[]'),
      type:            row.type,
      dwellThreshold:  row.dwellThreshold,
      minDisplacement: row.minDisplacement,
      reentryWindow:   row.reentryWindow,
      schedule:        row.schedule ? JSON.parse(row.schedule) : null,
      active:          row.active === 1,
    };
  }

  _invalidateCache(cameraId) {
    this._cache.delete(cameraId);
  }

  /**
   * Check if a schedule is currently active.
   * Schedule format: { days: [0-6], start: "HH:MM", end: "HH:MM" }
   * Null schedule means always active.
   * @param {object|null} schedule
   * @param {Date} timestamp
   * @returns {boolean}
   */
  _isScheduleActive(schedule, timestamp) {
    if (!schedule) return true;

    const day  = timestamp.getDay();  // 0=Sun … 6=Sat
    const hour = timestamp.getHours();
    const min  = timestamp.getMinutes();
    const currentMinutes = hour * 60 + min;

    if (schedule.days && !schedule.days.includes(day)) return false;

    if (schedule.start && schedule.end) {
      const [sh, sm] = schedule.start.split(':').map(Number);
      const [eh, em] = schedule.end.split(':').map(Number);
      const startMin = sh * 60 + sm;
      const endMin   = eh * 60 + em;
      if (startMin <= endMin) {
        return currentMinutes >= startMin && currentMinutes <= endMin;
      } else {
        // Overnight schedule (e.g. 22:00 – 06:00)
        return currentMinutes >= startMin || currentMinutes <= endMin;
      }
    }

    return true;
  }
}

module.exports = ZoneManager;
