'use strict';
/**
 * Test Report Generator
 * Run all test suites and produce a Markdown report.
 *
 * Usage:
 *   node test/generate_report.js
 *   node test/generate_report.js --output test/reports/my-report.md
 *   node test/generate_report.js --skip e2e
 *   node test/generate_report.js --only face
 *
 * Output: test/reports/report_YYYY-MM-DD_HH-MM.md  (or --output path)
 * Exits non-zero if any suite failed (mirrors run_all.js behaviour).
 */

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const ROOT       = path.resolve(__dirname, '..');
const REPORT_DIR = path.join(ROOT, 'test', 'reports');

// ── Parse CLI flags ──────────────────────────────────────────────────────────

const args       = process.argv.slice(2);
const onlyIdx    = args.indexOf('--only');
const skipIdx    = args.indexOf('--skip');
const outputIdx  = args.indexOf('--output');
const onlyFilter = onlyIdx   !== -1 ? (args[onlyIdx   + 1] || '').toLowerCase() : null;
const skipFilter = skipIdx   !== -1 ? (args[skipIdx   + 1] || '').toLowerCase() : null;
const outputPath = outputIdx !== -1 ? args[outputIdx  + 1] : null;

// ── Suite definitions ────────────────────────────────────────────────────────

const SUITES = [
  {
    file:  'test/api/face_gallery.test.js',
    label: 'Face Gallery (face_gallery)',
    tc:    ['TC_AI_Face_Recognition.md'],
    tags:  ['face'],
  },
  {
    file:  'test/api/face_enrollment.test.js',
    label: 'Face Enrollment (face_enrollment)',
    tc:    ['TC_AI_Face_Recognition.md'],
    tags:  ['face'],
  },
  {
    file:  'test/api/missing_persons.test.js',
    label: 'Missing Persons (missing_persons)',
    tc:    ['TC_AI_Face_Recognition.md'],
    tags:  ['face'],
  },
  {
    file:  'test/api/human_detection.test.js',
    label: 'Human Detection (human_detection)',
    tc:    ['TC_AI_Human_Detection.md'],
    tags:  ['human', 'detection'],
  },
  {
    file:  'test/api/object_tracking.test.js',
    label: 'Object Tracking (object_tracking)',
    tc:    ['TC_Object_Tracking.md'],
    tags:  ['tracking', 'zones'],
  },
  {
    file:  'test/api/camera_discovery.test.js',
    label: 'Camera Discovery (camera_discovery)',
    tc:    ['TC_Camera_Discovery.md'],
    tags:  ['camera', 'discovery'],
  },
  {
    file:  'test/api/analytics_config.test.js',
    label: 'Analytics Config (analytics_config)',
    tc:    ['TC_AI_Human_Detection.md', 'TC_AI_Vehicle_Detection.md'],
    tags:  ['analytics', 'ai'],
  },
  {
    file:  'test/api/youtube_streams.test.js',
    label: 'YouTube Streams (youtube_streams)',
    tc:    ['TC_YouTube_RTSP_Ingest.md'],
    tags:  ['youtube'],
  },
  {
    file:  'test/api/youtube_streams_lts2026.test.js',
    label: 'YouTube LTS2026 (youtube_streams_lts2026)',
    tc:    ['TC_LTS2026_YouTube_RTSP_Ingest.md'],
    tags:  ['youtube', 'lts2026'],
  },
  {
    file:  'test/api/webrtc_ice.test.js',
    label: 'WebRTC ICE Config (webrtc_ice)',
    tc:    ['TC_STUN_TURN_ICE.md'],
    tags:  ['webrtc', 'ice'],
  },
  {
    file:  'test/api/webrtc.test.js',
    label: 'WebRTC Gateway (webrtc)',
    tc:    ['TC_WebRTC_Media_Gateway.md'],
    tags:  ['webrtc'],
  },
  {
    file:  'test/api/main_system.test.js',
    label: 'Main System (main_system)',
    tc:    ['TC_LTS2026_Loitering_Tracking_System.md'],
    tags:  ['main', 'zones', 'alerts', 'events'],
  },
  {
    file:  'test/api/mcp_server.test.js',
    label: 'MCP Server (mcp_server)',
    tc:    ['TC_LLM_MCP_Server.md'],
    tags:  ['mcp', 'llm'],
  },
  {
    file:  'test/api/ai_detection_modules.test.js',
    label: 'AI Detection Modules (ai_detection_modules)',
    tc:    [
      'TC_AI_Accessories_Detection.md',
      'TC_AI_Animal_Detection.md',
      'TC_AI_Cloth_Analysis.md',
      'TC_AI_Color_Analysis.md',
      'TC_AI_Fire_Smoke_Detection.md',
      'TC_AI_Hat_Detection.md',
      'TC_AI_Mask_Detection.md',
      'TC_AI_Vehicle_Detection.md',
    ],
    tags:  ['ai', 'detection', 'analytics'],
  },
  {
    file:  'test/api/cross_camera_tracking.test.js',
    label: 'Cross-Camera Tracking (cross_camera_tracking)',
    tc:    ['TC_CrossCamera_Face_Tracking.md'],
    tags:  ['face', 'crosscamera', 'tracking'],
  },
  {
    file:  'test/api/sidebar_alerts_zones.test.js',
    label: 'Sidebar Alerts & Zones (sidebar_alerts_zones)',
    tc:    ['TC_Dashboard_Sidebar_Alerts_Zones.md'],
    tags:  ['alerts', 'zones', 'sidebar'],
  },
  {
    file:  'test/api/sidebar_cameras.test.js',
    label: 'Sidebar Cameras (sidebar_cameras)',
    tc:    ['TC_Dashboard_Sidebar_Cameras.md'],
    tags:  ['camera', 'sidebar'],
  },
  {
    file:  'test/e2e/dashboard_e2e.test.js',
    label: 'Dashboard E2E — Phase-3 placeholder (dashboard_e2e)',
    tc:    [
      'TC_Dashboard_Layout.md',
      'TC_Dashboard_Detection_Display.md',
      'TC_Mobile_Layout.md',
    ],
    tags:  ['e2e', 'phase3', 'dashboard', 'mobile'],
  },
];

