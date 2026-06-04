'use strict';

const { getUDPDiscovery }  = require('../utils/udpDiscovery');
const { ONVIFDiscovery }   = require('./onvifDiscovery');

const SCAN_TIMEOUT  = 10000; // each scan duration (ms)
const SCAN_INTERVAL = 15000; // pause between scans — long enough for cameras to reset rate limits

// ─── UDP device mapper ────────────────────────────────────────────────────────

function mapUDPDevice(raw) {
  const clean = (v) => String(v || '').replace(/\xff/g, '').replace(/[^\x20-\x7E]/g, '').trim();

  // Accept both WiseNet submodule shape (chIP/chMac/...) and
  // inline fallback shape (ip/mac/model/httpPort/...)
  const mac = clean(raw.chMac || raw.MACAddress || raw.mac);
  const ip  = clean(raw.chIP  || raw.IPAddress  || raw.ip);
  if (!ip) return null;

  const model     = clean(
    (raw.chDeviceNameNew && raw.chDeviceNameNew !== '')
      ? raw.chDeviceNameNew
      : (raw.chDeviceName || raw.Model || raw.model || raw.name)
  );

  const resolvePort = (a, b, fallback) => {
    const v = parseInt(a != null ? a : b, 10);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };

  const httpPort  = resolvePort(raw.nHttpPort,  raw.httpPort ?? raw.HttpPort,  80);
  const httpsPort = resolvePort(raw.nHttpsPort, raw.httpsPort ?? raw.HttpsPort, 443);
  const rtspPort  = resolvePort(raw.nPort,      raw.Port,                    554);
  const httpType  = raw.httpType != null
    ? raw.httpType !== 0
    : (raw.HttpType != null ? !!raw.HttpType : false);

  const rtspUrl = clean(raw.rtspUrl) || `rtsp://${ip}:${rtspPort}/`;
  const gateway = clean(raw.chGateway || raw.Gateway);
  const subnet  = clean(raw.chSubnetMask || raw.SubnetMask);
  const ddnsUrl = clean(raw.DDNSURL || raw.URL);
  const supportSunapi = raw.isSupportSunapi === 1 || raw.SupportSunapi === true;
  const supportOnvif  = raw.SupportOnvif !== false;
  const id = mac ? `${mac}_${ip}` : `ip_${ip}`;

  return {
    id,
    source:       'udp',
    Model:        model,
    Manufacturer: 'Hanwha Vision',
    Type:         raw.modelType,
    IPAddress:    ip,
    MACAddress:   mac,
    Port:         rtspPort,
    Channel:      1,
    MaxChannel:   1,
    HttpType:     httpType,
    HttpPort:     httpPort,
    HttpsPort:    httpsPort,
    Gateway:      gateway,
    SubnetMask:   subnet,
    SupportSunapi: supportSunapi,
    SupportOnvif:  supportOnvif,
    URL:          ddnsUrl,
    rtspUrl,
    profiles:     [],
  };
}

// ─── Merge helpers ────────────────────────────────────────────────────────────

/** Return the registry key for a device — prefers MAC, falls back to IP. */
function deviceKey(dev) {
  if (dev.MACAddress && dev.MACAddress.length > 5) return `mac_${dev.MACAddress}`;
  return `ip_${dev.IPAddress}`;
}

/**
 * Merge an incoming device into an existing one.
 * UDP result wins for Hanwha-specific fields; ONVIF enrichment wins for
 * Manufacturer/FirmwareVersion/SerialNumber/profiles/rtspUrl.
 */
function mergeDevices(existing, incoming) {
  const merged = { ...existing };

  const hasMeaningful = (v) => {
    const s = String(v || '').trim();
    if (!s) return false;
    return !/^unknown$/i.test(s);
  };

  // Source badge
  if (existing.source !== incoming.source) merged.source = 'both';

  // Fill in empty basic fields (never overwrite existing data)
  for (const key of ['Model', 'Manufacturer', 'MACAddress', 'FirmwareVersion',
                      'SerialNumber', 'Gateway', 'SubnetMask', 'URL']) {
    if (!hasMeaningful(merged[key]) && hasMeaningful(incoming[key])) {
      merged[key] = incoming[key];
    }
  }

  // rtspUrl: prefer a real GetStreamUri URL over the fallback 'rtsp://ip:554/'
  if (incoming.rtspUrl) {
    const fallback = `rtsp://${incoming.IPAddress || existing.IPAddress}:554/`;
    if (!merged.rtspUrl || incoming.rtspUrl !== fallback) {
      merged.rtspUrl = incoming.rtspUrl;
    }
  }

  // Capabilities: OR them together
  if (incoming.SupportSunapi) merged.SupportSunapi = true;
  if (incoming.SupportOnvif)  merged.SupportOnvif  = true;

  // ONVIF profiles: take the richer list
  if ((incoming.profiles?.length || 0) > (merged.profiles?.length || 0)) {
    merged.profiles = incoming.profiles;
  }

  return merged;
}

