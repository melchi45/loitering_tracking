'use strict';

/**
 * Passport configuration — Google OAuth 2.0
 *
 * Required env vars:
 *   GOOGLE_CLIENT_ID      — from Google Cloud Console → APIs & Services → Credentials
 *   GOOGLE_CLIENT_SECRET  — same location
 *   OAUTH_CALLBACK_BASE   — base URL of THIS server, e.g. https://localhost:3443
 *                           Must match the "Authorized redirect URIs" entry:
 *                           {OAUTH_CALLBACK_BASE}/auth/google/callback
 */

const https         = require('https');
const passport      = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const UserService   = require('../services/UserService');

passport.serializeUser((user, done) => done(null, user.id));

passport.deserializeUser((id, done) => {
  const user = UserService.findById(id);
  done(null, user || false);
});

/**
 * Call once at server startup after env is loaded.
 * Skipped (with a warning) if credentials are not set.
 */
function setup() {
  const callbackBase = (process.env.OAUTH_CALLBACK_BASE || 'https://localhost:3443')
    .replace(/\/$/, '');

  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    const strategy = new GoogleStrategy(
      {
        clientID:     process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL:  `${callbackBase}/auth/google/callback`,
      },
      async (_accessToken, _refreshToken, profile, done) => {
        try {
          const email = profile.emails?.[0]?.value;
          if (!email) return done(new Error('No email returned by Google'));
          const user = UserService.upsertOAuthUser({
            provider:   'google',
            providerId: profile.id,
            email,
            name:       profile.displayName,
          });
          done(null, user);
        } catch (err) {
          done(err);
        }
      },
    );

    // The token exchange (code → access_token) is an outbound server→Google HTTPS
    // request. On some systems the Node.js CA bundle does not include the Google
    // root CA that signed oauth2.googleapis.com, causing SELF_SIGNED_CERT_IN_CHAIN.
    // We set a dedicated agent for this ONE connection only (not for incoming TLS).
    strategy._oauth2.setAgent(new https.Agent({ rejectUnauthorized: false }));

    passport.use(strategy);
    console.log('[Auth] Google OAuth strategy registered');
  } else {
    console.warn('[Auth] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set — Google OAuth disabled');
  }
}

module.exports = { passport, setup };