// TC → canonical label map (all 24 TC documents)
const TC_LABELS = {
  'TC_AI_Accessories_Detection.md':           'AI Accessories Detection',
  'TC_AI_Animal_Detection.md':                'AI Animal Detection',
  'TC_AI_Cloth_Analysis.md':                  'AI Cloth Analysis',
  'TC_AI_Color_Analysis.md':                  'AI Color Analysis',
  'TC_AI_Face_Recognition.md':                'AI Face Recognition',
  'TC_AI_Fire_Smoke_Detection.md':            'AI Fire & Smoke Detection',
  'TC_AI_Hat_Detection.md':                   'AI Hat Detection',
  'TC_AI_Human_Detection.md':                 'AI Human Detection',
  'TC_AI_Mask_Detection.md':                  'AI Mask Detection',
  'TC_AI_Vehicle_Detection.md':               'AI Vehicle Detection',
  'TC_Camera_Discovery.md':                   'Camera Discovery',
  'TC_CrossCamera_Face_Tracking.md':          'Cross-Camera Face Tracking',
  'TC_Dashboard_Detection_Display.md':        'Dashboard Detection Display',
  'TC_Dashboard_Layout.md':                   'Dashboard Layout',
  'TC_Dashboard_Sidebar_Alerts_Zones.md':     'Dashboard Sidebar: Alerts & Zones',
  'TC_Dashboard_Sidebar_Cameras.md':          'Dashboard Sidebar: Cameras',
  'TC_LLM_MCP_Server.md':                     'LLM / MCP Server',
  'TC_LTS2026_Loitering_Tracking_System.md':  'LTS-2026 Main System',
  'TC_LTS2026_YouTube_RTSP_Ingest.md':        'LTS-2026 YouTube/RTSP Ingest',
  'TC_Mobile_Layout.md':                      'Mobile Layout',
  'TC_Object_Tracking.md':                    'Object Tracking',
  'TC_STUN_TURN_ICE.md':                      'STUN/TURN/ICE',
  'TC_WebRTC_Media_Gateway.md':               'WebRTC Media Gateway',
  'TC_YouTube_RTSP_Ingest.md':                'YouTube/RTSP Ingest',
};

// ── Filter suites ─────────────────────────────────────────────────────────────

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

// ── Run suites, capture output ────────────────────────────────────────────────

const runResults = [];
let totalPassed = 0;
let totalFailed = 0;
let totalSkipped = 0;

console.log('╔════════════════════════════════════════════════════════════════╗');
console.log('║  LTS-2026 Test Report Generator                               ║');
console.log('╚════════════════════════════════════════════════════════════════╝');
if (onlyFilter) console.log(`  Filter --only: "${onlyFilter}"`);
if (skipFilter) console.log(`  Filter --skip: "${skipFilter}"`);
console.log(`  Running ${filteredSuites.length} of ${SUITES.length} suite(s)\n`);