// ─── DiscoveryService ─────────────────────────────────────────────────────────

class DiscoveryService {
  constructor(io) {
    this._io       = io;
    this._timer    = null;
    this._udpDisc  = null;
    this._onvifDisc = null;
    this._known    = new Map();   // deviceKey → device
    this._ipIndex  = new Map();   // IPAddress → deviceKey  (for cross-protocol dedup)
    this._scanning = false;
    this._pendingDone = 0;        // counts how many protocols are still running
  }

  start() {
    console.log('[Discovery] Background discovery started (UDP + ONVIF)');
    this._runScan();
  }

  stop() {
    // Set these first — _onProtocolDone() checks _scanning to skip stray callbacks
    this._scanning    = false;
    this._pendingDone = 0;
    if (this._timer)     { clearTimeout(this._timer); this._timer = null; }
    if (this._udpDisc)   { try { this._udpDisc.stop();   } catch (_) {} this._udpDisc   = null; }
    if (this._onvifDisc) { try { this._onvifDisc.stop(); } catch (_) {} this._onvifDisc = null; }
  }

  rescan() {
    this.stop();
    this._known.clear();
    this._ipIndex.clear();
    this._io.emit('discovery:cleared');
    this._runScan();
  }

  hydrate(socket) {
    for (const device of this._known.values()) {
      socket.emit('discovery:result', { device });
    }
    socket.emit('discovery:scanning', {
      scanning: this._scanning,
      count: this._known.size,
    });
  }

  get knownCount() { return this._known.size; }

  // ── Internal ────────────────────────────────────────────────────────────────

  _upsert(device) {
    // Check if we already know this IP under a different key (cross-protocol merge)
    let key = deviceKey(device);
    const existingKeyByIp = this._ipIndex.get(device.IPAddress);

    if (existingKeyByIp && existingKeyByIp !== key) {
      // Same camera discovered by both protocols — merge under existing key
      const existing = this._known.get(existingKeyByIp);
      const merged   = mergeDevices(existing, device);
      this._known.set(existingKeyByIp, merged);
      if (device.MACAddress) this._ipIndex.set(device.IPAddress, existingKeyByIp);
      return merged;
    }

    // New or same-protocol update
    const prev   = this._known.get(key);
    const merged = prev ? mergeDevices(prev, device) : device;
    this._known.set(key, merged);
    this._ipIndex.set(device.IPAddress, key);
    return merged;
  }

  _emit(device) {
    this._io.emit('discovery:result', { device });
  }

  _onProtocolDone() {
    if (!this._scanning) return;  // stop() was called — ignore stray done events
    this._pendingDone--;
    if (this._pendingDone <= 0) {
      this._pendingDone = 0;
      this._scanning    = false;
      this._io.emit('discovery:scanning', { scanning: false, count: this._known.size });
      this._timer = setTimeout(() => this._runScan(), SCAN_INTERVAL);
    }
  }

  _runScan() {
    this._scanning    = true;
    this._pendingDone = 2;   // UDP + ONVIF
    this._io.emit('discovery:scanning', { scanning: true });

    // ── UDP (WiseNet) ──────────────────────────────────────────────────────
    const UDPDiscovery = getUDPDiscovery();
    try {
      const udp = new UDPDiscovery({ timeout: SCAN_TIMEOUT });
      this._udpDisc = udp;

      udp.on('device', (raw) => {
        const device = mapUDPDevice(raw);
        if (!device) return;
        const merged = this._upsert(device);
        this._emit(merged);
      });

      udp.on('done',  () => { this._udpDisc = null;  this._onProtocolDone(); });
      udp.on('error', (err) => {
        console.warn('[Discovery][UDP]', err.message);
        this._udpDisc = null;
        this._onProtocolDone();
      });

      udp.start();
    } catch (err) {
      console.error('[Discovery][UDP] failed to start:', err.message);
      this._onProtocolDone();
    }

    // ── ONVIF ──────────────────────────────────────────────────────────────
    try {
      const onvif = new ONVIFDiscovery({ timeout: SCAN_TIMEOUT });
      this._onvifDisc = onvif;

      onvif.on('device', (device) => {
        const merged = this._upsert(device);
        this._emit(merged);
      });

      onvif.on('done',  () => { this._onvifDisc = null; this._onProtocolDone(); });
      onvif.on('error', (err) => {
        console.warn('[Discovery][ONVIF]', err.message);
        this._onvifDisc = null;
        this._onProtocolDone();
      });

      onvif.start();
    } catch (err) {
      console.error('[Discovery][ONVIF] failed to start:', err.message);
      this._onProtocolDone();
    }
  }
}

let _svc = null;

function getDiscoveryService(io) {
  if (!_svc && io) _svc = new DiscoveryService(io);
  return _svc;
}

module.exports = { getDiscoveryService };
