'use strict';

const { v4: uuidv4 } = require('uuid');
const { getDB } = require('../db');

// ── internal helpers ─────────────────────────────────────────────────────────

/** Strip passwordHash before returning a user to callers. */
function _safe(user) {
  if (!user) return null;
  const { passwordHash: _, ...safe } = user;
  return safe;
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Find a user by id.
 * @returns {object|null}
 */
function findById(id) {
  return _safe(getDB().findOne('users', { id }));
}

/**
 * Find a user by email (case-insensitive).
 * @returns {object|null}
 */
function findByEmail(email) {
  const lc = email.toLowerCase();
  return _safe(getDB().all('users').find(u => u.email === lc) ?? null);
}

/**
 * List users with optional filters.
 * @param {{ status?: string, search?: string }} opts
 */
function list({ status, search } = {}) {
  let users = getDB().all('users');
  if (status) users = users.filter(u => u.status === status);
  if (search) {
    const q = search.toLowerCase();
    users = users.filter(u =>
      u.email.toLowerCase().includes(q) ||
      (u.name         || '').toLowerCase().includes(q) ||
      (u.organization || '').toLowerCase().includes(q) ||
      (u.phone        || '').toLowerCase().includes(q) ||
      (u.bio          || '').toLowerCase().includes(q)
    );
  }
  return users.map(_safe);
}

/**
 * Create a new user record.
 * Returns the created user (without passwordHash).
 */
function create({ email, name, passwordHash, role = 'viewer' }) {
  const db      = getDB();
  const users   = db.all('users');
  const isFirst = users.length === 0;
  const seedEmail  = (process.env.ADMIN_SEED_EMAIL || '').toLowerCase();
  const isAdminSeed = seedEmail && email.toLowerCase() === seedEmail;

  const user = {
    id:          uuidv4(),
    email:       email.toLowerCase(),
    name:        name || email.split('@')[0],
    passwordHash,
    role:        (isFirst || isAdminSeed) ? 'admin'  : role,
    status:      (isFirst || isAdminSeed) ? 'active' : 'pending',
    createdAt:   new Date().toISOString(),
    approvedAt:  (isFirst || isAdminSeed) ? new Date().toISOString() : null,
    approvedBy:  (isFirst || isAdminSeed) ? 'system' : null,
    lastLoginAt: null,
    loginCount:  0,
  };

  db.insert('users', user);
  return _safe(user);
}

/**
 * Update user status / role (admin action).
 * action: 'approve' | 'reject' | 'revoke' | 'reactivate'
 */
function updateStatus(id, { action, role } = {}) {
  const db   = getDB();
  const user = db.findOne('users', { id });
  if (!user) return null;

  const updates = {};
  switch (action) {
    case 'approve':
      updates.status     = 'active';
      updates.approvedAt = new Date().toISOString();
      break;
    case 'reject':
      updates.status = 'rejected';
      break;
    case 'revoke':
      updates.status = 'revoked';
      break;
    case 'reactivate':
      updates.status = 'active';
      break;
  }
  if (role && ['admin', 'operator', 'viewer'].includes(role)) updates.role = role;

  db.update('users', id, updates);
  return _safe(db.findOne('users', { id }));
}

/** Record a successful login. */
function recordLogin(id) {
  const user = getDB().findOne('users', { id });
  if (user) {
    getDB().update('users', id, {
      lastLoginAt: new Date().toISOString(),
      loginCount:  (user.loginCount || 0) + 1,
    });
  }
}

/**
 * Update profile fields for a user (self-service).
 * @param {string} id
 * @param {{ name?, organization?, phone?, bio?, avatarDataUrl? }} fields
 * @returns {object|null} safe user record (no passwordHash)
 */
function updateProfile(id, { name, organization, phone, bio, avatarDataUrl } = {}) {
  const db   = getDB();
  const user = db.findOne('users', { id });
  if (!user) return null;

  const updates = {};
  if (name          !== undefined) updates.name          = name;
  if (organization  !== undefined) updates.organization  = organization;
  if (phone         !== undefined) updates.phone         = phone;
  if (bio           !== undefined) updates.bio           = bio;
  if (avatarDataUrl !== undefined) updates.avatarDataUrl = avatarDataUrl;

  db.update('users', id, updates);
  return _safe(db.findOne('users', { id }));
}

/** Delete a user by id. Returns true if found and deleted. */
function remove(id) {
  const db   = getDB();
  const user = db.findOne('users', { id });
  if (!user) return false;
  db.delete('users', id);
  return true;
}

/** Return the raw user record including passwordHash (for auth verification). */
function findByIdWithHash(id) {
  return getDB().findOne('users', { id }) ?? null;
}

/** Return the raw user record including passwordHash (for auth verification). */
function findByEmailWithHash(email) {
  const lc = email.toLowerCase();
  return getDB().all('users').find(u => u.email === lc) ?? null;
}

/**
 * Find a user by OAuth provider + provider-side user ID.
 * @returns {object|null}
 */
function findByProvider(provider, providerId) {
  return getDB().all('users').find(u => u.provider === provider && u.providerId === providerId) ?? null;
}

/**
 * Create or update a user from an OAuth provider callback.
 * Returns the safe user record (no passwordHash).
 */
function upsertOAuthUser({ provider, providerId, email, name }) {
  const db      = getDB();
  const emailLc = email.toLowerCase();
  const users   = db.all('users');

  // 1. Find by provider + providerId
  let existing = users.find(u => u.provider === provider && u.providerId === providerId);

  // 2. Fallback: find by email (link OAuth to existing account)
  if (!existing) existing = users.find(u => u.email === emailLc);

  if (existing) {
    if (!existing.provider || existing.provider === 'local') {
      db.update('users', existing.id, { provider, providerId });
    }
    return _safe(db.findOne('users', { id: existing.id }));
  }

  // 3. New user
  const isFirst     = users.length === 0;
  const seedEmail   = (process.env.ADMIN_SEED_EMAIL || '').toLowerCase();
  const isAdminSeed = seedEmail && emailLc === seedEmail;

  const user = {
    id:           uuidv4(),
    email:        emailLc,
    name:         name || email.split('@')[0],
    passwordHash: null,
    provider,
    providerId,
    role:         (isFirst || isAdminSeed) ? 'admin'  : 'viewer',
    status:       (isFirst || isAdminSeed) ? 'active' : 'pending',
    createdAt:    new Date().toISOString(),
    approvedAt:   (isFirst || isAdminSeed) ? new Date().toISOString() : null,
    approvedBy:   (isFirst || isAdminSeed) ? 'system' : null,
    lastLoginAt:  null,
    loginCount:   0,
  };

  db.insert('users', user);
  return _safe(user);
}

module.exports = {
  findById,
  findByEmail,
  findByIdWithHash,
  findByEmailWithHash,
  findByProvider,
  upsertOAuthUser,
  list,
  create,
  updateStatus,
  updateProfile,
  recordLogin,
  remove,
};
