'use strict';
/**
 * TC Runner CLI — Admin Dashboard "Startup Tests" 와 동일한 TC-ID 단위 테스트 실행기
 *
 * 각 테스트 스위트를 child process로 실행하고 ✓/✗ TC-ID 행을 파싱해
 * Admin Dashboard Audit 패널과 동일한 구조의 리포트를 생성합니다.
 *
 * Usage:
 *   node test/tc_runner_cli.js
 *   node test/tc_runner_cli.js --url http://localhost:3080
 *   node test/tc_runner_cli.js --skip youtube --only face
 *   node test/tc_runner_cli.js --output-json test/reports/tc.json
 *   node test/tc_runner_cli.js --output-md test/reports/tc.md
 *   node test/tc_runner_cli.js --github-summary
 *   node test/tc_runner_cli.js --server-mode streaming
 *
 * npm scripts:
 *   npm run test:tc           (root or server/)
 *   npm run test:tc -- --only face
 *   npm run test:report
 *
 * Exits:
 *   0 — all suites passed (or skipped)
 *   1 — one or more suites failed
 *   2 — server not reachable
 */

const { spawn, execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const http  = require('http');
const https = require('https');

// ── Resolve node binary ───────────────────────────────────────────────────────

const NODE_BIN = (() => {
  try {
    return execSync('which node', { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim() || process.execPath;
  } catch (_) { return process.execPath; }
})();

const ROOT       = path.resolve(__dirname, '..');
const REPORT_DIR = path.join(ROOT, 'test', 'reports');

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] || '' : null;
}
function hasFlag(flag) { return args.includes(flag); }

const LTS_URL       = getArg('--url')         || process.env.LTS_URL  || 'http://localhost:3080';
const onlyFilter    = getArg('--only')?.toLowerCase()  || null;
const skipFilter    = getArg('--skip')?.toLowerCase()  || null;
const outputJson    = getArg('--output-json') || null;
const outputMd      = getArg('--output-md')   || null;
const githubSummary = hasFlag('--github-summary');
const serverModeArg = getArg('--server-mode') || null;
const SUITE_TIMEOUT = parseInt(process.env.TC_SUITE_TIMEOUT_MS || '90000', 10);

// ── Suite registry (mirrors TcRunnerService.js) ───────────────────────────────
// analysisOnly:  skip in SERVER_MODE=streaming           (requires local AI pipeline)
// streamingOnly: skip in SERVER_MODE=combined|analysis   (streaming server specific)
// captureOnly:   skip in SERVER_MODE=analysis            (requires RTSP capture backend)

const SUITES = [
  // DB Layer
  { file: 'test/api/db_layer.test.js',                      srs: 'FR-STORAGE-001~074, NFR-STORAGE-001~017',   label: 'DB Layer  A+B+H+I+J' },
  // Camera (captureOnly: analysis server has no capture backend / discovery service)
  { file: 'test/api/camera_discovery.test.js',              srs: 'FR-CAM-040~056',                            label: 'Camera Discovery  A+B+G',    captureOnly: true },
  { file: 'test/api/nvr_channel_discovery.test.js',         srs: 'FR-CAM-060~067',                            label: 'NVR MaxChannel  H',           captureOnly: true },
  { file: 'test/api/sidebar_cameras.test.js',               srs: 'FR-CAM-001~020',                            label: 'Sidebar Cameras  B+C+D+G' },
  // Auth / User
  { file: 'test/api/auth.test.js',                          srs: 'FR-USR-AUTH-001~020',                       label: 'User Authentication' },
  { file: 'test/api/user_profile.test.js',                  srs: 'FR-USR-PROF-001~010',                       label: 'User Profile' },
  // AI Detection (analysisOnly: skip in SERVER_MODE=streaming)
  { file: 'test/api/human_detection.test.js',               srs: 'FR-HDT-017, FR-HDT-020, FR-HDT-032',       label: 'Human Detection' },
  { file: 'test/api/ai_detection_modules.test.js',          srs: 'FR-AI-MOD-001~010',                        label: 'AI Detection Modules', analysisOnly: true },
  { file: 'test/api/analytics_config.test.js',              srs: 'FR-ANA-CFG-001~010',                       label: 'Analytics Config Toggle', analysisOnly: true },
  { file: 'test/api/model_catalog.test.js',                 srs: 'FR-MODEL-001~010',                         label: 'YOLO Model Catalog', analysisOnly: true },
  // Tracking / Zones / Alerts
  { file: 'test/api/object_tracking.test.js',               srs: 'FR-TRK-001~030',                           label: 'Object Tracking  A+B+G' },
  { file: 'test/api/sidebar_alerts_zones.test.js',          srs: 'FR-ZONE-001, FR-ALERT-001',                label: 'Alerts & Zones  B+D' },
  { file: 'test/api/main_system.test.js',                   srs: 'FR-SYS-D+E+F+H',                          label: 'Main System  Zones/Alerts/Events' },
  { file: 'test/api/stats_panel.test.js',                   srs: 'FR-STATS-001~010',                         label: 'Stats Panel Modal' },
  // Face Recognition
  { file: 'test/api/face_gallery.test.js',                  srs: 'FR-FACE-001~020',                          label: 'Face Gallery  A+E' },
  { file: 'test/api/face_enrollment.test.js',               srs: 'FR-FACE-021~040',                          label: 'Face Enrollment  B+G' },
  { file: 'test/api/missing_persons.test.js',               srs: 'FR-FACE-MISSING-001~010',                  label: 'Missing Persons  C' },
  { file: 'test/api/missing-person.test.js',                srs: 'FR-FACE-MISSING-011~020',                  label: 'Missing Person API' },
  { file: 'test/api/cross_camera_tracking.test.js',         srs: 'FR-REID-001~030',                         label: 'Cross-Camera Tracking  A+B+C+G' },
  // Detection Snapshots
  { file: 'test/api/detection_snapshot_search.test.js',     srs: 'FR-SNAP-001~010',                         label: 'Detection Snapshots' },
  // WebRTC
  { file: 'test/api/webrtc.test.js',                        srs: 'FR-WEBRTC-001~020',                       label: 'WebRTC Capabilities & Stats  F' },
  { file: 'test/api/webrtc_ice.test.js',                    srs: 'FR-WEBRTC-ICE-001~010',                   label: 'WebRTC ICE Config  A+C' },
  { file: 'test/api/webrtc_stability.test.js',              srs: 'FR-WEBRTC-STA-001~010',                   label: 'WebRTC Stability  H' },
  { file: 'test/api/webrtc_telemetry.test.js',              srs: 'FR-WEBRTC-TEL-001~010',                   label: 'WebRTC Telemetry' },
  // TLS
  { file: 'test/api/https_tls.test.js',                     srs: 'FR-TLS-001~010',                          label: 'HTTPS TLS' },
  // ONVIF (captureOnly: ONVIF subscription and App-RTP require a capture pipeline)
  { file: 'test/api/onvif_metadata_pipeline.test.js',       srs: 'FR-ONVIF-PIPE-001~020',                   label: 'ONVIF Metadata Pipeline',     captureOnly: true },
  { file: 'test/api/onvif_apprtp.test.js',                  srs: 'FR-ONVIF-RTP-001~010',                    label: 'ONVIF App-RTP',               captureOnly: true },
  { file: 'test/api/thermal_radiometry_overlay.test.js',    srs: 'FR-THERMAL-001~010',                      label: 'Thermal Radiometry Overlay' },
  // Timeline (streamingOnly)
  { file: 'test/api/timeline_range.test.js',                srs: 'FR-TIMELINE-RANGE-001~008',               label: 'Timeline 1H Range  Streaming', streamingOnly: true },
  // Capture / Pipeline (captureOnly: tests the RTSP capture backend which analysis server lacks)
  { file: 'test/api/capture-backend.test.js',               srs: 'FR-CAP-001~020',                          label: 'RTSP Capture Backend',        captureOnly: true },
  { file: 'test/api/distributed_pipeline.test.js',          srs: 'FR-DIST-001~020',                         label: 'Distributed Pipeline  SERVER_MODE' },
  { file: 'test/api/streaming_mode_model_skip.test.js',     srs: 'FR-STREAM-MODEL-001~005',                 label: 'Streaming Model-Load Guard' },
  { file: 'test/api/streaming_without_analysis_url.test.js',srs: 'FR-STREAM-FALLBACK-001~005',              label: 'Streaming Monitoring-Only Fallback' },
  // YouTube (captureOnly: YouTubeStreamService is disabled in analysis mode)
  { file: 'test/api/youtube_streams.test.js',               srs: 'FR-YT-001~020',                           label: 'YouTube RTSP Ingest  A+D',    captureOnly: true },
  { file: 'test/api/youtube_streams_lts2026.test.js',       srs: 'FR-YT-LTS-001~010',                      label: 'LTS2026 YouTube Schema  A+B+D', captureOnly: true },
  // MCP
  { file: 'test/api/mcp_server.test.js',                    srs: 'FR-MCP-001~020',                          label: 'MCP Server Tools  A-F' },
  { file: 'test/api/mcp_server_extended.test.js',           srs: 'FR-MCP-070~110',                          label: 'MCP Server Extended  J-O' },
];

// ── Filter ────────────────────────────────────────────────────────────────────

function matchesSuite(suite) {
  const hay = (suite.file + ' ' + suite.label).toLowerCase();
  if (onlyFilter && !hay.includes(onlyFilter)) return false;
  if (skipFilter && hay.includes(skipFilter))  return false;
  return true;
}

const filteredSuites = SUITES.filter(matchesSuite);

// ── Server health check ───────────────────────────────────────────────────────

async function checkHealth(url) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(`${url}/health`, { timeout: 5000 }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// ── Suite runner (same logic as TcRunnerService._runSuite) ───────────────────

function runSuite(absPath) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const env = { ...process.env, LTS_URL };
    if (LTS_URL.startsWith('https://')) env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

    const proc = spawn(NODE_BIN, [absPath], { cwd: ROOT, env, stdio: ['ignore','pipe','pipe'] });
    proc.stdout.on('data', d => { stdout += d.toString('utf8'); });
    proc.stderr.on('data', d => { stderr += d.toString('utf8'); });
    const kill = setTimeout(() => proc.kill('SIGTERM'), SUITE_TIMEOUT);
    proc.on('close', code => {
      clearTimeout(kill);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
    proc.on('error', err => { clearTimeout(kill); resolve({ stdout, stderr, code: 1, spawnErr: err.message }); });
  });
}

// ── Output parser (identical to TcRunnerService._parseOutput) ────────────────

function parseOutput(stdout, stderr) {
  const results = {};
  for (const line of stdout.split('\n')) {
    const m = line.match(/✓\s+(TC[\w-]+):\s+(.+)/u);
    if (m) results[m[1]] = { tcId: m[1], desc: m[2].trim(), status: 'pass', errorMsg: null };
  }
  const stderrLines = stderr.split('\n');
  for (let i = 0; i < stderrLines.length; i++) {
    const m = stderrLines[i].match(/✗\s+(TC[\w-]+):\s+(.+)/u);
    if (!m) continue;
    const next = (stderrLines[i + 1] ?? '').trim();
    const errorMsg = next && !next.match(/[✗⊘]\s+TC/u) ? next : null;
    results[m[1]] = { tcId: m[1], desc: m[2].trim(), status: 'fail', errorMsg };
  }
  // Also catch skip lines
  for (const line of (stdout + '\n' + stderr).split('\n')) {
    const m = line.match(/⊘\s+(TC[\w-]+):\s+(.+)/u);
    if (m && !results[m[1]]) results[m[1]] = { tcId: m[1], desc: m[2].trim(), status: 'skip', errorMsg: null };
  }
  return Object.values(results).sort((a, b) => a.tcId.localeCompare(b.tcId));
}

// ── Console formatting ────────────────────────────────────────────────────────

const RESET = '\x1b[0m';
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';
const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';

function statusColor(status) {
  if (status === 'pass') return `${GREEN}✓ PASS${RESET}`;
  if (status === 'fail') return `${RED}✗ FAIL${RESET}`;
  return `${YELLOW}⊘ SKIP${RESET}`;
}

function pad(str, len) { return String(str ?? '').slice(0, len).padEnd(len); }

function printRow(tcId, label, srs, status, desc) {
  const statusStr = status === 'pass' ? `${GREEN}✓${RESET}` : status === 'fail' ? `${RED}✗${RESET}` : `${YELLOW}⊘${RESET}`;
  console.log(`  ${statusStr}  ${DIM}${pad(tcId, 16)}${RESET} ${pad(label, 28)} ${DIM}${pad(desc, 52)}${RESET}`);
}

// ── Markdown helpers ──────────────────────────────────────────────────────────

function mdStatusBadge(status) {
  if (status === 'pass') return '✅';
  if (status === 'fail') return '❌';
  return '⊘';
}

function buildMarkdown(runId, startedAt, allRows, totalPass, totalFail, totalSkip) {
  const endedAt  = new Date().toISOString();
  const total    = totalPass + totalFail + totalSkip;
  const passRate = total > 0 ? ((totalPass / (totalPass + totalFail || 1)) * 100).toFixed(1) : '—';
  const overall  = totalFail === 0 ? '✅ PASSED' : `❌ ${totalFail} FAILED`;

  const suiteRows = SUITES.filter(matchesSuite).map(s => {
    const rows = allRows.filter(r => r.suiteFile === s.file);
    const p = rows.filter(r => r.status === 'pass').length;
    const f = rows.filter(r => r.status === 'fail').length;
    const k = rows.filter(r => r.status === 'skip').length;
    const icon = f > 0 ? '❌' : rows.length === 0 ? '⊘' : '✅';
    return `| ${icon} | ${s.label} | ${s.srs} | ${p} | ${f} | ${k} |`;
  }).join('\n');

  const tcRows = allRows.map(r => {
    const icon = mdStatusBadge(r.status);
    const err = r.errorMsg ? `\`${r.errorMsg.slice(0, 80)}\`` : '';
    return `| ${icon} | \`${r.tcId}\` | ${r.suiteLabel || ''} | ${r.desc || ''} | ${err} |`;
  }).join('\n');

  return `# LTS-2026 TC Test Report — Admin Dashboard Audit

> **Run ID**: \`${runId}\`
> **Started**: ${startedAt}
> **Ended**: ${endedAt}
> **Server**: \`${LTS_URL}\`
> **Overall**: ${overall}

---

## Summary

| Metric | Value |
|---|---|
| Total TCs | ${total} |
| ✅ Passed | ${totalPass} |
| ❌ Failed | ${totalFail} |
| ⊘ Skipped | ${totalSkip} |
| Pass rate | **${passRate}%** |

---

## Suite Results

| Status | Suite | SRS Refs | Pass | Fail | Skip |
|---|---|---|---|---|---|
${suiteRows}

---

## TC-ID Detail

| Status | TC ID | Suite | Description | Error |
|---|---|---|---|---|
${tcRows}

---

_Generated by \`node test/tc_runner_cli.js\` — ${endedAt}_
`;
}

// ── GitHub Step Summary ───────────────────────────────────────────────────────

function writeGithubSummary(content) {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) {
    console.warn('[TC CLI] --github-summary set but $GITHUB_STEP_SUMMARY not defined — skipping');
    return;
  }
  fs.appendFileSync(summaryFile, content, 'utf8');
  console.log(`[TC CLI] GitHub Step Summary appended: ${summaryFile}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const runId    = `cli-${Date.now().toString(36)}`;
  const startedAt = new Date().toISOString();

  console.log(`\n${BOLD}╔═══════════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}║  LTS-2026 TC Runner — Admin Dashboard Audit Mode              ║${RESET}`);
  console.log(`${BOLD}╚═══════════════════════════════════════════════════════════════╝${RESET}`);
  console.log(`  Run ID:  ${CYAN}${runId}${RESET}`);
  console.log(`  Server:  ${LTS_URL}`);
  console.log(`  Suites:  ${filteredSuites.length} / ${SUITES.length}`);
  if (onlyFilter) console.log(`  --only:  ${onlyFilter}`);
  if (skipFilter) console.log(`  --skip:  ${skipFilter}`);
  console.log('');

  // ── Health check ────────────────────────────────────────────────────────────
  process.stdout.write('  Checking server health ... ');
  const healthy = await checkHealth(LTS_URL);
  if (!healthy) {
    console.log(`${RED}✗ unreachable${RESET}`);
    console.error(`\n  ERROR: LTS server not responding at ${LTS_URL}/health`);
    console.error('  Start the server first: npm start   (or npm run dev)');
    process.exit(2);
  }
  console.log(`${GREEN}✓ ok${RESET}\n`);

  // ── Detect server mode ──────────────────────────────────────────────────────
  const serverMode = (serverModeArg || process.env.SERVER_MODE || 'combined').trim().toLowerCase();
  const isStreaming = serverMode === 'streaming';
  console.log(`  SERVER_MODE: ${CYAN}${serverMode}${RESET}\n`);

  // ── Run suites ──────────────────────────────────────────────────────────────
  let totalPass = 0;
  let totalFail = 0;
  let totalSkip = 0;
  const allRows = [];

  for (const suite of filteredSuites) {
    const absPath = path.resolve(ROOT, suite.file);

    // Mode-based skip
    let skipReason = null;
    if (isStreaming && suite.analysisOnly)           skipReason = 'analysisOnly — SERVER_MODE=streaming';
    if (!isStreaming && suite.streamingOnly)         skipReason = `streamingOnly — SERVER_MODE=${serverMode}`;
    if (serverMode === 'analysis' && suite.captureOnly) skipReason = 'captureOnly — SERVER_MODE=analysis has no capture backend';
    if (!fs.existsSync(absPath)) skipReason = 'file not found';

    if (skipReason) {
      console.log(`  ${YELLOW}⊘${RESET} ${DIM}${suite.label}${RESET}  ${DIM}(${skipReason})${RESET}`);
      allRows.push({ suiteFile: suite.file, suiteLabel: suite.label, srsRefs: suite.srs,
                     tcId: 'TC-SKIP', desc: `${suite.label} — ${skipReason}`, status: 'skip', errorMsg: null });
      totalSkip++;
      continue;
    }

    // Run suite
    console.log(`\n  ${BOLD}▶ ${suite.label}${RESET}  ${DIM}[${suite.srs}]${RESET}`);
    const { stdout, stderr, code } = await runSuite(absPath);
    const tcResults = parseOutput(stdout, stderr);

    if (tcResults.length === 0) {
      const status = code === 0 ? 'pass' : 'fail';
      const desc   = `${suite.label} — suite exited ${code === 0 ? 'OK' : `code ${code}`}`;
      console.log(`    ${statusColor(status)}  TC-SUITE  ${desc}`);
      allRows.push({ suiteFile: suite.file, suiteLabel: suite.label, srsRefs: suite.srs,
                     tcId: 'TC-SUITE', desc, status, errorMsg: null });
      status === 'pass' ? totalPass++ : totalFail++;
    } else {
      for (const r of tcResults) {
        printRow(r.tcId, suite.label, suite.srs, r.status, r.desc);
        if (r.errorMsg) console.log(`    ${RED}    └─ ${r.errorMsg}${RESET}`);
        allRows.push({ suiteFile: suite.file, suiteLabel: suite.label, srsRefs: suite.srs,
                       tcId: r.tcId, desc: r.desc, status: r.status, errorMsg: r.errorMsg ?? null });
        if (r.status === 'pass')   totalPass++;
        else if (r.status === 'fail') totalFail++;
        else totalSkip++;
      }
    }
  }

  // ── Console summary ─────────────────────────────────────────────────────────
  const total    = totalPass + totalFail + totalSkip;
  const passRate = total > 0 ? ((totalPass / (totalPass + totalFail || 1)) * 100).toFixed(1) : '—';
  console.log('\n');
  console.log(`${BOLD}╔═══════════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}║  AUDIT RESULT                                                 ║${RESET}`);
  console.log(`${BOLD}╠═══════════════════════════════════════════════════════════════╣${RESET}`);
  console.log(`${BOLD}║${RESET}  Total TCs : ${BOLD}${total}${RESET}`);
  console.log(`${BOLD}║${RESET}  ${GREEN}✓ Passed${RESET}  : ${BOLD}${totalPass}${RESET}`);
  console.log(`${BOLD}║${RESET}  ${RED}✗ Failed${RESET}  : ${BOLD}${totalFail}${RESET}`);
  console.log(`${BOLD}║${RESET}  ${YELLOW}⊘ Skipped${RESET} : ${BOLD}${totalSkip}${RESET}`);
  console.log(`${BOLD}║${RESET}  Pass rate : ${BOLD}${passRate}%${RESET}`);
  if (totalFail === 0) {
    console.log(`${BOLD}║${RESET}  ${GREEN}${BOLD}ALL TC PASSED ✓${RESET}`);
  } else {
    console.log(`${BOLD}║${RESET}  ${RED}${BOLD}${totalFail} TC FAILED ✗${RESET}`);
  }
  console.log(`${BOLD}╚═══════════════════════════════════════════════════════════════╝${RESET}\n`);

  // ── Reports ──────────────────────────────────────────────────────────────────
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  // JSON
  const jsonData = { runId, startedAt, endedAt: new Date().toISOString(), ltsUrl: LTS_URL,
                     serverMode, totalPass, totalFail, totalSkip, passRate, results: allRows };
  const jsonPath = outputJson || path.join(REPORT_DIR, `tc-results-${runId}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2), 'utf8');
  console.log(`  JSON report: ${jsonPath}`);

  // Markdown
  const mdContent = buildMarkdown(runId, startedAt, allRows, totalPass, totalFail, totalSkip);
  const mdPath    = outputMd || path.join(REPORT_DIR, `tc-report-${runId}.md`);
  fs.writeFileSync(mdPath, mdContent, 'utf8');
  console.log(`  MD report:   ${mdPath}`);

  // GitHub Step Summary
  if (githubSummary) writeGithubSummary(mdContent);

  console.log('');
  process.exit(totalFail > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(`\nFatal: ${err.message}`);
  process.exit(1);
});
