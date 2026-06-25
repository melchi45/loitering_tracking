# DESIGN DOCUMENT
# TC 모드별 실행 정책 (Test Case Mode Execution Policy)

| | |
|---|---|
| **Document ID** | DESIGN-LTS-TCMEP-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-06-25 |
| **Parent SRS** | [srs/SRS_Distributed_AI_Pipeline.md](../srs/SRS_Distributed_AI_Pipeline.md) |
| **Parent PRD** | [prd/PRD_Distributed_AI_Pipeline.md](../prd/PRD_Distributed_AI_Pipeline.md) |

---

## Table of Contents

1. [개요](#1-개요)
2. [서버 모드별 특성](#2-서버-모드별-특성)
3. [TC 스위트 플래그 체계](#3-tc-스위트-플래그-체계)
4. [TC 실행 결정 매트릭스](#4-tc-실행-결정-매트릭스)
5. [전체 스위트 레지스트리 및 분류](#5-전체-스위트-레지스트리-및-분류)
6. [TC Runner 스크립트 실행 흐름](#6-tc-runner-스크립트-실행-흐름)
7. [서버 자동 TC 실행 흐름 (TcRunnerService)](#7-서버-자동-tc-실행-흐름-tcrunnerservice)
8. [신규 TC 스위트 등록 절차](#8-신규-tc-스위트-등록-절차)
9. [유지보수 체크리스트](#9-유지보수-체크리스트)

---

## 1. 개요

LTS-2026은 세 가지 SERVER_MODE(combined / streaming / analysis)로 운영되며,
각 모드에서 실행 가능한 기능이 다르기 때문에 모든 TC 스위트가 모든 모드에서 유효하지 않습니다.

이 문서는 다음을 정의합니다:
- 어떤 플래그가 어떤 조건에서 TC 스위트를 스킵하는지
- 각 TC 스위트가 어떤 모드에서 실행되는지
- `test/tc_runner_cli.js`와 `server/src/services/TcRunnerService.js`의 실행 흐름
- 신규 TC 스위트를 추가할 때 플래그를 어떻게 설정해야 하는지

---

## 2. 서버 모드별 특성

| 항목 | combined | streaming | analysis |
|---|---|---|---|
| RTSP 캡처 백엔드 | ✓ | ✓ | ✗ |
| MediaMTX / ingest-daemon | ✓ | ✓ | ✗ |
| ONVIF 구독 / App-RTP | ✓ | ✓ | ✗ |
| YouTube 스트림 서비스 | ✓ | ✓ | ✗ |
| 카메라 자동 탐색 | ✓ | ✓ | ✗ |
| 로컬 AI 추론 (ONNX) | ✓ | ✗ | ✓ |
| WebRTC 엔진 | ✓ | ✓ | ✗ |
| `/api/youtube-streams` 라우트 | ✓ | ✓ | ✗ |
| `/internal` 라우트 | ✓ | ✓ | ✗ |
| `/api/analysis/frame` 수신 | ✗ | ✗ | ✓ |

---

## 3. TC 스위트 플래그 체계

TC 스위트 레지스트리(`SUITES` 배열)의 각 항목에 다음 플래그를 설정합니다:

### 3.1 플래그 정의

| 플래그 | 타입 | 스킵 조건 | 의미 |
|---|---|---|---|
| `analysisOnly: true` | boolean | `SERVER_MODE=streaming` | 로컬 AI 추론이 필요한 TC. streaming 서버에는 ONNX 모델이 없음 |
| `streamingOnly: true` | boolean | `SERVER_MODE=combined` 또는 `SERVER_MODE=analysis` | streaming 서버 전용 기능 TC. combined/analysis에서 의미 없음 |
| `captureOnly: true` | boolean | `SERVER_MODE=analysis` | RTSP 캡처 백엔드가 필요한 TC. analysis 서버에는 캡처 기능이 없음 |
| (없음) | — | 스킵 없음 | 모든 모드에서 실행 |

### 3.2 플래그 선택 기준

```
신규 TC 스위트를 등록할 때:

1. 이 TC가 로컬 AI 추론(ONNX/YOLO)을 검증하는가?
   → YES: analysisOnly: true  (streaming 모드에서 스킵)

2. 이 TC가 streaming 서버 전용 기능(회로차단기, 프레임 포워딩)을 검증하는가?
   → YES: streamingOnly: true  (combined/analysis에서 스킵)

3. 이 TC가 RTSP 캡처, ONVIF, YouTube, MediaMTX, 카메라 탐색을 검증하는가?
   → YES: captureOnly: true  (analysis 모드에서 스킵)

4. 이 TC가 공통 기능(DB, 인증, 통계, 얼굴, 알림)을 검증하는가?
   → 플래그 없음  (모든 모드에서 실행)
```

---

## 4. TC 실행 결정 매트릭스

| 플래그 | combined | streaming | analysis |
|---|---|---|---|
| (없음) | ✓ RUN | ✓ RUN | ✓ RUN |
| `analysisOnly` | ✓ RUN | ✗ SKIP | ✓ RUN |
| `streamingOnly` | ✗ SKIP | ✓ RUN | ✗ SKIP |
| `captureOnly` | ✓ RUN | ✓ RUN | ✗ SKIP |

---

## 5. 전체 스위트 레지스트리 및 분류

> 소스: `test/tc_runner_cli.js` SUITES 배열 (TcRunnerService.js 와 항상 동기화)

### 5.1 모든 모드 실행 (플래그 없음)

| 스위트 | SRS | 설명 |
|---|---|---|
| DB Layer | FR-STORAGE-001~074 | 스토리지 백엔드 |
| Sidebar Cameras | FR-CAM-001~020 | 카메라 목록 API |
| User Authentication | FR-USR-AUTH-001~020 | JWT/MSAL 인증 |
| User Profile | FR-USR-PROF-001~010 | 사용자 프로필 |
| Human Detection | FR-HDT-017,020,032 | 인체 감지 |
| Object Tracking | FR-TRK-001~030 | 객체 추적 |
| Alerts & Zones | FR-ZONE-001, FR-ALERT-001 | 구역·알림 |
| Main System | FR-SYS-D+E+F+H | 시스템 통합 |
| Stats Panel | FR-STATS-001~010 | 통계 |
| Face Gallery | FR-FACE-001~020 | 얼굴 갤러리 |
| Face Enrollment | FR-FACE-021~040 | 얼굴 등록 |
| Missing Persons | FR-FACE-MISSING-001~020 | 실종자 |
| Cross-Camera Tracking | FR-REID-001~030 | 크로스카메라 |
| Detection Snapshots | FR-SNAP-001~010 | 스냅샷 |
| WebRTC | FR-WEBRTC-001~020 | WebRTC |
| WebRTC ICE | FR-WEBRTC-ICE-001~010 | ICE 설정 |
| WebRTC Stability | FR-WEBRTC-STA-001~010 | 안정성 |
| WebRTC Telemetry | FR-WEBRTC-TEL-001~010 | 품질 메트릭 |
| HTTPS TLS | FR-TLS-001~010 | TLS |
| Thermal Radiometry | FR-THERMAL-001~010 | 열상 오버레이 |
| Distributed Pipeline | FR-DIST-001~020 | 분산 파이프라인 |
| MCP Server | FR-MCP-001~020 | MCP 도구 |
| MCP Server Extended | FR-MCP-070~110 | MCP 확장 |

### 5.2 analysisOnly (streaming 스킵)

| 스위트 | SRS | 이유 |
|---|---|---|
| AI Detection Modules | FR-AI-MOD-001~010 | 로컬 ONNX 추론 필요 |
| Analytics Config Toggle | FR-ANA-CFG-001~010 | 로컬 AI 설정 |
| YOLO Model Catalog | FR-MODEL-001~010 | 로컬 모델 관리 |

### 5.3 streamingOnly (combined/analysis 스킵)

| 스위트 | SRS | 이유 |
|---|---|---|
| Timeline 1H Range | FR-TIMELINE-RANGE-001~008 | streaming 캡처+ONVIF 필요 |
| Streaming Model-Load Guard | FR-STREAM-MODEL-001~005 | streaming 전용 로직 |
| Streaming Monitoring-Only Fallback | FR-STREAM-FALLBACK-001~005 | streaming 전용 fallback |

### 5.4 captureOnly (analysis 스킵)

| 스위트 | SRS | 이유 |
|---|---|---|
| Camera Discovery | FR-CAM-040~056 | ONVIF WS-Discovery 없음 |
| NVR MaxChannel | FR-CAM-060~067 | NVR 채널 탐색 없음 |
| ONVIF Metadata Pipeline | FR-ONVIF-PIPE-001~020 | ONVIF 구독 없음 |
| ONVIF App-RTP | FR-ONVIF-RTP-001~010 | RTSP App-RTP 없음 |
| RTSP Capture Backend | FR-CAP-001~020 | 캡처 백엔드 없음 |
| YouTube RTSP Ingest | FR-YT-001~020 | YouTube 서비스 비활성 |
| LTS2026 YouTube Schema | FR-YT-LTS-001~010 | YouTube 서비스 비활성 |

---

## 6. TC Runner 스크립트 실행 흐름

> 소스: `test/tc_runner_cli.js`
> 진입: `npm run test:tc` (루트 또는 server/)

```
┌─────────────────────────────────────────────────────────────────┐
│  npm run test:tc [--server-mode <mode>] [--only X] [--skip Y]  │
│  → node test/tc_runner_cli.js                                   │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                    ┌──────▼──────────────────────────────────┐
                    │ 1. CLI 인수 파싱                         │
                    │    --url        (기본 http://localhost:3080) │
                    │    --server-mode (기본 SERVER_MODE env)  │
                    │    --only / --skip (스위트 필터)         │
                    │    --output-json / --output-md           │
                    └──────┬──────────────────────────────────┘
                           │
                    ┌──────▼──────────────────────────────────┐
                    │ 2. 서버 Health Check                     │
                    │    GET ${LTS_URL}/health                 │
                    │    실패 시 exit(2)                       │
                    └──────┬──────────────────────────────────┘
                           │
                    ┌──────▼──────────────────────────────────┐
                    │ 3. SERVER_MODE 결정                      │
                    │    serverModeArg → process.env.SERVER_MODE │
                    │    → 기본값 'combined'                   │
                    └──────┬──────────────────────────────────┘
                           │
              ┌────────────▼────────────────────────────────────┐
              │ 4. 각 스위트 순서 처리 (for..of SUITES)         │
              │                                                  │
              │  ① --only/--skip 필터 적용                      │
              │                                                  │
              │  ② 모드 기반 스킵 판정:                         │
              │     isStreaming && analysisOnly  → SKIP           │
              │     !isStreaming && streamingOnly → SKIP          │
              │     isAnalysis && captureOnly   → SKIP           │
              │     파일 없음                   → SKIP           │
              │                                                  │
              │  ③ 스킵이 아니면: child_process.spawn()          │
              │     node <suite-file> --url ${LTS_URL}           │
              │     stdout 실시간 파싱:                          │
              │       ✓ TC-DAP-001: ... → pass                  │
              │       ✗ TC-DAP-002: ... → fail                  │
              │       ⊘ TC-SKIP: ...    → skip                  │
              │     SUITE_TIMEOUT(90s) 초과 시 SIGTERM           │
              └─────────────┬───────────────────────────────────┘
                            │
                    ┌───────▼─────────────────────────────────┐
                    │ 5. 결과 집계 및 출력                     │
                    │    --output-json → test/reports/*.json   │
                    │    --output-md   → test/reports/*.md     │
                    │    --github-summary → $GITHUB_STEP_SUMMARY│
                    └───────┬─────────────────────────────────┘
                            │
                    ┌───────▼─────────────────────────────────┐
                    │ 6. Exit Code                            │
                    │    0 — 모든 스위트 PASS 또는 SKIP       │
                    │    1 — 1개 이상 FAIL                    │
                    │    2 — 서버 unreachable                 │
                    └─────────────────────────────────────────┘
```

---

## 7. 서버 자동 TC 실행 흐름 (TcRunnerService)

> 소스: `server/src/services/TcRunnerService.js`
> 서버 시작 후 자동 실행, Admin Dashboard Audit 패널에 표시

```
┌─────────────────────────────────────────────────────────────────┐
│  서버 시작 (index.js → app.listen())                            │
│  → TcRunnerService.runOnStartup(port, proto)                   │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                    ┌──────▼──────────────────────────────────┐
                    │ 1. TC_STARTUP_RUN=false ?               │
                    │    YES → 로그 출력 후 종료 (skip)       │
                    └──────┬──────────────────────────────────┘
                           │
                    ┌──────▼──────────────────────────────────┐
                    │ 2. STARTUP_DELAY_MS(기본 30s) 대기      │
                    │    서버 초기화 완료 대기용              │
                    └──────┬──────────────────────────────────┘
                           │
                    ┌──────▼──────────────────────────────────┐
                    │ 3. _run(port, proto)                     │
                    │    runId = UUID 생성                    │
                    │    ltsUrl = http(s)://localhost:{port}  │
                    │    serverMode = process.env.SERVER_MODE │
                    └──────┬──────────────────────────────────┘
                           │
              ┌────────────▼────────────────────────────────────┐
              │ 4. 각 스위트 순서 처리                          │
              │                                                  │
              │  ① 모드 기반 스킵:                              │
              │     streaming && analysisOnly  → _save(skip)    │
              │     analysis && streamingOnly  → _save(skip)    │
              │     analysis && captureOnly    → _save(skip)    │
              │     파일 없음                  → _save(skip)    │
              │                                                  │
              │  ② child_process.spawn(node <suite-file>)       │
              │     stdout/stderr 라인 파싱                     │
              │     TC-ID 행 추출 → pass/fail/skip 판별        │
              │                                                  │
              │  ③ _save(runId, runAt, suite, tcId, desc,      │
              │           status, errorMsg)                     │
              │     → DB tc_results 테이블에 저장               │
              └─────────────┬───────────────────────────────────┘
                            │
                    ┌───────▼─────────────────────────────────┐
                    │ 5. 완료 로그 출력                        │
                    │    PASS/FAIL/SKIP 집계 + 경과 시간      │
                    └───────┬─────────────────────────────────┘
                            │
                    ┌───────▼─────────────────────────────────┐
                    │ 6. Admin Dashboard 조회                  │
                    │    GET /admin/tc-results                 │
                    │    → tc_results DB에서 최신 runId 조회  │
                    │    → Audit 패널 Pass/Fail/Skip 표시     │
                    │    → suiteMode 태그(analysis/streaming/ │
                    │       streaming+combined/all) 색상 표시 │
                    └─────────────────────────────────────────┘
```

---

## 8. 신규 TC 스위트 등록 절차

### 8.1 등록 위치 (반드시 두 파일 동시 수정)

| 파일 | 역할 |
|---|---|
| `test/tc_runner_cli.js` SUITES | CLI 실행기 레지스트리 |
| `server/src/services/TcRunnerService.js` SUITES | 서버 자동 실행 레지스트리 |

> **두 파일의 SUITES는 항상 동일해야 합니다.** 한쪽만 수정하면 CLI와 Admin Dashboard 결과가 달라집니다.

### 8.2 등록 양식

```js
{
  file:  'test/api/<테스트파일>.test.js',  // 루트 기준 상대경로
  srs:   'FR-XXX-001~010',                 // 커버하는 SRS FR 번호
  label: '기능 이름  그룹라벨',            // Admin Dashboard 표시명
  // 아래 중 해당하는 플래그만 추가 (없으면 모든 모드 실행)
  analysisOnly:  true,  // streaming에서 스킵
  streamingOnly: true,  // combined/analysis에서 스킵
  captureOnly:   true,  // analysis에서 스킵
}
```

### 8.3 등록 위치 규칙 (SUITES 내 순서)

```
1. DB Layer
2. Camera (captureOnly)
3. Auth / User
4. AI Detection (analysisOnly)
5. Tracking / Zones / Alerts
6. Face Recognition
7. Detection Snapshots
8. WebRTC
9. TLS
10. ONVIF (captureOnly)
11. Timeline (streamingOnly)
12. Capture / Pipeline (captureOnly)
13. Distributed Pipeline / Streaming Guard (streamingOnly)
14. YouTube (captureOnly)
15. MCP
```

---

## 9. 유지보수 체크리스트

### 9.1 새 기능 추가 시

- [ ] 테스트 파일 생성 (`test/api/<feature>.test.js`)
- [ ] 적절한 플래그 선택 (§3.2 기준)
- [ ] `test/tc_runner_cli.js` SUITES에 등록
- [ ] `server/src/services/TcRunnerService.js` SUITES에 **동일하게** 등록
- [ ] `docs/tc/TC_<Feature>.md` 작성 또는 업데이트
- [ ] `docs/srs/SRS_*.md`에 FR 번호 추가

### 9.2 SERVER_MODE 동작 변경 시

- [ ] 영향받는 스위트 플래그 재검토
- [ ] `§5` 분류 표 업데이트
- [ ] `§4` 결정 매트릭스 업데이트
- [ ] 관련 SRS/TC 문서 업데이트

### 9.3 플래그 체계 자체 변경 시

- [ ] `§3` 플래그 정의 업데이트
- [ ] `tc_runner_cli.js` 스킵 로직 수정
- [ ] `TcRunnerService.js` 스킵 로직 동일하게 수정
- [ ] `api-testing/SKILL.md` (.claude 및 .github 양쪽) 업데이트
- [ ] `CLAUDE.md` SDLC 동기화 규칙 표 업데이트

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-25 | 초기 작성 — captureOnly 플래그 도입 및 3종 플래그 체계 정의, TC Runner 실행 흐름 문서화 |
