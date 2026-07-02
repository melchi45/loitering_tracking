'use strict';

/**
 * Dashboard Channel Slot — validation, auto-assignment, and startup migration.
 *
 * channelSlot is a globally-unique, system-wide dashboard grid position
 * (1..MAX_CHANNEL_NUM), independent of the pre-existing NVR sub-channel
 * field `channelIndex` (per-device, 1-based, discovery-time only).
 *
 * See docs/design/Design_Channel_Slot.md and docs/srs/SRS_Channel_Slot.md.
 */

const MAX_CHANNEL_NUM_DEFAULT = 512;

function getMaxChannelNum() {
  const n = parseInt(process.env.MAX_CHANNEL_NUM, 10);
  return Number.isInteger(n) && n > 0 ? n : MAX_CHANNEL_NUM_DEFAULT;
}

/**
 * Validates range + uniqueness of a channelSlot value.
 * @param {*} db - DB instance (must expose .all('cameras'))
 * @param {number} channelSlot
 * @param {string|null} [excludeId] - camera id to exclude from the conflict check
 *   (lets a camera's own PUT resubmit its current slot without a false 409)
 */
function validateChannelSlot(db, channelSlot, excludeId = null) {
  const max = getMaxChannelNum();
  if (!Number.isInteger(channelSlot) || channelSlot < 1 || channelSlot > max) {
    return { ok: false, status: 400, error: `channelSlot must be between 1 and ${max}` };
  }
  const conflict = db.all('cameras').find(
    (c) => c.channelSlot === channelSlot && c.id !== excludeId
  );
  if (conflict) {
    return {
      ok: false,
      status: 409,
      error: `Channel slot ${channelSlot} is already assigned to camera "${conflict.name}"`,
    };
  }
  return { ok: true };
}

/** Lowest currently-free slot, or null if MAX_CHANNEL_NUM is exhausted. */
function nextFreeChannelSlot(db) {
  const max = getMaxChannelNum();
  const used = new Set(
    db.all('cameras').filter((c) => c.channelSlot != null).map((c) => c.channelSlot)
  );
  for (let slot = 1; slot <= max; slot++) {
    if (!used.has(slot)) return slot;
  }
  return null;
}

/**
 * Startup migration: assigns the lowest free slot to any camera record
 * missing channelSlot, processed in ascending createdAt order. Idempotent —
 * safe to call on every startup.
 */
function backfillChannelSlots(db) {
  const max = getMaxChannelNum();
  const cameras = db.all('cameras').sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return ta - tb;
  });
  const used = new Set(cameras.filter((c) => c.channelSlot != null).map((c) => c.channelSlot));
  let next = 1;
  let assigned = 0;
  for (const cam of cameras) {
    if (cam.channelSlot != null) continue;
    while (used.has(next) && next <= max) next++;
    if (next > max) {
      console.warn(
        `[channelSlotService] No free channel slot for camera "${cam.name}" (${cam.id}) — MAX_CHANNEL_NUM=${max} exhausted`
      );
      continue;
    }
    db.update('cameras', cam.id, { channelSlot: next });
    used.add(next);
    assigned++;
  }
  if (assigned > 0) {
    console.log(`[channelSlotService] Backfilled channelSlot for ${assigned} camera(s)`);
  }
}

module.exports = {
  getMaxChannelNum,
  validateChannelSlot,
  nextFreeChannelSlot,
  backfillChannelSlots,
};
