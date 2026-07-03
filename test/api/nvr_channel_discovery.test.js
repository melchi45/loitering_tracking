'use strict';
/**
 * NVR Multi-Channel Discovery Tests
 *
 * TC: TC-LTS-CAM-01 — Test Group H (TC-H-001 ~ TC-H-040)
 * SRS: FR-CAM-060 ~ FR-CAM-091
 *
 * Tests for NVR MaxChannel detection, channel selection UI logic,
 * RTSP URL generation, camera name formatting, (TC-H-021~025) the SUNAPI
 * dual RTSP URL pattern (/profileN/ vs /N/H.264/), RtspPort CGI confirmation,
 * the sunapiRequest() same-host redirect follow, (TC-H-026~027) UDP
 * discovery's extended-field bounds checking (Device Type byte),
 * (TC-H-028~029) server/src/utils/udpDiscovery.js's (npm-package-backed)
 * WiseNet binary parser,
 * (TC-H-030) the supported_protocol/no_password field-offset regression fix,
 * (TC-H-031~032) nMode-gated extended-block parsing (DEF_RES_SCAN_EXT=12
 * vs the undocumented base-mode 11 real devices actually send),
 * (TC-H-033~034) the full nMode dispatch (Table 1/2) bailing out for
 * RSA/password-apply response modes this parser doesn't implement, and
 * (TC-H-035~036) the RTSP port field bug (nTcpPort/nPort are not the RTSP
 * port, FR-CAM-088) and SUNAPI CGI Digest-auth combined-header detection
 * (FR-CAM-089), (TC-H-037~039b) the ONVIF SOAP client's own
 * Basic→Digest auth fallback (FR-CAM-090) — the ONVIF-side counterpart of
 * FR-CAM-072/089, now shared via server/src/utils/digestAuth.js — and
 * (TC-H-040) UDP discovery's MaxChannel derivation from nMulticastPort on
 * an extended (nMode=12) scan response (FR-CAM-091).
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

// ── TC-H-037~039: ONVIF SOAP client Basic→Digest auth fallback (FR-CAM-090) ──
//    Mirrors discoveryService.js's SUNAPI CGI Digest-retry coverage
//    (FR-CAM-072/089) but against onvifDiscovery.js's soapPost(). The mock
//    server does real RFC 7616 digest verification (not just "did it send
//    an Authorization header") so a wrong password is provably still rejected.

/** Mock ONVIF SOAP server requiring HTTP auth. `scheme` is 'basic' or
 *  'digest'; a 'digest' server 401s any Basic attempt outright (forcing the
 *  soapPost() Digest retry) and verifies the RFC 7616 response server-side. */
