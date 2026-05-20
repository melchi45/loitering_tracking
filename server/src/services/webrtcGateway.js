'use strict';

const os = require('os');

let mediasoup;
try { mediasoup = require('mediasoup'); } catch (_) {}

const MEDIA_CODECS = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  { kind: 'audio', mimeType: 'audio/PCMU', clockRate: 8000 },
  { kind: 'audio', mimeType: 'audio/PCMA', clockRate: 8000 },
  {
    kind: 'video', mimeType: 'video/H264', clockRate: 90000,
    parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f',
                  'level-asymmetry-allowed': 1 },
  },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 },
];

// Virtual / container interface name prefixes to skip — these IPs are not
// reachable from a browser client and bloat the ICE candidate list.
const SKIP_IFACE_RE = /^(docker|br-|virbr|veth|lo|tun|tap|dummy|bond|ovs)/i;

// Private IP ranges (RFC 1918 + link-local)
function _isPrivate(addr) {
  return /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(addr);
}

function getAllListenIps() {
  const envIp    = process.env.SERVER_IP;
  // SERVER_PUBLIC_IP is intentionally NOT added as a mediasoup host ICE candidate.
  //
  // Why: browsers on the LAN (192.168.214.x) can sometimes reach the server's
  // public IP via hairpin NAT.  The initial STUN check succeeds (server binds on
  // 0.0.0.0), ICE nominates that public-IP pair — but subsequent consent-STUN
  // checks time-out because hairpin NAT state expires or the path is asymmetric.
  // Result: connection state flips  connected → disconnected → failed repeatedly.
  //
  // External (internet) clients should reach mediasoup through the TURN relay
  // (coturn at SERVER_PUBLIC_IP:3478 relaying to SERVER_IP).  See .env comments
  // and the coturn `allowed-peer-ip` requirement for that path to work.
  if (envIp) {
    return [{ ip: '0.0.0.0', announcedIp: envIp }];
  }

  // Auto-detect: one private IP per physical interface, then public IPs.
  // Skips Docker bridges, veth pairs, and other virtual interfaces.
  // Having fewer ICE candidates makes ICE connectivity checks complete faster.
  const privateIps = [];
  const publicIps  = [];
  const seenIface  = new Set();
  const ifaces     = os.networkInterfaces();

  for (const [name, list] of Object.entries(ifaces)) {
    if (SKIP_IFACE_RE.test(name)) continue;
    if (seenIface.has(name)) continue;
    // Take only the FIRST IPv4 address of each physical interface
    // (secondary aliases inflate the ICE candidate count needlessly)
    for (const addr of (list || [])) {
      if (!addr.internal && addr.family === 'IPv4') {
        const entry = { ip: '0.0.0.0', announcedIp: addr.address };
        _isPrivate(addr.address) ? privateIps.push(entry) : publicIps.push(entry);
        seenIface.add(name);
        break;
      }
    }
  }

  // Prefer private (LAN) IPs; fall back to public if no private found
  const ips = privateIps.length ? privateIps : publicIps;

  if (!ips.length) {
    console.warn('[WebRTCGateway] No usable network interface found — falling back to 127.0.0.1. Set SERVER_IP in .env!');
    return [{ ip: '0.0.0.0', announcedIp: '127.0.0.1' }];
  }

  console.warn(
    `[WebRTCGateway] SERVER_IP not set — auto-detected: ${ips.map(l => l.announcedIp).join(', ')}. ` +
    'Set SERVER_IP=<your-server-IP> in server/.env for reliable WebRTC connectivity.'
  );
  return ips;
}

class WebRTCGateway {
  constructor() {
    this.enabled   = false;
    this._worker   = null;
    this._routers  = new Map(); // cameraId → Router
    this._producers = new Map(); // cameraId → { video, audio }
    this._routerPending = new Map(); // cameraId → Promise<Router>  (creation lock)
  }

  async init() {
    if (!mediasoup) {
      console.warn('[WebRTCGateway] mediasoup not installed — WebRTC disabled');
      return;
    }
    try {
      this._worker = await mediasoup.createWorker({
        logLevel:   'warn',
        logTags:    ['rtp', 'srtp'],
        rtcMinPort: parseInt(process.env.WEBRTC_PORT_MIN || '40000'),
        rtcMaxPort: parseInt(process.env.WEBRTC_PORT_MAX || '49999'),
      });
      this._worker.on('died', () => {
        console.error('[WebRTCGateway] mediasoup worker died — WebRTC unavailable');
        this.enabled = false;
      });
      this.enabled = true;
      console.log(`[WebRTCGateway] Worker ready (PID ${this._worker.pid}) — WebRTC enabled`);
    } catch (err) {
      console.warn('[WebRTCGateway] Worker init failed:', err.message, '— WebRTC disabled');
    }
  }

  async getOrCreateRouter(cameraId) {
    // Fast path: router already created
    if (this._routers.has(cameraId)) return this._routers.get(cameraId);

    // If creation is already in-flight, wait for that same promise so all
    // concurrent callers (webrtcSignaling + RtpIngestion) share ONE router.
    if (this._routerPending.has(cameraId)) return this._routerPending.get(cameraId);

    const promise = this._worker.createRouter({ mediaCodecs: MEDIA_CODECS })
      .then((router) => {
        this._routers.set(cameraId, router);
        this._routerPending.delete(cameraId);
        return router;
      })
      .catch((err) => {
        this._routerPending.delete(cameraId);
        throw err;
      });
    this._routerPending.set(cameraId, promise);
    return promise;
  }

  getRouter(cameraId) {
    return this._routers.get(cameraId) ?? null;
  }

  deleteRouter(cameraId) {
    this._routerPending.delete(cameraId);
    const r = this._routers.get(cameraId);
    if (r && !r.closed) r.close();
    this._routers.delete(cameraId);
    this._producers.delete(cameraId);
  }

  registerProducers(cameraId, videoProducer, audioProducer) {
    this._producers.set(cameraId, { video: videoProducer, audio: audioProducer });
  }

  unregisterProducers(cameraId) {
    this._producers.delete(cameraId);
  }

  getProducers(cameraId) {
    return this._producers.get(cameraId) ?? { video: null, audio: null };
  }

  getListenIps() {
    return getAllListenIps();
  }

  async close() {
    for (const r of this._routers.values()) { if (!r.closed) r.close(); }
    if (this._worker) this._worker.close();
  }
}

module.exports = new WebRTCGateway();
