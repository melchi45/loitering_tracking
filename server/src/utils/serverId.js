'use strict';

/**
 * Resolves the identifier used to scope per-server-instance settings (e.g.
 * logConfigService.js's `settings` row id) so that multiple server processes
 * sharing one DB_TYPE=mongodb database don't overwrite each other's
 * inherently-per-machine config (see Design_Log_Rotation.md §3A).
 *
 * Kept in its own module (rather than inline in logConfigService.js) so
 * logger.js can also require it without creating a require cycle —
 * logConfigService.js already requires logger.js.
 */

const os = require('os');

/** @returns {string} SERVER_ID env var if set, else the OS hostname. */
function getServerId() {
  return process.env.SERVER_ID || os.hostname();
}

module.exports = { getServerId };
