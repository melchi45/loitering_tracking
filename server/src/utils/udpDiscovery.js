'use strict';

const dgram  = require('dgram');
const { EventEmitter } = require('events');
const path   = require('path');

let _SubmoduleDiscovery = null;
function _isDiscoveryCtor(v) {
  return typeof v === 'function' && typeof v.prototype?.start === 'function';
}

const SUBMODULE_CANDIDATES = [
  path.resolve(__dirname, '..', '..', '..', 'submodules', 'WiseNetChromeIPInstaller', 'nodejs', 'udpDiscovery.js'),
  path.resolve(__dirname, '..', '..', '..', 'submodules', 'WiseNetChromeIPInstaller', 'udpDiscovery.js'),
];

for (const candidate of SUBMODULE_CANDIDATES) {
  try {
    const mod = require(candidate);
    const Ctor = mod.UDPDiscovery || mod.default || mod;
    if (_isDiscoveryCtor(Ctor)) {
      _SubmoduleDiscovery = Ctor;
      console.log(`[UDPDiscovery] Using submodule implementation: ${candidate}`);
      break;
    }
  } catch (_) {
    // try next candidate
  }
}

if (!_SubmoduleDiscovery) {
  console.warn('[UDPDiscovery] Submodule implementation not found. Using inline fallback.');
}

// ─── Inline Fallback Implementation ─────────────────────────────────────────
// Implements WiseNet SUNAPI UDP device discovery broadcast.
// Sends discovery to port 7701 and listens on 7711 (same as legacy tool behavior).

const DISCOVERY_SEND_PORT = 7701;
const DISCOVERY_RECV_PORT = 7711;
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
   * @param {number} [options.sendPort=7701] Broadcast destination port
   * @param {number} [options.recvPort=7711] Local UDP listen port
   */
  constructor(options = {}) {
    super();
    this.timeout  = options.timeout  || DISCOVERY_TIMEOUT;
    this.sendPort = options.sendPort || options.port || DISCOVERY_SEND_PORT;
    this.recvPort = options.recvPort || DISCOVERY_RECV_PORT;
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

    this._socket.bind(this.recvPort, '0.0.0.0', () => {
      try {
        this._socket.setBroadcast(true);
        this._socket.send(
          DISCOVERY_PAYLOAD, 0, DISCOVERY_PAYLOAD.length,
          this.sendPort, DISCOVERY_BROADCAST
        );
        this.emit('listening', { recvPort: this.recvPort, sendPort: this.sendPort });
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
    const model = this._extractTag(text, 'Model')      || this._extractTag(text, 'FriendlyName')    || '';
    const name  = this._extractTag(text, 'Name')       || model || '';
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
