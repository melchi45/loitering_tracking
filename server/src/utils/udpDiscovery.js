'use strict';

// WiseNet/Hanwha SUNAPI UDP camera discovery ("IP Scan for SUNAPI" —
// SUNAPI IP Installer spec §3.4). The actual implementation lives in
// submodules/WiseNetChromeIPInstaller/nodejs/ — reachable two ways, tried
// in order: the git submodule path, or the `wisenet-chrome-ip-installer`
// npm optionalDependency (server/package.json) — same source, two install
// paths. This file has no independent socket-opening/parsing
// implementation of its own.
//
// Resolution is deferred to first actual use (a call to getUDPDiscovery(),
// or access to one of the properties defined below) rather than done at
// require() time. This matters concretely: `discoveryService.js` requires
// this module unconditionally, and `index.js` requires `discoveryService.js`
// unconditionally, in every SERVER_MODE — including `analysis`, which has
// no cameras and never calls getUDPDiscovery() at all. An eager
// `require('wisenet-chrome-ip-installer/...')` at the top of this file
// crashes server startup in that mode if neither install path is present,
// even though nothing there ever needed camera discovery in the first
// place (regression found live 2026-07-03, analysis-mode server, neither
// path installed).
const path = require('path');

const CANDIDATES = [
  path.resolve(__dirname, '..', '..', '..', 'submodules', 'WiseNetChromeIPInstaller', 'nodejs', 'udpDiscovery.js'),
  'wisenet-chrome-ip-installer/nodejs/udpDiscovery',
];

let _impl = null;

function _resolveImpl() {
  if (_impl) return _impl;
  const errors = [];
  for (const candidate of CANDIDATES) {
    try {
      _impl = require(candidate);
      return _impl;
    } catch (err) {
      errors.push(`  - ${candidate}: ${err.message}`);
    }
  }
  throw new Error(
    'WiseNet UDP discovery implementation not found. Either run ' +
    '`git submodule update --init submodules/WiseNetChromeIPInstaller`, or ' +
    '`npm install` in server/ (wisenet-chrome-ip-installer optionalDependency).\n' +
    errors.join('\n')
  );
}

/** @returns {typeof import('wisenet-chrome-ip-installer/nodejs/udpDiscovery').UDPDiscovery} */
function getUDPDiscovery() {
  return _resolveImpl().UDPDiscovery;
}

module.exports = { getUDPDiscovery };

// Re-exported lazily too — property access (not just getUDPDiscovery())
// triggers resolution, so `require('./udpDiscovery')` alone still never
// throws.
for (const key of [
  'UDPDiscovery', 'SEND_PORT', 'RECEIVE_PORT', 'BROADCAST_ADDR',
  'RESPONSE_MODE_SCAN_EXT', 'NMODE', 'NON_SCAN_RESPONSE_MODES',
]) {
  Object.defineProperty(module.exports, key, {
    enumerable: true,
    get() { return _resolveImpl()[key]; },
  });
}
