'use strict';

/**
 * Stateless summary/reconcile helpers over the existing faceGalleries/faceGalleryFaces
 * tables, used bidirectionally between a streaming server and its analysis server:
 *  - streaming → analysis: display-only, embedding stripped (analysis never matches with it)
 *  - analysis → streaming: embeddings included, so a condition registered directly on the
 *    analysis server's own dashboard becomes locally matchable on the streaming server too
 */

const GALLERY_TYPES = ['missing', 'vip', 'blocklist', 'general'];

function galleryTypeOf(db, galleryId, galleryCache) {
  const gallery = galleryCache.get(galleryId);
  return (gallery && gallery.type) || 'general';
}

/** { total, byType } — cheap enough to compute on every /metrics poll. */
function summarize(db) {
  const galleries = db.all('faceGalleries');
  const faces = db.all('faceGalleryFaces');
  const galleryCache = new Map(galleries.map((g) => [g.id, g]));

  const byType = { missing: 0, vip: 0, blocklist: 0, general: 0 };
  for (const face of faces) {
    const type = galleryTypeOf(db, face.galleryId, galleryCache);
    if (Object.prototype.hasOwnProperty.call(byType, type)) byType[type]++;
  }

  return { total: faces.length, byType };
}

/** Full list with galleryType resolved, embedding excluded — for the dashboard detail view. */
function listGrouped(db) {
  const galleries = db.all('faceGalleries');
  const galleryCache = new Map(galleries.map((g) => [g.id, g]));
  const faces = db.all('faceGalleryFaces').map((f) => ({
    id:          f.id,
    galleryId:   f.galleryId,
    galleryType: galleryTypeOf(db, f.galleryId, galleryCache),
    name:        f.name,
    thumbnail:   f.thumbnail,
    source:      f.source || 'local',
    createdAt:   f.createdAt,
  }));

  const { total, byType } = summarize(db);
  return { total, byType, faces };
}

/**
 * Export this process's own galleries/faces (source 'local' or missing — never re-export
 * rows that were themselves synced in from the other side) WITH embeddings intact.
 * Used for the reverse direction of reconcile: a server pulling in conditions that were
 * registered directly on the OTHER server, so they become locally matchable too — unlike
 * the display-only, embedding-stripped snapshot faceSearchSync.js sends outbound.
 */
function exportLocal(db) {
  const galleries = db.all('faceGalleries').filter((g) => g.source !== 'synced');
  const faces      = db.all('faceGalleryFaces').filter((f) => f.source !== 'synced');
  return { galleries, faces };
}

/**
 * Apply an incoming full-state snapshot from the other server (streaming↔analysis, either
 * direction — the tag means "synced in from elsewhere" regardless of which physical side).
 * Upserts every entry tagged 'synced'; deletes any existing 'synced' row absent from the
 * snapshot. Rows tagged 'local' (or missing a source field) are never touched.
 */
function applyReconcile(db, snapshot) {
  const galleries = Array.isArray(snapshot?.galleries) ? snapshot.galleries : [];
  const faces      = Array.isArray(snapshot?.faces)      ? snapshot.faces      : [];

  const incomingGalleryIds = new Set(galleries.map((g) => g.id));
  const incomingFaceIds    = new Set(faces.map((f) => f.id));

  for (const g of galleries) {
    const row = { ...g, source: 'synced' };
    if (db.findOne('faceGalleries', { id: g.id })) db.update('faceGalleries', g.id, row);
    else db.insert('faceGalleries', row);
  }

  for (const f of faces) {
    const row = { ...f, source: 'synced' };
    if (db.findOne('faceGalleryFaces', { id: f.id })) db.update('faceGalleryFaces', f.id, row);
    else db.insert('faceGalleryFaces', row);
  }

  for (const row of db.all('faceGalleries')) {
    if (row.source === 'synced' && !incomingGalleryIds.has(row.id)) db.delete('faceGalleries', row.id);
  }
  for (const row of db.all('faceGalleryFaces')) {
    if (row.source === 'synced' && !incomingFaceIds.has(row.id)) db.delete('faceGalleryFaces', row.id);
  }
}

module.exports = { GALLERY_TYPES, summarize, listGrouped, exportLocal, applyReconcile };
