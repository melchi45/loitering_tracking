'use strict';
/**
 * Dashboard Channel Slot — REST API Tests
 *
 * TC: TC-CH-A-001 ~ TC-CH-B-003, TC-CH-F-001 ~ TC-CH-F-003, TC-CH-F-006 ~ TC-CH-F-009, TC-CH-F-011 ~ TC-CH-F-013d,
 *     TC-CH-G-001 ~ TC-CH-G-003
 *     (see docs/tc/TC_Channel_Slot.md — TC-CH-F-004/F-005/F-010 are manual, not in this file)
 * SRS: FR-CH-001 ~ FR-CH-069 (see docs/srs/SRS_Channel_Slot.md)
 *
 * Run: node test/api/channel_slot.test.js
 * Set LTS_URL env var to override the base URL (default http://localhost:3080).
 *
 * These tests create/delete their own camera records and do not require auth
 * against a running LTS server (consistent with test/api/nvr_channel_discovery.test.js).
 */

const BASE_URL = process.env.LTS_URL || 'http://localhost:3080';

// ── Minimal test harness ──────────────────────────────────────────────────────

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

async function put(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, body: data };
}

async function get(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, body: data };
}

async function del(path) {
  const res = await fetch(`${BASE_URL}${path}`, { method: 'DELETE' });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

let maxChannelNum = 512;
const createdIds = [];

function uniqueRtsp() {
  return `rtsp://127.0.0.${1 + Math.floor(Math.random() * 250)}:554/profile1/media.smp`;
}

async function addCamera(overrides = {}) {
  const { status, body } = await post('/api/cameras', {
    name:    `channel-slot-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    rtspUrl: uniqueRtsp(),
    ...overrides,
  });
  if (body?.data?.id) createdIds.push(body.data.id);
  return { status, body };
}

// ── Group A: POST/PUT validation ──────────────────────────────────────────────

async function runValidationTests() {
  console.log('\n── POST/PUT /api/cameras — channelSlot validation ──────────────\n');

  await test('TC-CH-A-001', 'POST /api/cameras auto-assigns channelSlot when omitted', async () => {
    const { status, body } = await addCamera();
    assertEq(status, 201, 'status');
    assert(typeof body.data?.channelSlot === 'number', 'channelSlot must be auto-assigned');
    assert(body.data.channelSlot >= 1 && body.data.channelSlot <= maxChannelNum, 'channelSlot in range');
  });

  await test('TC-CH-A-002a', 'channelSlot below 1 rejected', async () => {
    const { status, body } = await addCamera({ channelSlot: 0 });
    assertEq(status, 400, 'status');
    assert(/channelSlot/i.test(body.error || ''), 'error mentions channelSlot');
  });

  await test('TC-CH-A-002b', 'channelSlot above MAX_CHANNEL_NUM rejected', async () => {
    const { status, body } = await addCamera({ channelSlot: maxChannelNum + 1 });
    assertEq(status, 400, 'status');
    assert(/channelSlot/i.test(body.error || ''), 'error mentions channelSlot');
  });

  await test('TC-CH-A-003', 'Duplicate channelSlot rejected with 409', async () => {
    const slot = 200 + Math.floor(Math.random() * 50); // avoid clashing with other test runs
    const first = await addCamera({ channelSlot: slot });
    assertEq(first.status, 201, 'first camera status');

    const second = await addCamera({ channelSlot: slot });
    assertEq(second.status, 409, 'second camera status');
    assert(second.body.error?.includes(String(slot)) || /already assigned/i.test(second.body.error || ''),
      'error identifies the conflicting slot');
  });

  await test('TC-CH-A-004', 'PUT resubmitting own channelSlot is not a conflict', async () => {
    const { body } = await addCamera({ channelSlot: 260 });
    const id = body.data.id;
    const { status } = await put(`/api/cameras/${id}`, { channelSlot: 260, name: 'renamed-camera' });
    assertEq(status, 200, 'PUT status');
  });

  await test('TC-CH-A-005', 'PUT to a slot taken by a different camera is rejected', async () => {
    const a = await addCamera({ channelSlot: 270 });
    const b = await addCamera({ channelSlot: 271 });
    const { status, body } = await put(`/api/cameras/${b.body.data.id}`, { channelSlot: 270 });
    assertEq(status, 409, 'status');
    assert(body.error?.includes(a.body.data.name) || /already assigned/i.test(body.error || ''),
      'error identifies camera A');
  });

  await test('TC-CH-A-006', 'GET /health includes maxChannelNum', async () => {
    const { status, body } = await get('/health');
    assertEq(status, 200, 'status');
    assert(typeof body.maxChannelNum === 'number' && body.maxChannelNum > 0, 'maxChannelNum is a positive number');
    maxChannelNum = body.maxChannelNum;
  });

  await test('TC-CH-A-007', 'PUT accepts channelIndex update', async () => {
    const { body } = await addCamera({ maxChannel: 8, supportSunapi: true });
    const id = body.data.id;
    const { status } = await put(`/api/cameras/${id}`, { channelIndex: 4 });
    assertEq(status, 200, 'PUT status');

    const getRes = await get(`/api/cameras/${id}`);
    assertEq(getRes.body.data?.channelIndex, 4, 'channelIndex persisted');
  });
}

// ── Group F: POST /api/cameras/probe-channels ─────────────────────────────────

const http = require('http');

/** Minimal local HTTP server emulating SUNAPI's GET /stw-cgi/attributes.cgi/attributes
 *  (System/Limit/MaxChannel) — the real endpoint/XML shape, matching the vendor IP
 *  Installer's own query path (see discoveryService.js querySunapiMaxChannel()). */
function startMockSunapiServer(maxChannel) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.includes('attributes.cgi/attributes')) {
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        res.end(`<?xml version="1.0" encoding="UTF-8"?>
<attributes version="1.00">
  <group name="System">
    <category name="Limit">
      <attribute name="MaxChannel" type="int" value="${maxChannel}"/>
    </category>
  </group>
</attributes>`);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** Mock SUNAPI server that challenges with HTTP Digest (RFC 7616, qop=auth) instead
 *  of accepting Basic — reproduces the real-world firmware (nginx-fronted iPolis)
 *  that motivated FR-CH-067 (see docs/design/Design_Channel_Slot.md §4.6g). Only
 *  returns MaxChannel when the client's computed Digest `response` value is
 *  actually correct for the given username/password — a wrong password still
 *  401s, so this genuinely verifies the credential, not just "sent some Digest
 *  header". */
function startMockDigestSunapiServer(maxChannel, { username, password }) {
  const crypto = require('crypto');
  const realm = 'iPolis_test';
  const nonce = crypto.randomBytes(8).toString('hex');
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (!req.url.includes('attributes.cgi/attributes')) { res.writeHead(404); res.end(); return; }
      const auth = req.headers['authorization'] || '';
      if (/^Digest\s/i.test(auth)) {
        const param = (name) => {
          const m = auth.match(new RegExp(`${name}="?([^",]+)"?`, 'i'));
          return m ? m[1] : null;
        };
        const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
        const qop    = param('qop') || 'auth';
        const nc     = param('nc') || '00000001';
        const cnonce = param('cnonce') || '';
        const ha1 = md5(`${username}:${realm}:${password}`);
        const ha2 = md5(`GET:${param('uri')}`);
        const expected = md5(`${ha1}:${param('nonce')}:${nc}:${cnonce}:${qop}:${ha2}`);
        if (param('username') === username && param('nonce') === nonce && param('response') === expected) {
          res.writeHead(200, { 'Content-Type': 'application/xml' });
          res.end(`<?xml version="1.0" encoding="UTF-8"?>
<attributes version="1.00">
  <group name="System">
    <category name="Limit">
      <attribute name="MaxChannel" type="int" value="${maxChannel}"/>
    </category>
  </group>
</attributes>`);
          return;
        }
      }
      res.writeHead(401, { 'WWW-Authenticate': `Digest qop="auth", realm="${realm}", nonce="${nonce}"` });
      res.end();
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** Generic mock HTTP server — used to exercise probe-channels' per-branch error
 *  handling (auth-rejected / malformed-JSON) added alongside the DEBUG logging
 *  in FR-CH-063 (see docs/srs/SRS_Channel_Slot.md §8, docs/design/Design_Channel_Slot.md §4.6a). */
