# CLAUDE.md — LTS-2026 Loitering Detection & Tracking System

> 이 파일은 Claude AI가 이 프로젝트 작업 시 자동으로 로드하는 프로젝트 컨텍스트 파일입니다.

---

## 프로젝트 개요

**LTS-2026**은 AI 기반 배회(Loitering) 감지 및 추적 시스템입니다.

- **카메라 수집**: IP 카메라(RTSP/ONVIF/WebRTC) + YouTube 스트림 → MediaMTX 프록시
- **AI 파이프라인**: YOLOv8 ONNX 객체 감지 → ByteTrack 다중 추적 → 배회 행동 분석 → 알림 발생
- **크로스 카메라**: 얼굴 임베딩 Re-ID로 카메라 간 동일인 추적
- **서버**: Node.js 18+ (Express + Socket.IO + MediaSoup)
- **클라이언트**: React 18 + TypeScript + Tailwind CSS + Zustand
- **저장소**: JSON 파일 DB (`storage/lts.json`) + 선택적 MongoDB Atlas
- **MCP 서버**: LLM 연동용 별도 프로세스 (`mcp-server/`)

---

## 디렉토리 구조

```
loitering_tracking/
├── server/src/
│   ├── index.js                    # Express 진입점 (포트 3001)
│   ├── db.js                       # JSON DB 추상화 (직접 파일 I/O 금지)
│   ├── services/
│   │   ├── detection.js            # YOLOv8 ONNX 추론 (640×640)
│   │   ├── tracking.js             # ByteTrack + KalmanFilter
│   │   ├── behaviorEngine.js       # 배회 위험 점수 산출
│   │   ├── zoneManager.js          # 다각형 구역 관리
│   │   ├── alertService.js         # 알림 생성·에스컬레이션
│   │   ├── pipelineManager.js      # AI 서비스 생명주기 오케스트레이션
│   │   ├── attributePipeline.js    # 의상·색상·PPE 속성 분석
│   │   ├── faceService.js          # 얼굴 인식·임베딩·Re-ID
│   │   ├── rtspCapture.js          # RTSP 스트림 캡처 (10 FPS)
│   │   ├── webrtcGateway.js        # WebRTC SDP/ICE 협상
│   │   ├── fireSmokeService.js     # 화재·연기 감지
│   │   ├── colorClothService.js    # 색상·의류 분석
│   │   ├── protectiveEquipService.js # 안전모·마스크 감지
│   │   ├── discoveryService.js     # 카메라 자동 탐색
│   │   ├── onvifDiscovery.js       # ONVIF WS-Discovery
│   │   ├── youtubeStreamService.js # YouTube → RTSP 변환
│   │   ├── snapshotService.js      # 프레임 스냅샷 저장
│   │   ├── trackerConfig.js        # 추적기 파라미터
│   │   ├── TokenService.js         # JWT 토큰 관리
│   │   ├── UserService.js          # 사용자 CRUD
│   │   ├── AuditService.js         # 감사 로그
│   │   ├── MsalService.js          # Microsoft MSAL 인증
│   │   ├── mongoDbService.js       # MongoDB Atlas 연결
│   │   └── analyticsConfig.js      # 분석 설정
│   ├── routes/
│   │   ├── admin.js                # 관리자 라우터
│   │   └── auth.js                 # 인증 라우터
│   ├── socket/
│   │   ├── streamHandler.js        # Socket.IO 스트림 이벤트
│   │   ├── webrtcSignaling.js      # WebRTC 시그널링
│   │   ├── webrtcTelemetry.js      # WebRTC 품질 메트릭
│   │   └── webrtcTelemetryHandlers.js
│   ├── middleware/
│   │   ├── auth.js                 # JWT 인증 미들웨어
│   │   └── role.js                 # 역할 기반 접근 제어
│   ├── config/                     # 환경별 설정
│   └── utils/                      # 공통 유틸리티
├── client/src/
│   ├── App.tsx
│   ├── components/
│   │   ├── CameraGrid.tsx          # 멀티 카메라 그리드
│   │   ├── CameraView.tsx          # 단일 카메라 WebRTC 뷰
│   │   ├── AlertPanel.tsx          # 실시간 알림 목록
│   │   ├── ZonesPanel.tsx          # 구역 목록 사이드바
│   │   ├── ZoneEditor.tsx          # 구역 다각형 편집기
│   │   ├── FaceGalleryTab.tsx      # 얼굴 갤러리
│   │   ├── SearchFullscreen.tsx    # 전체화면 검색
│   │   ├── StatsPanelModal.tsx     # 통계 모달
│   │   └── DashboardDetectionPanel.tsx
│   ├── stores/                     # Zustand 상태 스토어
│   ├── hooks/                      # 커스텀 React 훅
│   ├── i18n/                       # 다국어(ko/en) 리소스
│   ├── pages/                      # 페이지 컴포넌트
│   └── types/                      # TypeScript 타입 정의
├── mcp-server/                     # MCP LLM 통합 서버
├── test/                           # Jest 테스트
│   ├── api/                        # API 단위 테스트
│   ├── integration/                # 통합 테스트
│   ├── e2e/                        # E2E 테스트
│   ├── fixtures/                   # 테스트 픽스처
│   ├── run_all.js                  # 전체 테스트 실행기
│   └── generate_report.js          # 리포트 생성기
├── docs/                           # 설계 문서
│   ├── design/                     # 기능별 설계 문서
│   ├── srs/                        # 소프트웨어 요구사항
│   ├── prd/                        # 제품 요구사항
│   └── ops/                        # 운영 가이드
├── storage/                        # 로컬 JSON 데이터
│   ├── lts.json                    # 메인 DB (카메라·구역·알림)
│   ├── analytics.json              # 분석 데이터
│   ├── face_tracking.json          # 얼굴 추적 데이터
│   └── tracker.json                # 추적기 상태
├── .github/
│   ├── copilot-instructions.md     # GitHub Copilot 전역 지침
│   └── skills/                     # Copilot Agent Skills
├── .claude/
│   └── skills/                     # Claude Skills
├── docker-compose.yml
├── mediamtx.yml                    # MediaMTX 미디어 서버 설정
└── yolov8s.pt                      # YOLOv8 학습 모델
```

