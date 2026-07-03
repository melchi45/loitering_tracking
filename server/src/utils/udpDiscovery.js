'use strict';

// WiseNet/Hanwha SUNAPI UDP camera discovery ("IP Scan for SUNAPI" —
// SUNAPI IP Installer spec §3.4). Implementation lives entirely in the
// `wisenet-chrome-ip-installer` npm dependency (server/package.json), the
// Node.js port of the WiseNetChromeIPInstaller Chrome extension's UDP
// broadcast discovery — this file is a thin re-export, no independent
// socket-opening/parsing implementation here. Previously this file had a
// submodule-path-detection layer plus a fully duplicated inline fallback
// (`UDPDiscoveryFallback`) for when the git submodule wasn't initialised;
// both are gone now that the same code is a regular `npm install`ed
// dependency (see docs/design/Design_Camera_Discovery.md §3.1e/§3.1f).
const {
  UDPDiscovery, SEND_PORT, RECEIVE_PORT, BROADCAST_ADDR,
  RESPONSE_MODE_SCAN_EXT, NMODE, NON_SCAN_RESPONSE_MODES,
} = require('wisenet-chrome-ip-installer/nodejs/udpDiscovery');

/** @returns {typeof UDPDiscovery} */
function getUDPDiscovery() {
  return UDPDiscovery;
}

module.exports = {
  getUDPDiscovery,
  UDPDiscovery,
  SEND_PORT, RECEIVE_PORT, BROADCAST_ADDR,
  RESPONSE_MODE_SCAN_EXT, NMODE, NON_SCAN_RESPONSE_MODES,
};
