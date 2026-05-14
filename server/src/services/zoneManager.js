'use strict';

const { v4: uuidv4 } = require('uuid');

class ZoneManager {
  constructor(db) {
    this._db = db;
    this._cache = new Map();
  }

  getZonesForCamera(cameraId) {
    if (this._cache.has(cameraId)) return this._cache.get(cameraId);

    const rows = this._db.find('zones', { cameraId });
    const zones = rows.map(r => this._rowToZone(r));
    this._cache.set(cameraId, zones);
    return zones;
  }

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

  getActiveZones(cameraId, timestamp = new Date()) {
    const zones = this.getZonesForCamera(cameraId);
    return zones.filter(z => z.active && this._isScheduleActive(z.schedule, timestamp));
  }

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

    this._db.insert('zones', zone);
    this._invalidateCache(cameraId);
    return zone;
  }

  updateZone(id, data) {
    const existing = this._db.findOne('zones', { id });
    if (!existing) return null;

    const updated = {
      ...this._rowToZone(existing),
      ...data,
    };

    this._db.update('zones', id, updated);
    this._invalidateCache(updated.cameraId);
    return updated;
  }

  deleteZone(id) {
    const row = this._db.findOne('zones', { id });
    if (!row) return false;
    this._db.delete('zones', id);
    this._invalidateCache(row.cameraId);
    return true;
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  _rowToZone(row) {
    return {
      id:              row.id,
      cameraId:        row.cameraId,
      name:            row.name,
      polygon:         Array.isArray(row.polygon) ? row.polygon : JSON.parse(row.polygon || '[]'),
      type:            row.type,
      dwellThreshold:  row.dwellThreshold,
      minDisplacement: row.minDisplacement,
      reentryWindow:   row.reentryWindow,
      schedule:        row.schedule && typeof row.schedule === 'string'
                         ? JSON.parse(row.schedule)
                         : (row.schedule || null),
      active:          row.active === 1 || row.active === true,
    };
  }

  _invalidateCache(cameraId) {
    this._cache.delete(cameraId);
  }

  _isScheduleActive(schedule, timestamp) {
    if (!schedule) return true;

    const day  = timestamp.getDay();
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
        return currentMinutes >= startMin || currentMinutes <= endMin;
      }
    }

    return true;
  }
}

module.exports = ZoneManager;
