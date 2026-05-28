'use strict';

const fs   = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const STORAGE_PATH = process.env.STORAGE_PATH
  ? path.resolve(process.cwd(), process.env.STORAGE_PATH)
  : path.resolve(__dirname, '../../storage');

const USERS_FILE = path.join(STORAGE_PATH, 'users.json');

// ── helpers ──────────────────────────────────────────────────────────────────

function _load() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      return Array.isArray(raw.users) ? raw.users : [];
    }
  } catch {}
  return [];
}

function _save(users) {
  if (!fs.existsSync(STORAGE_PATH)) fs.mkdirSync(STORAGE_PATH, { recursive: true });
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ users }, null, 2));
  fs.renameSync(tmp, USERS_FILE);
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Find a user by id.
 * @returns {object|null}
 */
function findById(id) {
  return _load().find(u => u.id === id) ?? null;
}

/**
 * Find a user by email (case-insensitive).
 * @returns {object|null}
 */
function findByEmail(email) {
  const lc = email.toLowerCase();
  return _load().find(u => u.email.toLowerCase() === lc) ?? null;
}

/**
 * List users with optional filters.
 * @param {{ status?: string, search?: string }} opts
 */
function list({ status, search } = {}) {
  let users = _load();
  if (status) users = users.filter(u => u.status === status);
  if (search) {
    const q = search.toLowerCase();
    users = users.filter(u =>
      u.email.toLowerCase().includes(q) ||
      (u.name || '').toLowerCase().includes(q)
    );
  }
  // Never return password hash to callers
  return users.map(({ passwordHash: _, ...rest }) => rest);
}

/**
 * Create a new user record.
 * Returns the created user (without passwordHash).
 */
function create({ email, name, passwordHash, role = 'viewer' }) {
  const users = _load();
  // Determine status: first user ever → auto-approved admin
  const isFirst     = users.length === 0;
  const seedEmail   = (process.env.ADMIN_SEED_EMAIL || '').toLowerCase();
  const isAdminSeed = seedEmail && email.toLowerCase() === seedEmail;

  const user = {
    id:             uuidv4(),
    email:          email.toLowerCase(),
    name:           name || email.split('@')[0],
    passwordHash,
    role:           (isFirst || isAdminSeed) ? 'admin' : role,
    status:         (isFirst || isAdminSeed) ? 'active' : 'pending',
    createdAt:      new Date().toISOString(),
    approvedAt:     (isFirst || isAdminSeed) ? new Date().toISOString() : null,
    approvedBy:     (isFirst || isAdminSeed) ? 'system' : null,
    lastLoginAt:    null,
    loginCount:     0,
  };

  users.push(user);
  _save(users);

  const { passwordHash: _, ...safe } = user;
  return safe;
}

/**
 * Update user status / role (admin action).
 * action: 'approve' | 'reject' | 'revoke' | 'reactivate'
 */
function updateStatus(id, { action, role } = {}) {
  const users = _load();
  const idx   = users.findIndex(u => u.id === id);
  if (idx === -1) return null;

  const user = users[idx];
  switch (action) {
    case 'approve':
      user.status     = 'active';
      user.approvedAt = new Date().toISOString();
      break;
    case 'reject':
      user.status = 'rejected';
      break;
    case 'revoke':
      user.status = 'revoked';
      break;
    case 'reactivate':
      user.status = 'active';
      break;
  }
  if (role && ['admin', 'operator', 'viewer'].includes(role)) {
    user.role = role;
  }

  _save(users);
  const { passwordHash: _, ...safe } = user;
  return safe;
}

/** Record a successful login. */
function recordLogin(id) {
  const users = _load();
  const user  = users.find(u => u.id === id);
  if (user) {
    user.lastLoginAt = new Date().toISOString();
    user.loginCount  = (user.loginCount || 0) + 1;
    _save(users);
  }
}

/** Delete a user by id. Returns true if found and deleted. */
function remove(id) {
  const users   = _load();
  const updated = users.filter(u => u.id !== id);
  if (updated.length === users.length) return false;
  _save(updated);
  return true;
}

/** Return the raw user record including passwordHash (for auth verification). */
function findByIdWithHash(id) {
  return _load().find(u => u.id === id) ?? null;
}

/** Return the raw user record including passwordHash (for auth verification). */
function findByEmailWithHash(email) {
  const lc = email.toLowerCase();
  return _load().find(u => u.email.toLowerCase() === lc) ?? null;
}

/**
 * Find a user by OAuth provider + provider-side user ID.
 * @returns {object|null}
 */
function findByProvider(provider, providerId) {
  return _load().find(u => u.provider === provider && u.providerId === providerId) ?? null;
}

/**
 * Create or update a user from an OAuth provider callback.
 * - Matches first by (provider, providerId), then falls back to email.
 * - New users get status='pending' (or 'active' if first / ADMIN_SEED_EMAIL).
 * Returns the safe user record (no passwordHash).
 */
function upsertOAuthUser({ provider, providerId, email, name }) {
  const users   = _load();
  const emailLc = email.toLowerCase();

  // 1. Find existing user by provider + providerId
  let idx = users.findIndex(u => u.provider === provider && u.providerId === providerId);

  // 2. Fall back: find by email (link OAuth to existing account)
  if (idx === -1) idx = users.findIndex(u => u.email === emailLc);

  if (idx !== -1) {
    const u = users[idx];
    // Link OAuth provider if account was previously local-only
    if (!u.provider || u.provider === 'local') {
      u.provider   = provider;
      u.providerId = providerId;
      _save(users);
    }
    const { passwordHash: _, ...safe } = u;
    return safe;
  }

  // 3. New user
  const isFirst    = users.length === 0;
  const seedEmail  = (process.env.ADMIN_SEED_EMAIL || '').toLowerCase();
  const isAdminSeed = seedEmail && emailLc === seedEmail;

  const user = {
    id:          uuidv4(),
    email:       emailLc,
    name:        name || email.split('@')[0],
    passwordHash: null,
    provider,
    providerId,
    role:        (isFirst || isAdminSeed) ? 'admin'  : 'viewer',
    status:      (isFirst || isAdminSeed) ? 'active' : 'pending',
    createdAt:   new Date().toISOString(),
    approvedAt:  (isFirst || isAdminSeed) ? new Date().toISOString() : null,
    approvedBy:  (isFirst || isAdminSeed) ? 'system' : null,
    lastLoginAt: null,
    loginCount:  0,
  };

  users.push(user);
  _save(users);
  const { passwordHash: _, ...safe } = user;
  return safe;
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
  recordLogin,
  remove,
};