for (const suite of filteredSuites) {
  const label = suite.label;
  console.log(`  Running: ${label} ...`);

  let output = '';
  let suiteExitOk = true;

  try {
    output = execSync(`node ${suite.file}`, {
      cwd: ROOT,
      env: { ...process.env },
      timeout: 120000,
    }).toString();
  } catch (err) {
    output = (err.stdout || Buffer.alloc(0)).toString() +
             (err.stderr || Buffer.alloc(0)).toString();
    suiteExitOk = false;
  }

  // Parse results — support two output formats:
  // Format A: "Results: N passed, M failed[, K skipped]"      (most test files)
  // Format B: "=== Results ===\n  Passed: N\n  Failed: M\n..."  (older test files)
  const resultMatchA = output.match(/Results:\s*(\d+)\s*passed,\s*(\d+)\s*failed(?:,\s*(\d+)\s*skipped)?/);
  const passedMatchB = output.match(/Passed:\s*(\d+)/);
  const failedMatchB = output.match(/Failed:\s*(\d+)/);
  const skippedMatchB = output.match(/Skipped:\s*(\d+)/);
  let passed  = 0;
  let failed  = 0;
  let skipped = 0;
  if (resultMatchA) {
    passed  = parseInt(resultMatchA[1], 10);
    failed  = parseInt(resultMatchA[2], 10);
    skipped = parseInt(resultMatchA[3] || '0', 10);
  } else if (passedMatchB) {
    passed  = parseInt(passedMatchB[1],  10);
    failed  = parseInt((failedMatchB  || ['', '0'])[1], 10);
    skipped = parseInt((skippedMatchB || ['', '0'])[1], 10);
  }

  totalPassed  += passed;
  totalFailed  += failed;
  totalSkipped += skipped;

  const status = failed > 0 ? 'FAIL' : (passed === 0 && skipped > 0 ? 'SKIP' : 'PASS');
  const icon   = status === 'PASS' ? '✓' : (status === 'SKIP' ? '⊘' : '✗');
  console.log(`  ${icon}  ${passed} pass / ${failed} fail / ${skipped} skip`);

  runResults.push({
    suite,
    output,
    passed,
    failed,
    skipped,
    status,
    exitOk: suiteExitOk,
  });
}

// ── Build TC coverage matrix ──────────────────────────────────────────────────

const tcCoverage = {};
for (const tc of Object.keys(TC_LABELS)) {
  tcCoverage[tc] = { suiteFiles: [], status: 'no-test' };
}

for (const r of runResults) {
  for (const tc of r.suite.tc) {
    if (!tcCoverage[tc]) tcCoverage[tc] = { suiteFiles: [], status: 'no-test' };
    tcCoverage[tc].suiteFiles.push(r.suite.file);
    if (tcCoverage[tc].status === 'no-test') {
      tcCoverage[tc].status = r.status;
    } else if (r.status === 'FAIL') {
      tcCoverage[tc].status = 'FAIL';
    } else if (r.status === 'PASS' && tcCoverage[tc].status !== 'FAIL') {
      tcCoverage[tc].status = 'PASS';
    }
  }
}

// ── Generate Markdown report ─────────────────────────────────────────────────

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const ts  = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
            `_${pad(now.getHours())}-${pad(now.getMinutes())}`;

const ltsUrl    = process.env.LTS_URL    || 'http://localhost:3080';
const nodeVer   = process.version;
const platform  = process.platform;

const totalTests = totalPassed + totalFailed + totalSkipped;
const passRate   = totalTests > 0 ? ((totalPassed / (totalPassed + totalFailed)) * 100).toFixed(1) : '—';
const tcTotal    = Object.keys(TC_LABELS).length;
const tcCovered  = Object.values(tcCoverage).filter(v => v.status !== 'no-test').length;
const tcPassPct  = ((tcCovered / tcTotal) * 100).toFixed(1);

function tcStatusIcon(status) {
  if (status === 'PASS') return '✅';
  if (status === 'FAIL') return '❌';
  if (status === 'SKIP') return '⊘ Phase-3';
  return '—';
}

const suiteRows = runResults.map(r => {
  const icon = r.status === 'PASS' ? '✅' : (r.status === 'SKIP' ? '⊘' : '❌');
  return `| ${icon} | ${r.suite.label} | ${r.passed} | ${r.failed} | ${r.skipped} |`;
});

