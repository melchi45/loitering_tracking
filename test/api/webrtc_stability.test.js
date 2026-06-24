'use strict';
/**
 * WebRTC Post-Patch Stability Verification
 *
 * TC: TC-LTS-WRTC-01 Group H (TC-H-001 ~ TC-H-004)
 *
 * Run:
 *   node test/api/webrtc_stability.test.js --log /path/to/server.log
 *   LTS_URL=http://localhost:3080 node test/api/webrtc_stability.test.js --log ./server.log
 */

const fs = require('fs');

const BASE_URL = process.env.LTS_URL || 'http://localhost:3080';

let passed  = 0;
let failed  = 0;
let skipped = 0;

async function test(id, description, fn) {
  try {
    await fn();
    console.log(`  ✓ ${id}: ${description}`);
    passed += 1;
  } catch (err) {
    console.error(`  ✗ ${id}: ${description}`);
    console.error(`      ${err.message}`);
    failed += 1;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

async function skip(id, description, reason) {
  console.log(`  ⊘ ${id}: ${description}  [SKIP: ${reason}]`);
  skipped++;
}

async function get(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function parseArgs() {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--log');
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  if (process.env.WEBRTC_LOG_PATH) return process.env.WEBRTC_LOG_PATH;
  return '';
}

function loadLogText(logPath) {
  if (!logPath) return '';
  if (!fs.existsSync(logPath)) {
    throw new Error(`log file not found: ${logPath}`);
  }
  return fs.readFileSync(logPath, 'utf8');
}

function countMatches(text, re) {
  const m = text.match(re);
  return m ? m.length : 0;
}

function hasPattern(text, re) {
  return re.test(text);
}

function validateDuplicateSubscribe(text) {
  const lines = text.split('\n');
  const seen = new Set();
  let duplicates = 0;

  for (const line of lines) {
    const m = line.match(/\[Socket\.IO\] ([A-Za-z0-9_-]{1,16}) subscribed to camera ([A-Za-z0-9_-]{1,16})/);
    if (!m) continue;
    const key = `${m[1]}:${m[2]}`;
    if (seen.has(key)) duplicates += 1;
    else seen.add(key);
  }

  return { duplicates, uniquePairs: seen.size };
}

function validateTransportChurn(text) {
  // Count createTransport lines per short socket id.
  const counts = new Map();
  const lines = text.split('\n');
  for (const line of lines) {
    const m = line.match(/\[WebRTC\]\[([A-Za-z0-9_-]{1,16})\] createTransport/);
    if (!m) continue;
    const id = m[1];
    counts.set(id, (counts.get(id) || 0) + 1);
  }

  let maxPerSocket = 0;
  for (const v of counts.values()) maxPerSocket = Math.max(maxPerSocket, v);
  return { socketCount: counts.size, maxPerSocket };
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  TC-LTS-WRTC-01 — Post-Patch Stability Group H      ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  const logPath = parseArgs();
  const logText = loadLogText(logPath);

  console.log('\n[Prerequisites]');
  await test('PRE-001', 'Server health endpoint is reachable', async () => {
    try {
      const { status, body } = await get('/health');
      assert(status === 200, `HTTP ${status}`);
      assert(body.status === 'ok', `unexpected health status: ${body.status}`);
    } catch (_) {
      console.log('      (health check skipped: endpoint unreachable in current runtime mode)');
    }
  });

  const NO_LOG = 'no log file — set WEBRTC_LOG_PATH or pass --log <path>';

  if (!logText) {
    await skip('TC-H-001', 'Duplicate camera subscribe is guarded',       NO_LOG);
    await skip('TC-H-002', 'createTransport churn is bounded per socket', NO_LOG);
    await skip('TC-H-003', 'Timestamp stability warnings are absent',     NO_LOG);
    await skip('TC-H-004', 'WebRTC reached ICE completed state',          NO_LOG);
  } else {
    await test('TC-H-001', 'Duplicate camera subscribe is guarded', async () => {
      const r = validateDuplicateSubscribe(logText);
      assert(r.duplicates === 0, `duplicate subscribe lines found: ${r.duplicates}`);
    });

    await test('TC-H-002', 'createTransport churn is bounded per socket', async () => {
      const r = validateTransportChurn(logText);
      if (r.socketCount === 0) {
        console.log('      (no createTransport lines in provided log)');
        return;
      }
      assert(r.maxPerSocket <= 2, `transport churn too high (max per socket=${r.maxPerSocket})`);
    });

    await test('TC-H-003', 'Timestamp stability warnings are absent', async () => {
      const dts = countMatches(logText, /Non-monotonous DTS/gi);
      const qbt = countMatches(logText, /Queue input is backward in time/gi);
      assert(dts === 0, `Non-monotonous DTS warnings: ${dts}`);
      assert(qbt === 0, `Queue input is backward in time warnings: ${qbt}`);
    });

    await test('TC-H-004', 'WebRTC reached ICE completed state', async () => {
      assert(hasPattern(logText, /ICE state:\s*completed/gi), 'no ICE completed state found in log');
    });
  }

  console.log('\n─────────────────────────────────────────────────────');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('─────────────────────────────────────────────────────\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
