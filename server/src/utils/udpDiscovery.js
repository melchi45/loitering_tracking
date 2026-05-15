'use strict';

const dgram  = require('dgram');
const { EventEmitter } = require('events');
const path   = require('path');

const SUBMODULE_PATH = path.resolve(
  __dirname,
  '..', '..', '..', 'submodules',
  'WiseNetChromeIPInstaller', 'nodejs', 'udpDiscovery.js'
);

let _SubmoduleDiscovery = null;
try {
  const mod = require(SUBMODULE_PATH);
  _SubmoduleDiscovery = mod.UDPDiscovery || mod.default || mod;
} catch (_) {
  // Submodule not initialised — use inline fallback
}

// ─── Inline Fallback Implementation ─────────────────────────────────────────
// Implements WiseNet SUNAPI UDP device discovery broadcast.
// Sends a discovery broadcast to port 7700 and parses XML-like responses.

const DISCOVERY_PORT      = 7700;
const DISCOVERY_BROADCAST = '255.255.255.255';
const DISCOVERY_TIMEOUT   = 5000; // ms
const DISCOVERY_PAYLOAD   = Buffer.from(
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope">' +
  '<Header/><Body>' +
  '<Probe><Types>NetworkVideoTransmitter</Types></Probe>' +
  '</Body></Envelope>'
);

class UDPDiscoveryFallback extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {number} [options.timeout=5000]  Discovery window in ms
   * @param {number} [options.port=7700]     Broadcast port
   */
  constructor(options = {}) {
    super();
    this.timeout  = options.timeout  || DISCOVERY_TIMEOUT;
    this.port     = options.port     || DISCOVERY_PORT;
    this._socket  = null;
    this._timer   = null;
    this._seen    = new Set();
  }

  /** Start UDP discovery broadcast. Emits 'device' for each discovered camera. */
  start() {
    this._socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    this._socket.on('error', (err) => {
      this.emit('error', err);
      this.stop();
    });

    this._socket.on('message', (msg, rinfo) => {
      if (this._seen.has(rinfo.address)) return;
      this._seen.add(rinfo.address);

      const device = this._parseResponse(msg, rinfo);
      if (device) this.emit('device', device);
    });

    this._socket.bind(() => {
      try {
        this._socket.setBroadcast(true);
        this._socket.send(
          DISCOVERY_PAYLOAD, 0, DISCOVERY_PAYLOAD.length,
          this.port, DISCOVERY_BROADCAST
        );
      } catch (err) {
        this.emit('error', err);
      }
    });

    this._timer = setTimeout(() => this.stop(), this.timeout);
  }

  /** Stop discovery and release the socket. */
  stop() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._socket) {
      try { this._socket.close(); } catch (_) {}
      this._socket = null;
    }
    this.emit('done');
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  _parseResponse(buf, rinfo) {
    const text = buf.toString('utf8');
    // Extract common fields from ONVIF/WiseNet XML response
    const ip    = rinfo.address;
    const mac   = this._extractTag(text, 'MACAddress') || this._extractTag(text, 'HardwareAddress') || null;
    const model = this._extractTag(text, 'Model')      || this._extractTag(text, 'FriendlyName')    || 'Unknown';
    const name  = this._extractTag(text, 'Name')       || model;
    const xaddr = this._extractTag(text, 'XAddrs')     || null;

    // Try to derive HTTP port from XAddrs
    let httpPort = 80;
    if (xaddr) {
      try {
        const u = new URL(xaddr.split(' ')[0]);
        httpPort = parseInt(u.port) || 80;
      } catch (_) {}
    }

    return { ip, mac, name, model, httpPort, raw: text.slice(0, 512) };
  }

  _extractTag(text, tag) {
    const re = new RegExp(`<(?:[^:]+:)?${tag}[^>]*>([^<]*)<`, 'i');
    const m  = text.match(re);
    return m ? m[1].trim() : null;
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

/**
 * Returns the best available UDPDiscovery implementation.
 * Uses the submodule version if the submodule is initialised, otherwise
 * falls back to the inline WiseNet UDP broadcast implementation.
 * @returns {typeof UDPDiscoveryFallback}
 */
function getUDPDiscovery() {
  return _SubmoduleDiscovery || UDPDiscoveryFallback;
}

module.exports = { getUDPDiscovery, UDPDiscoveryFallback };