---

## 기술 스택 및 코딩 규칙

### 서버 (Node.js)

- **CommonJS 전용** — `require()` / `module.exports` 사용, `import`/`export` 금지
- 비동기는 `async/await` 사용, Promise 체인(`.then()`) 지양
- `server/src/db.js`를 통해서만 `storage/lts.json` 접근 (직접 파일 I/O 금지)
- 환경변수는 `server/.env`에서 `dotenv`로 로드
- 포트 기본값 `3001`; `process.env.PORT`로 재정의
- Socket.IO 이벤트명은 `camelCase` (예: `frameData`, `newAlert`)
- 새 AI 서비스 추가 시 반드시 `pipelineManager.js`에 등록

### 클라이언트 (React/TypeScript)

- **Zustand** 스토어로 전역 상태 관리 (`client/src/stores/`)
- 함수형 컴포넌트 + 훅만 사용, 클래스 컴포넌트 금지
- Tailwind CSS 유틸리티 클래스 사용, 인라인 스타일 최소화
- 신규 컴포넌트는 `.tsx` 확장자 필수, 타입 정의 필수
- i18n 텍스트는 `useTranslation()` 훅 사용 (`client/src/i18n/`)
- WebSocket 이벤트 수신은 커스텀 훅으로 캡슐화

---

