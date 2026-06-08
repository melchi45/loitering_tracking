---
name: api-testing
description: "LTS-2026 API 테스트 실행 및 테스트 케이스 작성. Use when: 단위·통합·E2E 테스트 실행, 특정 기능 테스트 케이스 작성, Jest 테스트 오류 디버깅, 테스트 커버리지 확인, API 엔드포인트 검증, GitHub Actions CI 파이프라인 문제 해결, 새 기능에 대한 테스트 추가. Covers: test/ 폴더 구조, Jest 설정, server/jest.config.js, test/run_all.js, test/generate_report.js."
argument-hint: "테스트 대상 (예: face-enrollment, camera-discovery, webrtc, 또는 all)"
---

# API Testing

## 테스트 구조

```
test/
├── run_all.js          — 전체 테스트 스위트 실행기
├── generate_report.js  — HTML/JSON 테스트 리포트 생성
├── fixtures/           — 테스트용 이미지·데이터 픽스처
├── api/                — 단위 및 API 테스트 (Jest)
├── integration/        — 통합 테스트
├── e2e/                — End-to-End 테스트
└── reports/            — 테스트 결과 리포트 출력
```

## 테스트 파일 목록

| 테스트 파일 | 대상 기능 |
|---|---|
| `main_system.test.js` | 전체 시스템 통합 테스트 |
| `human_detection.test.js` | 인체 감지 AI 파이프라인 |
| `object_tracking.test.js` | 객체 추적 (ByteTrack) |
| `face_enrollment.test.js` | 얼굴 등록 API |
| `face_gallery.test.js` | 얼굴 갤러리 조회 |
| `cross_camera_tracking.test.js` | 크로스 카메라 Re-ID |
| `camera_discovery.test.js` | ONVIF 카메라 탐색 |
| `webrtc.test.js` | WebRTC 기본 연결 |
| `webrtc_ice.test.js` | ICE/STUN/TURN 협상 |
| `webrtc_stability.test.js` | WebRTC 연결 안정성 |
| `webrtc_telemetry.test.js` | WebRTC 품질 메트릭 |
| `auth.test.js` | 사용자 인증 (JWT/MSAL) |
| `sidebar_alerts_zones.test.js` | 알림·구역 사이드바 API |
| `sidebar_cameras.test.js` | 카메라 사이드바 API |
| `youtube_streams.test.js` | YouTube 스트림 수집 |
| `mcp_server.test.js` | MCP 서버 도구 테스트 |
| `ai_detection_modules.test.js` | 모든 AI 감지 모듈 |
| `stats_panel.test.js` | 분석 통계 API |
| `detection_snapshot_search.test.js` | 스냅샷 검색 API |
| `user_profile.test.js` | 사용자 프로필 API |

## 테스트 실행 명령

### 전체 테스트 실행
```bash
cd /home/youngho/workspace/loitering_tracking
node test/run_all.js
```

### Jest 단위 테스트 (서버)
```bash
cd server
npm test                          # 전체
npm test -- --testNamePattern="face"  # 특정 이름 패턴
npm test -- test/api/auth.test.js     # 특정 파일
npm test -- --coverage                # 커버리지 포함
```

### 특정 기능 테스트
```bash
# 카메라 발견 테스트
npm test -- test/api/camera_discovery.test.js

# WebRTC 관련 전체
npm test -- --testPathPattern="webrtc"

# AI 감지 모듈 전체
npm test -- test/api/ai_detection_modules.test.js
```

### 테스트 리포트 생성
```bash
node test/generate_report.js
# 결과: test/reports/ 폴더에 HTML/JSON 리포트 생성
```

## 테스트 케이스 작성 패턴

```js
// test/api/new_feature.test.js
const request = require('supertest');
const app = require('../../server/src/index');

describe('새 기능 API', () => {
  let authToken;

  beforeAll(async () => {
    // 인증 토큰 획득
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'test' });
    authToken = res.body.token;
  });

  test('GET /api/new-endpoint - 정상 응답', async () => {
    const res = await request(app)
      .get('/api/new-endpoint')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200);

    expect(res.body).toHaveProperty('data');
  });

  test('POST /api/new-endpoint - 유효성 검사 오류', async () => {
    await request(app)
      .post('/api/new-endpoint')
      .set('Authorization', `Bearer ${authToken}`)
      .send({})   // 빈 바디 → 400 예상
      .expect(400);
  });
});
```

## Jest 설정 확인
- `server/jest.config.js` — 테스트 환경, 타임아웃, 커버리지 임계값
- `server/nodemon.json` — 개발 중 자동 재시작 설정

## CI 파이프라인
- `.github/workflows/test.yml` — GitHub Actions 자동 테스트
- Push 또는 PR 시 자동 실행: `npm test` → 결과를 PR 상태로 표시

## 디버깅 팁
```bash
# 자세한 로그로 테스트 실행
npm test -- --verbose

# 실패 시 즉시 중단
npm test -- --bail

# 특정 테스트만 실행 (--only 패턴 사용)
npm test -- --testNamePattern="WebRTC ICE"
```

## 관련 문서 (SDLC 참조)

> 테스트 작성 전 아래 문서를 확인하고, **코드 변경 시 TC 문서를 반드시 동기화**하세요.

