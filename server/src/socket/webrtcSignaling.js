'use strict';

const webrtcGateway = require('../services/webrtcGateway');

// socketId:cameraId → { cameraId, transport, videoConsumer, audioConsumer }
const sessions = new Map();

/**
 * Register WebRTC signaling Socket.IO handlers on a socket.
 * Uses acknowledgment callbacks (no SDP — uses mediasoup-client protocol).
 *
 * @param {import('socket.io').Server} _io
 * @param {import('socket.io').Socket} socket
 */
function registerWebRTCHandlers(_io, socket) {
  function sessionKey(cameraId) { return `${socket.id}:${cameraId}`; }

  function getPreferredAnnouncedIp() {
    const xfHost = socket.handshake?.headers?.['x-forwarded-host'];
    const hostHeader = (Array.isArray(xfHost) ? xfHost[0] : xfHost) || socket.handshake?.headers?.host || '';
    const host = String(hostHeader).split(',')[0].trim();
    if (!host) return '';

    // host examples: "192.168.214.254:3080", "[::1]:3080", "localhost:5173"
    const ipv6Match = host.match(/^\[([^\]]+)\]/);
    if (ipv6Match) return '';

    const withoutPort = host.replace(/:\d+$/, '');
    return withoutPort;
  }

  const tag = `[WebRTC][${socket.id.slice(0, 8)}]`;

  // ── webrtc:getCapabilities ─────────────────────────────────────────────
  // Browser requests router RTP capabilities to create a mediasoup Device.
  // Uses getOrCreateRouter so early connections don't fail if RtpIngestion
  // hasn't finished _setupMediasoup() yet (startup race condition).
  socket.on('webrtc:getCapabilities', async ({ cameraId }, cb) => {
    try {
      const router = await webrtcGateway.getOrCreateRouter(cameraId);
      console.log(`${tag} getCapabilities OK — camera ${cameraId.slice(0, 8)}`);
      cb(router.rtpCapabilities);
    } catch (err) {
      cb({ error: err.message });
    }
  });

  // ── webrtc:createTransport ─────────────────────────────────────────────
  // Server creates a WebRtcTransport; returns its ICE/DTLS params to browser.
  socket.on('webrtc:createTransport', async ({ cameraId }, cb) => {
    try {
      const router = await webrtcGateway.getOrCreateRouter(cameraId);

      // ── Reuse existing transport for duplicate createTransport calls ───
      // Some clients may call createTransport repeatedly during transient
      // network jitter. Reusing avoids tearing down a healthy transport.
      const key = sessionKey(cameraId);
      const existing = sessions.get(key);
      if (existing && existing.transport && !existing.transport.closed) {
        const t = existing.transport;
        console.log(`${tag} createTransport: reusing existing transport ${t.id.slice(0, 8)} for camera ${cameraId.slice(0, 8)}`);
        return cb({
          id:             t.id,
          iceParameters:  t.iceParameters,
          iceCandidates:  t.iceCandidates,
          dtlsParameters: t.dtlsParameters,
        });
      }

      // If an old closed/broken session object is hanging around, clear it.
      if (existing) {
        for (const c of [existing.videoConsumer, existing.audioConsumer]) {
          if (c && !c.closed) try { c.close(); } catch (_) {}
        }
        if (existing.transport && !existing.transport.closed) {
          try { existing.transport.close(); } catch (_) {}
        }
        sessions.delete(key);
      }

      const preferredIp = getPreferredAnnouncedIp();
      const listenIps = webrtcGateway.getListenIps(preferredIp);
      console.log(`${tag} createTransport — announcing IPs: ${listenIps.map(l => l.announcedIp).join(', ')}`);
      const transport = await router.createWebRtcTransport({
        listenIps,
        enableUdp:  true,
        enableTcp:  true,
        preferUdp:  true,
        enableSctp: false,
      });

      sessions.set(key, { cameraId, transport, videoConsumer: null, audioConsumer: null });

      transport.on('icestatechange', (iceState) => {
        console.log(`${tag} ICE state: ${iceState} — transport ${transport.id.slice(0, 8)}`);
      });
      transport.on('dtlsstatechange', (state) => {
        console.log(`${tag} DTLS state: ${state} — transport ${transport.id.slice(0, 8)}`);
        if (state === 'closed' || state === 'failed') {
          if (!transport.closed) try { transport.close(); } catch (_) {}
          sessions.delete(key);
        }
      });
      transport.on('close', () => sessions.delete(key));

      console.log(
        `${tag} transport ${transport.id.slice(0, 8)} created — ${transport.iceCandidates.length} ICE candidates: ` +
        transport.iceCandidates.map(c => `${c.protocol}:${c.ip}:${c.port}`).join(', ')
      );
      cb({
        id:             transport.id,
        iceParameters:  transport.iceParameters,
        iceCandidates:  transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      });
    } catch (err) {
      cb({ error: err.message });
    }
  });

  // ── webrtc:connectTransport ────────────────────────────────────────────
  // Browser supplies its DTLS fingerprint; server finalises the handshake.
  socket.on('webrtc:connectTransport', async ({ cameraId, transportId, dtlsParameters }, cb) => {
    try {
      const session = sessions.get(sessionKey(cameraId));
      if (!session || session.transport.id !== transportId)
        return cb({ error: 'Transport not found' });
      await session.transport.connect({ dtlsParameters });
      console.log(`${tag} connectTransport OK — camera ${cameraId.slice(0, 8)}`);
      cb({});
    } catch (err) {
      console.error(`${tag} connectTransport error:`, err.message);
      cb({ error: err.message });
    }
  });

  // ── webrtc:consume ─────────────────────────────────────────────────────
  // Server creates Consumers for video and/or audio; returns their RTP params.
  socket.on('webrtc:consume', async ({ cameraId, transportId, rtpCapabilities }, cb) => {
    try {
      const session = sessions.get(sessionKey(cameraId));
      if (!session || session.transport.id !== transportId)
        return cb({ error: 'Session not found' });

      const router = webrtcGateway.getRouter(cameraId);
      if (!router) return cb({ error: 'Router not found' });

      // Wait up to 10 s for RtpIngestion to register producers (startup race)
      let producers = webrtcGateway.getProducers(cameraId);
      if (!producers.video) {
        console.log(`${tag} consume: waiting for producers — camera ${cameraId.slice(0, 8)}`);
        const WAIT_MS = 10_000;
        const STEP_MS = 250;
        const deadline = Date.now() + WAIT_MS;
        while (!producers.video && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, STEP_MS));
          producers = webrtcGateway.getProducers(cameraId);
        }
        if (!producers.video) {
          console.warn(`${tag} consume: timed out waiting for producers — camera ${cameraId.slice(0, 8)}`);
          return cb({ error: 'Pipeline not ready — no video producer' });
        }
        console.log(`${tag} consume: producers ready after wait — camera ${cameraId.slice(0, 8)}`);
      }

      const result = {};

      const tryConsume = async (producer, key) => {
        if (!producer || producer.closed) {
          console.log(`${tag} tryConsume(${key}): skip — producer=${!!producer} closed=${producer?.closed}`);
          return;
        }
        const canC = router.canConsume({ producerId: producer.id, rtpCapabilities });
        console.log(`${tag} tryConsume(${key}): canConsume=${canC} routerId=${router.id.slice(0,8)} producerId=${producer.id.slice(0,8)}`);
        if (!canC) return;
        const consumer = await session.transport.consume({
          producerId:    producer.id,
          rtpCapabilities,
          paused:        true, // resumed after transport DTLS handshake completes
        });
        session[`${key}Consumer`] = consumer;
        result[key] = {
          id:            consumer.id,
          producerId:    producer.id,
          kind:          consumer.kind,
          rtpParameters: consumer.rtpParameters,
        };

        // ── Propagate producer lifecycle events to the client ─────────────
        // When the RTSP pipeline stops/restarts the producer closes; without
        // this the browser just sees a frozen frame forever.
        consumer.on('producerclose', () => {
          console.log(`${tag} ${key} producer closed — notifying client (camera ${cameraId.slice(0,8)})`);
          if (!socket.disconnected) {
            socket.emit('webrtc:producer-closed', { cameraId });
          }
        });
        consumer.on('producerpause', () => {
          if (!socket.disconnected) socket.emit('webrtc:producer-paused', { cameraId, kind: key });
        });
        consumer.on('producerresume', () => {
          if (!socket.disconnected) socket.emit('webrtc:producer-resumed', { cameraId, kind: key });
        });
      };

      await tryConsume(producers.video, 'video');
      await tryConsume(producers.audio, 'audio');

      // Request an IDR frame so the browser starts with a clean keyframe
      // (avoids corrupted / partial first frame after mid-stream subscribe).
      // Guard: requestKeyFrame() was added in mediasoup 3.6 — skip if absent.
      if (producers.video && !producers.video.closed &&
          typeof producers.video.requestKeyFrame === 'function') {
        producers.video.requestKeyFrame().catch(() => {});
      }

      console.log(`${tag} consume OK — tracks: ${Object.keys(result).join(', ') || 'none'}`);
      cb(result);
    } catch (err) {
      cb({ error: err.message });
    }
  });

  // ── webrtc:resumeConsumer ──────────────────────────────────────────────
  // Browser calls this after transport is connected to un-pause the consumer.
  socket.on('webrtc:resumeConsumer', async ({ cameraId, consumerId }) => {
    try {
      const session = sessions.get(sessionKey(cameraId));
      if (!session) {
        console.warn(`${tag} resumeConsumer: no session for camera ${cameraId?.slice(0,8)}`);
        return;
      }
      for (const c of [session.videoConsumer, session.audioConsumer]) {
        if (c && c.id === consumerId && !c.closed) {
          await c.resume();
          console.log(`${tag} resumeConsumer OK — ${c.kind} consumer ${consumerId.slice(0,8)}`);
        }
      }
    } catch (err) {
      console.error(`${tag} resumeConsumer error:`, err.message);
    }
  });

  // ── webrtc:leave ──────────────────────────────────────────────────────
  // Browser explicitly leaves (unsubscribes) a camera.
  socket.on('webrtc:leave', ({ cameraId }) => {
    _cleanup(sessionKey(cameraId));
  });

  // ── cleanup on socket disconnect ──────────────────────────────────────
  socket.on('disconnect', () => {
    for (const key of [...sessions.keys()]) {
      if (key.startsWith(socket.id + ':')) _cleanup(key);
    }
  });

  function _cleanup(key) {
    const session = sessions.get(key);
    if (!session) return;
    for (const c of [session.videoConsumer, session.audioConsumer]) {
      if (c && !c.closed) c.close();
    }
    if (!session.transport.closed) session.transport.close();
    sessions.delete(key);
  }
}

module.exports = registerWebRTCHandlers;
