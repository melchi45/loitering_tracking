'use strict';
/**
 * NVR Multi-Channel Discovery Tests
 *
 * TC: TC-LTS-CAM-01 — Test Group H (TC-H-001 ~ TC-H-019)
 * SRS: FR-CAM-060 ~ FR-CAM-076
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

  await test('TC-H-013c', 'POST /api/cameras: channelIndex stored in camera record (FR-CAM-070)', async () => {
    const { status, body } = await post('/api/cameras', {
      name:         'XRN-810S Ch3',
      rtspUrl:      'rtsp://127.0.0.4:554/profile5/media.smp',
      channelIndex: 3,
    });
    assert(status === 201, `Expected 201, got ${status}: ${JSON.stringify(body)}`);
    assertEq(body.data?.channelIndex, 3, 'channelIndex in POST response');

    // Verify persisted via GET
    if (body.data?.id) {
      const getRes = await fetch(`${BASE_URL}/api/cameras/${body.data.id}`);
      const getData = await getRes.json().catch(() => ({}));
      assertEq(getData.data?.channelIndex, 3, 'channelIndex in GET response');
      await del(`/api/cameras/${body.data.id}`);
    }
  });

  // Cleanup
  if (createdId) await del(`/api/cameras/${createdId}`);
}

// ── TC-H-014 … TC-H-017: channelCountMax + SUNAPI auth logic ────────────────

/**
 * channelCountMax — mirrors DiscoveredCameraPanel.tsx FR-CAM-071 rule
 */
function computeChannelCountMax(camera) {
  return camera.SupportSunapi && (camera.MaxChannel ?? 1) > 1
    ? camera.MaxChannel
    : 64;
}

/**
 * SUNAPI Basic-auth header builder — mirrors querySunapiMaxChannel()
 */
