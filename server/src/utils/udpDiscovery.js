'use strict';

// WiseNet/Hanwha SUNAPI UDP camera discovery ("IP Scan for SUNAPI" —
// SUNAPI IP Installer spec §3.4). The actual implementation lives in the
// `@melchi45/wisenet-udp-discovery` npm dependency (server/package.json,
// GitHub Packages — see server/.npmrc.example) — the Node.js port of the
// WiseNetChromeIPInstaller Chrome extension's UDP broadcast discovery. This
// file has no independent socket-opening/parsing implementation of its own,
// and does not read from any git submodule path — the npm package (an
// ordinary `npm install`) is the sole install path this file resolves
// against. The package's own `main` entry is a CLI demo that runs discovery
// as a side effect on require(), so this imports the `udpDiscovery`
// submodule path directly rather than the package root (see the package's
// README "Installing this package in another project").
//
// Resolution is deferred to first actual use (a call to getUDPDiscovery(),
// or access to one of the properties defined below) rather than done at
// require() time. This matters concretely: `discoveryService.js` requires
// this module unconditionally, and `index.js` requires `discoveryService.js`
// unconditionally, in every SERVER_MODE — including `analysis`, which has
// no cameras and never calls getUDPDiscovery() at all. An eager
// `require('@melchi45/wisenet-udp-discovery/...')` at the top of this file
// crashes server startup in that mode whenever the package isn't installed,
// even though nothing there ever needed camera discovery in the first
// place (regression found live 2026-07-03, analysis-mode server).
const PACKAGE = '@melchi45/wisenet-udp-discovery/udpDiscovery';

let _impl = null;

function _resolveImpl() {
  if (_impl) return _impl;
  try {
    _impl = require(PACKAGE);
    return _impl;
  } catch (err) {
    throw new Error(
      `WiseNet UDP discovery implementation not found (${PACKAGE}). Run ` +
      '`npm install` in server/ (@melchi45/wisenet-udp-discovery optionalDependency ' +
      '— GitHub Packages, requires server/.npmrc; see server/.npmrc.example).\n' +
      `  - ${err.message}`
    );
  }
}

/** @returns {typeof import('@melchi45/wisenet-udp-discovery/udpDiscovery').UDPDiscovery} */
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
