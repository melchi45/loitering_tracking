'use strict';

/**
 * Microsoft MSAL service — Authorization Code flow
 *
 * Required env vars:
 *   MICROSOFT_CLIENT_ID     — from Azure Portal → App registrations → Application (client) ID
 *   MICROSOFT_CLIENT_SECRET — from App registrations → Certificates & secrets → New client secret
 *   MICROSOFT_TENANT_ID     — Tenant ID (or "common" for multi-tenant / personal accounts)
 *   OAUTH_CALLBACK_BASE     — base URL of THIS server, e.g. https://localhost:3443
 *                             Must match the "Redirect URI" registered in Azure:
 *                             {OAUTH_CALLBACK_BASE}/auth/microsoft/callback
 */

const msal = require('@azure/msal-node');

let _app = null;

function _callbackBase() {
  return (process.env.OAUTH_CALLBACK_BASE || 'https://localhost:3443').replace(/\/$/, '');
}

function getApp() {
  if (_app) return _app;
  if (!process.env.MICROSOFT_CLIENT_ID || !process.env.MICROSOFT_CLIENT_SECRET) return null;

  _app = new msal.ConfidentialClientApplication({
    auth: {
      clientId:     process.env.MICROSOFT_CLIENT_ID,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
      authority:    `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID || 'common'}`,
    },
  });
  return _app;
}

function isConfigured() {
  return !!(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET);
}

/**
 * Return the Microsoft OAuth authorization URL (with a CSRF state parameter).
 * @param {string} state — random nonce stored server-side for CSRF verification
 */
async function getAuthCodeUrl(state) {
  const app = getApp();
  if (!app) throw new Error('Microsoft OAuth not configured (missing MICROSOFT_CLIENT_ID)');
  return app.getAuthCodeUrl({
    scopes:      ['openid', 'profile', 'email'],
    redirectUri: `${_callbackBase()}/auth/microsoft/callback`,
    state,
  });
}

/**
 * Exchange an authorization code for tokens.
 * Returns the full MSAL AuthenticationResult.
 */
async function acquireTokenByCode(code) {
  const app = getApp();
  if (!app) throw new Error('Microsoft OAuth not configured');
  return app.acquireTokenByCode({
    code,
    scopes:      ['openid', 'profile', 'email'],
    redirectUri: `${_callbackBase()}/auth/microsoft/callback`,
  });
}

module.exports = { isConfigured, getAuthCodeUrl, acquireTokenByCode };
