---
name: api-testing
description: "LTS-2026 API 테스트 실행 및 테스트 케이스 작성. Use when: 단위·통합·E2E 테스트 실행, 특정 기능 테스트 케이스 작성, Jest 테스트 오류 디버깅, 테스트 커버리지 확인, API 엔드포인트 검증, GitHub Actions CI 파이프라인 문제 해결, 새 기능에 대한 테스트 추가, TC 스위트 모드별 실행 정책(analysisOnly/streamingOnly/captureOnly) 적용. Covers: test/ 폴더 구조, Jest 설정, server/jest.config.js, test/tc_runner_cli.js, test/run_all.js, test/generate_report.js, server/src/services/TcRunnerService.js."
argument-hint: "테스트 대상 (예: face-enrollment, camera-discovery, webrtc, 또는 all)"
---

# API Testing

## 테스트 구조

```
test/
├── tc_runner_cli.js    — TC-ID 단위 실행기 (SERVER_MODE 인식, 리포트 생성)
├── run_all.js          — 스위트 단위 전체 실행기
├── generate_report.js  — HTML/JSON 테스트 리포트 생성
├── fixtures/           — 테스트용 이미지·데이터 픽스처
├── api/                — 단위 및 API 테스트 (node 직접 실행)
├── integration/        — 통합 테스트
├── e2e/                — End-to-End 테스트
└── reports/            — 테스트 결과 리포트 출력
```

## 테스트 파일 목록 (모드별 분류)

> TC 스위트 플래그: `analysisOnly` / `streamingOnly` / `captureOnly` / 없음(모든 모드)
> 상세: [Design_TC_Mode_Execution_Policy.md](../../../docs/design/Design_TC_Mode_Execution_Policy.md)

### 모든 모드 실행 (플래그 없음)

| 테스트 파일 | 대상 기능 |
|---|---|
| `main_system.test.js` | 전체 시스템 통합 테스트 |
| `human_detection.test.js` | 인체 감지 AI 파이프라인 |
| `object_tracking.test.js` | 객체 추적 (ByteTrack) |
| `face_enrollment.test.js` | 얼굴 등록 API |
| `face_gallery.test.js` | 얼굴 갤러리 조회 |
| `cross_camera_tracking.test.js` | 크로스 카메라 Re-ID |
| `face_match_history.test.js` | 얼굴 매칭 이력 조회 API |
| `face_match_timeline_navigation.test.js` | Live Match → Detections 타임라인 이동 (join key 계약) |
| `webrtc.test.js` | WebRTC 기본 연결 |
| `webrtc_ice.test.js` | ICE/STUN/TURN 협상 |
| `webrtc_stability.test.js` | WebRTC 연결 안정성 |
| `webrtc_telemetry.test.js` | WebRTC 품질 메트릭 |
| `auth.test.js` | 사용자 인증 (JWT/MSAL) |
| `sidebar_alerts_zones.test.js` | 알림·구역 사이드바 API |
| `sidebar_cameras.test.js` | 카메라 사이드바 API |
| `mcp_server.test.js` | MCP 서버 도구 테스트 |
| `stats_panel.test.js` | 분석 통계 API |
| `detection_snapshot_search.test.js` | 스냅샷 검색 API |
| `user_profile.test.js` | 사용자 프로필 API |
| `distributed_pipeline.test.js` | 분산 파이프라인 (SERVER_MODE 전반) |

### `analysisOnly` — streaming 모드에서 스킵

| 테스트 파일 | 대상 기능 | 이유 |
|---|---|---|
| `ai_detection_modules.test.js` | 모든 AI 감지 모듈 | 로컬 ONNX 추론 필요 |
| `analytics_config.test.js` | Analytics Config 토글 | 로컬 AI 설정 |
| `model_catalog.test.js` | YOLO 모델 카탈로그 | 로컬 모델 관리 |

### `streamingOnly` — combined/analysis 모드에서 스킵

| 테스트 파일 | 대상 기능 | 이유 |
|---|---|---|
| `timeline_range.test.js` | Timeline 1H Range | streaming 캡처+ONVIF 필요 |
| `streaming_mode_model_skip.test.js` | Streaming Model-Load Guard | streaming 전용 로직 |
| `streaming_without_analysis_url.test.js` | Streaming Monitoring-Only Fallback | streaming 전용 fallback |
| `face_search_condition_sync.test.js` | Face Search Condition Sync (얼굴 등록 위임 + push/poll) | streaming→analysis 전용 흐름 |

### `captureOnly` — analysis 모드에서 스킵