function startMockHttp(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function runProbeChannelsTests() {
  console.log('\n── POST /api/cameras/probe-channels ─────────────────────────────\n');

  await test('TC-CH-F-001', 'probe-channels requires ip', async () => {
    const { status, body } = await post('/api/cameras/probe-channels', {});
    assertEq(status, 400, 'status');
    assert(/ip/i.test(body.error || ''), 'error mentions ip');
  });

  await test('TC-CH-F-002', 'Unreachable IP responds within the timeout (not hanging)', async () => {
    const start = Date.now();
    const { status, body } = await post('/api/cameras/probe-channels', { ip: '192.0.2.1' }); // TEST-NET-1
    const elapsedMs = Date.now() - start;
    assertEq(status, 200, 'status');
    assertEq(body.maxChannel, 1, 'maxChannel falls back to 1');
    assertEq(body.protocol, 'none', 'protocol none');
    assert(elapsedMs < 15000, `expected response within ~9s timeout budget, got ${elapsedMs}ms`);
  });

  await test('TC-CH-F-003', 'SUNAPI detection synthesizes per-channel profiles from baseRtspUrl', async () => {
    const mockMaxChannel = 4;
    const server = await startMockSunapiServer(mockMaxChannel);
    try {
      const port = server.address().port;
      const { status, body } = await post('/api/cameras/probe-channels', {
        ip: '127.0.0.1',
        httpPort: port,
        baseRtspUrl: 'rtsp://127.0.0.1:554/profile1/media.smp',
      });
      assertEq(status, 200, 'status');
      assertEq(body.protocol, 'sunapi', 'protocol sunapi');
      assertEq(body.maxChannel, mockMaxChannel, 'maxChannel matches mock');
      assert(body.supportSunapi === true, 'supportSunapi true');
      assertEq(body.profiles.length, mockMaxChannel, 'one profile per channel');
      assert(body.profiles.some((p) => p.rtspUrl.includes('/profile3/')), 'channel 3 URL substituted');
    } finally {
      server.close();
    }
  });

  await test('TC-CH-F-006', 'SUNAPI 401 (auth rejected) is treated as not-detected, not an error (FR-CH-063 log path)', async () => {
    const server = await startMockHttp((req, res) => { res.writeHead(401); res.end(); });
    try {
      const port = server.address().port;
      const { status, body } = await post('/api/cameras/probe-channels', { ip: '127.0.0.1', httpPort: port });
      assertEq(status, 200, 'status');
      assertEq(body.maxChannel, 1, 'maxChannel falls back to 1 on auth rejection');
      assertEq(body.protocol, 'none', 'protocol none');
    } finally {
      server.close();
    }
  });

  await test('TC-CH-F-007', 'SUNAPI malformed/unparseable response body does not crash probe-channels (FR-CH-063 log path)', async () => {
    const server = await startMockHttp((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end('not-xml{{{ <unterminated');
    });
    try {
      const port = server.address().port;
      const { status, body } = await post('/api/cameras/probe-channels', { ip: '127.0.0.1', httpPort: port });
      assertEq(status, 200, 'status');
      assertEq(body.maxChannel, 1, 'maxChannel falls back to 1 on parse failure');
      assertEq(body.protocol, 'none', 'protocol none');
    } finally {
      server.close();
    }
  });

  await test('TC-CH-F-008', 'probe-channels skips the SUNAPI network call for an added camera with no password on file (FR-CH-064)', async () => {
    const mockMaxChannel = 4;
    const server = await startMockSunapiServer(mockMaxChannel);
    try {
      const port = server.address().port;
      const { body: added } = await addCamera({ httpPort: port }); // no username/password
      const { status, body } = await post('/api/cameras/probe-channels', {
        ip: '127.0.0.1', httpPort: port, cameraId: added.data.id,
      });
      assertEq(status, 200, 'status');
      if (process.env.RTSP_DEFAULT_PASSWORD) {
        // This server has a site-wide default password configured, so the SUNAPI
        // probe is still expected to run by design (FR-CH-064 only gates when *no*
        // credential is resolvable from any source) — can't exercise the "truly no
        // credentials" path in this environment.
        console.log('      (RTSP_DEFAULT_PASSWORD set on this server — skipping the no-credentials assertion)');
      } else {
        assertEq(body.maxChannel, 1, 'SUNAPI must be skipped, not queried — mock reports 4 but must not surface');
        assertEq(body.protocol, 'none', 'protocol none — SUNAPI was never attempted');
      }
    } finally {
      server.close();
    }
  });

  await test('TC-CH-F-009', "probe-channels uses the camera record's stored password when cameraId is given (FR-CH-064)", async () => {
    const mockMaxChannel = 4;
    const server = await startMockSunapiServer(mockMaxChannel);
    try {
      const port = server.address().port;
      const { body: added } = await addCamera({ httpPort: port, username: 'admin', password: 'secret123' });
      const { status, body } = await post('/api/cameras/probe-channels', {
        ip: '127.0.0.1', httpPort: port, cameraId: added.data.id,
        // deliberately no username/password in the request body — must come from the camera record
      });
      assertEq(status, 200, 'status');
      assertEq(body.protocol, 'sunapi', 'protocol sunapi — camera record credentials were used to authenticate the probe');
      assertEq(body.maxChannel, mockMaxChannel, 'maxChannel matches mock');
    } finally {
      server.close();
    }
  });

  await test('TC-CH-F-011', "probe-channels returns sunapiMaxChannel/onvifMaxChannel independently of which protocol wins as maxChannel/protocol (FR-CH-066)", async () => {
    const mockMaxChannel = 6;
    const server = await startMockSunapiServer(mockMaxChannel);
    try {
      const port = server.address().port;
      const { status, body } = await post('/api/cameras/probe-channels', { ip: '127.0.0.1', httpPort: port });
      assertEq(status, 200, 'status');
      // SUNAPI wins the combined maxChannel/protocol fields here (no ONVIF profiles on 127.0.0.1) —
      // sunapiMaxChannel/onvifMaxChannel must still both be present and independently correct,
      // not just mirror whichever protocol won.
      assertEq(body.protocol, 'sunapi', 'protocol sunapi (SUNAPI wins — no ONVIF profiles)');
      assertEq(body.maxChannel, mockMaxChannel, 'combined maxChannel reflects the winner');
      assertEq(body.sunapiMaxChannel, mockMaxChannel, "sunapiMaxChannel reports SUNAPI's own count");
      assert(typeof body.onvifMaxChannel === 'number', 'onvifMaxChannel is present (ONVIF probe completed on 127.0.0.1, even though it lost)');
    } finally {
      server.close();
    }
  });

  await test('TC-CH-F-012', 'probe-channels retries with computed HTTP Digest auth when SUNAPI challenges for it, not just Basic (FR-CH-067)', async () => {
    const mockMaxChannel = 2;
    const creds = { username: 'admin', password: 'digestpass123' };
    const server = await startMockDigestSunapiServer(mockMaxChannel, creds);
    try {
      const port = server.address().port;
      const { status, body } = await post('/api/cameras/probe-channels', {
        ip: '127.0.0.1', httpPort: port, username: creds.username, password: creds.password,
      });
      assertEq(status, 200, 'status');
      assertEq(body.protocol, 'sunapi', 'protocol sunapi — Digest retry succeeded after the initial Basic attempt was challenged');
      assertEq(body.maxChannel, mockMaxChannel, 'maxChannel matches mock (only obtainable via the authenticated Digest retry)');
    } finally {
      server.close();
    }
  });

  await test('TC-CH-F-012b', 'probe-channels still fails when the Digest retry itself uses wrong credentials (FR-CH-067 does not weaken the credential check)', async () => {
    const mockMaxChannel = 2;
    const server = await startMockDigestSunapiServer(mockMaxChannel, { username: 'admin', password: 'correctpass' });
    try {
      const port = server.address().port;
      const { status, body } = await post('/api/cameras/probe-channels', {
        ip: '127.0.0.1', httpPort: port, username: 'admin', password: 'wrongpass',
      });
      assertEq(status, 200, 'status');
      assertEq(body.protocol, 'none', 'protocol none — wrong password is still rejected even after the Digest retry');
      assertEq(body.maxChannel, 1, 'maxChannel falls back to 1');
    } finally {
      server.close();
    }
  });
}

// TC-CH-F-005: probe-channels logs SUNAPI/ONVIF discovery data at DEBUG level
//   (FR-CH-063) — manual, not automated here. This suite deliberately runs
//   without auth (see file header), but observing log content requires either
//   `admin`-role auth against GET /admin/logs/recent or direct file/console
//   access — neither is available to this unauthenticated harness. TC-CH-F-006
//   and TC-CH-F-007 above are the automated proxy: they exercise the exact
//   branches (401 auth-rejected, malformed XML) that the new console.debug()
//   calls run through, verifying the added logging didn't change response
//   behavior or throw, even though the log *content* itself isn't asserted.
//   Manual steps: set LOG_LEVEL=DEBUG in server/.env, restart, trigger
//   Detect Channels/Re-detect, tail the log file or use Admin Dashboard →
//   Server Logs (see docs/ops/Channel_Slot_Guide.md §5.2 for expected output).

// ── Group D/E: UI behaviour notes (frontend-only, verified manually) ──────────
//
// TC-CH-D-006~009: manual Add "Detect Channels" / Edit "Re-detect" flows —
//   requires an actual browser session, no component test harness exists yet
//   for CameraList.tsx/CameraEditModal.tsx in this repo (see docs/tc/TC_Channel_Slot.md).
//
// TC-CH-D-010: Re-detect result feedback (fixed 2026-07-02) — clicking "Re-detect"
//   against a camera with no multi-channel NVR must replace the pre-click prompt
//   with a distinct "detection ran, nothing found" message, not leave the
//   pre-click prompt unchanged (previously indistinguishable from the button
//   silently doing nothing). Manual: open Edit on a camera with no maxChannel,
//   click Re-detect against a non-NVR IP, confirm the message text changes.
//
// TC-CH-D-011~012: Found-tab discovery panel (DiscoveredCameraPanel.tsx) — no
//   "Detect Channels" button (would duplicate the scan's own data); a
//   "Re-detect" button next to the channel-count field lets the operator force
//   a fresh single-IP probe when the scan result looks stale/incomplete, using
//   the panel's already-known HttpPort/HttpType/Username/Password. A successful
//   result updates the channel-count badge and CH button grid in the same
//   panel session (no re-scan, no reopen). Manual: open a discovered device
//   whose scan reported MaxChannel:1, click Re-detect against a mock endpoint
//   reporting >1 channels, confirm the grid updates and "+ Add to System"
//   submits the refreshed maxChannel.

// ── Group G: hasConfiguredSunapiCredentials() — pure function, no server needed ──

async function runBackgroundScanCredentialGateTests() {
  console.log('\n── discoveryService.hasConfiguredSunapiCredentials() (FR-CH-040a) ──\n');

  // Requires the module directly rather than going over HTTP — this is a pure
  // function with no I/O, so a live server isn't needed to exercise it (unlike
  // the rest of this suite). Loading discoveryService.js has no side effects at
  // require-time (no sockets opened, no scan started) — see its top-level code.
  let hasConfiguredSunapiCredentials;
  try {
    ({ hasConfiguredSunapiCredentials } = require('../../server/src/services/discoveryService'));
  } catch (err) {
    console.log(`      (could not require discoveryService.js from this working directory — skipping: ${err.message})`);
    return;
  }

  const savedUser = process.env.RTSP_DEFAULT_USERNAME;
  const savedPass = process.env.RTSP_DEFAULT_PASSWORD;
  try {
    await test('TC-CH-G-001', "hasConfiguredSunapiCredentials() gates the background-scan CGI fallback", async () => {
      // Step 1: neither set
      delete process.env.RTSP_DEFAULT_USERNAME;
      delete process.env.RTSP_DEFAULT_PASSWORD;
      assertEq(hasConfiguredSunapiCredentials(), false, 'step 1: neither set');

      // Step 2: only username set
      process.env.RTSP_DEFAULT_USERNAME = 'admin';
      delete process.env.RTSP_DEFAULT_PASSWORD;
      assertEq(hasConfiguredSunapiCredentials(), false, 'step 2: username alone is not sufficient');

      // Step 3: both set
      process.env.RTSP_DEFAULT_USERNAME = 'admin';
      process.env.RTSP_DEFAULT_PASSWORD = 'pass';
      assertEq(hasConfiguredSunapiCredentials(), true, 'step 3: both configured');

      // Step 4: both set to empty strings — falsy, same as unset
      process.env.RTSP_DEFAULT_USERNAME = '';
      process.env.RTSP_DEFAULT_PASSWORD = '';
      assertEq(hasConfiguredSunapiCredentials(), false, 'step 4: empty strings must not count as configured');
    });
  } finally {
    // Restore whatever this process actually had configured, so the rest of
    // the suite (and the live server this suite talks to, if run in the same
    // process — it isn't, but this is cheap insurance) isn't affected.
    if (savedUser === undefined) delete process.env.RTSP_DEFAULT_USERNAME; else process.env.RTSP_DEFAULT_USERNAME = savedUser;
    if (savedPass === undefined) delete process.env.RTSP_DEFAULT_PASSWORD; else process.env.RTSP_DEFAULT_PASSWORD = savedPass;
  }
}

async function runDiscoveryCacheLookupTests() {
  console.log('\n── discoveryService.getByIp() (FR-CH-065) ──\n');

  // Same direct-require approach as Group G above — getByIp() is a synchronous,
  // no-I/O Map lookup, so it's tested against a DiscoveryService instance created
  // in *this* process. That instance is isolated from whatever singleton the live
  // LTS server (that the rest of this suite talks to over HTTP) has in its own
  // process — this only proves the lookup logic itself is correct, not the full
  // probe-channels HTTP integration (see TC-CH-F-010, manual).
  let getDiscoveryService;
  try {
    ({ getDiscoveryService } = require('../../server/src/services/discoveryService'));
  } catch (err) {
    console.log(`      (could not require discoveryService.js from this working directory — skipping: ${err.message})`);
    return;
  }

  await test('TC-CH-G-002', 'DiscoveryService.getByIp() returns a cached device by IP, null on a miss', async () => {
    const svc = getDiscoveryService({ emit: () => {} }); // minimal mock io — never emits in this test
    assert(svc, 'getDiscoveryService() with a mock io must return a singleton instance');

    assertEq(svc.getByIp('203.0.113.99'), null, 'unknown IP returns null (no network call, no throw)');

    svc._upsert({
      id: 'ip_203.0.113.99', source: 'udp', IPAddress: '203.0.113.99',
      MACAddress: '', SupportSunapi: true, MaxChannel: 8, profiles: [],
    });

    const found = svc.getByIp('203.0.113.99');
    assert(found, 'known IP must return the cached device');
    assertEq(found.MaxChannel, 8, 'cached MaxChannel matches what was upserted');
    assertEq(found.SupportSunapi, true, 'cached SupportSunapi matches');
  });

  await test('TC-CH-G-003', 'DiscoveryService.applyProbeResult() raises a stale registry value but never lowers it, and no-ops for unknown IPs (FR-CH-068)', async () => {
    const emitted = [];
    const svc = getDiscoveryService({ emit: (event, payload) => emitted.push({ event, payload }) });

    // Seed a device the way an under-informative UDP-only scan would —
    // MaxChannel:1 (binary field not parsed yet, see FR-CH-040a).
    svc._upsert({
      id: 'ip_203.0.113.100', source: 'udp', IPAddress: '203.0.113.100',
      MACAddress: '', SupportSunapi: true, MaxChannel: 1, SunapiMaxChannel: 1, profiles: [],
    });

    // A probe that found a genuinely higher count (e.g. attributes.cgi confirmed
    // via a device-specific credential) must raise the registry value and emit.
    const before = emitted.length;
    const raised = svc.applyProbeResult('203.0.113.100', {
      maxChannel: 2, supportSunapi: true, sunapiMaxChannel: 2, onvifMaxChannel: null,
    });
    assert(raised, 'a genuine improvement must return the updated device, not null');
    assertEq(raised.MaxChannel, 2, 'MaxChannel raised to the probe result');
    assertEq(raised.SunapiMaxChannel, 2, 'SunapiMaxChannel raised to the probe result');
    assertEq(svc.getByIp('203.0.113.100').MaxChannel, 2, 'the raise is persisted in the registry, not just returned');
    assertEq(emitted.length, before + 1, 'exactly one discovery:result broadcast for the genuine improvement');
    assertEq(emitted[emitted.length - 1].event, 'discovery:result', 'broadcast event name');

    // A subsequent lower/equal probe result must NOT regress the registry or emit again.
    const afterRaise = emitted.length;
    const notLowered = svc.applyProbeResult('203.0.113.100', {
      maxChannel: 1, supportSunapi: true, sunapiMaxChannel: 1, onvifMaxChannel: null,
    });
    assertEq(notLowered, null, 'a lower/equal result must return null (no-op)');
    assertEq(svc.getByIp('203.0.113.100').MaxChannel, 2, 'registry value must not regress');
    assertEq(emitted.length, afterRaise, 'no additional broadcast for a no-op probe result');

    // An IP the registry has never heard of has nothing to correct.
    const unknown = svc.applyProbeResult('203.0.113.200', { maxChannel: 5, sunapiMaxChannel: 5 });
    assertEq(unknown, null, 'unknown IP must return null — this corrects existing entries, it does not create new ones');
    assertEq(emitted.length, afterRaise, 'no broadcast for an IP outside the registry');
  });
}

// ── Group F (cont.): resolveProbeChannelsDecision() registry fallback (FR-CH-069) ──

async function runProbeChannelsDecisionTests() {
  console.log('\n── api/cameras.resolveProbeChannelsDecision() registry fallback (FR-CH-069) ──\n');

  // Same direct-require approach as Groups G above — this is a pure, no-I/O
  // decision function extracted specifically so the registry-fallback branch
  // can be tested without a live server/HTTP round-trip (see cameras.js).
  let resolveProbeChannelsDecision;
  try {
    ({ resolveProbeChannelsDecision } = require('../../server/src/api/cameras'));
  } catch (err) {
    console.log(`      (could not require api/cameras.js from this working directory — skipping: ${err.message})`);
    return;
  }

  await test('TC-CH-F-013', 'resolveProbeChannelsDecision falls back to the registry SUNAPI MaxChannel when both live probes find nothing (FR-CH-069)', async () => {
    const result = resolveProbeChannelsDecision({
      onvifMax: 1, onvifProfiles: [], sunapiMax: 1, sunapiProfiles: [],
      knownDevice: { MaxChannel: 2, SupportSunapi: true },
      baseRtspUrl: 'rtsp://127.0.0.1:554/profile1/media.smp',
    });
    assertEq(result.protocol, 'sunapi', 'protocol sunapi — registry fallback used, not none');
    assertEq(result.maxChannel, 2, 'maxChannel taken from the registry entry, not the empty live probes');
    assert(result.supportSunapi, 'supportSunapi true');
    assertEq(result.profiles.length, 2, 'profiles synthesized via channelRtspUrl() from baseRtspUrl');
    assertEq(result.profiles[1].rtspUrl, 'rtsp://127.0.0.1:554/profile2/media.smp', 'channel 2 URL substituted');
  });

  await test('TC-CH-F-013b', 'resolveProbeChannelsDecision reuses cached ONVIF profiles when the registry entry is ONVIF-only (FR-CH-069)', async () => {
    const result = resolveProbeChannelsDecision({
      onvifMax: 1, onvifProfiles: [], sunapiMax: 1, sunapiProfiles: [],
      knownDevice: {
        MaxChannel: 3, SupportSunapi: false,
        profiles: [
          { channelIndex: 1, rtspUrl: 'rtsp://127.0.0.1/ch1' },
          { channelIndex: 2, rtspUrl: 'rtsp://127.0.0.1/ch2' },
          { channelIndex: 3, rtspUrl: '' }, // unresolved — must be filtered out
        ],
      },
      baseRtspUrl: null,
    });
    assertEq(result.protocol, 'onvif', 'protocol onvif — registry entry has no SupportSunapi flag');
    assertEq(result.maxChannel, 3, 'maxChannel taken from the registry entry');
    assertEq(result.profiles.length, 2, 'only profiles with a resolved rtspUrl are reused');
  });

  await test('TC-CH-F-013c', 'resolveProbeChannelsDecision leaves the result unchanged when the registry has no better answer (FR-CH-069)', async () => {
    const noRegistryHit = resolveProbeChannelsDecision({
      onvifMax: 1, onvifProfiles: [], sunapiMax: 1, sunapiProfiles: [], knownDevice: null, baseRtspUrl: null,
    });
    assertEq(noRegistryHit.protocol, 'none', 'no registry entry at all — falls through to none, unchanged from before FR-CH-069');
    assertEq(noRegistryHit.maxChannel, 1, 'maxChannel 1');

    const registryAlsoSingleChannel = resolveProbeChannelsDecision({
      onvifMax: 1, onvifProfiles: [], sunapiMax: 1, sunapiProfiles: [],
      knownDevice: { MaxChannel: 1, SupportSunapi: true }, baseRtspUrl: null,
    });
    assertEq(registryAlsoSingleChannel.protocol, 'none', 'registry itself only knows single-channel — nothing to fall back to');
  });

  await test('TC-CH-F-013d', 'resolveProbeChannelsDecision prefers a successful live probe over the registry fallback (FR-CH-069 does not override a working live result)', async () => {
    const liveOnvifWins = resolveProbeChannelsDecision({
      onvifMax: 5, onvifProfiles: [{ channelIndex: 1, rtspUrl: 'rtsp://live/1' }], sunapiMax: 1, sunapiProfiles: [],
      knownDevice: { MaxChannel: 2, SupportSunapi: true }, baseRtspUrl: null,
    });
    assertEq(liveOnvifWins.protocol, 'onvif', 'a successful live ONVIF result wins over the (lower) registry value');
    assertEq(liveOnvifWins.maxChannel, 5, 'maxChannel from the live probe, not the registry');

    const liveSunapiWins = resolveProbeChannelsDecision({
      onvifMax: 1, onvifProfiles: [], sunapiMax: 4, sunapiProfiles: [{ channelIndex: 1, rtspUrl: 'rtsp://live/1' }],
      knownDevice: { MaxChannel: 99, SupportSunapi: true }, baseRtspUrl: null,
    });
    assertEq(liveSunapiWins.protocol, 'sunapi', 'a successful live SUNAPI result wins over the registry value');
    assertEq(liveSunapiWins.maxChannel, 4, 'maxChannel from the live probe, not the (higher) registry value');
  });
}

// ── Cleanup ────────────────────────────────────────────────────────────────────

async function cleanup() {
  for (const id of createdIds) {
    await del(`/api/cameras/${id}`).catch(() => {});
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  Dashboard Channel Slot — API Tests');
  console.log(`  Server: ${BASE_URL}`);
  console.log('══════════════════════════════════════════════════════════════');

  try {
    await runValidationTests();
    await runProbeChannelsTests();
    await runProbeChannelsDecisionTests();
    await runBackgroundScanCredentialGateTests();
    await runDiscoveryCacheLookupTests();
  } finally {
    await cleanup();
  }

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed · ${failed} failed`);
  console.log('══════════════════════════════════════════════════════════════\n');

  if (failed > 0) {
    console.log('Failed tests:');
    results.filter((r) => r.status === 'FAIL').forEach((r) => {
      console.log(`  ✗ ${r.id}: ${r.description}`);
      if (r.error) console.log(`    ${r.error}`);
    });
  }

  if (typeof process !== 'undefined') {
    process.exitCode = failed > 0 ? 1 : 0;
  }
})();
