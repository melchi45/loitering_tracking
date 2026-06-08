'use strict';
/**
 * Verify streaming mode works in monitoring-only mode when ANALYSIS_SERVER_URL is empty.
 *
 * Run: node test/api/streaming_without_analysis_url.test.js
 */

const path = require('path');

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  TC_STREAMING_NO_ANALYSIS_URL — Contract Test       ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  const prevMode = process.env.SERVER_MODE;
  const prevUrl = process.env.ANALYSIS_SERVER_URL;

  process.env.SERVER_MODE = 'streaming';
  process.env.ANALYSIS_SERVER_URL = '';

  const modulePath = path.resolve(__dirname, '../../server/src/services/pipelineManager.js');
  delete require.cache[modulePath];
  const PipelineManager = require(modulePath);

  const io = {
    emit() {},
    to() {
      return { emit() {} };
    },
  };

  const db = {
    insert() {},
    update() {},
    find() { return []; },
    findOne() { return null; },
    all() { return []; },
    delete() {},
  };

  const pm = new PipelineManager(io, db);
  const cam = {
    id: 'cam-streaming-monitoring-only',
    name: 'MonitoringOnlyCam',
    rtspUrl: 'rtsp://127.0.0.1:8554/nonexistent',
    status: 'offline',
    webrtcEnabled: false,
    aiEnabled: true,
  };

  await pm.startCamera(cam);
  const status = pm.getCameraStatus(cam.id);
  assert(status && status.running === true, 'Pipeline should run even when ANALYSIS_SERVER_URL is empty');

  // Give ffmpeg process a short chance to spawn and emit startup warnings, then stop cleanly.
  await sleep(300);
  await pm.stopCamera(cam.id);

  process.env.SERVER_MODE = prevMode;
  process.env.ANALYSIS_SERVER_URL = prevUrl;

  console.log('  ✓ monitoring-only streaming path is active when ANALYSIS_SERVER_URL is empty');
}

main().catch((err) => {
  console.error(`  ✗ ${err.message}`);
  process.exit(1);
});