| 테스트 파일 | 대상 기능 | 이유 |
|---|---|---|
| `camera_discovery.test.js` | ONVIF 카메라 탐색 | capture 백엔드 없음 |
| `nvr_channel_discovery.test.js` | NVR MaxChannel 탐색 | capture 백엔드 없음 |
| `channel_slot.test.js` | Dashboard Channel Slot 매핑 (FR-CH-001~062) | capture 백엔드 없음 |
| `capture-backend.test.js` | RTSP Capture Backend | 캡처 클래스 테스트 |
| `onvif_metadata_pipeline.test.js` | ONVIF 메타데이터 파이프라인 | ONVIF 구독 없음 |
| `onvif_apprtp.test.js` | ONVIF App-RTP | capture 파이프라인 없음 |
| `youtube_streams.test.js` | YouTube 스트림 수집 | YouTubeStreamService 비활성 |
| `youtube_streams_lts2026.test.js` | LTS2026 YouTube Schema | YouTubeStreamService 비활성 |

---

## TC 모드별 실행 결정 매트릭스

| 플래그 | combined | streaming | analysis |
|---|---|---|---|
| (없음) | ✓ RUN | ✓ RUN | ✓ RUN |
| `analysisOnly` | ✓ RUN | **✗ SKIP** | ✓ RUN |
| `streamingOnly` | **✗ SKIP** | ✓ RUN | **✗ SKIP** |
| `captureOnly` | ✓ RUN | ✓ RUN | **✗ SKIP** |

---

## 테스트 실행 명령

### TC-ID 단위 실행 (추천 — Admin Dashboard 동기)
```bash
# combined 모드 (기본)
npm run test:tc

# streaming 서버 대상
SERVER_MODE=streaming npm run test:tc
# 또는
npm run test:tc -- --server-mode streaming

# analysis 서버 대상
SERVER_MODE=analysis npm run test:tc
# 또는
npm run test:tc -- --server-mode analysis

# 특정 스위트만
npm run test:tc -- --only face
npm run test:tc -- --skip youtube

# 리포트 생성 포함
npm run test:tc -- --output-json test/reports/result.json --output-md test/reports/result.md
```

### 스위트 단위 전체 실행
```bash
npm run test:all     # 스위트 단위 전체 (e2e 제외)
npm run test:report  # 스위트 단위 + MD/JSON 리포트
```

### Jest 단위 테스트 (서버)
```bash
cd server
npm test                              # 전체
npm test -- --testNamePattern="face"  # 특정 이름 패턴
npm test -- test/api/auth.test.js     # 특정 파일
npm test -- --coverage                # 커버리지 포함
```

---

## TC Runner 실행 흐름 (tc_runner_cli.js)

```
npm run test:tc [--server-mode <mode>]
  │
  ├─ 1. CLI 인수 파싱 (--url, --server-mode, --only, --skip, --output-json/md)
  ├─ 2. GET ${LTS_URL}/health  →  실패 시 exit(2)
  ├─ 3. SERVER_MODE 결정 (인수 → env → 기본 'combined')
  │
  └─ 4. SUITES 순서 처리
         ├─ --only/--skip 필터
         ├─ analysisOnly  && streaming  → ⊘ SKIP
         ├─ streamingOnly && !streaming → ⊘ SKIP
         ├─ captureOnly   && analysis   → ⊘ SKIP
         ├─ 파일 없음                   → ⊘ SKIP
         └─ 그 외: node <suite-file> --url <LTS_URL> 실행
                   stdout 파싱: ✓/✗ TC-ID 행 → pass/fail
                   90s 타임아웃 → SIGTERM

  → 결과 집계 → JSON/MD 리포트 생성
  → exit(0: 전체 pass/skip | 1: 1개 이상 fail | 2: 서버 unreachable)
```

## 서버 자동 TC 실행 흐름 (TcRunnerService.js)

```
서버 시작 → TcRunnerService.runOnStartup(port)
  │  TC_STARTUP_RUN=false → 스킵
  │  30초 대기
  │
  └─ _run(port, proto)
       SERVER_MODE = process.env.SERVER_MODE
       │
       └─ SUITES 순서 처리 (tc_runner_cli.js와 동일 스킵 로직)
            pass/fail/skip → DB tc_results 테이블 저장
            │
            └─ GET /admin/tc-results → Admin Dashboard Audit 패널 표시
```

---

## 신규 TC 스위트 등록 절차

**반드시 두 파일을 동시에 수정:**
1. `test/tc_runner_cli.js` SUITES 배열
2. `server/src/services/TcRunnerService.js` SUITES 배열

```js
// 등록 양식
{
  file:  'test/api/<feature>.test.js',  // 루트 기준 상대경로
  srs:   'FR-XXX-001~010',              // 커버하는 SRS FR 번호
  label: '기능명  그룹라벨',
  // 해당하는 경우에만 플래그 추가:
  analysisOnly:  true,  // 로컬 AI 추론 필요 → streaming에서 스킵
  streamingOnly: true,  // streaming 전용 → combined/analysis에서 스킵
  captureOnly:   true,  // 캡처 백엔드 필요 → analysis에서 스킵
}
```

