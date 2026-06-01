'use strict';
/**
 * Test runner — executes all test scripts in order per TC document.
 * Run: node test/run_all.js
 *
 * Environment:
 *   LTS_URL=http://localhost:3001              (default)
 *   YOUTUBE_TEST_URL=https://www.youtube.com/watch?v=...  (optional)
 *
 * Flags:
 *   --only <group>   Run only matching suite names (substring match)
 *   --skip <group>   Skip matching suite names (substring match)
 *
 * Examples:
 *   node test/run_all.js
 *   node test/run_all.js --only face
 *   node test/run_all.js --skip youtube
 */

const { execSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ── Parse CLI flags ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const onlyIdx = args.indexOf('--only');
const skipIdx = args.indexOf('--skip');
const onlyFilter = onlyIdx !== -1 ? (args[onlyIdx + 1] || '').toLowerCase() : null;
const skipFilter = skipIdx !== -1 ? (args[skipIdx + 1] || '').toLowerCase() : null;

// ── Test suites ──────────────────────────────────────────────────────────────

const SUITES = [
  // ── Face Recognition ──────────────────────────────────────────────────────
  {
    file:  'test/api/face_gallery.test.js',
    label: 'TC_AI_Face_Recognition  — Groups A+E (Gallery CRUD & Cross-Camera)',
    tags:  ['face'],
  },
  {
    file:  'test/api/face_enrollment.test.js',
    label: 'TC_AI_Face_Recognition  — Groups B+G (Face Enrollment & Error Handling)',
    tags:  ['face'],
  },
  {
    file:  'test/api/missing_persons.test.js',
    label: 'TC_AI_Face_Recognition  — Group C (Missing Persons Detection)',
    tags:  ['face'],
  },

  // ── Human Detection ───────────────────────────────────────────────────────
  {
    file:  'test/api/human_detection.test.js',
    label: 'TC_AI_Human_Detection   — REST API Tests',
    tags:  ['human', 'detection'],
  },

  // ── Object Tracking ───────────────────────────────────────────────────────
  {
    file:  'test/api/object_tracking.test.js',
    label: 'TC_Object_Tracking      — Groups A+B+G (Zone CRUD & Tracker Config)',
    tags:  ['tracking', 'zones'],
  },

  // ── Camera Discovery ─────────────────────────────────────────────────────
  {
    file:  'test/api/camera_discovery.test.js',
    label: 'TC_Camera_Discovery     — Groups A+B+G (Discovery & Camera Registration)',
    tags:  ['camera', 'discovery'],
  },

  // ── Analytics Config (AI module toggles) ─────────────────────────────────
  {
    file:  'test/api/analytics_config.test.js',
    label: 'TC AI Modules           — Analytics Config Toggle Tests',
    tags:  ['analytics', 'ai'],
  },

  // ── YouTube Streams ───────────────────────────────────────────────────────
  {
    file:  'test/api/youtube_streams.test.js',
    label: 'TC_YouTube_RTSP_Ingest  — Groups A+D (URL Validation & REST CRUD)',
    tags:  ['youtube'],
  },
  {
    file:  'test/api/youtube_streams_lts2026.test.js',
    label: 'TC_LTS2026_YouTube      — Groups A+B+D (repeatPlayback & Schema)',
    tags:  ['youtube', 'lts2026'],
  },

  // ── WebRTC ────────────────────────────────────────────────────────────────
  {
    file:  'test/api/webrtc_ice.test.js',
    label: 'TC_STUN_TURN_ICE        — Groups A+C (ICE Config Endpoint)',
    tags:  ['webrtc', 'ice'],
  },
  {
    file:  'test/api/webrtc.test.js',
    label: 'TC_WebRTC_Media_Gateway — Group F (Capabilities & Stats API)',
    tags:  ['webrtc'],
  },
  {
    file:  'test/api/webrtc_stability.test.js',
    label: 'TC_WebRTC_Media_Gateway — Group H (Post-Patch Stability Verification)',
    tags:  ['webrtc', 'stability'],
  },

  // ── Main System ───────────────────────────────────────────────────────────
  {
    file:  'test/api/main_system.test.js',
    label: 'TC_LTS2026_Main_System  — Groups D+E+F+H (Zones, Alerts, Events, Tracker)',
    tags:  ['main', 'zones', 'alerts', 'events'],
  },

  // ── MCP Server ────────────────────────────────────────────────────────────
  {
    file:  'test/api/mcp_server.test.js',
    label: 'TC_LTS_MCP_Server       — Groups A+B+C+D+E+F (HTTP Transport & Tool Integration)',
    tags:  ['mcp', 'llm'],
  },

  // ── AI Detection Modules (Multi-module) ───────────────────────────────────
  {
    file:  'test/api/ai_detection_modules.test.js',
    label: 'TC AI Detection Modules — Accessories/Animal/Cloth/Color/Fire/Hat/Mask/Vehicle',
    tags:  ['ai', 'detection', 'analytics'],
  },

  // ── Cross-Camera Face Tracking ────────────────────────────────────────────
  {
    file:  'test/api/cross_camera_tracking.test.js',
    label: 'TC_CrossCamera_Tracking — Groups A+B+C+G (Trajectory, Stats, Persons)',
    tags:  ['face', 'crosscamera', 'tracking'],
  },

  // ── Dashboard Sidebar: Alerts & Zones ─────────────────────────────────────
  {
    file:  'test/api/sidebar_alerts_zones.test.js',
    label: 'TC_Sidebar_Alerts_Zones — Groups B+D (Alert Ack & Zone Editor REST API)',
    tags:  ['alerts', 'zones', 'sidebar'],
  },

  // ── Dashboard Sidebar: Cameras ────────────────────────────────────────────
  {
    file:  'test/api/sidebar_cameras.test.js',
    label: 'TC_Sidebar_Cameras      — Groups B+C+D+G (Camera REST API)',
    tags:  ['camera', 'sidebar'],
  },

  // ── Dashboard & Mobile E2E (Phase-3 placeholder) ─────────────────────────
  {
    file:  'test/e2e/dashboard_e2e.test.js',
    label: 'TC Dashboard & Mobile   — Phase-3 Placeholder (Layout/Detection/Mobile)',
    tags:  ['e2e', 'phase3', 'dashboard', 'mobile'],
  },
];

// ── Filter suites ────────────────────────────────────────────────────────────

function matchesSuite(suite) {
  const haystack = (suite.label + ' ' + suite.tags.join(' ')).toLowerCase();
  if (onlyFilter && !haystack.includes(onlyFilter)) return false;
  if (skipFilter && haystack.includes(skipFilter)) return false;
  return true;
}

const filteredSuites = SUITES.filter(matchesSuite);

if (filteredSuites.length === 0) {
  console.error('No suites matched the provided filter.');
  process.exit(1);
}

// ── Run ──────────────────────────────────────────────────────────────────────

let allPassed = true;
const summary = [];

console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║  LTS-2026 Full Test Suite                                    ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
if (onlyFilter) console.log(`  Filter --only: "${onlyFilter}"`);
if (skipFilter) console.log(`  Filter --skip: "${skipFilter}"`);
console.log(`  Running ${filteredSuites.length} of ${SUITES.length} suite(s)\n`);

for (const suite of filteredSuites) {
  console.log(`\n${'─'.repeat(64)}`);
  console.log(`Running: ${suite.label}`);
  console.log('─'.repeat(64));
  try {
    execSync(`node ${suite.file}`, {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env },
    });
    summary.push({ label: suite.label, passed: true });
  } catch (_) {
    allPassed = false;
    summary.push({ label: suite.label, passed: false });
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║  SUITE SUMMARY                                               ║');
console.log('╠══════════════════════════════════════════════════════════════╣');
for (const s of summary) {
  const icon = s.passed ? '✓' : '✗';
  const line = `  ${icon} ${s.label}`;
  console.log(line);
}
console.log('╠══════════════════════════════════════════════════════════════╣');
if (allPassed) {
  console.log('║  ALL SUITES PASSED ✓                                         ║');
} else {
  const failCount = summary.filter(s => !s.passed).length;
  console.log(`║  ${failCount} SUITE(S) FAILED ✗  — see output above${' '.repeat(26 - String(failCount).length)}║`);
}
console.log('╚══════════════════════════════════════════════════════════════╝\n');

process.exit(allPassed ? 0 : 1);