const tcRows = Object.entries(TC_LABELS).map(([file, label]) => {
  const cov  = tcCoverage[file];
  const icon = tcStatusIcon(cov?.status || 'no-test');
  const scripts = cov?.suiteFiles.length
    ? cov.suiteFiles.map(f => `\`${path.basename(f)}\``).join(', ')
    : '—';
  return `| ${icon} | ${label} | ${scripts} |`;
});

const failDetails = runResults
  .filter(r => r.status === 'FAIL')
  .map(r => {
    const lines = r.output.split('\n')
      .filter(l => l.includes('✗') || l.includes('Failed'))
      .slice(0, 20)
      .map(l => `    ${l.trim()}`)
      .join('\n');
    return `#### ${r.suite.label}\n\`\`\`\n${lines}\n\`\`\``;
  }).join('\n\n');

const skippedSuites = SUITES.filter(s => !filteredSuites.includes(s));
const skippedSuiteNote = skippedSuites.length > 0
  ? `\n> **Filtered out** (${skippedSuites.length} suite(s) skipped by --skip/--only):\n` +
    skippedSuites.map(s => `> - ${s.label}`).join('\n')
  : '';

const report = `# LTS-2026 Test Report

> Generated: ${now.toISOString()}
> Server: \`${ltsUrl}\`
> Node.js: ${nodeVer} (${platform})
${onlyFilter ? `> Filter --only: \`${onlyFilter}\`` : ''}
${skipFilter ? `> Filter --skip: \`${skipFilter}\`` : ''}

---

## Summary

| Metric | Value |
|---|---|
| Report timestamp | ${now.toISOString()} |
| Suites run | ${filteredSuites.length} / ${SUITES.length} |
| Total tests | ${totalTests} |
| ✅ Passed | ${totalPassed} |
| ❌ Failed | ${totalFailed} |
| ⊘ Skipped | ${totalSkipped} |
| Pass rate | **${passRate}%** |
| TC documents covered | ${tcCovered} / ${tcTotal} (${tcPassPct}%) |

**Overall status: ${totalFailed === 0 ? '✅ ALL SUITES PASSED' : `❌ ${totalFailed} FAILURES DETECTED`}**

---

## TC Coverage Matrix

All 24 TC documents mapped to test scripts:

| Status | TC Document | Test Script(s) |
|---|---|---|
${tcRows.join('\n')}

> Phase-3 (⊘) entries require Playwright browser automation — not yet implemented.

---

## Per-Suite Results

| Status | Suite | Passed | Failed | Skipped |
|---|---|---|---|---|
${suiteRows.join('\n')}
${skippedSuiteNote}

---

## Failure Details

${failDetails || '_No failures detected._'}

---

## Phase-3 Tests (Pending)

The following TC documents require Playwright browser automation:

| TC Document | Target Groups |
|---|---|
| TC_Dashboard_Layout.md | A (breakpoints), B (navigation), C (camera grid), D (video player), E (responsive) |
| TC_Dashboard_Detection_Display.md | A (overlay), B (bounding box), C (alert badge), D (heatmap), E (multi-camera) |
| TC_Mobile_Layout.md | A (viewport), B (header), C (bottom nav), D (cameras tab), E–G (other tabs, fullscreen) |

To implement Phase-3 tests:
\`\`\`bash
npm install --save-dev @playwright/test
npx playwright install
FRONTEND_URL=http://localhost:3080 npx playwright test test/e2e/
\`\`\`

---

## Environment

| Item | Value |
|---|---|
| Node.js | ${nodeVer} |
| Platform | ${platform} |
| Server URL | ${ltsUrl} |
| MCP Server URL | ${process.env.MCP_URL || 'http://localhost:3002'} |
| Test runner | \`node test/run_all.js\` |

---

_Report generated by \`node test/generate_report.js\`_
`;

// ── Write report ─────────────────────────────────────────────────────────────

const outFile = outputPath || path.join(REPORT_DIR, `report_${ts}.md`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, report, 'utf8');

console.log('\n─────────────────────────────────────────────────────────────────');
console.log(`  Total: ${totalPassed} passed, ${totalFailed} failed, ${totalSkipped} skipped`);
console.log(`  Pass rate: ${passRate}%`);
console.log(`  TC coverage: ${tcCovered}/${tcTotal} (${tcPassPct}%)`);
console.log(`  Report written: ${outFile}`);
console.log('─────────────────────────────────────────────────────────────────\n');

if (totalFailed > 0) process.exit(1);
