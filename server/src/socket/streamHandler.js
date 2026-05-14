'use strict';

const { getUDPDiscovery } = require('../utils/udpDiscovery');

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

    discovery.on('device', (device) => {
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
