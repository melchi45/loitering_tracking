'use strict';

const fs   = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const STORAGE_PATH = process.env.STORAGE_PATH
  ? path.resolve(process.cwd(), process.env.STORAGE_PATH)
  : path.resolve(__dirname, '../../storage');

const AUDIT_FILE = path.join(STORAGE_PATH, 'audit.json');

const MAX_EVENTS = 10_000; // keep last N events to prevent unbounded growth

function _load() {
  try {
    if (fs.existsSync(AUDIT_FILE)) {
      const raw = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
      return Array.isArray(raw.events) ? raw.events : [];
    }
  } catch {}
  return [];
}

function _save(events) {
  if (!fs.existsSync(STORAGE_PATH)) fs.mkdirSync(STORAGE_PATH, { recursive: true });
  const tmp = AUDIT_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ events }, null, 2));
  fs.renameSync(tmp, AUDIT_FILE);
}

/**
 * Append one audit event.
 *
 * @param {{
 *   event: 'signup'|'signin'|'signin_blocked'|'logout'|'token_refresh'|
 *          'approved'|'rejected'|'revoked'|'role_changed'|'deleted',
 *   userId?: string,
 *   email?: string,
 *   ip?: string,
 *   userAgent?: string,
 *   actorId?: string,
 *   detail?: object
 * }} entry
 */
function log(entry) {
  const events = _load();
  events.push({
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

  // Trim to last MAX_EVENTS
  const trimmed = events.length > MAX_EVENTS ? events.slice(-MAX_EVENTS) : events;
  _save(trimmed);
}

/**
 * Query recent audit events.
 * @param {{ userId?: string, event?: string, limit?: number }} opts
 */
function query({ userId, event, limit = 100 } = {}) {
  let events = _load();
  if (userId) events = events.filter(e => e.userId === userId);
  if (event)  events = events.filter(e => e.event  === event);
  return events.slice(-limit).reverse();
}

module.exports = { log, query };
