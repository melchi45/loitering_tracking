'use strict';

const crypto = require('crypto');

/**
 * Computes an RFC 7616 Digest Authorization header from a `WWW-Authenticate`
 * challenge string. Supports the common `qop=auth` case (and falls back to
 * the qop-less RFC 2069 form some embedded HTTP servers still send).
 * MD5 only — no camera/NVR firmware observed advertising SHA-256.
 *
 * Shared by discoveryService.js (SUNAPI CGI, FR-CAM-072/089) and
 * onvifDiscovery.js (ONVIF SOAP, FR-CAM-090) — both talk to the same class
 * of embedded HTTP servers that reject Basic outright and require Digest.
 */
function buildDigestAuthHeader(challenge, method, uri, username, password) {
  // A server can offer multiple schemes in one WWW-Authenticate header
  // (Node joins repeated headers with ", "), e.g.
  // `Basic realm="x", Digest realm="y", qop="auth", nonce="..."`. Scope
  // param lookups to the Digest portion only — reading realm/nonce/qop from
  // the full string would risk picking up Basic's realm instead.
  const digestChallenge = challenge.replace(/^[\s\S]*?\bDigest\b\s*/i, '');
  const param = (name) => {
    const m = digestChallenge.match(new RegExp(`${name}="?([^",]+)"?`, 'i'));
    return m ? m[1] : null;
  };
  const realm  = param('realm')  || '';
  const nonce  = param('nonce')  || '';
  const opaque = param('opaque');
  const qopOffered = (param('qop') || '').split(',').map((s) => s.trim());
  const qop    = qopOffered.includes('auth') ? 'auth' : null;
  const nc     = '00000001';
  const cnonce = crypto.randomBytes(8).toString('hex');

  const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);

  let header = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
  if (qop)    header += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  if (opaque) header += `, opaque="${opaque}"`;
  return header;
}

/** True if a `WWW-Authenticate` challenge string advertises the Digest scheme
 *  — word-boundary match, not string-start anchored, since a server can join
 *  multiple schemes into one combined header (see buildDigestAuthHeader() above). */
function challengesDigest(challenge) {
  return /\bDigest\b/i.test(challenge || '');
}

module.exports = { buildDigestAuthHeader, challengesDigest };
