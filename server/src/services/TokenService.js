'use strict';

const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { v4: uuidv4 } = require('uuid');

const STORAGE_PATH = process.env.STORAGE_PATH
  ? path.resolve(process.cwd(), process.env.STORAGE_PATH)
  : path.resolve(__dirname, '../../storage');

const TOKENS_FILE = path.join(STORAGE_PATH, 'tokens.json');

// ── Key loading ──────────────────────────────────────────────────────────────

let _privKey = null;
let _pubKey  = null;

function getPrivKey() {
  if (!_privKey) {
    _privKey = fs.readFileSync(
      path.resolve(__dirname, '../../', process.env.JWT_PRIVATE_KEY_PATH || './certs/jwt.key')
    );
  }
  return _privKey;
}

function getPubKey() {
  if (!_pubKey) {
    _pubKey = fs.readFileSync(
      path.resolve(__dirname, '../../', process.env.JWT_PUBLIC_KEY_PATH || './certs/jwt.pub')
    );
  }
  return _pubKey;
}

// ── Token file helpers ───────────────────────────────────────────────────────

function _load() {
  try {
    if (fs.existsSync(TOKENS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
      return Array.isArray(raw.refreshTokens) ? raw.refreshTokens : [];
    }
  } catch {}
  return [];
}

function _save(tokens) {
  if (!fs.existsSync(STORAGE_PATH)) fs.mkdirSync(STORAGE_PATH, { recursive: true });
  const tmp = TOKENS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ refreshTokens: tokens }, null, 2));
  fs.renameSync(tmp, TOKENS_FILE);
}

// ── JWT helpers ──────────────────────────────────────────────────────────────

/**
 * Issue a short-lived RS256 access token (default 15 m).
 */
function issueAccessToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, name: user.name },
    getPrivKey(),
    { algorithm: 'RS256', expiresIn: process.env.JWT_ACCESS_EXPIRES || '15m' }
  );
}

/**
 * Issue a refresh token (random 40-byte hex), persist its SHA-256 hash, and
 * return the raw token to send to the client via an HttpOnly cookie.
 */
function issueRefreshToken(user) {
  const token     = crypto.randomBytes(40).toString('hex');
  const tokenHash = hashToken(token);
  const expiresIn = process.env.JWT_REFRESH_EXPIRES || '7d';
  const msMap     = { d: 864e5, h: 36e5, m: 6e4, s: 1e3 };
  const match     = expiresIn.match(/^(\d+)([dhms])$/);
  const expiresAt = match
    ? new Date(Date.now() + parseInt(match[1]) * (msMap[match[2]] || 864e5)).toISOString()
    : new Date(Date.now() + 7 * 864e5).toISOString();

  const tokens = _load();
  tokens.push({
    id:        uuidv4(),
    tokenHash,
    userId:    user.id,
    issuedAt:  new Date().toISOString(),
    expiresAt,
    revoked:   false,
  });
  _save(tokens);
  return token;
}

/**
 * Validate a refresh token. Returns the stored record if valid, null otherwise.
 */
function validateRefreshToken(rawToken) {
  const hash    = hashToken(rawToken);
  const tokens  = _load();
  const record  = tokens.find(t => t.tokenHash === hash);
  if (!record)               return null;
  if (record.revoked)        return null;
  if (new Date(record.expiresAt) < new Date()) return null;
  return record;
}

/**
 * Revoke a refresh token by its raw value.
 */
function revokeRefreshToken(rawToken) {
  const hash   = hashToken(rawToken);
  const tokens = _load();
  const record = tokens.find(t => t.tokenHash === hash);
  if (record) {
    record.revoked = true;
    _save(tokens);
  }
}

/**
 * Revoke all refresh tokens belonging to a user (e.g. on password change).
 */
function revokeAllForUser(userId) {
  const tokens  = _load();
  let changed   = false;
  for (const t of tokens) {
    if (t.userId === userId && !t.revoked) { t.revoked = true; changed = true; }
  }
  if (changed) _save(tokens);
}

/** SHA-256 hex of a token string. */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Prune expired / revoked tokens older than 30 days (maintenance). */
function pruneExpired() {
  const cutoff = new Date(Date.now() - 30 * 864e5);
  const tokens = _load().filter(t =>
    !(t.revoked && new Date(t.expiresAt) < cutoff)
  );
  _save(tokens);
}

module.exports = {
  issueAccessToken,
  issueRefreshToken,
  validateRefreshToken,
  revokeRefreshToken,
  revokeAllForUser,
  hashToken,
  pruneExpired,
};
