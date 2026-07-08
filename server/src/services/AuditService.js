'use strict';

const { v4: uuidv4 } = require('uuid');
const { getDB } = require('../db');

/**
 * Append one audit event.
 *
 * @param {{
 *   event: 'signup'|'signin'|'signin_blocked'|'logout'|'token_refresh'|
 *          'approved'|'rejected'|'revoked'|'role_changed'|'deleted'|
 *          'gallery_created'|'gallery_deleted'|'face_enrolled'|'face_deleted',
 *   userId?: string,
 *   email?: string,
 *   ip?: string,
 *   userAgent?: string,
 *   actorId?: string,
 *   detail?: object
 * }} entry
 */
function log(entry) {
  getDB().insert('audit_logs', {
    id:        uuidv4(),
    ts:        new Date().toISOString(),
    event:     entry.event,
    userId:    entry.userId    ?? null,
    email:     entry.email     ?? null,
    ip:        entry.ip        ?? null,
    userAgent: entry.userAgent ?? null,
    actorId:   entry.actorId   ?? null,
    detail:    entry.detail    ?? {},
  });
}

/**
 * Query recent audit events.
 * @param {{ userId?: string, event?: string, limit?: number }} opts
 */
function query({ userId, event, limit = 100 } = {}) {
  let events = getDB().all('audit_logs');
  if (userId) events = events.filter(e => e.userId === userId);
  if (event)  events = events.filter(e => e.event  === event);
  return events.slice(-limit).reverse();
}

module.exports = { log, query };
