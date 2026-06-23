'use strict';
/**
 * Jira Issue Reporter — LTS-2026
 *
 * TC 문서와 Jest JSON 결과를 매핑하여 실패한 테스트 스위트를 Jira Issue로 등록합니다.
 *
 * 사용법:
 *   node test/run_all.js --json > test/reports/results.json
 *   node test/jira-reporter.js --input test/reports/results.json
 *
 * 환경변수 (GitHub Secrets 또는 .env):
 *   JIRA_BASE_URL      예: https://your-org.atlassian.net
 *   JIRA_USER_EMAIL    예: ci-bot@your-org.com
 *   JIRA_API_TOKEN     Atlassian API Token
 *   JIRA_PROJECT_KEY   예: LTS
 *   JIRA_ISSUE_TYPE    예: LTS (기본값)
 *   JIRA_COMPONENT     예: LTS-2026 (선택)
 *   GITHUB_RUN_URL     GitHub Actions 실행 URL (선택)
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');
const url   = require('url');

// ── 환경변수 검증 ─────────────────────────────────────────────────────────────

const JIRA_BASE_URL    = process.env.JIRA_BASE_URL;
const JIRA_USER_EMAIL  = process.env.JIRA_USER_EMAIL;
const JIRA_API_TOKEN   = process.env.JIRA_API_TOKEN;
const JIRA_PROJECT_KEY = process.env.JIRA_PROJECT_KEY || 'LTS';
const JIRA_ISSUE_TYPE  = process.env.JIRA_ISSUE_TYPE  || 'LTS';
const JIRA_COMPONENT   = process.env.JIRA_COMPONENT   || '';
const GITHUB_RUN_URL   = process.env.GITHUB_RUN_URL   || '';

if (!JIRA_BASE_URL || !JIRA_USER_EMAIL || !JIRA_API_TOKEN) {
  console.error('[jira-reporter] 필수 환경변수 누락: JIRA_BASE_URL, JIRA_USER_EMAIL, JIRA_API_TOKEN');
  process.exit(1);
}

// ── CLI 인수 파싱 ─────────────────────────────────────────────────────────────

const args      = process.argv.slice(2);
const inputIdx  = args.indexOf('--input');
const dryRunIdx = args.indexOf('--dry-run');
const inputFile = inputIdx !== -1 ? args[inputIdx + 1] : null;
const dryRun    = dryRunIdx !== -1;

// ── TC 문서 → Document ID 매핑 ───────────────────────────────────────────────
// docs/tc/ 각 파일의 Document ID 헤더에서 추출한 값

const TC_DOC_IDS = {
  'TC_AI_Accessories_Detection.md':          'TC-LTS-AI-02',
  'TC_AI_Animal_Detection.md':               'TC-LTS-AI-03',
  'TC_AI_Cloth_Analysis.md':                 'TC-LTS-AI-04',
  'TC_AI_Color_Analysis.md':                 'TC-LTS-AI-05',
  'TC_AI_Face_Recognition.md':               'TC-LTS-AI-06',
  'TC_AI_Fire_Smoke_Detection.md':           'TC-LTS-AI-07',
  'TC_AI_Hat_Detection.md':                  'TC-LTS-AI-08',
  'TC_AI_Human_Detection.md':                'TC-LTS-AI-01',
  'TC_AI_Mask_Detection.md':                 'TC-LTS-AI-09',
  'TC_AI_Vehicle_Detection.md':              'TC-LTS-AI-10',
  'TC_Camera_Discovery.md':                  'TC-LTS-CAM-01',
  'TC_CrossCamera_Face_Tracking.md':         'TC-LTS-FACE-02',
  'TC_Dashboard_Detection_Display.md':       'TC-LTS-UI-02',
  'TC_Dashboard_Layout.md':                  'TC-LTS-UI-01',
  'TC_Dashboard_Sidebar_Alerts_Zones.md':    'TC-LTS-UI-03',
  'TC_Dashboard_Sidebar_Cameras.md':         'TC-LTS-UI-04',
  'TC_Dashboard_Sidebar_Face_ID.md':         'TC-LTS-UI-05',
  'TC_Detection_Snapshot_Search.md':         'TC-LTS-SNAP-01',
  'TC_Distributed_AI_Pipeline.md':           'TC-LTS-DAP-01',
  'TC_Streaming_Model_Load_Policy.md':       'TC-LTS-DAP-02',
  'TC_HTTPS_TLS.md':                         'TC-LTS-SEC-01',
  'TC_LLM_MCP_Server.md':                    'TC-LTS-MCP-01',
  'TC_LTS2026_Loitering_Tracking_System.md': 'TC-LTS-MAIN-01',
  'TC_LTS2026_YouTube_RTSP_Ingest.md':       'TC-LTS-YT-02',
  'TC_Mobile_Layout.md':                     'TC-LTS-UI-06',
  'TC_Object_Tracking.md':                   'TC-LTS-TRACK-01',
  'TC_STUN_TURN_ICE.md':                     'TC-LTS-WEB-02',
  'TC_Stats_Panel.md':                       'TC-LTS-UI-07',
  'TC_DB_Layer.md':                   'TC-LTS-DB-01',
  'TC_User_Authentication.md':               'TC-LTS-AUTH-01',
  'TC_User_Profile.md':                      'TC-LTS-AUTH-02',
  'TC_WebRTC_Media_Gateway.md':              'TC-LTS-WEB-01',
  'TC_YouTube_RTSP_Ingest.md':               'TC-LTS-YT-01',
};

// ── 테스트 파일 → TC 문서 매핑 ───────────────────────────────────────────────

const SUITE_TC_MAP = {
  'test/api/face_gallery.test.js':              ['TC_AI_Face_Recognition.md'],
  'test/api/face_enrollment.test.js':           ['TC_AI_Face_Recognition.md'],
  'test/api/missing_persons.test.js':           ['TC_AI_Face_Recognition.md'],
  'test/api/human_detection.test.js':           ['TC_AI_Human_Detection.md'],
  'test/api/object_tracking.test.js':           ['TC_Object_Tracking.md'],
  'test/api/camera_discovery.test.js':          ['TC_Camera_Discovery.md'],
  'test/api/analytics_config.test.js':          ['TC_AI_Human_Detection.md', 'TC_AI_Vehicle_Detection.md'],
  'test/api/youtube_streams.test.js':           ['TC_YouTube_RTSP_Ingest.md'],
  'test/api/youtube_streams_lts2026.test.js':   ['TC_LTS2026_YouTube_RTSP_Ingest.md'],
  'test/api/webrtc_ice.test.js':                ['TC_STUN_TURN_ICE.md'],
  'test/api/webrtc.test.js':                    ['TC_WebRTC_Media_Gateway.md'],
  'test/api/webrtc_stability.test.js':          ['TC_WebRTC_Media_Gateway.md'],
  'test/api/webrtc_telemetry.test.js':          ['TC_WebRTC_Media_Gateway.md'],
  'test/api/main_system.test.js':               ['TC_LTS2026_Loitering_Tracking_System.md'],
  'test/api/mcp_server.test.js':                ['TC_LLM_MCP_Server.md'],
  'test/api/ai_detection_modules.test.js':      [
    'TC_AI_Accessories_Detection.md', 'TC_AI_Animal_Detection.md',
    'TC_AI_Cloth_Analysis.md',        'TC_AI_Color_Analysis.md',
    'TC_AI_Fire_Smoke_Detection.md',  'TC_AI_Hat_Detection.md',
    'TC_AI_Mask_Detection.md',        'TC_AI_Vehicle_Detection.md',
  ],
  'test/api/cross_camera_tracking.test.js':     ['TC_CrossCamera_Face_Tracking.md'],
  'test/api/sidebar_alerts_zones.test.js':      ['TC_Dashboard_Sidebar_Alerts_Zones.md'],
  'test/api/sidebar_cameras.test.js':           ['TC_Dashboard_Sidebar_Cameras.md'],
  'test/api/distributed_pipeline.test.js':      ['TC_Distributed_AI_Pipeline.md'],
  'test/api/streaming_mode_model_skip.test.js': ['TC_Streaming_Model_Load_Policy.md'],
  'test/api/streaming_without_analysis_url.test.js': ['TC_Streaming_Model_Load_Policy.md'],
  'test/api/auth.test.js':                      ['TC_User_Authentication.md'],
  'test/api/user_profile.test.js':              ['TC_User_Profile.md'],
  'test/api/https_tls.test.js':                 ['TC_HTTPS_TLS.md'],
  'test/api/stats_panel.test.js':               ['TC_Stats_Panel.md'],
  'test/api/detection_snapshot_search.test.js': ['TC_Detection_Snapshot_Search.md'],
  'test/e2e/dashboard_e2e.test.js':             ['TC_Dashboard_Layout.md', 'TC_Dashboard_Detection_Display.md', 'TC_Mobile_Layout.md'],
};

// ── Jira REST API 호출 ────────────────────────────────────────────────────────

function jiraRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const parsed   = new url.URL(`${JIRA_BASE_URL}/rest/api/3${endpoint}`);
    const authToken = Buffer.from(`${JIRA_USER_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
    const payload  = body ? JSON.stringify(body) : null;

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || 443,
      path:     parsed.pathname + parsed.search,
      method,
      headers: {
        'Authorization': `Basic ${authToken}`,
        'Accept':        'application/json',
        'Content-Type':  'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(new Error(`Jira API ${res.statusCode}: ${JSON.stringify(parsed)}`));
          }
        } catch (e) {
          reject(new Error(`JSON 파싱 오류: ${data}`));
        }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── 기존 Jira 이슈 중복 확인 ──────────────────────────────────────────────────

async function findExistingIssue(summary) {
  const jql = encodeURIComponent(
    `project = "${JIRA_PROJECT_KEY}" AND summary ~ "${summary}" AND statusCategory != Done`
  );
  const result = await jiraRequest('GET', `/search?jql=${jql}&maxResults=1`);
  return result.issues && result.issues.length > 0 ? result.issues[0] : null;
}

// ── Jira 이슈 생성 ────────────────────────────────────────────────────────────

async function createJiraIssue(failedSuite) {
  const { testFile, suiteName, failedTests, tcDocs, tcDocIds, duration } = failedSuite;

  const summary = `[${tcDocIds.join('/')}] 테스트 실패: ${suiteName}`;

  // 중복 이슈 확인
  const existing = await findExistingIssue(tcDocIds[0]);
  if (existing) {
    console.log(`  ↩ 기존 이슈 존재: ${existing.key} — ${existing.fields.summary}`);
    return { key: existing.key, created: false };
  }

  // 실패 테스트 상세 목록 구성 (Atlassian Document Format)
  const failureList = failedTests.map(t => ({
    type: 'listItem',
    content: [{
      type: 'paragraph',
      content: [{ type: 'text', text: `${t.ancestorTitles.join(' > ')} > ${t.title}`, marks: [{ type: 'code' }] }],
    }],
  }));

  const ciLink = GITHUB_RUN_URL
    ? `\n\n🔗 CI 실행 결과: ${GITHUB_RUN_URL}`
    : '';

  const issueBody = {
    fields: {
      project:   { key: JIRA_PROJECT_KEY },
      issuetype: { name: JIRA_ISSUE_TYPE },
      summary,
      description: {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'heading', attrs: { level: 3 },
            content: [{ type: 'text', text: '테스트 실패 요약' }],
          },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: '테스트 파일: ', marks: [{ type: 'strong' }] },
              { type: 'text', text: testFile, marks: [{ type: 'code' }] },
            ],
          },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'TC 문서: ', marks: [{ type: 'strong' }] },
              { type: 'text', text: tcDocs.map(d => `docs/tc/${d}`).join(', '), marks: [{ type: 'code' }] },
            ],
          },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: '실행 시간: ', marks: [{ type: 'strong' }] },
              { type: 'text', text: `${(duration / 1000).toFixed(2)}s` },
            ],
          },
          {
            type: 'heading', attrs: { level: 3 },
            content: [{ type: 'text', text: `실패한 테스트 (${failedTests.length}건)` }],
          },
          { type: 'bulletList', content: failureList },
          ...(failedTests[0]?.failureMessages?.length ? [{
            type: 'heading', attrs: { level: 3 },
            content: [{ type: 'text', text: '첫 번째 오류 메시지' }],
          }, {
            type: 'codeBlock', attrs: { language: 'text' },
            content: [{ type: 'text', text: failedTests[0].failureMessages.join('\n').slice(0, 2000) }],
          }] : []),
          ...(ciLink ? [{
            type: 'paragraph',
            content: [{ type: 'text', text: ciLink }],
          }] : []),
        ],
      },
      labels: ['lts-2026', 'automated', 'test-failure', ...tcDocIds.map(id => id.toLowerCase())],
      ...(JIRA_COMPONENT ? { components: [{ name: JIRA_COMPONENT }] } : {}),
    },
  };

  const created = await jiraRequest('POST', '/issue', issueBody);
  return { key: created.key, created: true };
}

// ── Jest JSON 결과 파싱 ───────────────────────────────────────────────────────

function parseJestResults(jestJson) {
  const failed = [];

  for (const testResult of jestJson.testResults) {
    // 실패한 테스트가 없으면 스킵
    if (testResult.status === 'passed') continue;

    // 상대 경로로 정규화
    const rootDir  = jestJson.rootDir || process.cwd();
    const relPath  = path.relative(rootDir, testResult.testFilePath).replace(/\\/g, '/');

    const tcDocs   = SUITE_TC_MAP[relPath] || [];
    const tcDocIds = [...new Set(tcDocs.map(d => TC_DOC_IDS[d]).filter(Boolean))];

    const failedTests = testResult.testResults.filter(t => t.status === 'failed');

    if (failedTests.length === 0) continue;

    failed.push({
      testFile:    relPath,
      suiteName:   path.basename(relPath, '.test.js'),
      failedTests,
      tcDocs,
      tcDocIds:    tcDocIds.length > 0 ? tcDocIds : [`UNKNOWN-${path.basename(relPath, '.test.js').toUpperCase()}`],
      duration:    testResult.perfStats?.runtime || 0,
    });
  }

  return failed;
}

// ── 메인 실행 ─────────────────────────────────────────────────────────────────

async function main() {
  // Jest JSON 결과 로드
  let jestJson;
  if (inputFile) {
    if (!fs.existsSync(inputFile)) {
      console.error(`[jira-reporter] 파일 없음: ${inputFile}`);
      process.exit(1);
    }
    jestJson = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  } else {
    // stdin에서 읽기
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    jestJson = JSON.parse(Buffer.concat(chunks).toString());
  }

  const failedSuites = parseJestResults(jestJson);

  if (failedSuites.length === 0) {
    console.log('[jira-reporter] ✅ 모든 테스트 통과 — Jira 이슈 없음');
    return;
  }

  console.log(`[jira-reporter] ⚠ 실패한 스위트 ${failedSuites.length}개 발견\n`);

  const results = [];

  for (const suite of failedSuites) {
    console.log(`  처리 중: ${suite.testFile} (${suite.failedTests.length}개 실패, TC: ${suite.tcDocIds.join(', ')})`);

    if (dryRun) {
      console.log(`  [DRY-RUN] 이슈 생성 시뮬레이션: [${suite.tcDocIds.join('/')}] 테스트 실패: ${suite.suiteName}`);
      results.push({ testFile: suite.testFile, tcDocIds: suite.tcDocIds, dry: true });
      continue;
    }

    try {
      const result = await createJiraIssue(suite);
      if (result.created) {
        console.log(`  ✅ 이슈 생성: ${result.key}`);
      } else {
        console.log(`  ↩ 기존 이슈 재사용: ${result.key}`);
      }
      results.push({ testFile: suite.testFile, tcDocIds: suite.tcDocIds, issueKey: result.key, created: result.created });
    } catch (err) {
      console.error(`  ❌ 이슈 생성 실패 (${suite.testFile}): ${err.message}`);
      results.push({ testFile: suite.testFile, tcDocIds: suite.tcDocIds, error: err.message });
    }
  }

  // 결과 요약 출력
  console.log('\n─── Jira 이슈 등록 결과 ───────────────────────────────');
  for (const r of results) {
    if (r.dry)        console.log(`  [DRY] ${r.testFile} → ${r.tcDocIds.join(', ')}`);
    else if (r.error) console.log(`  ❌ ${r.testFile} → ${r.error}`);
    else if (r.created) console.log(`  ✅ ${r.testFile} → ${r.issueKey} (신규)`);
    else              console.log(`  ↩ ${r.testFile} → ${r.issueKey} (기존)`);
  }

  // 생성된 이슈 목록을 파일로 저장 (GitHub Actions STEP SUMMARY용)
  const reportDir = path.join(__dirname, 'reports');
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });

  const summaryPath = path.join(reportDir, 'jira-issues.json');
  fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2));
  console.log(`\n📄 결과 저장: ${summaryPath}`);

  // 오류 있으면 비정상 종료
  if (results.some(r => r.error)) process.exit(1);
}

main().catch(err => {
  console.error('[jira-reporter] 예외:', err);
  process.exit(1);
});
