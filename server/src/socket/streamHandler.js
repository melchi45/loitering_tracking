'use strict';

const { getUDPDiscovery }    = require('../utils/udpDiscovery');
const { getDiscoveryService } = require('../services/discoveryService');

/**
 * Register Socket.IO event handlers for streaming and discovery.
 * @param {import('socket.io').Server}   io
 * @param {import('socket.io').Socket}   socket
 * @param {import('better-sqlite3').Database} db
 */
function registerStreamHandlers(io, socket, db) {
  let _discoveryInstance = null;

  // ─── Camera room subscription ──────────────────────────────────────────

  /**
   * Join the room for a specific camera to receive frame and detection events.
   * payload: { cameraId: string }
   */
  socket.on('camera:subscribe', ({ cameraId } = {}) => {
    if (!cameraId) return;
    socket.join(cameraId);
    socket.emit('camera:subscribed', { cameraId });
  });

  /**
   * Leave the room for a specific camera.
   * payload: { cameraId: string }
   */
  socket.on('camera:unsubscribe', ({ cameraId } = {}) => {
    if (!cameraId) return;
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
    // If a discovery is already in progress, stop it first
    if (_discoveryInstance) {
      try { _discoveryInstance.stop(); } catch (_) {}
      _discoveryInstance = null;
    }

    const UDPDiscovery = getUDPDiscovery();
    const discovery = new UDPDiscovery({ timeout });
    _discoveryInstance = discovery;

    discovery.on('device', (raw) => {
      // Map raw WiseNet binary fields exactly as the Chrome extension does
      const strMacAddress = (raw.chMac  || '').replace(/\xff/g, '').trim();
      const strIpAddress  = (raw.chIP   || '').replace(/\xff/g, '').trim();
      const strModel      = (raw.chDeviceNameNew && raw.chDeviceNameNew !== '')
                              ? raw.chDeviceNameNew
                              : (raw.chDeviceName || '');
      const numHttpPort   = (!raw.nHttpPort  || raw.nHttpPort  === 0) ? 80  : raw.nHttpPort;
      const numHttpsPort  = (!raw.nHttpsPort || raw.nHttpsPort === 0) ? 443 : raw.nHttpsPort;
      const httpType      = (raw.httpType != null) ? (raw.httpType !== 0) : false;

      const device = {
        id:           `${strMacAddress}_${strIpAddress}`,
        Model:        strModel,
        Type:         raw.modelType,
        Username:     '',
        Password:     '',
        IPAddress:    strIpAddress,
        MACAddress:   strMacAddress,
        Port:         raw.nPort,
        Channel:      1,
        MaxChannel:   1,
        HttpType:     httpType,
        HttpPort:     numHttpPort,
        HttpsPort:    numHttpsPort,
        Gateway:      (raw.chGateway    || '').replace(/\xff/g, '').trim(),
        SubnetMask:   (raw.chSubnetMask || '').replace(/\xff/g, '').trim(),
        SupportSunapi: raw.isSupportSunapi === 1,
        URL:          raw.DDNSURL || '',
        rtspUrl:      raw.rtspUrl,
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
    const svc = getDiscoveryService();
    if (svc) svc.rescan();
  });

  /**
   * Stop an in-progress discovery scan.
   */
  socket.on('discovery:stop', () => {
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
