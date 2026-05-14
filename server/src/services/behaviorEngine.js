'use strict';

const { EventEmitter } = require('events');

const HISTORY_CAPACITY = 300;  // ~30 seconds at 10 FPS
const FPS = 10;

/**
 * Detects loitering behavior from tracked objects within defined zones.
 * Emits 'loitering' when a person exceeds dwellThreshold with low displacement.
 */
class BehaviorEngine extends EventEmitter {
  /** @param {import('./zoneManager')} zoneManager */
  constructor(zoneManager) {
    super();
    this._zoneManager = zoneManager;
    // objectId → { frames: [{x,y,timestamp}], enteredAt, zoneId, lastLoiteringEmit, reentryData }
    this._state = new Map();
  }

  /**
   * Process tracked objects for a given frame.
   * @param {string} cameraId
   * @param {Array<{objectId,bbox,confidence,state}>} trackedObjects
   * @param {number} frameTimestamp  Unix ms timestamp
   * @returns {Array}  Enriched objects with { ...tracked, isLoitering, dwellTime, zoneId }
   */
  update(cameraId, trackedObjects, frameTimestamp) {
    const now = frameTimestamp || Date.now();
    const zones = this._zoneManager.getActiveZones(cameraId, new Date(now));

    const enriched = [];

    for (const obj of trackedObjects) {
      const { objectId, bbox } = obj;
      const cx = bbox.x + bbox.width  / 2;
      const cy = bbox.y + bbox.height / 2;

      // Determine which MONITOR zone (if any) the object is in
      let matchedZone = null;
      for (const zone of zones) {
        if (zone.type === 'MONITOR' && this._zoneManager.isPointInZone(cx, cy, zone)) {
          matchedZone = zone;
          break;
        }
      }

      // Skip objects inside EXCLUDE zones
      const inExclude = zones.some(
        z => z.type === 'EXCLUDE' && this._zoneManager.isPointInZone(cx, cy, z)
      );
      if (inExclude) {
        this._clearState(objectId);
        enriched.push({ ...obj, isLoitering: false, dwellTime: 0, zoneId: null });
        continue;
      }

      if (!matchedZone) {
        // Left any zone — clear state (but preserve for re-entry window)
        const prev = this._state.get(objectId);
        if (prev) {
          prev.leftAt = now;
          // Keep state briefly for re-entry detection
        }
        enriched.push({ ...obj, isLoitering: false, dwellTime: 0, zoneId: null });
        continue;
      }

      // Object is inside a MONITOR zone
      let state = this._state.get(objectId);

      if (!state) {
        // Brand-new track entering zone
        state = {
          frames:           [],
          enteredAt:        now,
          zoneId:           matchedZone.id,
          lastLoiteringEmit: 0,
          reentryData:      null,
          leftAt:           null,
        };
        this._state.set(objectId, state);
      } else if (state.zoneId !== matchedZone.id) {
        // Switched zones
        state.enteredAt = now;
        state.zoneId    = matchedZone.id;
        state.frames    = [];
      }

      // Handle re-entry: if this object re-enters within reentryWindow,
      // cut the effective threshold by 50%
      let effectiveThreshold = matchedZone.dwellThreshold;
      if (state.leftAt) {
        const gapSec = (now - state.leftAt) / 1000;
        if (gapSec <= matchedZone.reentryWindow) {
          effectiveThreshold = Math.max(1, Math.floor(effectiveThreshold * 0.5));
        }
        state.leftAt = null;
      }

      // Push position to circular buffer
      state.frames.push({ x: cx, y: cy, timestamp: now });
      if (state.frames.length > HISTORY_CAPACITY) {
        state.frames.shift();
      }

      // Calculate dwellTime in seconds
      const dwellTime = (now - state.enteredAt) / 1000;

      // Calculate max displacement from initial position
      const origin = state.frames[0];
      let maxDisp = 0;
      for (const f of state.frames) {
        const d = Math.sqrt((f.x - origin.x) ** 2 + (f.y - origin.y) ** 2);
        if (d > maxDisp) maxDisp = d;
      }

      const isLoitering =
        dwellTime >= effectiveThreshold &&
        maxDisp  <= matchedZone.minDisplacement;

      // Throttle emissions: emit at most once per dwellThreshold seconds
      if (isLoitering) {
        const cooldown = effectiveThreshold * 1000;
        if (now - state.lastLoiteringEmit >= cooldown) {
          state.lastLoiteringEmit = now;
          this.emit('loitering', {
            cameraId,
            objectId,
            zoneId:    matchedZone.id,
            zoneName:  matchedZone.name,
            dwellTime,
            maxDisplacement: maxDisp,
            bbox,
            timestamp: now,
          });
        }
      }

      enriched.push({
        ...obj,
        isLoitering,
        dwellTime,
        zoneId: matchedZone.id,
      });
    }

    // Purge state for objects no longer tracked
    const activeIds = new Set(trackedObjects.map(o => o.objectId));
    for (const [id, state] of this._state.entries()) {
      if (!activeIds.has(id) && state.leftAt === null) {
        state.leftAt = now;
      }
      // Remove state entries that have been gone longer than the max reentry window
      const maxWindow = 300000; // 5 minutes
      if (state.leftAt && now - state.leftAt > maxWindow) {
        this._state.delete(id);
      }
    }

    return enriched;
  }

  /** Remove tracking state for a specific object. */
  _clearState(objectId) {
    this._state.delete(objectId);
  }

  /** Reset all state (e.g. when camera stops). */
  reset() {
    this._state.clear();
  }
}

module.exports = BehaviorEngine;
