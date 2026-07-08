'use strict';

/**
 * Stateless summary/reconcile helpers over the existing faceGalleries/faceGalleryFaces
 * tables. Used on the analysis server to expose a display-only mirror of face search
 * conditions pushed from a streaming server — never consulted for live matching.
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
 * Apply an incoming full-state snapshot from a streaming server.
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

module.exports = { GALLERY_TYPES, summarize, listGrouped, applyReconcile };
