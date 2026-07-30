'use strict';

/**
 * ingestDaemonPool.js — single source of truth for "how many ingest-daemon
 * instances exist, what are their ports/URLs, and which instance owns a
 * given cameraId" (2026-07-28, §6.45).
 *
 * Why this exists: a single ingest_daemon.py process handling every camera
 * in one CPython GIL was confirmed (live strace during a wedge — see
 * Design_RTSP_Capture_Backend.md §6.45) to hit a GIL hand-off livelock
 * ("GIL thrashing": ~22,000 futex()/sec across 96 threads, zero actual I/O)
 * once the fleet grew large enough. Splitting cameras across N independent
 * OS processes (N independent GILs) — mirroring how webrtc/mediasoupEngine.js
 * already splits cameras across a mediasoup Worker pool via the same
 * cameraHash.js hash — removes the single-GIL bottleneck entirely rather
 * than continuing to tune inside one process (six single-process
 * mitigations were tried first and each failed to stop the recurrence).
 *
 * Camera → instance assignment is a PURE function of (cameraId, instance
 * count) — re-hashed fresh every time, never persisted. Unlike mediasoup's
 * Worker pool (where a camera's Producer/Consumer must stay on one Router,
 * forcing a cached workerIndex), ingest-daemon instances are independent
 * HTTP services with no cross-instance state, so there is nothing that
 * requires "sticky" assignment — every caller in this codebase can call
 * `instanceIndexForCamera(cameraId)` fresh and always get the same answer
 * as long as INGEST_DAEMON_INSTANCES hasn't changed.
 *
 * Backward compatibility: with INGEST_DAEMON_INSTANCES unset (default 1),
 * getInstanceConfig(0) resolves to exactly today's single-daemon
 * port/URL (from INGEST_DAEMON_ADDR/INGEST_DAEMON_URL) — every module that
 * switches from a hardcoded INGEST_DAEMON_URL constant to this module must
 * behave identically to before for existing single-instance deployments.
 */

const os = require('os');
const path = require('path');
const { indexForCamera } = require('../utils/cameraHash');

// Port spacing between instances (2026-07-28, §6.45) — each instance's own
// ingest_daemon.py may additionally spawn an internal health-proxy on
// port+1 (see ingest-daemon/ingest_health_proxy.py, INGEST_INTERNAL_HTTP_PORT
// default = external port + 1). A spacing of 10 leaves 8 spare ports per
// instance beyond external+internal for any future sidecar, while keeping
// the scheme simple to reason about (instance i's external port is always
// exactly basePort + i*10).
const _PORT_STEP = 10;

function getInstanceCount() {
  const n = parseInt(process.env.INGEST_DAEMON_INSTANCES, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function getBasePort() {
  if (process.env.INGEST_DAEMON_BASE_PORT) {
    return parseInt(process.env.INGEST_DAEMON_BASE_PORT, 10);
  }
  // Derive from the existing single-instance env var so a deployment that
  // never sets INGEST_DAEMON_INSTANCES keeps using its already-configured
  // port with zero changes.
  const addr = (process.env.INGEST_DAEMON_ADDR || ':7070').trim();
  return parseInt(addr.replace(':', '') || '7070', 10);
}

function getInstanceConfig(index) {
  const port = getBasePort() + index * _PORT_STEP;
  const internalPort = port + 1;
  const addr = `:${port}`;
  const url = `http://127.0.0.1:${port}`;
  const daemonLogBase = process.env.INGEST_DAEMON_LOG || path.join(os.tmpdir(), 'ingest-daemon.log');
  // ingest_daemon.py's own heartbeat file (INGEST_HEARTBEAT_FILE) defaults to
  // one fixed path in the OS temp dir — with multiple instances that would
  // have every instance's _stats_sampler() overwrite the SAME file, so each
  // instance's own ingest_health_proxy.py would read a heartbeat written by
  // whichever instance happened to write last, not its own parent. Must be
  // unique per instance; ingest_daemon.py needs no code change since it
  // already reads this path from env and passes it straight through to the
  // health-proxy subprocess it spawns.
  const heartbeatFileBase = process.env.INGEST_HEARTBEAT_FILE || path.join(os.tmpdir(), 'ingest-daemon-heartbeat.json');
  // Instance 0 keeps today's exact filenames (no suffix) so a single-instance
  // deployment's paths never change; instances 1+ get a `.N` suffix inserted
  // before the extension.
  const _suffix = (base) => index === 0 ? base : base.replace(/(\.[^./\\]+)?$/, (ext) => `.${index}${ext || ''}`);

  return {
    index,
    addr,
    port,
    internalPort,
    url,
    healthUrl: `${url}/health`,
    statsUrl: `${url}/cameras/stats`,
    logPath: _suffix(daemonLogBase),
    heartbeatFile: _suffix(heartbeatFileBase),
  };
}

function getAllInstanceConfigs() {
  return Array.from({ length: getInstanceCount() }, (_, i) => getInstanceConfig(i));
}

function instanceIndexForCamera(cameraId) {
  return indexForCamera(cameraId, getInstanceCount());
}

function getInstanceForCamera(cameraId) {
  return getInstanceConfig(instanceIndexForCamera(cameraId));
}

function urlForCamera(cameraId) {
  return getInstanceForCamera(cameraId).url;
}

module.exports = {
  getInstanceCount,
  getBasePort,
  getInstanceConfig,
  getAllInstanceConfigs,
  instanceIndexForCamera,
  getInstanceForCamera,
  urlForCamera,
};