| 구분 | 문서 |
|------|------|
| RFP | [RFP_LTS2026_Loitering_Tracking_System](../../../docs/rfp/RFP_LTS2026_Loitering_Tracking_System.md) — 최상위 요구사항 원본 (TC 추적성 기준) |
| SRS | [SRS_LTS2026_Loitering_Tracking_System](../../../docs/srs/SRS_LTS2026_Loitering_Tracking_System.md) — 테스트 대상 요구사항 원본 |
| TC | [TC_AI_Human_Detection](../../../docs/tc/TC_AI_Human_Detection.md) · [TC_Object_Tracking](../../../docs/tc/TC_Object_Tracking.md) · [TC_AI_Fire_Smoke_Detection](../../../docs/tc/TC_AI_Fire_Smoke_Detection.md) |
| TC | [TC_AI_Face_Recognition](../../../docs/tc/TC_AI_Face_Recognition.md) · [TC_CrossCamera_Face_Tracking](../../../docs/tc/TC_CrossCamera_Face_Tracking.md) · [TC_Camera_Discovery](../../../docs/tc/TC_Camera_Discovery.md) |
| TC | [TC_WebRTC_Media_Gateway](../../../docs/tc/TC_WebRTC_Media_Gateway.md) · [TC_STUN_TURN_ICE](../../../docs/tc/TC_STUN_TURN_ICE.md) · [TC_RTSP_Capture_Backend](../../../docs/tc/TC_RTSP_Capture_Backend.md) |
| TC | [TC_User_Authentication](../../../docs/tc/TC_User_Authentication.md) · [TC_Dashboard_Sidebar_Alerts_Zones](../../../docs/tc/TC_Dashboard_Sidebar_Alerts_Zones.md) · [TC_LTS2026_YouTube_RTSP_Ingest](../../../docs/tc/TC_LTS2026_YouTube_RTSP_Ingest.md) |
| TC | [TC_Storage_MongoDB](../../../docs/tc/TC_Storage_MongoDB.md) · [TC_HTTPS_TLS](../../../docs/tc/TC_HTTPS_TLS.md) · [TC_Stats_Panel](../../../docs/tc/TC_Stats_Panel.md) · [TC_Detection_Snapshot_Search](../../../docs/tc/TC_Detection_Snapshot_Search.md) |
| TC (전체 목록) | [`docs/tc/`](../../../docs/tc/) 디렉토리 |

## 테스트 파일 ↔ TC 문서 매핑

| 테스트 파일 | 대응 TC 문서 |
|-------------|-------------|
| `human_detection.test.js` | `docs/tc/TC_AI_Human_Detection.md` |
| `object_tracking.test.js` | `docs/tc/TC_Object_Tracking.md` |
| `face_enrollment.test.js`, `face_gallery.test.js` | `docs/tc/TC_AI_Face_Recognition.md` |
| `cross_camera_tracking.test.js` | `docs/tc/TC_CrossCamera_Face_Tracking.md` |
| `camera_discovery.test.js` | `docs/tc/TC_Camera_Discovery.md` |
| `webrtc.test.js`, `webrtc_ice.test.js`, `webrtc_stability.test.js` | `docs/tc/TC_WebRTC_Media_Gateway.md`, `docs/tc/TC_STUN_TURN_ICE.md` |
| `auth.test.js` | `docs/tc/TC_User_Authentication.md` |
| `sidebar_alerts_zones.test.js` | `docs/tc/TC_Dashboard_Sidebar_Alerts_Zones.md` |
| `youtube_streams.test.js` | `docs/tc/TC_LTS2026_YouTube_RTSP_Ingest.md` |
| `ai_detection_modules.test.js` | `docs/tc/TC_AI_Human_Detection.md`, `docs/tc/TC_AI_Fire_Smoke_Detection.md` 등 |
| `stats_panel.test.js` | `docs/tc/TC_Stats_Panel.md` |
| `detection_snapshot_search.test.js` | `docs/tc/TC_Detection_Snapshot_Search.md` |

## 코드 수정 시 문서 동기화 의무

| 변경 사항 | 업데이트 필요 문서 |
|-----------|------------------|
| 새 테스트 파일 추가 | `docs/tc/` 에 대응 TC 문서 생성, `test/jira-reporter.js` `TC_DOC_IDS` 매핑 추가 |
| 기존 테스트 케이스 변경 | 대응 `docs/tc/TC_xxx.md` 의 테스트 케이스 항목 동기화 |
| API 엔드포인트 변경으로 인한 테스트 수정 | 해당 기능의 SRS API 명세 + TC 문서 갱신 |
| `test/run_all.js` 스위트 구조 변경 | Jira 통합 SKILL 참조 (`test/jira-reporter.js` `SUITE_TC_MAP` 업데이트) |

**공통 규칙**
- **새 기능 구현** → 기능 코드 작성과 동시에 `docs/tc/TC_xxx.md` 테스트 케이스 문서화
- **테스트 실패 회귀** → TC 문서에 회귀 케이스(Regression) 항목 추가
- **커버리지 미달 영역** → 해당 SRS 요구사항 항목에 TC 연결 확인 후 테스트 추가
