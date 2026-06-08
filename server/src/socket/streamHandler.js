'use strict';

const { getUDPDiscovery }    = require('../utils/udpDiscovery');
const { getDiscoveryService } = require('../services/discoveryService');

/**
 * Register Socket.IO event handlers for streaming and discovery.
 * @param {import('socket.io').Server}   io
 * @param {import('socket.io').Socket}   socket
 * @param {import('better-sqlite3').Database} db
 * @param {{ discoveryEnabled?: boolean }} [options]
 */
function registerStreamHandlers(io, socket, db, options = {}) {
  const discoveryEnabled = options.discoveryEnabled !== false;
  let _discoveryInstance = null;

  // ─── Camera room subscription ──────────────────────────────────────────

  /**
   * Join the room for a specific camera to receive frame and detection events.
   * payload: { cameraId: string }
   */
  socket.on('camera:subscribe', ({ cameraId } = {}) => {
    if (!cameraId) return;
    if (socket.rooms.has(cameraId)) {
      socket.emit('camera:subscribed', { cameraId });
      return;
    }
    socket.join(cameraId);
    console.log(`[Socket.IO] ${socket.id.slice(0,8)} subscribed to camera ${cameraId.slice(0,8)}`);
    socket.emit('camera:subscribed', { cameraId });
  });

  /**
   * Leave the room for a specific camera.
   * payload: { cameraId: string }
   */
  socket.on('camera:unsubscribe', ({ cameraId } = {}) => {
    if (!cameraId) return;
    if (!socket.rooms.has(cameraId)) {
      socket.emit('camera:unsubscribed', { cameraId });
      return;
    }
    socket.leave(cameraId);
    socket.emit('camera:unsubscribed', { cameraId });
  });

  // ─── Device discovery ──────────────────────────────────────────────────

  /**
   * Start a UDP broadcast discovery scan.
   * payload: { timeout?: number }  (ms, default 5000)
   * Emits 'discovery:result' for each found device and 'discovery:done' when finished.
   */
  socket.on('discovery:start', ({ timeout = 5000 } = {}) => {
    if (!discoveryEnabled) {
      socket.emit('discovery:disabled', { reason: 'SERVER_MODE=analysis' });
      return;
    }
    // If a discovery is already in progress, stop it first
    if (_discoveryInstance) {
      try { _discoveryInstance.stop(); } catch (_) {}
      _discoveryInstance = null;
    }

    const UDPDiscovery = getUDPDiscovery();
    const discovery = new UDPDiscovery({ timeout });
    _discoveryInstance = discovery;

    discovery.on('device', (raw) => {
      const clean = (v) => String(v || '').replace(/\xff/g, '').replace(/[^\x20-\x7E]/g, '').trim();
      const resolvePort = (a, b, fallback) => {
        const v = parseInt(a != null ? a : b, 10);
        return Number.isFinite(v) && v > 0 ? v : fallback;
      };

      // Map raw WiseNet binary fields exactly as the Chrome extension does
      const strMacAddress = clean(raw.chMac || raw.MACAddress || raw.mac);
      const strIpAddress  = clean(raw.chIP  || raw.IPAddress  || raw.ip);
      const strModel      = (raw.chDeviceNameNew && raw.chDeviceNameNew !== '')
                              ? raw.chDeviceNameNew
                              : (raw.chDeviceName || raw.Model || raw.model || raw.name || '');
      const numHttpPort   = resolvePort(raw.nHttpPort,  raw.httpPort ?? raw.HttpPort,  80);
      const numHttpsPort  = resolvePort(raw.nHttpsPort, raw.httpsPort ?? raw.HttpsPort, 443);
      const rtspPort      = resolvePort(raw.nPort,      raw.Port,                    554);
      const httpType      = (raw.httpType != null)
        ? (raw.httpType !== 0)
        : (raw.HttpType != null ? !!raw.HttpType : false);
      const supportSunapi = raw.isSupportSunapi === 1 || raw.SupportSunapi === true;
      const rtspUrl       = clean(raw.rtspUrl) || `rtsp://${strIpAddress}:${rtspPort}/`;
      const id            = strMacAddress ? `${strMacAddress}_${strIpAddress}` : `ip_${strIpAddress}`;

      const device = {
        id,
        Model:        strModel,
        Type:         raw.modelType,
        Username:     '',
        Password:     '',
        IPAddress:    strIpAddress,
        MACAddress:   strMacAddress,
        Port:         rtspPort,
        Channel:      1,
        MaxChannel:   1,
        HttpType:     httpType,
        HttpPort:     numHttpPort,
        HttpsPort:    numHttpsPort,
        Gateway:      clean(raw.chGateway || raw.Gateway),
        SubnetMask:   clean(raw.chSubnetMask || raw.SubnetMask),
        SupportSunapi: supportSunapi,
        URL:          clean(raw.DDNSURL || raw.URL),
        rtspUrl,
      };
      socket.emit('discovery:result', { device });
    });

    discovery.on('done', () => {
      socket.emit('discovery:done', { message: 'Discovery complete' });
      _discoveryInstance = null;
    });

    discovery.on('error', (err) => {
      socket.emit('discovery:error', { message: err.message });
      _discoveryInstance = null;
    });

    try {
      discovery.start();
      socket.emit('discovery:started', { timeout });
    } catch (err) {
      socket.emit('discovery:error', { message: err.message });
      _discoveryInstance = null;
    }
  });

  /**
   * Clear known devices and restart discovery from scratch (triggered by client "Clean").
   */
  socket.on('discovery:rescan', () => {
    if (!discoveryEnabled) {
      socket.emit('discovery:disabled', { reason: 'SERVER_MODE=analysis' });
      return;
    }
    const svc = getDiscoveryService();
    if (svc) svc.rescan();
  });

  // REST /api/cameras/discover emits this event via io.emit(...).
  // Bridge it to the same background rescan path used by the UI "Clean" action.
  socket.on('discovery:trigger', () => {
    if (!discoveryEnabled) {
      socket.emit('discovery:disabled', { reason: 'SERVER_MODE=analysis' });
      return;
    }
    const svc = getDiscoveryService();
    if (svc) svc.rescan();
  });

  /**
   * Stop an in-progress discovery scan.
   */
  socket.on('discovery:stop', () => {
    if (!discoveryEnabled) {
      socket.emit('discovery:disabled', { reason: 'SERVER_MODE=analysis' });
      return;
    }
    if (_discoveryInstance) {
      try { _discoveryInstance.stop(); } catch (_) {}
      _discoveryInstance = null;
    }
    socket.emit('discovery:stopped');
  });

  // ─── Disconnect cleanup ────────────────────────────────────────────────

  socket.on('disconnect', (reason) => {
    if (_discoveryInstance) {
      try { _discoveryInstance.stop(); } catch (_) {}
      _discoveryInstance = null;
    }
  });
}

module.exports = registerStreamHandlers;
