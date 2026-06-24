'use strict';
/**
 * NVR Multi-Channel Discovery Tests
 *
 * TC: TC-LTS-CAM-01 — Test Group H (TC-H-001 ~ TC-H-013)
 * SRS: FR-CAM-060 ~ FR-CAM-067
 *
 * Tests for NVR MaxChannel detection, channel selection UI logic,
 * RTSP URL generation, and camera name formatting.
 *
 * Run: node test/api/nvr_channel_discovery.test.js
 * Set LTS_URL env var to override the base URL (default http://localhost:3080).
 */

const http   = require('http');
const BASE_URL = process.env.LTS_URL || 'http://localhost:3080';

// ── Minimal test harness ─────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const results = [];

async function test(id, description, fn) {
  try {
    await fn();
    console.log(`  ✓ ${id}: ${description}`);
    passed++;
    results.push({ id, description, status: 'PASS' });
  } catch (err) {
    console.error(`  ✗ ${id}: ${description}`);
    console.error(`      ${err.message}`);
    failed++;
    results.push({ id, description, status: 'FAIL', error: err.message });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEq(actual, expected, label) {
  if (actual !== expected)
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function post(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, body: data };
}

async function del(path) {
  const res = await fetch(`${BASE_URL}${path}`, { method: 'DELETE' });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// ── Unit helpers (inline, no server required) ────────────────────────────────

/**
 * channelRtspUrl — same logic as DiscoveredCameraPanel.tsx
 * Replaces /profileN/ pattern in the base RTSP URL.
 */
function channelRtspUrl(baseUrl, channel) {
  if (!baseUrl) return baseUrl;
  if (/\/profile\d+\//i.test(baseUrl)) return baseUrl.replace(/\/profile\d+\//i, `/profile${channel}/`);
  if (/\/profile\d+$/i.test(baseUrl))  return baseUrl.replace(/\/profile\d+$/i,  `/profile${channel}`);
  return baseUrl;
}

/**
 * mergeDevices — MaxChannel rule only (from discoveryService.js)
 */
function mergeMaxChannel(existingMaxCh, incomingMaxCh) {
  return Math.max(existingMaxCh || 1, incomingMaxCh || 1);
}

/**
 * resolveRtspUrl — same priority logic as DiscoveredCameraPanel.tsx
 */
function resolveRtspUrl(camera, channel) {
  const profiles = camera.profiles || [];
  const byChannel = profiles.find((p) => p.channelIndex === channel && p.rtspUrl);
  if (byChannel) return byChannel.rtspUrl;
  if (profiles.length >= channel && profiles[channel - 1]?.rtspUrl)
    return profiles[channel - 1].rtspUrl;
  const base = camera.rtspUrl || `rtsp://${camera.IPAddress}:554/profile1/media.smp`;
  return channel > 1 ? channelRtspUrl(base, channel) : base;
}

// ── TC-H-001 … TC-H-007: Server-logic unit tests (no real camera) ────────────

async function runUnitTests() {
  console.log('\n── Unit Tests (no server required) ─────────────────────────\n');

  await test('TC-H-001', 'SourceToken-Based MaxChannel — 4 distinct tokens → MaxChannel=4', async () => {
    // Simulate what enrichDevice() does
    const sourceTokenOrder = new Map();
    const profiles = [
      { token: 'P1', sourceToken: 'VideoSrc_01' },
      { token: 'P2', sourceToken: 'VideoSrc_01' }, // same channel, sub stream
      { token: 'P3', sourceToken: 'VideoSrc_02' },
      { token: 'P4', sourceToken: 'VideoSrc_03' },
      { token: 'P5', sourceToken: 'VideoSrc_04' },
    ];
    for (const p of profiles) {
      if (p.sourceToken && !sourceTokenOrder.has(p.sourceToken))
        sourceTokenOrder.set(p.sourceToken, sourceTokenOrder.size + 1);
    }
    const maxChannel = sourceTokenOrder.size > 0 ? sourceTokenOrder.size : 1;
    assertEq(maxChannel, 4, 'MaxChannel');
  });

  await test('TC-H-002', 'Single-channel camera: 2 profiles same SourceToken → MaxChannel=1', async () => {
    const sourceTokenOrder = new Map();
    const profiles = [
      { token: 'Profile_1', sourceToken: 'VideoSrc_00' },
      { token: 'Profile_2', sourceToken: 'VideoSrc_00' },
    ];
    for (const p of profiles) {
      if (p.sourceToken && !sourceTokenOrder.has(p.sourceToken))
        sourceTokenOrder.set(p.sourceToken, sourceTokenOrder.size + 1);
    }
    const maxChannel = sourceTokenOrder.size > 0 ? sourceTokenOrder.size : 1;
    assertEq(maxChannel, 1, 'MaxChannel');
  });

  await test('TC-H-003', 'channelIndex: main+sub pairs share same channelIndex', async () => {
    const sourceTokenOrder = new Map();
    const rawProfiles = [
      { token: 'CH1_main', sourceToken: 'VideoSrc_01' },
      { token: 'CH1_sub',  sourceToken: 'VideoSrc_01' },
      { token: 'CH2_main', sourceToken: 'VideoSrc_02' },
      { token: 'CH2_sub',  sourceToken: 'VideoSrc_02' },
    ];
    const profiles = rawProfiles.map((p) => {
      if (p.sourceToken && !sourceTokenOrder.has(p.sourceToken))
        sourceTokenOrder.set(p.sourceToken, sourceTokenOrder.size + 1);
      return { ...p, channelIndex: sourceTokenOrder.get(p.sourceToken) || 1 };
    });
    assertEq(profiles[0].channelIndex, 1, 'CH1_main channelIndex');
    assertEq(profiles[1].channelIndex, 1, 'CH1_sub channelIndex');
    assertEq(profiles[2].channelIndex, 2, 'CH2_main channelIndex');
    assertEq(profiles[3].channelIndex, 2, 'CH2_sub channelIndex');
  });

  await test('TC-H-004', 'mergeDevices MaxChannel: UDP=1, ONVIF=4 → merged=4', async () => {
    const result = mergeMaxChannel(1, 4);
    assertEq(result, 4, 'merged MaxChannel');
  });

  await test('TC-H-005', 'mergeDevices MaxChannel: both=1 → stays 1', async () => {
    const result = mergeMaxChannel(1, 1);
    assertEq(result, 1, 'merged MaxChannel');
  });

  await test('TC-H-006', 'mergeDevices MaxChannel: undefined existing → incoming wins', async () => {
    const result = mergeMaxChannel(undefined, 8);
    assertEq(result, 8, 'merged MaxChannel');
  });

  await test('TC-H-007', 'channelRtspUrl: replaces /profile1/ with /profileN/', async () => {
    const base = 'rtsp://192.168.1.10:554/profile1/media.smp';
    assertEq(channelRtspUrl(base, 3), 'rtsp://192.168.1.10:554/profile3/media.smp', 'channel 3 URL');
    assertEq(channelRtspUrl(base, 1), 'rtsp://192.168.1.10:554/profile1/media.smp', 'channel 1 unchanged');
  });
}

// ── TC-H-008 … TC-H-013: resolveRtspUrl + API integration ───────────────────

async function runResolveUrlTests() {
  console.log('\n── resolveRtspUrl Logic Tests ───────────────────────────────\n');

  const nvrCamera = {
    IPAddress: '192.168.1.10',
    Port: 554,
    Model: 'XRN-810S',
    MaxChannel: 4,
    rtspUrl: 'rtsp://192.168.1.10:554/profile1/media.smp',
    profiles: [
      { token: 'P1', channelIndex: 1, rtspUrl: 'rtsp://192.168.1.10:554/profile1/media.smp' },
      { token: 'P2', channelIndex: 1, rtspUrl: '' },
      { token: 'P3', channelIndex: 2, rtspUrl: 'rtsp://192.168.1.10:554/profile3/media.smp' },
      { token: 'P4', channelIndex: 2, rtspUrl: '' },
      { token: 'P5', channelIndex: 3, rtspUrl: 'rtsp://192.168.1.10:554/profile5/media.smp' },
      { token: 'P6', channelIndex: 4, rtspUrl: '' },
    ],
  };

  await test('TC-H-008', 'resolveRtspUrl: channel 1 uses first profile with channelIndex=1', async () => {
    const url = resolveRtspUrl(nvrCamera, 1);
    assertEq(url, 'rtsp://192.168.1.10:554/profile1/media.smp', 'ch1 URL');
  });

  await test('TC-H-009', 'resolveRtspUrl: channel 2 uses profile with channelIndex=2', async () => {
    const url = resolveRtspUrl(nvrCamera, 2);
    assertEq(url, 'rtsp://192.168.1.10:554/profile3/media.smp', 'ch2 URL');
  });

  await test('TC-H-010', 'resolveRtspUrl: channel 4 has no rtspUrl → falls back to channelRtspUrl()', async () => {
    const url = resolveRtspUrl(nvrCamera, 4);
    // No profile with channelIndex=4 has rtspUrl; fallback replaces profile number
    assertEq(url, 'rtsp://192.168.1.10:554/profile4/media.smp', 'ch4 fallback URL');
  });

  await test('TC-H-011', 'Camera name format: "XRN-810S Ch5" when MaxChannel > 1', async () => {
    const maxChannel = nvrCamera.MaxChannel;
    const selectedChannel = 5;
    const baseName = nvrCamera.Model || nvrCamera.IPAddress;
    const cameraName = maxChannel > 1 ? `${baseName} Ch${selectedChannel}` : baseName;
    assertEq(cameraName, 'XRN-810S Ch5', 'camera name');
  });

  await test('TC-H-012', 'Camera name format: no suffix when MaxChannel = 1', async () => {
    const singleCamera = { ...nvrCamera, MaxChannel: 1 };
    const cameraName = (singleCamera.MaxChannel ?? 1) > 1
      ? `${singleCamera.Model} Ch1`
      : singleCamera.Model;
    assertEq(cameraName, 'XRN-810S', 'camera name (no suffix)');
  });
}

// ── TC-H-013: API integration (requires running server) ─────────────────────

async function runApiTests() {
  console.log('\n── API Integration Tests (requires server at', BASE_URL, ')─\n');

  let createdId = null;

  await test('TC-H-013a', 'POST /api/cameras: NVR channel name "XRN-810S Ch3" accepted', async () => {
    const { status, body } = await post('/api/cameras', {
      name:    'XRN-810S Ch3',
      rtspUrl: 'rtsp://127.0.0.2:554/profile5/media.smp',
    });
    assert(status === 201, `Expected 201, got ${status}`);
    assert(body.success === true, 'success flag');
    assertEq(body.data?.name, 'XRN-810S Ch3', 'camera name');
    createdId = body.data?.id;
  });

  await test('TC-H-013b', 'POST /api/cameras: NVR channel 2 RTSP URL stored correctly', async () => {
    const { status, body } = await post('/api/cameras', {
      name:    'XRN-410S Ch2',
      rtspUrl: 'rtsp://127.0.0.3:554/profile3/media.smp',
    });
    assert(status === 201, `Expected 201, got ${status}: ${JSON.stringify(body)}`);
    assertEq(body.data?.rtspUrl, 'rtsp://127.0.0.3:554/profile3/media.smp', 'rtspUrl');
    if (body.data?.id) await del(`/api/cameras/${body.data.id}`);
  });

  // Cleanup
  if (createdId) await del(`/api/cameras/${createdId}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== NVR Channel Discovery Tests (TC-H-001 ~ TC-H-013) ===');

  await runUnitTests();
  await runResolveUrlTests();
  await runApiTests();

  console.log(`\n══════════════════════════════════════════════════════`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log(`══════════════════════════════════════════════════════`);

  if (failed > 0) {
    console.log('\nFailed tests:');
    results.filter((r) => r.status === 'FAIL').forEach((r) => {
      console.log(`  ✗ ${r.id}: ${r.description}`);
      if (r.error) console.log(`    ${r.error}`);
    });
    process.exit(1);
  }
})();
