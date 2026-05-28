'use strict';

const crypto   = require('crypto');
const express  = require('express');
const bcrypt   = require('bcryptjs');
const router   = express.Router();

const UserService   = require('../services/UserService');
const TokenService  = require('../services/TokenService');
const AuditService  = require('../services/AuditService');
const MsalService   = require('../services/MsalService');
const { passport }  = require('../config/passport');
const { verifyAccessToken } = require('../middleware/auth');

const REFRESH_COOKIE = 'refreshToken';
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days in ms

// ── Helpers ──────────────────────────────────────────────────────────────────

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

function cookieOpts(req) {
  return {
    httpOnly: true,
    secure:   req.secure || req.headers['x-forwarded-proto'] === 'https',
    sameSite: 'strict',
    maxAge:   COOKIE_MAX_AGE,
    path:     '/',
  };
}

// ── POST /auth/register ───────────────────────────────────────────────────────
// Body: { email, password, name? }
// Creates a new user. First user is auto-approved as admin; others get status=pending.
router.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'email and password are required' });
    if (password.length < 8)
      return res.status(400).json({ error: 'password must be at least 8 characters' });

    // Check duplicate
    if (UserService.findByEmail(email))
      return res.status(409).json({ error: 'Email already registered' });

    const passwordHash = await bcrypt.hash(password, 12);
    const user = UserService.create({ email, name, passwordHash });

    AuditService.log({
      event:     'signup',
      userId:    user.id,
      email:     user.email,
      ip:        clientIp(req),
      userAgent: req.headers['user-agent'],
    });

    // If auto-approved (first user / admin seed) — issue tokens immediately
    if (user.status === 'active') {
      const accessToken  = TokenService.issueAccessToken(user);
      const refreshToken = TokenService.issueRefreshToken(user);
      UserService.recordLogin(user.id);
      res.cookie(REFRESH_COOKIE, refreshToken, cookieOpts(req));
      return res.status(201).json({ accessToken, user });
    }

    // Otherwise pending — return status so client can redirect to /pending
    return res.status(201).json({ status: 'pending', user });
  } catch (err) {
    console.error('[auth/register]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /auth/login ──────────────────────────────────────────────────────────
// Body: { email, password }
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'email and password are required' });

    const user = UserService.findByEmailWithHash(email);
    if (!user)
      return res.status(401).json({ error: 'Invalid email or password' });

    const valid = await bcrypt.compare(password, user.passwordHash || '');
    if (!valid)
      return res.status(401).json({ error: 'Invalid email or password' });

    if (user.status === 'pending') {
      AuditService.log({ event: 'signin_blocked', userId: user.id, email: user.email, ip: clientIp(req), detail: { reason: 'pending' } });
      return res.status(403).json({ error: 'Account is pending admin approval', status: 'pending' });
    }
    if (user.status === 'rejected') {
      AuditService.log({ event: 'signin_blocked', userId: user.id, email: user.email, ip: clientIp(req), detail: { reason: 'rejected' } });
      return res.status(403).json({ error: 'Account has been rejected', status: 'rejected' });
    }
    if (user.status === 'revoked') {
      AuditService.log({ event: 'signin_blocked', userId: user.id, email: user.email, ip: clientIp(req), detail: { reason: 'revoked' } });
      return res.status(403).json({ error: 'Account has been revoked', status: 'revoked' });
    }

    const { passwordHash: _, ...safeUser } = user;
    const accessToken  = TokenService.issueAccessToken(safeUser);
    const refreshToken = TokenService.issueRefreshToken(safeUser);
    UserService.recordLogin(user.id);

    AuditService.log({
      event:     'signin',
      userId:    user.id,
      email:     user.email,
      ip:        clientIp(req),
      userAgent: req.headers['user-agent'],
    });

    res.cookie(REFRESH_COOKIE, refreshToken, cookieOpts(req));
    return res.json({ accessToken, user: safeUser });
  } catch (err) {
    console.error('[auth/login]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /auth/refresh ────────────────────────────────────────────────────────
// Cookie: refreshToken
router.post('/refresh', async (req, res) => {
  try {
    const raw = req.cookies[REFRESH_COOKIE];
    if (!raw) return res.status(401).json({ error: 'No refresh token' });

    const record = TokenService.validateRefreshToken(raw);
    if (!record)  return res.status(401).json({ error: 'Invalid or expired refresh token' });

    const user = UserService.findById(record.userId);
    if (!user || user.status !== 'active')
      return res.status(403).json({ error: 'Account is not active' });

    // Rotate: revoke old, issue new
    TokenService.revokeRefreshToken(raw);
    const newRefresh = TokenService.issueRefreshToken(user);
    const accessToken = TokenService.issueAccessToken(user);

    AuditService.log({ event: 'token_refresh', userId: user.id, email: user.email, ip: clientIp(req) });

    res.cookie(REFRESH_COOKIE, newRefresh, cookieOpts(req));
    return res.json({ accessToken });
  } catch (err) {
    console.error('[auth/refresh]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /auth/logout ─────────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  const raw = req.cookies[REFRESH_COOKIE];
  if (raw) {
    const record = TokenService.validateRefreshToken(raw);
    if (record) {
      AuditService.log({ event: 'logout', userId: record.userId, ip: clientIp(req) });
    }
    TokenService.revokeRefreshToken(raw);
  }
  res.clearCookie(REFRESH_COOKIE, { path: '/' });
  res.json({ ok: true });
});

// ── GET /auth/me ──────────────────────────────────────────────────────────────
router.get('/me', verifyAccessToken, (req, res) => {
  const user = UserService.findById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

// ═══════════════════════════════════════════════════════════════════════════════
// OAUTH 2.0 — Google & Microsoft
// After a successful OAuth callback the server:
//  1. Creates / links the user account
//  2. Issues a JWT refresh token (HttpOnly cookie)
//  3. Redirects the browser back to the React SPA
//     /?auth=success  → SPA calls /auth/refresh to get access token
//     /?auth=pending  → SPA shows "awaiting approval" page
//     /?auth=denied   → SPA shows "access denied" on sign-in page
//     /?auth=error    → SPA shows generic error on sign-in page
// ═══════════════════════════════════════════════════════════════════════════════

/** Primary frontend origin (first entry in CLIENT_ORIGIN). */
function spaOrigin() {
  return (process.env.CLIENT_ORIGIN || 'https://localhost:5173')
    .split(',')[0]
    .trim()
    .replace(/\/$/, '');
}

/** Issue tokens, set refresh cookie, redirect to SPA after successful OAuth. */
async function _handleOAuthSuccess(req, res, user) {
  if (!user) return res.redirect(`${spaOrigin()}/?auth=error`);

  if (user.status === 'pending') {
    AuditService.log({ event: 'signup', userId: user.id, email: user.email, ip: clientIp(req) });
    return res.redirect(`${spaOrigin()}/?auth=pending`);
  }
  if (user.status !== 'active') {
    AuditService.log({
      event:  'signin_blocked',
      userId: user.id,
      email:  user.email,
      ip:     clientIp(req),
      detail: { reason: user.status },
    });
    return res.redirect(`${spaOrigin()}/?auth=denied`);
  }

  const accessToken = TokenService.issueAccessToken(user);
  const rawRefresh  = TokenService.issueRefreshToken(user);
  UserService.recordLogin(user.id);

  AuditService.log({ event: 'signin', userId: user.id, email: user.email, ip: clientIp(req) });

  // sameSite:'lax' is required so the cookie is accepted after the cross-site
  // OAuth redirect (strict would block it on the first SPA load after redirect).
  res.cookie(REFRESH_COOKIE, rawRefresh, {
    httpOnly: true,
    secure:   req.secure || req.headers['x-forwarded-proto'] === 'https',
    sameSite: 'lax',
    maxAge:   COOKIE_MAX_AGE,
    path:     '/',
  });

  // Redirect to SPA — the SPA will call POST /auth/refresh to get the access token.
  res.redirect(`${spaOrigin()}/?auth=success`);
}

// ── GET /auth/google ──────────────────────────────────────────────────────────
router.get('/google', (req, res, next) => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.redirect(`${spaOrigin()}/?auth=error&reason=not_configured`);
  }
  passport.authenticate('google', {
    scope: ['openid', 'email', 'profile'],
  })(req, res, next);
});

// ── GET /auth/google/callback ─────────────────────────────────────────────────
router.get(
  '/google/callback',
  (req, res, next) => {
    passport.authenticate('google', { failWithError: true })(req, res, next);
  },
  async (req, res) => {
    await _handleOAuthSuccess(req, res, req.user);
  },
  // eslint-disable-next-line no-unused-vars
  (err, req, res, _next) => {
    console.error('[auth/google/callback] OAuth error:', err?.message, err?.oauthError || '');
    res.redirect(`${spaOrigin()}/?auth=error`);
  },
);

// ── GET /auth/microsoft ────────────────────────────────────────────────────────
router.get('/microsoft', async (req, res) => {
  if (!MsalService.isConfigured()) {
    return res.redirect(`${spaOrigin()}/?auth=error&reason=not_configured`);
  }
  try {
    const state = crypto.randomBytes(16).toString('hex');
    req.session.msOauthState = state;
    const url = await MsalService.getAuthCodeUrl(state);
    res.redirect(url);
  } catch (err) {
    console.error('[auth/microsoft]', err.message);
    res.redirect(`${spaOrigin()}/?auth=error`);
  }
});

// ── GET /auth/microsoft/callback ──────────────────────────────────────────────
router.get('/microsoft/callback', async (req, res) => {
  try {
    if (req.query.error) {
      console.error('[auth/microsoft/callback]', req.query.error, req.query.error_description);
      return res.redirect(`${spaOrigin()}/?auth=error&reason=${encodeURIComponent(req.query.error)}`);
    }

    // CSRF state verification
    const storedState = req.session?.msOauthState;
    if (!storedState || req.query.state !== storedState) {
      return res.redirect(`${spaOrigin()}/?auth=error&reason=state_mismatch`);
    }
    delete req.session.msOauthState;

    const result  = await MsalService.acquireTokenByCode(String(req.query.code));
    const claims  = result.idTokenClaims || {};
    const email   = claims.email || claims.preferred_username || result.account?.username;
    const name    = claims.name  || result.account?.name || email;
    const oid     = claims.oid   || result.uniqueId;

    if (!email) throw new Error('No email returned by Microsoft');

    const user = UserService.upsertOAuthUser({
      provider:   'microsoft',
      providerId: oid,
      email,
      name,
    });

    await _handleOAuthSuccess(req, res, user);
  } catch (err) {
    console.error('[auth/microsoft/callback]', err.message);
    res.redirect(`${spaOrigin()}/?auth=error`);
  }
});

module.exports = router;