**플래그 선택 기준:**
- ONNX/YOLO AI 추론 검증 → `analysisOnly`
- streaming 서버 전용 기능 → `streamingOnly`
- RTSP/ONVIF/YouTube/MediaMTX/카메라 탐색 → `captureOnly`
- 공통 기능(DB/인증/통계) → 플래그 없음

---

## 테스트 케이스 작성 패턴

```js
// test/api/new_feature.test.js
'use strict';
/**
 * Feature Name Tests
 * TC: TC-LTS-FEATURE-001
 * SRS: FR-XXX-001~010
 */
const http = require('http');
const BASE_URL = process.env.LTS_URL || 'http://localhost:3080';

let passed = 0, failed = 0;

function assert(condition, tcId, desc) {
  if (condition) {
    console.log(`  ✓ ${tcId}: ${desc}`);
    passed++;
  } else {
    console.error(`  ✗ ${tcId}: ${desc}`);
    failed++;
  }
}

// 테스트 케이스들...

async function runAll() {
  // 테스트 실행...
  process.exit(failed > 0 ? 1 : 0);
}
runAll().catch(err => { console.error(err); process.exit(1); });
```

---

## Jest 설정 확인
- `server/jest.config.js` — 테스트 환경, 타임아웃, 커버리지 임계값
- `server/nodemon.json` — 개발 중 자동 재시작 설정

## CI 파이프라인
- `.github/workflows/test.yml` — GitHub Actions 자동 테스트
- Push 또는 PR 시 자동 실행: `npm test` → 결과를 PR 상태로 표시

## 테스트 격리·정리 관련 주의사항 (2026-07-21 실측)

### 1. 서버 재시작이 TC 자동 실행을 중단시키면 테스트 카메라가 고아로 남는다

`camera_discovery.test.js`(TC-B 그룹)처럼 `POST /api/cameras`로 실제 카메라 레코드를 만드는 스위트는 `main()` 맨 끝의 `cleanupAll()`에서 일괄 삭제하는 구조 — 테스트 하나하나가 아니라 **런 전체가 끝나야** 정리된다. 액티브 디버깅 세션에서 서버를 자주 재시작(`npm run start`)하면 `TcRunnerService.runOnStartup()`이 매 부팅마다 43개 스위트를 새로 돌리는데(30초 지연 후 시작), 다음 재시작이 그 실행 도중에 발생하면 `cleanupAll()`에 도달하기 전에 프로세스가 죽어 `TC-B-001 Cam`, `TC-B-005 Del`, `TC-A-*-Cam*` 같은 이름의 카메라 레코드가 DB에 영구적으로 남는다 — RTSP URL이 `10.0.0.x`/`192.0.2.x`(TEST-NET, RFC 5737) 대역이라 실제 카메라일 수 없음이 확인 기준.

**예방**: 서버를 반복 재시작해야 하는 활성 디버깅 세션에서는 `server/.env`에 `TC_STARTUP_RUN=false`를 임시로 설정해 자동 실행 자체를 끄는 것을 권장 — 작업이 끝나면 원복. 이미 고아가 된 카메라는 이름이 `TC-*` 접두사이고 RTSP URL이 TEST-NET 대역인지 확인 후 `DELETE /api/cameras/:id`로 안전하게 정리 가능.

### 2. `distributed_pipeline.test.js`의 TC-DAP-005/009는 카메라를 등록하지 않고 cameraId만 사용한다

`POST /api/analysis/frame`에 `cameraId: 'test-cam-distributed'` / `'tc009-cam-alpha'` / `'tc009-cam-beta'`를 직접 실어 보내는 방식(FR-DAP-027 — cameraId별 상태 격리 검증이 테스트 목적이므로 실제 카메라 등록이 오히려 불필요) — 이 cameraId들은 `POST /api/cameras`를 거친 적이 없어 `DELETE /api/cameras/:id`로 지울 대상 자체가 없다. Analysis 서버(`analysisApi.js`)가 프레임을 받을 때마다 `_cameraContexts`/`_metrics.perCamera`에 lazy-create하는데, `_cameraContexts`는 5분 idle 후 자동 정리(`CONTEXT_EXPIRY_MS`)되지만 `_metrics.perCamera`는 2026-07-21 이전에는 만료 로직이 없어 프로세스 수명 내내 누적되던 버그였음 — 같은 60초 프루닝 인터벌에 편입해 수정 완료(`Design_RTSP_Capture_Backend.md` §6.29.11). 정상 등록된 카메라를 삭제할 때는 `DELETE /api/cameras/:id`가 이제 `POST {ANALYSIS_SERVER_URL}/api/analysis/camera-removed`로 즉시 통지해 5분을 기다리지 않고 정리된다(§6.29.12) — 단, 이 통지가 실제로 반영되려면 **Analysis 서버 자신도 이 커밋을 pull·재시작해야** 신규 엔드포인트가 응답한다(원격 서버라 이 세션에서 직접 재시작 불가, 실측 시 404 확인됨).

