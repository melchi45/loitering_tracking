'use strict';
/**
 * TcRunnerService — Startup TC test runner
 *
 * Runs all API test suites as child processes after server startup.
 * Results (TC ID, SRS ref, Pass/Fail) are stored in the `tc_results` DB table
 * and shown in Admin Dashboard → Audit → Startup Tests.
 *
 * Enabled by default; set TC_STARTUP_RUN=false to disable.
 */

const { spawn, execSync } = require('child_process');
const path        = require('path');
const fs          = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDB }   = require('../db');

// process.execPath may point to the glibc loader on systems where node is
// installed as a wrapper script (e.g. /opt/glibc-2.33 + shell shim).
// Resolve the actual 'node' binary via PATH instead.
const NODE_BIN = (() => {
  try {
    const p = execSync('which node', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (p) return p;
  } catch (_) {}
  return process.execPath;
})();

const ROOT = path.resolve(__dirname, '../../..');

// Milliseconds to wait after server listen before starting tests.
// Gives time for cameras to auto-start and the pipeline to settle.
const STARTUP_DELAY_MS = parseInt(process.env.TC_STARTUP_DELAY_MS || '10000', 10);

// Per-suite timeout (ms)
const SUITE_TIMEOUT_MS = parseInt(process.env.TC_SUITE_TIMEOUT_MS || '60000', 10);

// ── Suite registry ────────────────────────────────────────────────────────────
// Each entry: { file, label, srs }
// label = short human-readable name shown in the UI
// srs   = comma-separated SRS FR identifiers covered by this suite
const SUITES = [
  // Camera
  { file: 'test/api/camera_discovery.test.js',              srs: 'FR-CAM-040~056', label: 'Camera Discovery  A+B+G' },
  { file: 'test/api/nvr_channel_discovery.test.js',         srs: 'FR-CAM-060~067', label: 'NVR MaxChannel  H' },
  { file: 'test/api/sidebar_cameras.test.js',               srs: 'FR-CAM-001~020', label: 'Sidebar Cameras  B+C+D+G' },
  // Auth / User
  { file: 'test/api/auth.test.js',                          srs: 'FR-USR-AUTH-001~020', label: 'User Authentication' },
  { file: 'test/api/user_profile.test.js',                  srs: 'FR-USR-PROF-001~010', label: 'User Profile' },
  // AI Detection (analysisOnly: skip in SERVER_MODE=streaming)
  { file: 'test/api/human_detection.test.js',               srs: 'FR-HDT-017, FR-HDT-020, FR-HDT-032', label: 'Human Detection' },
  { file: 'test/api/ai_detection_modules.test.js',          srs: 'FR-AI-MOD-001~010', label: 'AI Detection Modules', analysisOnly: true },
  { file: 'test/api/analytics_config.test.js',              srs: 'FR-ANA-CFG-001~010', label: 'Analytics Config Toggle', analysisOnly: true },
  { file: 'test/api/model_catalog.test.js',                 srs: 'FR-MODEL-001~010', label: 'YOLO Model Catalog', analysisOnly: true },
  // Tracking / Zones / Alerts
  { file: 'test/api/object_tracking.test.js',               srs: 'FR-TRK-001~030', label: 'Object Tracking  A+B+G' },
  { file: 'test/api/sidebar_alerts_zones.test.js',          srs: 'FR-ZONE-001, FR-ALERT-001', label: 'Alerts & Zones  B+D' },
  { file: 'test/api/main_system.test.js',                   srs: 'FR-SYS-D+E+F+H', label: 'Main System  Zones/Alerts/Events' },
  { file: 'test/api/stats_panel.test.js',                   srs: 'FR-STATS-001~010', label: 'Stats Panel Modal' },
  // Face Recognition
  { file: 'test/api/face_gallery.test.js',                  srs: 'FR-FACE-001~020', label: 'Face Gallery  A+E' },
  { file: 'test/api/face_enrollment.test.js',               srs: 'FR-FACE-021~040', label: 'Face Enrollment  B+G' },
  { file: 'test/api/missing_persons.test.js',               srs: 'FR-FACE-MISSING-001~010', label: 'Missing Persons  C' },
  { file: 'test/api/missing-person.test.js',                srs: 'FR-FACE-MISSING-011~020', label: 'Missing Person API' },
  { file: 'test/api/cross_camera_tracking.test.js',         srs: 'FR-REID-001~030', label: 'Cross-Camera Tracking  A+B+C+G' },
  // Detection Snapshots
  { file: 'test/api/detection_snapshot_search.test.js',     srs: 'FR-SNAP-001~010', label: 'Detection Snapshots' },
  // WebRTC
  { file: 'test/api/webrtc.test.js',                        srs: 'FR-WEBRTC-001~020', label: 'WebRTC Capabilities & Stats  F' },
  { file: 'test/api/webrtc_ice.test.js',                    srs: 'FR-WEBRTC-ICE-001~010', label: 'WebRTC ICE Config  A+C' },
  { file: 'test/api/webrtc_stability.test.js',              srs: 'FR-WEBRTC-STA-001~010', label: 'WebRTC Stability  H' },
  { file: 'test/api/webrtc_telemetry.test.js',              srs: 'FR-WEBRTC-TEL-001~010', label: 'WebRTC Telemetry' },
  // TLS
  { file: 'test/api/https_tls.test.js',                     srs: 'FR-TLS-001~010', label: 'HTTPS TLS' },
  // ONVIF
  { file: 'test/api/onvif_metadata_pipeline.test.js',       srs: 'FR-ONVIF-PIPE-001~020', label: 'ONVIF Metadata Pipeline' },
  { file: 'test/api/onvif_apprtp.test.js',                  srs: 'FR-ONVIF-RTP-001~010', label: 'ONVIF App-RTP' },
  { file: 'test/api/thermal_radiometry_overlay.test.js',    srs: 'FR-THERMAL-001~010', label: 'Thermal Radiometry Overlay' },
  // Timeline range — streaming only (camera capture + ONVIF pipeline required)
  { file: 'test/api/timeline_range.test.js', srs: 'FR-TIMELINE-RANGE-001~008', label: 'Timeline 1H Range  Streaming', streamingOnly: true },
  // Capture / Pipeline
  { file: 'test/api/capture-backend.test.js',               srs: 'FR-CAP-001~020', label: 'RTSP Capture Backend' },
  { file: 'test/api/distributed_pipeline.test.js',          srs: 'FR-DIST-001~020', label: 'Distributed Pipeline  SERVER_MODE' },
  { file: 'test/api/streaming_mode_model_skip.test.js',     srs: 'FR-STREAM-MODEL-001~005', label: 'Streaming Model-Load Guard' },
  { file: 'test/api/streaming_without_analysis_url.test.js', srs: 'FR-STREAM-FALLBACK-001~005', label: 'Streaming Monitoring-Only Fallback' },
  // YouTube
  { file: 'test/api/youtube_streams.test.js',               srs: 'FR-YT-001~020', label: 'YouTube RTSP Ingest  A+D' },
  { file: 'test/api/youtube_streams_lts2026.test.js',       srs: 'FR-YT-LTS-001~010', label: 'LTS2026 YouTube Schema  A+B+D' },
  // MCP
  { file: 'test/api/mcp_server.test.js',                    srs: 'FR-MCP-001~020', label: 'MCP Server Tools  A-F' },
];

// ── State ─────────────────────────────────────────────────────────────────────

let _running   = false;
let _lastRunId = null;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Schedule the startup test run after a delay.
 * Must be called after the server is listening.
 * @param {number} port  The HTTP port the server is listening on
 */
function runOnStartup(port) {
  if (process.env.TC_STARTUP_RUN === 'false') {
    console.log('[TcRunner] TC_STARTUP_RUN=false — startup tests disabled');
    return;
  }
  console.log(`[TcRunner] Startup tests scheduled in ${STARTUP_DELAY_MS / 1000}s`);
  setTimeout(() => _run(port).catch(err => {
    console.error('[TcRunner] Unhandled error in test run:', err.message);
  }), STARTUP_DELAY_MS);
}

/**
 * Trigger a manual re-run immediately.
 * @param {number} port
 */
function runNow(port) {
  if (_running) return false;
  _run(port).catch(err => console.error('[TcRunner] Manual run error:', err.message));
  return true;
}

/**
 * @returns {{ run: object|null, results: object[] }}
 */
function getLatestRun() {
  const all = getDB().all('tc_results');
  if (!all.length) return { run: null, results: [], running: _running };

  // Find the runId with the latest runAt
  const runMap = {};
  for (const r of all) {
    if (!runMap[r.runId] || r.runAt > runMap[r.runId]) runMap[r.runId] = r.runAt;
  }
  const latestRunId = Object.entries(runMap).sort((a, b) => b[1].localeCompare(a[1]))[0][0];
  const results = all.filter(r => r.runId === latestRunId);
  results.sort((a, b) => {
    if (a.suiteFile !== b.suiteFile) return a.suiteFile.localeCompare(b.suiteFile);
    return a.tcId.localeCompare(b.tcId);
  });

  const passed  = results.filter(r => r.status === 'pass').length;
  const failed  = results.filter(r => r.status === 'fail').length;
  const skipped = results.filter(r => r.status === 'skip').length;

  return {
    run:     { runId: latestRunId, runAt: runMap[latestRunId], passed, failed, skipped, total: results.length },
    results,
    running: _running,
  };
}

/**
 * Delete all stored TC results.
 * @returns {number} rows deleted
 */
function clearResults() {
  const db = getDB();
  const all = db.all('tc_results');
  all.forEach(r => db.delete('tc_results', r.id));
  return all.length;
}

// ── Internal ──────────────────────────────────────────────────────────────────

async function _run(port) {
  if (_running) {
    console.warn('[TcRunner] A run is already in progress — skipping');
    return;
  }
  _running   = true;
  const runId = uuidv4();
  const runAt = new Date().toISOString();
  _lastRunId  = runId;

  const ltsUrl    = `http://localhost:${port}`;
  const serverMode = (process.env.SERVER_MODE || 'combined').trim().toLowerCase();
  const isStreaming = serverMode === 'streaming';
  let totalPass = 0, totalFail = 0, totalSkip = 0;

  console.log(`[TcRunner] Run ${runId.slice(0, 8)} started — ${SUITES.length} suites, SERVER_MODE=${serverMode}, LTS_URL=${ltsUrl}`);

  for (const suite of SUITES) {
    // Analysis-only suites are skipped in streaming mode (no local AI pipeline)
    if (isStreaming && suite.analysisOnly) {
      _save(runId, runAt, suite, 'TC-SKIP',
        `${suite.label} — skipped (SERVER_MODE=streaming, Analysis Server only)`, 'skip', null);
      totalSkip++;
      continue;
    }
    // Streaming-only suites are skipped in analysis/combined mode (need camera capture pipeline)
    if (!isStreaming && suite.streamingOnly) {
      _save(runId, runAt, suite, 'TC-SKIP',
        `${suite.label} — skipped (SERVER_MODE=${serverMode}, Streaming Server only)`, 'skip', null);
      totalSkip++;
      continue;
    }

    const absPath = path.resolve(ROOT, suite.file);
    if (!fs.existsSync(absPath)) {
      _save(runId, runAt, suite, 'TC-SKIP', `${suite.label} — file missing`, 'skip', null);
      totalSkip++;
      continue;
    }

    try {
      const { results, code } = await _runSuite(absPath, ltsUrl);

      if (results.length === 0) {
        // No TC-ID lines found — record the suite as a whole
        const status = code === 0 ? 'pass' : 'fail';
        _save(runId, runAt, suite, 'TC-SUITE', `${suite.label} — suite exited ${code === 0 ? 'OK' : `code ${code}`}`, status, null);
        status === 'pass' ? totalPass++ : totalFail++;
      } else {
        for (const r of results) {
          _save(runId, runAt, suite, r.tcId, r.desc, r.status, r.errorMsg);
          if (r.status === 'pass')   totalPass++;
          else if (r.status === 'fail') totalFail++;
          else totalSkip++;
        }
      }
    } catch (err) {
      _save(runId, runAt, suite, 'TC-ERR', `${suite.label} — runner error: ${err.message}`, 'fail', err.message);
      totalFail++;
    }
  }

  _running = false;
  console.log(`[TcRunner] Run ${runId.slice(0, 8)} complete: ${totalPass} pass, ${totalFail} fail, ${totalSkip} skip`);
}

/**
 * Spawn a single test file and capture its output.
 */
function _runSuite(absPath, ltsUrl) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn(NODE_BIN, [absPath], {
      cwd: ROOT,
      env: { ...process.env, LTS_URL: ltsUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', d => { stdout += d.toString('utf8'); });
    proc.stderr.on('data', d => { stderr += d.toString('utf8'); });

    const killTimer = setTimeout(() => {
      proc.kill('SIGTERM');
    }, SUITE_TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(killTimer);
      resolve({ results: _parseOutput(stdout, stderr), code: code ?? 1 });
    });

    proc.on('error', (err) => {
      clearTimeout(killTimer);
      resolve({ results: [], code: 1, _err: err.message });
    });
  });
}

