'use strict';

const { getUDPDiscovery } = require('../utils/udpDiscovery');

const SCAN_TIMEOUT  = 8000;  // each scan duration (ms)
const SCAN_INTERVAL = 2000;  // brief pause between scans → effectively continuous

function mapDevice(raw) {
  const mac = (raw.chMac || '').replace(/\xff/g, '').trim();
  const ip  = (raw.chIP  || '').replace(/\xff/g, '').trim();
  if (!ip) return null;

  const model     = (raw.chDeviceNameNew && raw.chDeviceNameNew !== '')
                      ? raw.chDeviceNameNew : (raw.chDeviceName || raw.Model || '');
  const httpPort  = (!raw.nHttpPort  || raw.nHttpPort  === 0) ? 80  : raw.nHttpPort;
  const httpsPort = (!raw.nHttpsPort || raw.nHttpsPort === 0) ? 443 : raw.nHttpsPort;
  const httpType  = raw.httpType != null ? raw.httpType !== 0 : false;

  // Strip non-printable / non-ASCII bytes (fixes garbage after 0.0.0.0\0 in fixed-length fields)
  const clean = (s) => (s || '').replace(/[^\x20-\x7E]/g, '').trim();

  return {
    id:          `${mac}_${ip}`,
    Model:       model,
    Type:        raw.modelType,
    IPAddress:   ip,
    MACAddress:  mac,
    Port:        raw.nPort,
    Channel:     1,
    MaxChannel:  1,
    HttpType:    httpType,
    HttpPort:    httpPort,
    HttpsPort:   httpsPort,
    Gateway:     clean(raw.chGateway),
    SubnetMask:  clean(raw.chSubnetMask),
    SupportSunapi: raw.isSupportSunapi === 1,
    URL:         raw.DDNSURL || '',
    rtspUrl:     raw.rtspUrl,
  };
}

class DiscoveryService {
  constructor(io) {
    this._io    = io;
    this._timer = null;
    this._disc  = null;
    this._known = new Map(); // id → device (persists across scans)
    this._scanning = false;
  }

  start() {
    console.log('[Discovery] Background discovery service started');
    this._runScan();
  }

  stop() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._disc)  { try { this._disc.stop(); } catch (_) {} this._disc = null; }
    this._scanning = false;
  }

  /** Stop current scan, clear all known devices, restart fresh */
  rescan() {
    this.stop();
    this._known.clear();
    this._io.emit('discovery:cleared');
    this._runScan();
  }

  /** Send all currently-known devices to a newly connected socket */
  hydrate(socket) {
    for (const device of this._known.values()) {
      socket.emit('discovery:result', { device });
    }
    socket.emit('discovery:status', {
      scanning: this._scanning,
      count: this._known.size,
    });
  }

  get knownCount() { return this._known.size; }

  _runScan() {
    const UDPDiscovery = getUDPDiscovery();
    let disc;
    try {
      disc = new UDPDiscovery({ timeout: SCAN_TIMEOUT });
    } catch (err) {
      console.error('[Discovery] Failed to create UDPDiscovery:', err.message);
      this._timer = setTimeout(() => this._runScan(), SCAN_INTERVAL);
      return;
    }
    this._disc = disc;
    this._scanning = true;
    this._io.emit('discovery:scanning', { scanning: true });

    disc.on('device', (raw) => {
      const device = mapDevice(raw);
      if (!device) return;
      const prev = this._known.get(device.id);
      this._known.set(device.id, device);
      // Emit to all clients (new device or updated info)
      if (!prev || JSON.stringify(prev) !== JSON.stringify(device)) {
        this._io.emit('discovery:result', { device });
      }
    });

    disc.on('done', () => {
      this._disc = null;
      this._scanning = false;
      this._io.emit('discovery:scanning', { scanning: false, count: this._known.size });
      this._timer = setTimeout(() => this._runScan(), SCAN_INTERVAL);
    });

    disc.on('error', (err) => {
      console.error('[Discovery]', err.message);
      this._disc = null;
      this._scanning = false;
      this._io.emit('discovery:scanning', { scanning: false, count: this._known.size });
      this._timer = setTimeout(() => this._runScan(), SCAN_INTERVAL);
    });

    try {
      disc.start();
    } catch (err) {
      console.error('[Discovery] start failed:', err.message);
      this._disc = null;
      this._scanning = false;
      this._timer = setTimeout(() => this._runScan(), SCAN_INTERVAL);
    }
  }
}

let _svc = null;

function getDiscoveryService(io) {
  if (!_svc && io) _svc = new DiscoveryService(io);
  return _svc;
}

module.exports = { getDiscoveryService };