function buildBasicAuth(username, password) {
  if (!username || !password) return null;
  return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

async function runChannelCountMaxTests() {
  console.log('\n── channelCountMax + SUNAPI Auth Tests ──────────────────────\n');

  await test('TC-H-014', 'channelCountMax = SUNAPI MaxChannel when SupportSunapi=true (FR-CAM-071)', async () => {
    const cam = { SupportSunapi: true, MaxChannel: 8 };
    assertEq(computeChannelCountMax(cam), 8, 'channelCountMax');
  });

  await test('TC-H-015', 'channelCountMax = 64 when SupportSunapi=false (FR-CAM-071)', async () => {
    const cam = { SupportSunapi: false, MaxChannel: 4 };
    assertEq(computeChannelCountMax(cam), 64, 'channelCountMax (non-SUNAPI)');
  });

  await test('TC-H-015b', 'channelCountMax = 64 when SupportSunapi=true but MaxChannel=1 (FR-CAM-071)', async () => {
    const cam = { SupportSunapi: true, MaxChannel: 1 };
    assertEq(computeChannelCountMax(cam), 64, 'channelCountMax (SUNAPI single-ch)');
  });

  await test('TC-H-015c', 'channelCountMax = 64 when MaxChannel is undefined (FR-CAM-071)', async () => {
    const cam = { SupportSunapi: true };
    assertEq(computeChannelCountMax(cam), 64, 'channelCountMax (MaxChannel undefined)');
  });

  await test('TC-H-017', 'SUNAPI Basic auth header: admin:password → correct base64 (FR-CAM-068)', async () => {
    const header = buildBasicAuth('admin', 'password');
    assertEq(header, 'Basic YWRtaW46cGFzc3dvcmQ=', 'Authorization header');
  });

  await test('TC-H-017b', 'SUNAPI Basic auth: empty password → no header (FR-CAM-068)', async () => {
    const header = buildBasicAuth('admin', '');
    assertEq(header, null, 'No header when password empty');
  });

  await test('TC-H-017c', 'SUNAPI Basic auth: both empty → no header (FR-CAM-068)', async () => {
    const header = buildBasicAuth('', '');
    assertEq(header, null, 'No header when both empty');
  });

  // channelCountMax onChange clamp logic (mirrors component onChange)
  await test('TC-H-014b', 'channelCount onChange clamps to channelCountMax (FR-CAM-069)', async () => {
    const cam = { SupportSunapi: true, MaxChannel: 4 };
    const max = computeChannelCountMax(cam);
    // Simulate entering 10 (above SUNAPI MaxChannel of 4)
    const rawInput = 10;
    const clamped = Math.min(rawInput || 1, max);
    assertEq(clamped, 4, 'clamped to SUNAPI MaxChannel');
  });

  await test('TC-H-014c', 'channelCount onChange allows values up to 64 for non-SUNAPI (FR-CAM-069)', async () => {
    const cam = { SupportSunapi: false, MaxChannel: 4 };
    const max = computeChannelCountMax(cam);
    const rawInput = 32;
    const clamped = Math.min(rawInput || 1, max);
    assertEq(clamped, 32, 'not clamped below 64');
  });
}

// ── TC-H-018 ~ TC-H-019: enrichDevice/enrichDeviceAutoScheme (FR-CAM-074/075) ──
//    Mock ONVIF SOAP server + direct require of onvifDiscovery.js — no live
//    server/network camera needed, same approach as the discoveryService.js
//    direct-requires in channel_slot.test.js's Group G.

/** Mock ONVIF SOAP server. `handlers` maps a substring found in the request
 *  body (e.g. 'GetVideoSources') to a function returning the XML response body.
 *  Any request not matching a handler gets an empty SOAP envelope (200). */
function startMockOnvifServer(handlers) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        const entry = Object.entries(handlers).find(([key]) => body.includes(key));
        res.end(entry ? entry[1](body) : '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body/></s:Envelope>');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function mediaServiceCapabilities(port) {
  return `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>
    <GetCapabilitiesResponse><Capabilities><Media><XAddr>http://127.0.0.1:${port}/onvif/media_service</XAddr></Media></Capabilities></GetCapabilitiesResponse>
  </s:Body></s:Envelope>`;
}

async function runOnvifEnrichmentTests() {
  console.log('\n── ONVIF enrichDevice()/enrichDeviceAutoScheme() — GetVideoSources + dual scheme ──\n');

  let enrichDevice, enrichDeviceAutoScheme;
  try {
    ({ enrichDevice, enrichDeviceAutoScheme } = require('../../server/src/services/onvifDiscovery'));
  } catch (err) {
    console.log(`      (could not require onvifDiscovery.js from this working directory — skipping: ${err.message})`);
    return;
  }

  await test('TC-H-018', 'MaxChannel/channelIndex derived from GetVideoSources order, not GetProfiles order (FR-CAM-075)', async () => {
    // GetProfiles deliberately lists VideoSource_2 first, VideoSource_0 last —
    // channelIndex must follow GetVideoSources' order (0,1,2), not this order.
    const server = await startMockOnvifServer({
      GetCapabilities: (body) => mediaServiceCapabilities(server.address().port),
      GetVideoSources: () => `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>
        <GetVideoSourcesResponse>
          <VideoSources token="VideoSource_0"/><VideoSources token="VideoSource_1"/><VideoSources token="VideoSource_2"/>
        </GetVideoSourcesResponse></s:Body></s:Envelope>`,
      GetProfiles: () => `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>
        <GetProfilesResponse>
          <Profiles token="P_VS2"><Name>VS2</Name><VideoSourceConfiguration><SourceToken>VideoSource_2</SourceToken></VideoSourceConfiguration></Profiles>
          <Profiles token="P_VS0"><Name>VS0</Name><VideoSourceConfiguration><SourceToken>VideoSource_0</SourceToken></VideoSourceConfiguration></Profiles>
          <Profiles token="P_VS1"><Name>VS1</Name><VideoSourceConfiguration><SourceToken>VideoSource_1</SourceToken></VideoSourceConfiguration></Profiles>
        </GetProfilesResponse></s:Body></s:Envelope>`,
      GetStreamUri: (body) => {
        const m = body.match(/<ProfileToken>([^<]+)<\/ProfileToken>/);
        return `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><GetStreamUriResponse><MediaUri><Uri>rtsp://127.0.0.1:554/${m ? m[1] : 'x'}</Uri></MediaUri></GetStreamUriResponse></s:Body></s:Envelope>`;
      },
    });
    try {
      const port = server.address().port;
      const result = await enrichDevice('127.0.0.1', `http://127.0.0.1:${port}/onvif/device_service`);
      assertEq(result.MaxChannel, 3, 'MaxChannel = GetVideoSources token count, not GetProfiles order/count');
      const byToken = Object.fromEntries(result.profiles.map((p) => [p.sourceToken, p.channelIndex]));
      assertEq(byToken.VideoSource_0, 1, 'VideoSource_0 → channelIndex 1');
      assertEq(byToken.VideoSource_1, 2, 'VideoSource_1 → channelIndex 2');
      assertEq(byToken.VideoSource_2, 3, 'VideoSource_2 → channelIndex 3');
    } finally {
      server.close();
    }
  });

  await test('TC-H-018b', 'MaxChannel falls back to GetProfiles SourceToken count when GetVideoSources fails (FR-CAM-075)', async () => {
    const server = await startMockOnvifServer({
      GetCapabilities: () => mediaServiceCapabilities(server.address().port),
      // No GetVideoSources handler — falls through to the empty-envelope default (0 tokens parsed)
      GetProfiles: () => `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>
        <GetProfilesResponse>
          <Profiles token="P1"><Name>P1</Name><VideoSourceConfiguration><SourceToken>VS_A</SourceToken></VideoSourceConfiguration></Profiles>
          <Profiles token="P2"><Name>P2</Name><VideoSourceConfiguration><SourceToken>VS_B</SourceToken></VideoSourceConfiguration></Profiles>
        </GetProfilesResponse></s:Body></s:Envelope>`,
    });
    try {
      const port = server.address().port;
      const result = await enrichDevice('127.0.0.1', `http://127.0.0.1:${port}/onvif/device_service`);
      assertEq(result.MaxChannel, 2, 'falls back to distinct-SourceToken count from GetProfiles');
    } finally {
      server.close();
    }
  });

  await test('TC-H-019', 'enrichDeviceAutoScheme uses whichever of HTTP/HTTPS produced a usable result (FR-CAM-074)', async () => {
    // Only the HTTP mock answers meaningfully; the HTTPS attempt targets a port
    // nothing listens on, so it fails outright — result must still come through.
    const httpServer = await startMockOnvifServer({
      GetDeviceInformation: () => `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><GetDeviceInformationResponse><Manufacturer>MockCo</Manufacturer><Model>MockCam</Model></GetDeviceInformationResponse></s:Body></s:Envelope>`,
    });
    try {
      const httpPort = httpServer.address().port;
      // Port 1 is reserved/unlikely-bound — the HTTPS attempt should fail fast.
      const result = await enrichDeviceAutoScheme('127.0.0.1', { onvifPort: httpPort, onvifHttpsPort: 1 });
      assertEq(result.Manufacturer, 'MockCo', 'HTTP result used since HTTPS attempt failed');
    } finally {
      httpServer.close();
    }
  });

  await test('TC-H-020', 'ONVIF SOAP client follows one same-host redirect, but not a cross-host one (FR-CAM-076)', async () => {
    let onvifDiscovery;
    try {
      onvifDiscovery = require('../../server/src/services/onvifDiscovery');
    } catch (err) {
      console.log(`      (could not require onvifDiscovery.js — skipping: ${err.message})`);
      return;
    }
    // Same-host redirect: server A 301s every request to itself at a second
    // path/port combo that actually answers — must be followed and succeed.
    const target = await startMockOnvifServer({
      GetDeviceInformation: () => `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><GetDeviceInformationResponse><Manufacturer>RedirectedOK</Manufacturer></GetDeviceInformationResponse></s:Body></s:Envelope>`,
    });
    const targetPort = target.address().port;
    const redirector = http.createServer((req, res) => {
      res.writeHead(301, { Location: `http://127.0.0.1:${targetPort}/onvif/device_service` });
      res.end();
    });
    await new Promise((resolve) => redirector.listen(0, '127.0.0.1', resolve));
    try {
      const result = await onvifDiscovery.enrichDevice('127.0.0.1', `http://127.0.0.1:${redirector.address().port}/onvif/device_service`);
      assertEq(result.Manufacturer, 'RedirectedOK', 'same-host redirect followed to a working result');
    } finally {
      redirector.close();
      target.close();
    }

    // Cross-host redirect must NOT be followed (SSRF hardening) — GetDeviceInformation
    // fails and is caught silently by enrichDevice(), so Manufacturer stays empty.
    const crossHostRedirector = http.createServer((req, res) => {
      res.writeHead(301, { Location: 'http://198.51.100.1/onvif/device_service' }); // TEST-NET-2, never followed
      res.end();
    });
    await new Promise((resolve) => crossHostRedirector.listen(0, '127.0.0.1', resolve));
    try {
      const result = await onvifDiscovery.enrichDevice('127.0.0.1', `http://127.0.0.1:${crossHostRedirector.address().port}/onvif/device_service`);
      assertEq(result.Manufacturer, '', 'cross-host redirect target must NOT be contacted');
    } finally {
      crossHostRedirector.close();
    }
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== NVR Channel Discovery Tests (TC-H-001 ~ TC-H-020) ===');

  await runUnitTests();
  await runResolveUrlTests();
  await runChannelCountMaxTests();
  await runOnvifEnrichmentTests();
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