## 디버깅 팁
```bash
npm test -- --verbose    # 자세한 로그
npm test -- --bail       # 실패 시 즉시 중단
npm test -- --testNamePattern="WebRTC ICE"
```

---

## 관련 문서 (SDLC 참조)

| 구분 | 문서 |
|------|------|
| **TC 모드 정책** | [Design_TC_Mode_Execution_Policy.md](../../../docs/design/Design_TC_Mode_Execution_Policy.md) — 플래그 정의·매트릭스·흐름도 |
| RFP | [RFP_LTS2026_Loitering_Tracking_System](../../../docs/rfp/RFP_LTS2026_Loitering_Tracking_System.md) |
| SRS | [SRS_Distributed_AI_Pipeline.md](../../../docs/srs/SRS_Distributed_AI_Pipeline.md) — FR-DAP-029~031 |
| TC | [TC_Distributed_AI_Pipeline.md](../../../docs/tc/TC_Distributed_AI_Pipeline.md) — TC-DAP-014 |
| TC | [TC_AI_Human_Detection](../../../docs/tc/TC_AI_Human_Detection.md) · [TC_Object_Tracking](../../../docs/tc/TC_Object_Tracking.md) · [TC_Camera_Discovery](../../../docs/tc/TC_Camera_Discovery.md) |
| TC (전체 목록) | [`docs/tc/`](../../../docs/tc/) 디렉토리 |

## 테스트 파일 ↔ TC 문서 매핑

| 테스트 파일 | 대응 TC 문서 |
|-------------|-------------|
| `human_detection.test.js` | `docs/tc/TC_AI_Human_Detection.md` |
| `object_tracking.test.js` | `docs/tc/TC_Object_Tracking.md` |
| `face_enrollment.test.js`, `face_gallery.test.js` | `docs/tc/TC_AI_Face_Recognition.md` |
| `cross_camera_tracking.test.js` | `docs/tc/TC_CrossCamera_Face_Tracking.md` |
| `face_match_history.test.js` | `docs/tc/TC_Face_Match_History.md` |
| `face_match_timeline_navigation.test.js` | `docs/tc/TC_Face_Match_Timeline_Navigation.md` |
| `camera_discovery.test.js` | `docs/tc/TC_Camera_Discovery.md` |
| `channel_slot.test.js` | `docs/tc/TC_Channel_Slot.md` |
| `webrtc.test.js`, `webrtc_ice.test.js`, `webrtc_stability.test.js` | `docs/tc/TC_WebRTC_Media_Gateway.md`, `docs/tc/TC_STUN_TURN_ICE.md` |
| `auth.test.js` | `docs/tc/TC_User_Authentication.md` |
| `sidebar_alerts_zones.test.js` | `docs/tc/TC_Dashboard_Sidebar_Alerts_Zones.md` |
| `youtube_streams.test.js` | `docs/tc/TC_LTS2026_YouTube_RTSP_Ingest.md` |
| `ai_detection_modules.test.js` | `docs/tc/TC_AI_Human_Detection.md`, `docs/tc/TC_AI_Fire_Smoke_Detection.md` 등 |
| `stats_panel.test.js` | `docs/tc/TC_Stats_Panel.md` |
| `detection_snapshot_search.test.js` | `docs/tc/TC_Detection_Snapshot_Search.md` |
| `face_search_condition_sync.test.js` | `docs/tc/TC_Face_Search_Condition_Sync.md` |

## 코드 수정 시 문서 동기화 의무

| 변경 사항 | 업데이트 필요 |
|-----------|--------------|
| 새 TC 스위트 추가 | `tc_runner_cli.js` SUITES + `TcRunnerService.js` SUITES **동시** 수정, `docs/tc/TC_xxx.md` 생성 |
| TC 스위트 플래그 변경 | `Design_TC_Mode_Execution_Policy.md` §5 분류표 + `CLAUDE.md` SDLC 동기화 규칙 업데이트 |
| 새 테스트 파일 추가 | `docs/tc/` 에 대응 TC 문서 생성, 위 두 SUITES에 등록 |
| 기존 테스트 케이스 변경 | 대응 `docs/tc/TC_xxx.md` 동기화 |
| API 엔드포인트 변경 | 해당 기능의 SRS API 명세 + TC 문서 갱신 |

**공통 규칙**
- **새 기능 구현** → 기능 코드 + `docs/tc/TC_xxx.md` 동시 작성
- **테스트 실패 회귀** → TC 문서에 회귀 케이스(Regression) 항목 추가
- **커버리지 미달** → 해당 SRS FR 항목에 TC 연결 확인 후 테스트 추가
