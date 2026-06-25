'use strict';
/**
 * Test runner — executes all test scripts in order per TC document.
 * Run: node test/run_all.js
 *
 * Environment:
 *   LTS_URL=http://localhost:3080              (default)
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
  // ── DB Layer ──────────────────────────────────────────────────────────────
  {
    file:  'test/api/db_layer.test.js',
    label: 'TC_DB_Layer              — Groups A+B+H+I+J (CRUD · Persist · Security · Durability)',
    tags:  ['db', 'storage', 'json', 'mongodb'],
  },

  // ── Auth / User ───────────────────────────────────────────────────────────
  {
    file:  'test/api/auth.test.js',
    label: 'TC_User_Auth             — User Authentication',
    tags:  ['auth', 'user'],
  },
  {
    file:  'test/api/user_profile.test.js',
    label: 'TC_User_Profile          — User Profile CRUD',
    tags:  ['user', 'profile'],
  },

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
  {
    file:  'test/api/missing-person.test.js',
    label: 'TC_Missing_Person_API   — Missing Person API (FR-FACE-MISSING-011~020)',
    tags:  ['face', 'missing'],
  },
  {
    file:  'test/api/detection_snapshot_search.test.js',
    label: 'TC_Detection_Snapshots  — Detection Snapshot Search',
    tags:  ['detection', 'snapshots'],
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
  {
    file:  'test/api/nvr_channel_discovery.test.js',
    label: 'TC_NVR_MaxChannel       — Group H (NVR Channel Discovery)',
    tags:  ['camera', 'nvr'],
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
  {
    file:  'test/api/webrtc_telemetry.test.js',
    label: 'TC_WebRTC_Telemetry     — WebRTC Telemetry',
    tags:  ['webrtc', 'telemetry'],
  },

  // ── Stats Panel ───────────────────────────────────────────────────────────
  {
    file:  'test/api/stats_panel.test.js',
    label: 'TC_Stats_Panel          — Stats Panel Modal',
    tags:  ['stats', 'panel'],
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
  {
    file:  'test/api/mcp_server_extended.test.js',
    label: 'TC_LTS_MCP_Extended     — Groups J-O (System·Camera·ONVIF·Detection·FaceTrajectory)',
    tags:  ['mcp', 'llm', 'extended'],
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

  // ── Distributed AI Pipeline ───────────────────────────────────────────────
  {
    file:  'test/api/distributed_pipeline.test.js',
    label: 'TC_Distributed_Pipeline — SERVER_MODE mode contract tests',
    tags:  ['distributed', 'pipeline', 'server_mode', 'analysis', 'streaming'],
  },
  {
    file:  'test/api/streaming_mode_model_skip.test.js',
    label: 'TC_Streaming_Model_Skip — streaming eager model-load guard',
    tags:  ['streaming', 'server_mode', 'models', 'unit'],
  },
  {
    file:  'test/api/streaming_without_analysis_url.test.js',
    label: 'TC_Streaming_Monitoring_Only — empty ANALYSIS_SERVER_URL fallback',
    tags:  ['streaming', 'server_mode', 'monitoring-only', 'unit'],
  },

  // ── Capture Backend ───────────────────────────────────────────────────────
  {
    file:  'test/api/capture-backend.test.js',
    label: 'TC_RTSP_Capture_Backend — CaptureFactory / GStreamer / PyAV unit tests',
    tags:  ['capture', 'rtsp', 'gstreamer', 'pyav', 'ffmpeg'],
  },

  // ── HTTPS / TLS ───────────────────────────────────────────────────────────
  {
    file:  'test/api/https_tls.test.js',
    label: 'TC_HTTPS_TLS            — HTTPS TLS',
    tags:  ['https', 'tls', 'security'],
  },

  // ── ONVIF Metadata Pipeline ───────────────────────────────────────────────
  {
    file:  'test/api/onvif_apprtp.test.js',
    label: 'TC_ONVIF_AppRTP       — App RTP handler unit (TC-APPRTP-007~009, PARSER-A~C)',
    tags:  ['onvif', 'apprtp', 'unit', 'regression'],
  },
  {
    file:  'test/api/onvif_metadata_pipeline.test.js',
    label: 'TC_ONVIF_Metadata_Pipeline — parser unit + API integration (multi-notification)',
    tags:  ['onvif', 'parser', 'metadata', 'unit', 'regression'],
  },
  {
    file:  'test/api/thermal_radiometry_overlay.test.js',
    label: 'TC_Thermal_Radiometry   — Thermal Radiometry Overlay',
    tags:  ['thermal', 'onvif', 'overlay'],
  },

  // ── Timeline ──────────────────────────────────────────────────────────────
  {
    file:  'test/api/timeline_range.test.js',
    label: 'TC_Timeline_Range       — Timeline 1H Range (streaming mode only)',
    tags:  ['timeline', 'streaming'],
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