/**
 * Parse test output into structured results.
 * Pass lines: stdout  `  ✓ TC-X-001: description`
 * Fail lines: stderr  `  ✗ TC-X-001: description`
 *                     `      error message`
 */
function _parseOutput(stdout, stderr) {
  const results = {};

  // Passing TCs from stdout
  for (const line of stdout.split('\n')) {
    const m = line.match(/✓\s+(TC[\w-]+):\s+(.+)/u);
    if (m) results[m[1]] = { tcId: m[1], desc: m[2].trim(), status: 'pass', errorMsg: null };
  }

  // Failing TCs from stderr
  const stderrLines = stderr.split('\n');
  for (let i = 0; i < stderrLines.length; i++) {
    const m = stderrLines[i].match(/✗\s+(TC[\w-]+):\s+(.+)/u);
    if (!m) continue;
    const nextTrimmed = (stderrLines[i + 1] ?? '').trim();
    const errorMsg = nextTrimmed && !nextTrimmed.match(/✗\s+TC/u) ? nextTrimmed : null;
    results[m[1]] = { tcId: m[1], desc: m[2].trim(), status: 'fail', errorMsg };
  }

  return Object.values(results).sort((a, b) => a.tcId.localeCompare(b.tcId));
}

function _save(runId, runAt, suite, tcId, tcDesc, status, errorMsg) {
  try {
    getDB().insert('tc_results', {
      id:         uuidv4(),
      runId,
      runAt,
      suiteFile:  suite.file,
      suiteLabel: suite.label,
      srsRefs:    suite.srs,
      tcId,
      tcDesc,
      status,
      errorMsg:   errorMsg ?? null,
    });
  } catch (err) {
    console.warn(`[TcRunner] DB save failed for ${tcId}: ${err.message}`);
  }
}

module.exports = { runOnStartup, runNow, getLatestRun, clearResults };