## API 엔드포인트

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/cameras` | 카메라 목록 조회 |
| POST | `/api/cameras` | 카메라 추가 |
| POST | `/api/cameras/discover` | ONVIF 자동 탐색 |
| GET | `/api/alerts` | 알림 목록 조회 |
| PATCH | `/api/alerts/:id/acknowledge` | 알림 확인 처리 |
| GET | `/api/zones` | 구역 목록 조회 |
| POST | `/api/zones` | 구역 생성 |
| PATCH | `/api/zones/:id` | 구역 수정 |
| GET | `/api/analytics/summary` | 분석 요약 통계 |
| POST | `/api/faces/register` | 얼굴 등록 |
| POST | `/api/faces/search` | 얼굴 검색 |
| POST | `/api/streams/youtube` | YouTube 스트림 수집 |
| GET | `/health` | 서버 상태 확인 |

---

## Socket.IO 이벤트

| 이벤트 | 방향 | 설명 |
|--------|------|------|
| `frameData` | Server → Client | 어노테이션된 JPEG 프레임 |
| `newAlert` | Server → Client | 신규 알림 발생 |
| `alert:acknowledged` | Server → Client | 알림 확인 처리됨 |
| `objectTracked` | Server → Client | 추적 객체 업데이트 |
| `cameraStatus` | Server → Client | 카메라 연결 상태 변경 |
| `subscribeCamera` | Client → Server | 카메라 스트림 구독 |

---

## 개발 명령어

```bash
# 서버 개발 모드 (nodemon 자동 재시작)
cd server && npm run dev

# 클라이언트 개발 서버 (Vite HMR)
cd client && npm run dev

# 전체 테스트 실행
cd server && npm test
node test/run_all.js

# Docker 전체 스택
docker compose up -d
docker compose logs -f server
docker compose build server && docker compose up -d server
```

---

## 보안 규칙

- 입력 검증은 모든 API 엔드포인트 진입점에서 수행 (OWASP Top 10 준수)
- JWT 토큰은 `TokenService.js`로만 관리
- 민감 정보(비밀번호, API 키, RTSP URL 자격증명)는 소스코드 하드코딩 금지 → `.env` 사용
- RTSP URL의 자격증명은 로그 출력 금지
- SQL 인젝션 방지: MongoDB 쿼리 파라미터 항상 검증
- 얼굴 데이터는 `AuditService.js`로 모든 접근 기록

---

## MCP 도구 목록

Claude에서 직접 사용 가능한 LTS-2026 MCP 도구:

| 도구 | 설명 |
|------|------|
| `mcp_lts_get_camera_status` | 카메라 연결 상태 조회 |
| `mcp_lts_get_active_alerts` | 활성 알림 목록 조회 |
| `mcp_lts_acknowledge_alert` | 알림 확인 처리 |
| `mcp_lts_get_zone_config` | 구역 설정 조회 |
| `mcp_lts_update_zone_threshold` | 구역 임계값 수정 |
| `mcp_lts_query_loitering_events` | 배회 이벤트 조회 |
| `mcp_lts_get_tracking_history` | 인물 추적 이력 조회 |
| `mcp_lts_get_analytics_summary` | 분석 요약 통계 조회 |
| `mcp_lts_explain_alert` | 알림 상세 설명 생성 |
| `mcp_lts_generate_security_report` | 보안 리포트 생성 |

---

## Skills 참조

복잡한 작업 시 `.claude/skills/` 하위 스킬 파일 자동 로드:

| 스킬 | 용도 |
|------|------|
| `ai-detection-pipeline` | YOLOv8 감지·추적·배회 점수·속성 분석 |
| `camera-stream-setup` | RTSP/ONVIF/YouTube/WebRTC 스트림 설정 |
| `zone-alert-management` | 구역 생성·임계값·알림 에스컬레이션 |
| `cross-camera-face-reid` | 얼굴 등록·Re-ID·개인정보 보호 |
| `react-dashboard-dev` | React UI·Zustand·Tailwind·i18n |
| `api-testing` | Jest 테스트·커버리지·CI 파이프라인 |
| `docker-deploy` | Docker 배포·TLS·MongoDB·헬스체크 |
