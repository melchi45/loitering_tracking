'use strict';

const jwt  = require('jsonwebtoken');
const fs   = require('fs');
const path = require('path');

let _pubKey = null;

function getPublicKey() {
  if (!_pubKey) {
    const keyPath = path.resolve(
      __dirname, '../../',
      process.env.JWT_PUBLIC_KEY_PATH || './certs/jwt.pub'
    );
    _pubKey = fs.readFileSync(keyPath);
  }
  return _pubKey;
}

/**
 * Pure JWT verify (RS256) — no req/res, so it's usable outside Express
 * middleware too (2026-07-21, added for Socket.IO event-level auth — see
 * verifySocketAdmin below). Throws on invalid/expired token, same as
 * jwt.verify() itself; callers catch.
 */
function verifyToken(token) {
  return jwt.verify(token, getPublicKey(), { algorithms: ['RS256'] });
}

/**
 * Express middleware — verifies Bearer JWT (RS256) in Authorization header.
 * Sets req.user = { sub, email, role, iat, exp } on success.
 */
function verifyAccessToken(req, res, next) {
  // Auth can be globally disabled for development
  if (process.env.AUTH_ENABLED === 'false') {
    req.user = { sub: 'dev', email: 'dev@lts.local', role: 'admin' };
    return next();
  }

  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });

  try {
    req.user = verifyToken(token);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Verifies a JWT belongs to an admin — for Socket.IO events carrying
 * sensitive data (2026-07-21, ingest-daemon stats: RTSP URLs embed camera
 * credentials). Unlike this file's other Socket.IO-adjacent events
 * (server:log/admin:subscribe-logs in utils/logger.js), which broadcast via
 * io.emit() with no server-side role check at all, anything carrying
 * credentials must not follow that precedent. Returns true/false, never
 * throws — callers use it as a simple gate before adding a socket to a
 * subscriber set.
 */
function verifySocketAdmin(token) {
  if (process.env.AUTH_ENABLED === 'false') return true;
  if (!token) return false;
  try {
    return verifyToken(token).role === 'admin';
  } catch {
    return false;
  }
}

/**
 * Optional middleware — if a token is present and valid, populates req.user.
 * Does NOT reject the request if there is no token.
 */
function optionalToken(req, res, next) {
  if (process.env.AUTH_ENABLED === 'false') {
    req.user = { sub: 'dev', email: 'dev@lts.local', role: 'admin' };
    return next();
  }
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token) {
    try { req.user = verifyToken(token); } catch {}
  }
  next();
}

module.exports = { verifyAccessToken, optionalToken, verifyToken, verifySocketAdmin };
