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
    req.user = jwt.verify(token, getPublicKey(), { algorithms: ['RS256'] });
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
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
    try { req.user = jwt.verify(token, getPublicKey(), { algorithms: ['RS256'] }); } catch {}
  }
  next();
}

module.exports = { verifyAccessToken, optionalToken };