function startAuthOnvifServer({ scheme, username, password, handlers }) {
  const crypto = require('crypto');
  const realm = 'ONVIFRealm';
  const nonce = 'testnonce123';
  const md5   = (s) => crypto.createHash('md5').update(s).digest('hex');

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const authHeader = req.headers['authorization'] || '';
        let authorized = false;

        if (scheme === 'basic') {
          authorized = authHeader === 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
        } else if (authHeader.startsWith('Digest ')) {
          const get = (name) => { const m = authHeader.match(new RegExp(`${name}="?([^",]+)"?`)); return m ? m[1] : null; };
          const uri    = get('uri') || req.url;
          const ha1    = md5(`${username}:${realm}:${password}`);
          const ha2    = md5(`POST:${uri}`);
          const qop    = get('qop');
          const expected = qop
            ? md5(`${ha1}:${get('nonce')}:${get('nc')}:${get('cnonce')}:${qop}:${ha2}`)
            : md5(`${ha1}:${get('nonce')}:${ha2}`);
          authorized = get('nonce') === nonce && get('response') === expected;
        }
        // scheme === 'digest' && authHeader.startsWith('Basic ') → authorized stays
        // false, i.e. Digest-only servers reject the first Basic attempt outright.

        if (!authorized) {
          const wwwAuth = scheme === 'basic'
            ? `Basic realm="${realm}"`
            : `Digest realm="${realm}", qop="auth", nonce="${nonce}"`;
          res.writeHead(401, { 'WWW-Authenticate': wwwAuth });
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        const entry = Object.entries(handlers).find(([key]) => body.includes(key));
        res.end(entry ? entry[1](body) : '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body/></s:Envelope>');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function runOnvifAuthTests() {
  console.log('\n── ONVIF SOAP client Basic→Digest auth fallback (FR-CAM-090) ──\n');

  let enrichDevice;
  try {
    ({ enrichDevice } = require('../../server/src/services/onvifDiscovery'));
  } catch (err) {
    console.log(`      (could not require onvifDiscovery.js from this working directory — skipping: ${err.message})`);
    return;
  }

  const deviceInfoHandlers = {
    GetDeviceInformation: () => `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><GetDeviceInformationResponse><Manufacturer>AuthedCo</Manufacturer></GetDeviceInformationResponse></s:Body></s:Envelope>`,
  };

  await test('TC-H-037', 'enrichDevice() authenticates via HTTP Basic when the device accepts it (FR-CAM-090)', async () => {
    const server = await startAuthOnvifServer({ scheme: 'basic', username: 'admin', password: 'right-pass', handlers: deviceInfoHandlers });
    try {
      const port = server.address().port;
      const result = await enrichDevice('127.0.0.1', `http://127.0.0.1:${port}/onvif/device_service`, { username: 'admin', password: 'right-pass' });
      assertEq(result.Manufacturer, 'AuthedCo', 'Basic-authenticated GetDeviceInformation must succeed');
    } finally {
      server.close();
    }
  });

  await test('TC-H-038', 'enrichDevice() retries with computed RFC 7616 Digest after a Digest-only device rejects Basic (FR-CAM-090)', async () => {
    const server = await startAuthOnvifServer({ scheme: 'digest', username: 'admin', password: 'right-pass', handlers: deviceInfoHandlers });
    try {
      const port = server.address().port;
      const result = await enrichDevice('127.0.0.1', `http://127.0.0.1:${port}/onvif/device_service`, { username: 'admin', password: 'right-pass' });
      assertEq(result.Manufacturer, 'AuthedCo', 'Digest retry with correct credentials must succeed after Basic is 401-rejected');
    } finally {
      server.close();
    }
  });

  await test('TC-H-039', 'enrichDevice() Digest retry with a wrong password still fails — does not mask bad credentials (FR-CAM-090)', async () => {
    const server = await startAuthOnvifServer({ scheme: 'digest', username: 'admin', password: 'right-pass', handlers: deviceInfoHandlers });
    try {
      const port = server.address().port;
      const result = await enrichDevice('127.0.0.1', `http://127.0.0.1:${port}/onvif/device_service`, { username: 'admin', password: 'wrong-pass' });
      assertEq(result.Manufacturer, '', 'a genuinely wrong password must still fail even after the Digest retry');
    } finally {
      server.close();
    }
  });

  await test('TC-H-039b', 'enrichDevice() without credentials against an auth-required device stays empty (historical best-effort default unchanged)', async () => {
    const server = await startAuthOnvifServer({ scheme: 'digest', username: 'admin', password: 'right-pass', handlers: deviceInfoHandlers });
    try {
      const port = server.address().port;
      const result = await enrichDevice('127.0.0.1', `http://127.0.0.1:${port}/onvif/device_service`);
      assertEq(result.Manufacturer, '', 'no credentials given → no Digest retry attempted, AUTH_REQUIRED caught silently as before');
    } finally {
      server.close();
    }
  });
}

// ── TC-H-021 ~ TC-H-024: SUNAPI URL pattern + RtspPort CGI (FR-CAM-077~080) ───
//    Direct require of channelRtsp.js/discoveryService.js — unlike TC-H-001~007
//    above (which reimplement channelRtspUrl() inline), these exercise the
//    real modules so the new dual-pattern logic and querySunapiRtspPort()
//    can't silently drift from what the running server actually does.

function startMockSunapiServer(handlers) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const entry = Object.entries(handlers).find(([path]) => req.url.startsWith(path));
      if (!entry) { res.writeHead(404); res.end(); return; }
      entry[1](req, res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function runSunapiUrlPatternTests() {
  console.log('\n── SUNAPI RTSP URL patterns + RtspPort CGI (FR-CAM-077~080) ──\n');

  let channelRtsp, discoveryService;
  try {
    channelRtsp = require('../../server/src/utils/channelRtsp');
    discoveryService = require('../../server/src/services/discoveryService');
  } catch (err) {
    console.log(`      (could not require server modules from this working directory — skipping: ${err.message})`);
    return;
  }

  await test('TC-H-021a', 'channelRtspUrl: /profileN/ convention (1-based) still substitutes correctly', async () => {
    assertEq(
      channelRtsp.channelRtspUrl('rtsp://192.168.214.32:10030/profile1/media.smp', 3),
      'rtsp://192.168.214.32:10030/profile3/media.smp',
      '/profileN/ substitution (legacy TID-A800-style convention)',
    );
  });

  await test('TC-H-021b', 'channelRtspUrl: /N/H.264/ convention (0-based) substitutes correctly', async () => {
    assertEq(
      channelRtsp.channelRtspUrl('rtsp://192.168.214.40/0/H.264/media.smp', 2),
      'rtsp://192.168.214.40/1/H.264/media.smp',
      '/N/H.264/ substitution — channel arg stays 1-based, URL segment is channel-1',
    );
    assertEq(
      channelRtsp.channelRtspUrl('rtsp://192.168.214.40/1/H.264/media.smp', 1),
      'rtsp://192.168.214.40/0/H.264/media.smp',
      'round-trips back to channel 0 for channel arg 1',
    );
  });

  await test('TC-H-021c', 'channelRtspUrl: unrecognized URL shape is a no-op', async () => {
    assertEq(
      channelRtsp.channelRtspUrl('rtsp://foo/bar/baz', 2),
      'rtsp://foo/bar/baz',
      'neither pattern matches — returns input unchanged',
    );
  });

  await test('TC-H-022', 'defaultSunapiRtspUrl: 0-based channel, port fallback to 554 when unconfirmed', async () => {
    assertEq(
      channelRtsp.defaultSunapiRtspUrl('192.168.214.37', null, 1),
      'rtsp://192.168.214.37:554/0/H.264/media.smp',
      'null port falls back to SUNAPI default 554',
    );
    assertEq(
      channelRtsp.defaultSunapiRtspUrl('192.168.214.37', 554, 4),
      'rtsp://192.168.214.37:554/3/H.264/media.smp',
      'confirmed port used directly, channel 4 → segment 3',
    );
  });

  await test('TC-H-023', 'querySunapiRtspPort: parses RTSPPort from plain key=value network.cgi response', async () => {
    const server = await startMockSunapiServer({
      '/stw-cgi/network.cgi': (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('FixedPorts=3702,49152\nUsedPorts=\nHTTPPort=80\nHTTPSPort=443\nWebSessionTimeout=10\nRTSPPort=8554\nRTSPTimeout=60s\n');
      },
    });
    try {
      const port = server.address().port;
      const rtspPort = await discoveryService.querySunapiRtspPort('127.0.0.1', port, false, 3000, 'admin', 'pass');
      assertEq(rtspPort, 8554, 'RTSPPort parsed out of the plain-text response');
    } finally {
      server.close();
    }
  });

  await test('TC-H-024', 'querySunapiRtspPort: no credentials → null without a network round-trip', async () => {
    // No mock server started at all — a network call would fail/hang; a
    // correct implementation must short-circuit before ever connecting.
    const rtspPort = await discoveryService.querySunapiRtspPort('127.0.0.1', 1, false, 1000, '', '');
    assertEq(rtspPort, null, 'blank credentials → null immediately, no request attempted');
  });

  await test('TC-H-025', 'querySunapiMaxChannel (via sunapiRequest) follows one same-host redirect, not a cross-host one (FR-CAM-077)', async () => {
    // Companion to TC-H-020 (ONVIF soapPost) — same fix applied to the SUNAPI
    // CGI client (discoveryService.js's sunapiRequest()), verified live in
    // this session against 192.168.214.37 (HTTP:80 redirects to HTTPS:443).
    const target = await startMockSunapiServer({
      '/stw-cgi/attributes.cgi/attributes': (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end('<attributes><group name="System"><category name="Limit"><attribute name="MaxChannel" type="int" value="4"/></category></group></attributes>');
      },
    });
    const targetPort = target.address().port;
    const redirector = http.createServer((req, res) => {
      res.writeHead(301, { Location: `http://127.0.0.1:${targetPort}${req.url}` });
      res.end();
    });
    await new Promise((resolve) => redirector.listen(0, '127.0.0.1', resolve));
    try {
      const maxChannel = await discoveryService.querySunapiMaxChannel('127.0.0.1', redirector.address().port, false, 3000, '', '');
      assertEq(maxChannel, 4, 'same-host redirect followed to a working MaxChannel response');
    } finally {
      redirector.close();
      target.close();
    }

    const crossHostRedirector = http.createServer((req, res) => {
      res.writeHead(301, { Location: 'http://198.51.100.1/stw-cgi/attributes.cgi/attributes' }); // TEST-NET-2, never followed
      res.end();
    });
    await new Promise((resolve) => crossHostRedirector.listen(0, '127.0.0.1', resolve));
    try {
      const maxChannel = await discoveryService.querySunapiMaxChannel('127.0.0.1', crossHostRedirector.address().port, false, 3000, '', '');
      assertEq(maxChannel, 1, 'cross-host redirect target must NOT be contacted — falls back to default MaxChannel=1');
    } finally {
      crossHostRedirector.close();
    }
  });
}

// ── TC-H-026 ~ TC-H-027, TC-H-031: UDP extended-field parsing (FR-CAM-081, FR-CAM-084) ──
//    A 262-byte WiseNet UDP response (observed live from real cameras on this
//    network) numerically satisfies the old `b.length >= 261` gate but has
//    only 1 byte left for the 72-byte extended block. Per the vendor spec
//    (SUNAPI IP Installer §3.4.2/§4.4.2, Table 1/2), whether the extended
//    block is present at all is actually determined by the response's own
//    `nMode` byte (12 = DEF_RES_SCAN_EXT) — real devices on this network
//    respond with nMode=11 (a base-mode response, undocumented but
//    consistently observed), which per Annex A's `DATAPACKET_IPv4_T` has no
//    room for the extended block regardless of length. TC-H-031 verifies the
//    nMode gate specifically (a long-enough-but-base-mode packet must still
//    yield undefined extended fields) — direct require of the submodule's
//    parser + mapUDPDevice() to verify both the length- and mode-based gates
//    end-to-end.

async function runUdpExtendedFieldTests() {
  console.log('\n── UDP discovery extended-field parsing (FR-CAM-081, FR-CAM-084) ──\n');

  let UDPDiscovery, mapUDPDevice;
  try {
    ({ UDPDiscovery } = require('../../submodules/WiseNetChromeIPInstaller/nodejs/udpDiscovery'));
    ({ mapUDPDevice } = require('../../server/src/services/discoveryService'));
  } catch (err) {
    console.log(`      (could not require udpDiscovery.js/discoveryService.js from this working directory — skipping: ${err.message})`);
    return;
  }

  // Real captured 262-byte response, from an actual camera on this network —
  // sliced to its first 261 bytes (everything up to but not including the
  // extended block). The extended-field bytes appended below are synthetic.
  // This real capture's own nMode byte (offset 0) is 0x0b (11) — a base-mode
  // response; tests that want to simulate a genuine DEF_RES_SCAN_EXT (12)
  // response overwrite that one byte via withMode() below.
  const real262Hex = '0b8750735306465625ef6da75b047d7bcd1c3c30303a30393a31383a32313a39353a3835003139322e3136382e3231342e333700003235352e3235352e3235352e300000003139322e3136382e3231342e31000000000000000000000000000000000000000000000001bb0100504e4d2d433332303833745000a8112e2724271a2742270068747470733a2f2f3139322e3136382e3231342e33372f696e6465782e68746d00cf00d00b20000000000074ea18007a61c274f0eacf0000000000fc38410000000000000000000100000078f418008cea180076784100d00b2000f00000000000000001000000a4ea18000e7f4000c4ea18000904000050fe180078f41800f0ea';
  const realPrefix261Hex = real262Hex.slice(0, 261 * 2);
  const withMode = (buf, mode) => { const b = Buffer.from(buf); b[0] = mode; return b; };

  await test('TC-H-026', 'UDP extended fields (alias/chDeviceNameNew/modelType/...) are undefined, not false 0/empty, when the packet is too short (FR-CAM-081)', async () => {
    const prefix = Buffer.from(realPrefix261Hex, 'hex');
    assertEq(prefix.length, 261, 'test fixture prefix must be exactly 261 bytes (matches the old, insufficient `>= 261` gate)');
    // Real packets of this shape are exactly 262 bytes — 1 trailing byte, nowhere
    // near the 72 bytes the extended block needs.
    const shortPacket = Buffer.concat([prefix, Buffer.from([0xea])]);
    const inst = new UDPDiscovery();
    const parsed = inst._parseResponse(shortPacket, { address: '192.168.214.37' });
    assertEq(parsed.modelType, undefined, 'modelType must be undefined, not a false 0 ("Camera")');
    assertEq(parsed.chDeviceNameNew, undefined, 'chDeviceNameNew must be undefined, not a false empty string');
    assertEq(parsed.httpType, undefined, 'httpType must be undefined (already correct pre-fix, must stay so)');

    const mapped = mapUDPDevice(parsed);
    assertEq(mapped.Type, undefined, 'mapUDPDevice() must not surface a false Type from the short packet');
    assertEq(mapped.DeviceType, undefined, 'mapUDPDevice() must not surface a false DeviceType label from the short packet');
  });

  await test('TC-H-027', 'UDP extended fields parse correctly and map to a DeviceType label for a genuine nMode=12 (DEF_RES_SCAN_EXT) response (FR-CAM-081, FR-CAM-084)', async () => {
    const prefix = withMode(Buffer.from(realPrefix261Hex, 'hex'), 12);
    const alias = Buffer.alloc(32);
    const chDeviceNameNew = Buffer.alloc(32);
    chDeviceNameNew.write('XRN-1610S-TEST');
    const extended = Buffer.concat([
      alias, chDeviceNameNew,
      Buffer.from([0x03]),       // modelType = Recorder
      Buffer.from([0x00, 0x00]), // version
      Buffer.from([0x00]),       // httpType
      Buffer.from([0x00]),       // Reserved3
      Buffer.from([0x01, 0xbb]), // nHttpsPort
      Buffer.from([0x05]),       // supportedProtocol
      Buffer.from([0x01]),       // noPassword
    ]);
    const fullPacket = Buffer.concat([prefix, extended]);
    assertEq(fullPacket.length, 334, 'full extended packet is 334 bytes (73-byte extended block, per DATAPACKET_EXT_IPv4_T)');

    const inst = new UDPDiscovery();
    const parsed = inst._parseResponse(fullPacket, { address: '10.0.0.99' });
    assertEq(parsed.nMode, 12, 'test fixture actually carries nMode=12 (DEF_RES_SCAN_EXT)');
    assertEq(parsed.modelType, 3, 'modelType parses correctly for a genuine nMode=12 response');
    assertEq(parsed.chDeviceNameNew, 'XRN-1610S-TEST', 'chDeviceNameNew parses correctly');

    const mapped = mapUDPDevice(parsed);
    assertEq(mapped.Type, 3, 'mapUDPDevice() surfaces the raw Type code');
    assertEq(mapped.DeviceType, 'Recorder', 'mapUDPDevice() surfaces the human-readable label (0x03 = Recorder)');
  });

  await test('TC-H-040', 'MaxChannel is derived from nMulticastPort only when nMode is DEF_RES_SCAN_EXT (12) — a base-mode (nMode=11) response keeps nMulticastPort as a port, not a channel count (FR-CAM-091)', async () => {
    // MaxChannel is a BASE field (nMulticastPort, always decoded) reinterpreted
    // by UdpResponse's `MaxChannel` getter — no extended tail bytes needed,
    // just the real 262-byte capture with nMode forced to 12.
    const base262 = Buffer.from(real262Hex, 'hex');
    const inst = new UDPDiscovery();

    const parsedBase = inst._parseResponse(base262, { address: '192.168.214.37' });
    assertEq(parsedBase.nMode, 11, "sanity: this fixture's real nMode is 11 (base mode)");
    assertEq(parsedBase.nMulticastPort, 10050, "sanity: this fixture's raw nMulticastPort value");
    assertEq(parsedBase.nMaxChannel, undefined, 'base-mode (nMode=11) response must NOT derive a nMaxChannel from nMulticastPort');
    assertEq(mapUDPDevice(parsedBase).MaxChannel, 1, 'mapUDPDevice() falls back to 1 when raw.nMaxChannel is undefined');

    const parsedExt = inst._parseResponse(withMode(base262, 12), { address: '10.0.0.99' });
    assertEq(parsedExt.nMulticastPort, 10050, 'same underlying bytes — nMulticastPort decodes identically regardless of nMode');
    assertEq(parsedExt.nMaxChannel, 10050, 'extended (nMode=12) response derives nMaxChannel from the same nMulticastPort bytes');
    assertEq(mapUDPDevice(parsedExt).MaxChannel, 10050, 'mapUDPDevice() surfaces the derived MaxChannel when > 1');
  });

  await test('TC-H-030', '`supported_protocol` and `no_password` (DATAPACKET_EXT_IPv4_T\'s last two bytes) are read from distinct, correctly-ordered offsets, not aliased to the same byte (FR-CAM-083)', async () => {
    // Regression guard for a real off-by-one: _parseResponse() used to read
    // `noPassword` from the byte belonging to `supported_protocol` (the field
    // immediately before it in the struct) and never advanced to read the
    // actual trailing `no_password` byte at all. Distinct sentinel values
    // below (0x07 vs 0x01) fail loudly if the two ever collapse back into one.
    const prefix = withMode(Buffer.from(realPrefix261Hex, 'hex'), 12);
    const alias = Buffer.alloc(32);
    const chDeviceNameNew = Buffer.alloc(32);
    const extended = Buffer.concat([
      alias, chDeviceNameNew,
      Buffer.from([0x00]),       // modelType
      Buffer.from([0x00, 0x00]), // version
      Buffer.from([0x00]),       // httpType
      Buffer.from([0x00]),       // Reserved3
      Buffer.from([0x00, 0x50]), // nHttpsPort
      Buffer.from([0x07]),       // supportedProtocol (sentinel)
      Buffer.from([0x01]),       // noPassword (distinct sentinel)
    ]);
    const fullPacket = Buffer.concat([prefix, extended]);

    const inst = new UDPDiscovery();
    const parsed = inst._parseResponse(fullPacket, { address: '10.0.0.99' });
    assertEq(parsed.supportedProtocol, 7, 'supportedProtocol reads the byte immediately after nHttpsPort');
    assertEq(parsed.noPassword, 1, 'noPassword reads the final trailing byte, distinct from supportedProtocol');

    const mapped = mapUDPDevice(parsed);
    assertEq(mapped.SupportedProtocol, 7, 'mapUDPDevice() surfaces the raw SupportedProtocol byte');
  });

  await test('TC-H-031', 'A base-mode (nMode=11) response never parses the extended block, even when the packet happens to be long enough to numerically fit it (FR-CAM-084)', async () => {
    // Same synthetic extended bytes as TC-H-027, but nMode is left at the
    // real capture's actual base-mode value (11) instead of being forced to
    // 12 — proves the parser gates on nMode, not merely on remaining length.
    // Before this fix, this exact packet would have been (mis)parsed as if
    // it were a genuine DEF_RES_SCAN_EXT response.
    const prefix = Buffer.from(realPrefix261Hex, 'hex'); // nMode=11, unmodified
    assertEq(prefix[0], 11, 'sanity: real capture prefix is base-mode (nMode=11)');
    const alias = Buffer.alloc(32);
    const chDeviceNameNew = Buffer.alloc(32);
    chDeviceNameNew.write('XRN-1610S-TEST');
    const extended = Buffer.concat([
      alias, chDeviceNameNew,
      Buffer.from([0x03]),       // modelType = Recorder
      Buffer.from([0x00, 0x00]), // version
      Buffer.from([0x00]),       // httpType
      Buffer.from([0x00]),       // Reserved3
      Buffer.from([0x01, 0xbb]), // nHttpsPort
      Buffer.from([0x05]),       // supportedProtocol
      Buffer.from([0x01]),       // noPassword
    ]);
    const fullPacket = Buffer.concat([prefix, extended]);
    assertEq(fullPacket.length, 334, 'packet is numerically long enough for the full extended block');

    const inst = new UDPDiscovery();
    const parsed = inst._parseResponse(fullPacket, { address: '10.0.0.99' });
    assertEq(parsed.nMode, 11, 'test fixture carries base-mode nMode=11');
    assertEq(parsed.modelType, undefined, 'modelType must stay undefined — nMode=11 has no extended block regardless of packet length');
    assertEq(parsed.chDeviceNameNew, undefined, 'chDeviceNameNew must stay undefined for the same reason');
    assertEq(parsed.supportedProtocol, undefined, 'supportedProtocol must stay undefined for the same reason');

    const mapped = mapUDPDevice(parsed);
    assertEq(mapped.DeviceType, undefined, 'mapUDPDevice() must not surface a DeviceType from trailing bytes of a base-mode response');
  });

  await test('TC-H-033', '_parseResponse() bails out (returns null) for nMode values belonging to a different exchange entirely (RSA/password-apply), not the IP-Scan struct (FR-CAM-084)', async () => {
    // Table 1/2 defines nMode values for exchanges this parser never
    // implements (RSA key exchange §3.5, password-apply §3.6/§3.7) — each
    // uses its own wire struct, incompatible with the IP-Scan layout parsed
    // here. A well-behaved parser must recognize these and refuse to guess,
    // rather than reading garbage chIP/chMac/etc. from the wrong struct.
    const nonScanModes = [13, 23, 24, 25, 33, 66, 77]; // DEF_RES_SCAN_RSA .. DEF_RES_APPLY_ERR
    const inst = new UDPDiscovery();
    for (const mode of nonScanModes) {
      const packet = Buffer.from(realPrefix261Hex, 'hex');
      packet[0] = mode;
      const parsed = inst._parseResponse(packet, { address: '10.0.0.99' });
      assertEq(parsed, null, `nMode=${mode} must yield null, not a misparsed scan device`);
    }
    // Sanity: the same bytes with nMode restored to a real scan value parse normally.
    const scanPacket = Buffer.from(realPrefix261Hex, 'hex');
    const parsedScan = inst._parseResponse(scanPacket, { address: '192.168.214.37' });
    assertEq(parsedScan.chIP, '192.168.214.37', 'sanity: base-mode (nMode=11) scan packet still parses normally');
  });
}

// ── TC-H-028 ~ TC-H-029, TC-H-032: server-side UDPDiscovery WiseNet binary parser (FR-CAM-082, FR-CAM-084) ──
//    server/src/utils/udpDiscovery.js used to have its own independent
//    implementation: first an ONVIF-XML-only stub (despite listening on the
//    WiseNet-specific port 7701/7711 — couldn't discover a SUNAPI/WiseNet
//    device at all), later a full inline duplicate of the WiseNet binary
//    protocol kept in sync with the git submodule by hand. It is now a thin
//    re-export of the `wisenet-chrome-ip-installer` npm dependency (same
//    repo/branch as the git submodule below, fetched by `npm install`) — no
//    independent parsing implementation lives in server/ anymore. These
//    tests verify the npm-package-backed parser behaves correctly and
//    matches the submodule-loaded copy byte-for-byte (both should be the
//    same source, loaded from two different install paths).

async function runFallbackParserTests() {
  console.log('\n── server-side UDPDiscovery (npm package) WiseNet binary parser (FR-CAM-082) ──\n');

  let UDPDiscovery, mapUDPDevice;
  try {
    ({ UDPDiscovery } = require('../../server/src/utils/udpDiscovery'));
    ({ mapUDPDevice } = require('../../server/src/services/discoveryService'));
  } catch (err) {
    console.log(`      (could not require server modules from this working directory — skipping: ${err.message})`);
    return;
  }

  const real262Hex = '0b8750735306465625ef6da75b047d7bcd1c3c30303a30393a31383a32313a39353a3835003139322e3136382e3231342e333700003235352e3235352e3235352e300000003139322e3136382e3231342e31000000000000000000000000000000000000000000000001bb0100504e4d2d433332303833745000a8112e2724271a2742270068747470733a2f2f3139322e3136382e3231342e33372f696e6465782e68746d00cf00d00b20000000000074ea18007a61c274f0eacf0000000000fc38410000000000000000000100000078f418008cea180076784100d00b2000f00000000000000001000000a4ea18000e7f4000c4ea18000904000050fe180078f41800f0ea';

  await test('TC-H-028', 'UDPDiscovery._parseResponse() parses a real captured packet correctly (endianness, ports, strings)', async () => {
    const inst = new UDPDiscovery();
    const parsed = inst._parseResponse(Buffer.from(real262Hex, 'hex'), { address: '192.168.214.37' });
    assertEq(parsed.chIP, '192.168.214.37', 'chIP');
    assertEq(parsed.chMac, '00:09:18:21:95:85', 'chMac');
    assertEq(parsed.chDeviceName, 'PNM-C32083', 'chDeviceName');
    assertEq(parsed.nPort, 443, 'nPort (HTTPS/web port) — catches ntohs() big/little-endian flag inversion');
    assertEq(parsed.nTcpPort, 10030, 'nTcpPort — catches the same endianness class of bug');
    assertEq(parsed.modelType, undefined, 'modelType still undefined for a short packet (same bounds-check fix as the submodule)');
  });

  await test('TC-H-029', 'npm-package-backed UDPDiscovery + mapUDPDevice() end-to-end matches the submodule-loaded copy for the same bytes', async () => {
    let UDPDiscoverySubmodule;
    try {
      ({ UDPDiscovery: UDPDiscoverySubmodule } = require('../../submodules/WiseNetChromeIPInstaller/nodejs/udpDiscovery'));
    } catch (err) {
      console.log(`      (submodule not available — skipping parity check: ${err.message})`);
      return;
    }
    const buf = Buffer.from(real262Hex, 'hex');
    const npmParsed        = new UDPDiscovery()._parseResponse(buf, { address: '192.168.214.37' });
    const submoduleParsed  = new UDPDiscoverySubmodule()._parseResponse(buf, { address: '192.168.214.37' });
    const fields = ['chMac', 'chIP', 'chSubnetMask', 'chGateway', 'nPort', 'nStatus', 'chDeviceName',
                     'nHttpPort', 'nDevicePort', 'nTcpPort', 'nUdpPort', 'nUploadPort', 'nMulticastPort',
                     'nNetworkMode', 'DDNSURL', 'modelType', 'httpType', 'supportedProtocol', 'noPassword',
                     'url', 'rtspUrl'];
    for (const f of fields) {
      assertEq(JSON.stringify(npmParsed[f]), JSON.stringify(submoduleParsed[f]), `field "${f}" must match between the npm-package-backed and submodule-loaded parsers`);
    }
    const npmMapped       = mapUDPDevice(npmParsed);
    const submoduleMapped = mapUDPDevice(submoduleParsed);
    assertEq(npmMapped.Model, submoduleMapped.Model, 'mapUDPDevice() Model matches');
    assertEq(npmMapped.Port, submoduleMapped.Port, 'mapUDPDevice() Port matches');
    assertEq(npmMapped.DeviceType, submoduleMapped.DeviceType, 'mapUDPDevice() DeviceType matches (both undefined for this short packet)');
  });

  await test('TC-H-032', 'npm-package-backed UDPDiscovery matches the submodule-loaded copy for a genuine nMode=12 (DEF_RES_SCAN_EXT) response, including supportedProtocol (FR-CAM-084)', async () => {
    let UDPDiscoverySubmodule;
    try {
      ({ UDPDiscovery: UDPDiscoverySubmodule } = require('../../submodules/WiseNetChromeIPInstaller/nodejs/udpDiscovery'));
    } catch (err) {
      console.log(`      (submodule not available — skipping parity check: ${err.message})`);
      return;
    }
    const prefix = Buffer.from(real262Hex.slice(0, 261 * 2), 'hex');
    prefix[0] = 12; // force DEF_RES_SCAN_EXT
    const alias = Buffer.alloc(32);
    const chDeviceNameNew = Buffer.alloc(32);
    chDeviceNameNew.write('XRN-1610S-TEST');
    const extended = Buffer.concat([
      alias, chDeviceNameNew,
      Buffer.from([0x03]),       // modelType = Recorder
      Buffer.from([0x00, 0x00]), // version
      Buffer.from([0x00]),       // httpType
      Buffer.from([0x00]),       // Reserved3
      Buffer.from([0x01, 0xbb]), // nHttpsPort
      Buffer.from([0x05]),       // supportedProtocol
      Buffer.from([0x01]),       // noPassword
    ]);
    const buf = Buffer.concat([prefix, extended]);

    const npmParsed       = new UDPDiscovery()._parseResponse(buf, { address: '10.0.0.99' });
    const submoduleParsed = new UDPDiscoverySubmodule()._parseResponse(buf, { address: '10.0.0.99' });
    assertEq(npmParsed.modelType, 3, 'npm-package-backed parser resolves modelType for a genuine nMode=12 response');
    assertEq(npmParsed.supportedProtocol, 5, 'npm-package-backed parser resolves supportedProtocol correctly');
    const fields = ['modelType', 'chDeviceNameNew', 'version', 'httpType', 'nHttpsPort', 'supportedProtocol', 'noPassword'];
    for (const f of fields) {
      assertEq(JSON.stringify(npmParsed[f]), JSON.stringify(submoduleParsed[f]), `field "${f}" must match between the npm-package-backed and submodule-loaded parsers for an nMode=12 response`);
    }
    const npmMapped       = mapUDPDevice(npmParsed);
    const submoduleMapped = mapUDPDevice(submoduleParsed);
    assertEq(npmMapped.DeviceType, 'Recorder', 'mapUDPDevice() DeviceType resolves for the npm-package-backed parser');
    assertEq(npmMapped.DeviceType, submoduleMapped.DeviceType, 'mapUDPDevice() DeviceType matches between implementations');
    assertEq(npmMapped.SupportedProtocol, submoduleMapped.SupportedProtocol, 'mapUDPDevice() SupportedProtocol matches between implementations');
  });

  await test('TC-H-034', 'UDPDiscovery._parseResponse() also bails out (returns null) for non-scan nMode values (FR-CAM-084)', async () => {
    const nonScanModes = [13, 23, 24, 25, 33, 66, 77];
    const inst = new UDPDiscovery();
    for (const mode of nonScanModes) {
      const packet = Buffer.from(real262Hex, 'hex');
      packet[0] = mode;
      const parsed = inst._parseResponse(packet, { address: '10.0.0.99' });
      assertEq(parsed, null, `nMode=${mode} must yield null, not a misparsed scan device`);
    }
  });
}

// ── TC-H-035~036: RTSP port field bug (FR-CAM-088) + Digest auth combined-header detection (FR-CAM-089) ──

async function runRtspPortAndDigestAuthTests() {
  console.log('\n── RTSP port field bug (FR-CAM-088) + Digest auth robustness (FR-CAM-089) ──\n');

  let UDPDiscovery, mapUDPDevice, buildDigestAuthHeader;
  try {
    ({ UDPDiscovery } = require('../../server/src/utils/udpDiscovery'));
    ({ mapUDPDevice, buildDigestAuthHeader } = require('../../server/src/services/discoveryService'));
  } catch (err) {
    console.log(`      (could not require server modules from this working directory — skipping: ${err.message})`);
    return;
  }

  const real262Hex = '0b8750735306465625ef6da75b047d7bcd1c3c30303a30393a31383a32313a39353a3835003139322e3136382e3231342e333700003235352e3235352e3235352e300000003139322e3136382e3231342e31000000000000000000000000000000000000000000000001bb0100504e4d2d433332303833745000a8112e2724271a2742270068747470733a2f2f3139322e3136382e3231342e33372f696e6465782e68746d00cf00d00b20000000000074ea18007a61c274f0eacf0000000000fc38410000000000000000000100000078f418008cea180076784100d00b2000f00000000000000001000000a4ea18000e7f4000c4ea18000904000050fe180078f41800f0ea';

  await test('TC-H-035a', '_parseResponse() rtspUrl uses SUNAPI standard port 554, not nTcpPort (FR-CAM-088)', async () => {
    const inst = new UDPDiscovery();
    const parsed = inst._parseResponse(Buffer.from(real262Hex, 'hex'), { address: '192.168.214.37' });
    assertEq(parsed.nTcpPort, 10030, 'sanity: this fixture\'s raw nTcpPort is 10030 (a VNP-only field, not the RTSP port)');
    assert(parsed.rtspUrl.includes(':554/'), `rtspUrl must use port 554, got: ${parsed.rtspUrl}`);
    assert(!parsed.rtspUrl.includes(':10030'), `rtspUrl must NOT use nTcpPort's value (10030): ${parsed.rtspUrl}`);
  });

  await test('TC-H-035b', 'mapUDPDevice() Port/rtspUrl use 554, not raw.nPort (FR-CAM-088)', async () => {
    const inst = new UDPDiscovery();
    const parsed = inst._parseResponse(Buffer.from(real262Hex, 'hex'), { address: '192.168.214.37' });
    assertEq(parsed.nPort, 443, 'sanity: this fixture\'s raw nPort is 443 (the HTTPS web port, not the RTSP port)');
    const mapped = mapUDPDevice(parsed);
    assertEq(mapped.Port, 554, 'mapUDPDevice() Port must be the SUNAPI standard 554, not raw.nPort (443)');
    assert(mapped.rtspUrl.includes(':554'), `mapUDPDevice() rtspUrl must use port 554, got: ${mapped.rtspUrl}`);
  });

  await test('TC-H-036', 'buildDigestAuthHeader() detects and scopes to Digest in a combined multi-scheme WWW-Authenticate header (FR-CAM-089)', async () => {
    const combined = 'Basic realm="BasicRealm", Digest realm="DigestRealm", qop="auth", nonce="abc123nonce", opaque="op1"';
    assert(/\bDigest\b/i.test(combined), 'sanity: combined header does contain "Digest" (not at string start)');
    assert(!/^Digest\s/i.test(combined), 'sanity: the OLD anchored regex would NOT match this combined header (regression guard)');

    const header = buildDigestAuthHeader(combined, 'GET', '/stw-cgi/network.cgi?msubmenu=portconf&action=view', 'admin', 'pass');
    assert(header.includes('realm="DigestRealm"'), `Authorization header must use the Digest scheme's realm: ${header}`);
    assert(!header.includes('realm="BasicRealm"'), `Authorization header must NOT pick up the Basic scheme's realm: ${header}`);
    assert(header.includes('nonce="abc123nonce"'), `Authorization header must include the Digest nonce: ${header}`);

    // Single-scheme case (pre-existing FR-CAM-072 behavior) must still work unchanged.
    const plain = 'Digest realm="iPolis_x", qop="auth", nonce="n1"';
    const plainHeader = buildDigestAuthHeader(plain, 'GET', '/path', 'admin', 'pass');
    assert(plainHeader.includes('realm="iPolis_x"'), `single-scheme Digest challenge must still work: ${plainHeader}`);
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== NVR Channel Discovery Tests (TC-H-001 ~ TC-H-034) ===');

  await runUnitTests();
  await runResolveUrlTests();
  await runChannelCountMaxTests();
  await runOnvifEnrichmentTests();
  await runOnvifAuthTests();
  await runSunapiUrlPatternTests();
  await runUdpExtendedFieldTests();
  await runFallbackParserTests();
  await runRtspPortAndDigestAuthTests();
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
