# CLAUDE.md — LTS-2026 Loitering Detection & Tracking System

> 이 파일은 Claude AI가 이 프로젝트 작업 시 자동으로 로드하는 프로젝트 컨텍스트 파일입니다.

---

## 프로젝트 개요

**LTS-2026**은 AI 기반 배회(Loitering) 감지 및 추적 시스템입니다.

- **카메라 수집**: IP 카메라(RTSP/ONVIF/WebRTC) + YouTube 스트림 → MediaMTX 프록시
- **AI 파이프라인**: YOLOv8 ONNX 객체 감지 → ByteTrack 다중 추적 → 배회 행동 분석 → 알림 발생
- **크로스 카메라**: 얼굴 임베딩 Re-ID로 카메라 간 동일인 추적
- **서버**: Node.js 18+ (Express + Socket.IO + MediaMTX WHEP WebRTC)
  - `SERVER_MODE=combined` — 캡처+AI+WebRTC+REST 올인원 (기본값)
  - `SERVER_MODE=streaming` — 카메라 캡처·WebRTC, AI는 원격 analysis 서버로 전달
  - `SERVER_MODE=analysis` — AI 추론 전용 (GPU 서버, 카메라 없음)
  - 아키텍처 상세: `docs/design/Design_Server_Architecture.md`
- **클라이언트**: React 18 + TypeScript + Tailwind CSS + Zustand
- **저장소**: JSON 파일 DB (`storage/lts.json`) + 선택적 MongoDB Atlas
- **MCP 서버**: LLM 연동용 별도 프로세스 (`mcp-server/`)

---

## 디렉토리 구조

```
loitering_tracking/
├── server/src/
│   ├── index.js                    # Express 진입점 (SERVER_MODE별 분기)
│   ├── db.js                       # backward-compat shim → require('./db/index')
│   ├── db/                         # 플러그어블 DB 레이어 (v1.7+)
│   │   ├── index.js                # factory + public API (initDB/getDB/getStorageMode)
│   │   ├── BaseDatabase.js         # 추상 인터페이스 (SQLite·Oracle 확장용)
│   │   ├── JsonDatabase.js         # DB_TYPE=json 백엔드 (기본값)
│   │   ├── MongoDatabase.js        # DB_TYPE=mongodb 백엔드
│   │   └── constants.js            # ALL_TABLES, TABLE_ROW_CAPS, LEGACY_MIGRATIONS
│   ├── services/
│   │   ├── detection.js            # YOLOv8 ONNX 추론 (640×640)
│   │   ├── tracking.js             # ByteTrack + KalmanFilter
│   │   ├── behaviorEngine.js       # 배회 위험 점수 산출
│   │   ├── zoneManager.js          # 다각형 구역 관리
│   │   ├── alertService.js         # 알림 생성·에스컬레이션
│   │   ├── pipelineManager.js      # AI 서비스 생명주기 오케스트레이션
│   │   ├── attributePipeline.js    # 의상·색상·PPE 속성 분석
│   │   ├── faceService.js          # 얼굴 인식·임베딩·Re-ID
│   │   ├── captureFactory.js       # CAPTURE_BACKEND별 캡처 인스턴스 팩토리
│   │   ├── ingestDaemonCapture.js  # ingest-daemon 수신 EventEmitter (권장)
│   │   ├── rtspCapture.js          # ffmpeg RTSP 캡처 (레거시)
│   │   ├── gstreamerCapture.js     # GStreamer 캡처 (GPU 하드웨어 가속)
│   │   ├── pyavCapture.js          # Python PyAV 직접 캡처
│   │   ├── mediamtxSnapshotCapture.js # MediaMTX JPEG 스냅샷 캡처
│   │   ├── mediamtxManager.js      # MediaMTX 경로 등록/해제 (WebRTC WHEP)
│   │   ├── analysisClient.js       # streaming→analysis HTTP 클라이언트 (회로차단기)
│   │   ├── fireSmokeService.js     # 화재·연기 감지
│   │   ├── colorClothService.js    # 색상·의류 분석 — cloth-PAR PromptPAR(PA100k, CLIP ViT-L, Download 자동화 `pyExport` — scripts/exportPromptPAR.py)/OpenPAR(ResNet50, manualOnly) admin-selectable, PromptPAR 사전 메모리 게이트(가용 RAM 부족 시 로그+Cloth 분석 자동 비활성화); Phase-3 Human Parsing 포함, opt-in — `humanParsing` 토글
│   │   ├── appearanceReidService.js # CrossCamera Phase-2 Appearance/Body Re-ID OSNet 임베딩 추출 (opt-in, 모델 미배포 시 자동 비활성)
│   │   ├── ageEstimationService.js # 연령 예측 — InsightFace GenderAge(경량)/ViT Age Classifier(정밀, hfOptimumExport) admin-selectable, 얼굴crop 우선·사람crop 폴백 (opt-in, `ageEstimation` 토글, Proposed)
│   │   ├── qdrantService.js        # Qdrant 벡터 DB 클라이언트 — face_embeddings/appearance_embeddings 컬렉션, 서킷브레이커 (opt-in, `QDRANT_ENABLED=true`)
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
│   │   ├── mongoDbService.js       # MongoDB 연결 · 5초 keep-alive 핑 · 재연결 Retry (선형 back-off) · findDirect() 직접 쿼리 (onvif_snapshots 등 비hydration 테이블용)
│   │   ├── analyticsConfig.js      # 분석 설정
│   │   ├── missingPersonService.js # 실종자 등록·검색·감지 매칭·상태 관리
│   │   ├── faceEnrollHelper.js     # 얼굴 등록 사진 detect+embed+썸네일 공용 로직 (로컬/위임 양쪽에서 재사용)
│   │   ├── faceSearchConditions.js # Face Search Condition 요약/목록/reconcile 적용 (analysis 서버, 무상태)
│   │   ├── faceSearchSync.js       # streaming→analysis 갤러리/얼굴 스냅샷 push+5s poll (streaming 서버 전용)
│   │   ├── systemMetrics.js        # CPU·메모리·GPU·디스크 I/O 수집 (admin/system)
│   │   ├── TcRunnerService.js      # TC-ID 단위 테스트 실행기 (admin/tc-results)
│   │   └── channelSlotService.js   # Dashboard Channel Slot 검증·자동배정·시작 시 backfill 마이그레이션 (MAX_CHANNEL_NUM)
│   ├── api/                        # REST 리소스 라우터 (팩토리 함수, db/pipelineManager 주입)
│   │   ├── cameras.js              # /api/cameras — CRUD·probe-channels·stream start/stop/reconnect·ai/toggle
│   │   ├── zones.js                # /api/cameras/:cameraId/zones — 구역 CRUD
│   │   ├── events.js               # /api/events, /api/alerts — buildEventsRouters()
│   │   ├── analytics.js            # /api/analytics/config
│   │   ├── tracker.js              # /api/tracker/config(/reset)
│   │   ├── settings.js             # /api/settings — 범용 key-value 설정 API
│   │   ├── missingPersons.js       # /api/missing-persons — 실종자 등록·검색·감지·통계
│   │   ├── youtubeStreams.js       # /api/youtube-streams — YouTube 가상 카메라 CRUD
│   │   ├── internal.js             # /internal/mediamtx — MediaMTX publish/unpublish 웹훅 (loopback 전용)
│   │   ├── faceGallery.js          # /api/galleries — 갤러리·얼굴 등록(multer+sharp)·크로스카메라 통계
│   │   ├── snapshots.js            # /api/snapshots — 감지 스냅샷 조회/삭제
│   │   ├── search.js               # /api/search — alerts/detections/faces/events/matches 통합 검색
│   │   └── stats.js                # /api/stats(/items,/hourly) — 대시보드 통계
│   ├── routes/
│   │   ├── admin.js                # 관리자 라우터 (/admin — 사용자·시스템·감사로그·TC결과)
│   │   ├── auth.js                 # 인증 라우터 (/auth — 회원가입·로그인·OAuth)
│   │   ├── analysisApi.js          # AI 분석 API (analysis/combined 모드)
│   │   ├── analysisProxy.js        # 분석 API 프록시 (streaming 모드)
│   │   ├── onvifApi.js             # ONVIF 이벤트 REST API (GET/DELETE /api/onvif-events, GET /api/onvif-snapshots)
│   │   ├── internalApi.js          # /api/internal — ingest-daemon 전용 (frame/:cameraId JPEG, apprtp/:cameraId ONVIF 메타데이터)
│   │   └── clientLogs.js           # /api/client-logs(/webrtc) — 브라우저 콘솔 로그·WebRTC 통계 수신
│   ├── socket/
│   │   └── streamHandler.js        # Socket.IO 스트림 이벤트
│   ├── middleware/
│   │   ├── auth.js                 # JWT 인증 미들웨어
│   │   └── role.js                 # 역할 기반 접근 제어
│   ├── scripts/
│   │   ├── ensureMongodb.js        # DB_TYPE=mongodb 시작 시 MongoDB 실행 확인·재시작·설치 가이드
│   │   ├── migrateToMongo.js       # 일회성 JSON → MongoDB 마이그레이션
│   │   └── installDb.js            # MongoDB 컬렉션·인덱스·사용자 생성 스크립트
│   ├── config/                     # 환경별 설정
│   └── utils/
│       ├── logger.js               # 프로덕션 로거 — [YY-MM-DD HH:mm:ss.sss] 타임스탬프, /var/log/lts 파일 저장, makeLineRelay
│       ├── onvifParser.js          # ONVIF Application RTP 메타데이터 XML 파싱 (state-change dedup)
│       ├── channelRtsp.js          # NVR 채널별 RTSP URL 치환 (SUNAPI/ONVIF 경로 규칙)
│       └── kmeansColor.js          # K-Means 대표색 클러스터링 (Human Parsing 마스크 픽셀 대표색 추출용)
├── client/src/
│   ├── App.tsx
│   ├── components/
│   │   ├── CameraGrid.tsx          # 멀티 카메라 그리드 — channelSlot 기준 렌더링 (groupStart 0-based 오프셋, 빈 슬롯 placeholder)
│   │   ├── ChannelSlotPicker.tsx   # Channel Slot 선택 UI (stepper + Group 페이징 브라우저) — Add/Edit 카메라 모달 공용
│   │   ├── CameraView.tsx          # 단일 카메라 WebRTC 뷰
│   │   ├── AlertPanel.tsx          # 실시간 알림 목록
│   │   ├── ZonesPanel.tsx          # 구역 목록 사이드바
│   │   ├── ZoneEditor.tsx          # 구역 다각형 편집기
│   │   ├── FaceGalleryTab.tsx      # 얼굴 갤러리
│   │   ├── SearchFullscreen.tsx    # 전체화면 검색
│   │   ├── StatsPanelModal.tsx     # 통계 모달
│   │   ├── DashboardDetectionPanel.tsx
│   │   ├── AnalysisServerDashboard.tsx # analysis 모드 메인 대시보드
│   │   ├── AnalysisLivePanel.tsx   # 실시간 감지 피드 오버레이 (analysis 모드)
│   │   ├── AnalysisDetectionPanel.tsx  # 이벤트 히스토리 오버레이 (배회/화재/연기)
│   │   ├── FaceSearchConditionPanel.tsx # Face Search Condition 상세·추가 오버레이 (Analysis Server Dashboard 전용)
│   │   ├── AnalysisEventsTab.tsx   # Detections 탭 — 이벤트 히스토리 (analysis 모드)
│   │   ├── OnvifTimelineOverlay.tsx # ONVIF 이벤트 타임라인 오버레이 (줌/팬/상세/Raw XML)
│   │   ├── DetectionsTimelineInline.tsx # 감지 트랙 Gantt 타임라인 (FullscreenCameraView Detections 탭)
│   │   ├── AnalysisHistoryTab.tsx  # 분석 이벤트 이력 탭 (저장된 fire/smoke/loitering)
│   │   ├── ThermalOverlay.tsx      # 열상 카메라 온도 오버레이 (onvif:temperature, FullArea 배너 + 좌표 crosshair, Camera.thermalSensorWidth/Height로 센서 원본 해상도→영상 해상도 좌표 calibration)
│   │   └── AdminLogPanel.tsx       # 실시간 서버 로그 뷰어 (Socket.IO server:log + 파일 폴링, Admin Dashboard 전용)
│   ├── stores/                     # Zustand 상태 스토어
│   ├── hooks/                      # 커스텀 React 훅
│   ├── i18n/                       # 다국어(ko/en) 리소스
│   ├── pages/
│   │   └── admin/
│   │       └── AdminUsersPage.tsx  # Admin Dashboard (Users/ONVIF/Audit 섹션)
│   └── types/                      # TypeScript 타입 정의
├── ingest-daemon/
│   └── ingest_daemon.py            # Python PyAV 독립 캡처 데몬 (:7070)
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

## 수집 레이어 아키텍처 원칙 (Architecture Invariants)

> **이 원칙은 모든 코드·문서 작업 시 최우선으로 준수해야 합니다.**

### ingest-daemon 우선 원칙

| 상황 | 수집 방식 | 비고 |
|---|---|---|
| RTSP/ONVIF IP 카메라 (mediasoup) | **ingest-daemon → 카메라 직접 연결** | FFmpeg subprocess 금지, MediaMTX 경유 없음 |
| WEBRTC_ENGINE=mediamtx | ingest-daemon → MediaMTX RTSP loopback → JPEG+AI | MediaMTX WHEP WebRTC 전용 |
| WEBRTC_ENGINE=mediasoup (현재 기본) | ingest-daemon → 카메라 직접 → JPEG(AI) + H.264 RTP + Opus RTP + App RTP | 단일 RTSP 세션 4-way 팬아웃 |
| YouTube / RTMP / HLS | yt-dlp → ffmpeg → MediaMTX | FFmpeg 허용되는 유일한 구간 |

- `ingest_daemon.py`(Python PyAV)는 RTSP 수집의 유일한 공급자입니다.
- `rtspCapture.js`, `gstreamerCapture.js`, `pyavCapture.js`는 **레거시**입니다 — 신규 카메라에 사용 금지.
- `mediasoupEngine.js`가 WebRTC 비디오·오디오 RTP를 필요로 할 때도 ingest-daemon API(`POST /cameras { mediasoupPort, mediasoupAudioPort }`)를 통해 요청합니다. FFmpeg subprocess를 직접 띄우지 않습니다.
- **mediasoup 모드에서 MediaMTX는 IP 카메라에 사용하지 않습니다.** ingest-daemon이 카메라에 직접 단일 PyAV 세션을 열고 AI/WebRTC/ONVIF를 팬아웃합니다.

---

## 기술 스택 및 코딩 규칙

### 서버 (Node.js)

- **CommonJS 전용** — `require()` / `module.exports` 사용, `import`/`export` 금지
- 비동기는 `async/await` 사용, Promise 체인(`.then()`) 지양
- `server/src/db.js`를 통해서만 `storage/lts.json` 접근 (직접 파일 I/O 금지)
- 환경변수는 **`server/.env` 단일 파일**에서 `dotenv`로 로드 — 모든 서버 모드(combined/streaming/analysis)가 동일 파일 사용
- `server/.env.example`, `server/.env.streaming.example`, `server/.env.analysis.example`은 **참조용 문서**이며 서버가 절대 로드하지 않음
- HTTP 포트 기본값 `3080`; HTTPS 포트 기본값 `3443`
- `SERVER_MODE` = `combined`(기본) | `streaming` | `analysis` — 역할 분리
- `DB_TYPE` = `json`(기본) | `mongodb` — 스토리지 백엔드 선택
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

> 라우터 소스: `server/src/api/*.js` (REST 리소스), `server/src/routes/*.js` (auth/admin/internal/onvif/client-logs).

### 인증 (`/auth`)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/auth/register` | 회원가입 (첫 사용자는 자동 승인·admin, 이후는 status=pending) |
| POST | `/auth/login` | 로그인 (accessToken 응답 + refreshToken 쿠키) |
| POST | `/auth/refresh` | refreshToken 쿠키로 accessToken 재발급 (rotate) |
| POST | `/auth/logout` | 로그아웃 (refreshToken 폐기) |
| GET | `/auth/me` | 내 프로필 조회 |
| PATCH | `/auth/me` | 내 프로필 수정 (body: name?, organization?, phone?, bio?, avatarDataUrl?) |
| GET | `/auth/google`, `/auth/google/callback` | Google OAuth 로그인 |
| GET | `/auth/microsoft`, `/auth/microsoft/callback` | Microsoft MSAL OAuth 로그인 |

### 관리자 (`/admin`, admin 역할 전용)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/admin/users` | 사용자 목록 조회 (query: status, search) |
| GET | `/admin/users/:id` | 사용자 상세 조회 |
| PATCH | `/admin/users/:id` | 사용자 상태 변경 (body: action=approve\|reject\|revoke\|reactivate, role?) |
| DELETE | `/admin/users/:id` | 사용자 삭제 |
| GET | `/admin/system` | CPU·메모리·GPU·디스크 I/O·스토리지·DB 쿼리 통계 |
| GET | `/admin/audit` | 감사 로그 조회 |
| GET | `/admin/tc-results` | 최신 서버 시작 시 TC 테스트 실행 결과 (TC번호·SRS·Pass/Fail) |
| DELETE | `/admin/tc-results` | TC 테스트 결과 전체 삭제 |
| POST | `/admin/tc-results/run` | TC 테스트 수동 재실행 트리거 (body: { port? }) |
| GET | `/admin/logs/recent` | 최근 서버 로그 조회 (query: source=server\|ingest\|mediamtx, limit) |
| PATCH | `/admin/logs/level` | Socket.IO 릴레이 로그 레벨 런타임 변경 (body: { level } — 파일 로깅 불변) |

### 카메라 (`/api/cameras`)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/cameras` | 카메라 목록 조회 (password 제외, pipelineStatus 포함) |
| POST | `/api/cameras` | 카메라 추가 (body: channelSlot — Dashboard Channel Slot 1..MAX_CHANNEL_NUM, 생략 시 최저 빈 슬롯 자동 배정; maxChannel/supportSunapi/nvrProfiles — SUNAPI/ONVIF NVR 채널 정보) |
| POST | `/api/cameras/discover` | ONVIF/UDP 자동 탐색 트리거 (결과는 Socket.IO `discovery:result`) |
| POST | `/api/cameras/probe-channels` | 단일 IP SUNAPI/ONVIF MaxChannel 온디맨드 재탐지 (body: ip, httpPort?, onvifPort?, username?, password?, baseRtspUrl?, cameraId?) |
| GET | `/api/cameras/:id` | 카메라 상세 조회 |
| PUT | `/api/cameras/:id` | 카메라 설정 수정 (body: channelSlot?, channelIndex?, thermalSensorWidth?/thermalSensorHeight? — 열상 센서 네이티브 해상도, 예: 160x120, ThermalOverlay 좌표 calibration용, null이면 미보정) 포함 — 409: 이미 사용 중인 channelSlot; rtspUrl/자격증명/webrtcEnabled 변경 시 파이프라인 자동 재시작) |
| POST | `/api/cameras/:id/stream/reconnect` | 파이프라인 중지 후 재시작 |
| DELETE | `/api/cameras/:id` | 카메라 삭제 (YouTube 카메라는 yt-dlp/ffmpeg 프로세스도 중지) |
| POST | `/api/cameras/:id/ai/toggle` | AI 추론 ON/OFF 토글 (파이프라인 재시작 없이) |
| POST | `/api/cameras/:id/stream/start` | 파이프라인 시작 |
| POST | `/api/cameras/:id/stream/stop` | 파이프라인 중지 |

### 구역 (`/api/cameras/:cameraId/zones`)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/cameras/:cameraId/zones` | 카메라별 구역 목록 조회 |
| POST | `/api/cameras/:cameraId/zones` | 구역 생성 (body: name, polygon(≥3점), type?=MONITOR\|EXCLUDE, dwellThreshold?, minDisplacement?, reentryWindow?, schedule?, targetClasses?) |
| PUT | `/api/cameras/:cameraId/zones/:id` | 구역 수정 |
| DELETE | `/api/cameras/:cameraId/zones/:id` | 구역 삭제 |

### 이벤트 & 알림 (`/api/events`, `/api/alerts`)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/events` | 이벤트 목록 조회 (query: cameraId, from, to, limit) |
| GET | `/api/events/:id` | 이벤트 상세 조회 |
| GET | `/api/events/:id/clip` | 배회 클립 영상 스트리밍 (HTTP Range 지원, video/mp4) |
| GET | `/api/alerts` | 알림 목록 조회 (query: acknowledged, cameraId, limit) |
| POST | `/api/alerts/:id/acknowledge` | 알림 확인 처리 |

### 설정 (분석·추적기·범용 key-value)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET/PUT | `/api/analytics/config` | AI 분석 활성 항목 설정 (human/face 등) — streaming 모드는 analysis 서버로 자동 forward |
| GET/PUT | `/api/tracker/config` | ByteTrack 파라미터 설정 (fastSpeedThreshold, fastQScale 등) |
| POST | `/api/tracker/config/reset` | 추적기 설정 기본값 초기화 |
| GET | `/api/settings` | 전체 설정 조회 (analytics/tracker/language/layout/webrtcConfig 등) |
| GET/PUT/DELETE | `/api/settings/:key` | 개별 설정 키 조회/upsert/삭제 |

### 실종자 수색 (`/api/missing-persons`)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/api/missing-persons` | 실종자 프로필 등록 |
| GET | `/api/missing-persons` | 실종자 검색 (query: q, name, age, gender, status=MISSING(기본), limit) |
| GET | `/api/missing-persons/detections` | 날짜별 매칭 감지 조회 (query: date, missingPersonId, status, cameraId, limit) |
| PUT | `/api/missing-persons/:id/status` | 실종자 상태 변경 (body: status=FOUND\|MISSING\|UNCONFIRMED, notes?) |
| PUT | `/api/missing-persons/detections/:id/status` | 감지 확인 상태 변경 (body: status=PENDING\|CONFIRMED\|FALSE_POSITIVE, confirmedBy?) |
| GET | `/api/missing-persons/stats` | 실종자 등록·감지 통계 |

### YouTube 스트림 (`/api/youtube-streams`)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/api/youtube-streams` | YouTube 스트림 수집 (body: youtubeUrl, name, resolution?, bitrate?, repeatPlayback?, webrtcEnabled?, channelSlot? — 생략 시 최저 빈 슬롯 자동 배정) |
| GET | `/api/youtube-streams` | 활성 스트림 목록 조회 |
| GET | `/api/youtube-streams/:id/status` | 스트림 상태 폴링 (starting 단계 UI용) |
| PATCH | `/api/youtube-streams/:id` | 스트림 설정 수정 (재시작 트리거, body: channelSlot? 포함 — 409: 이미 사용 중인 channelSlot) |
| DELETE | `/api/youtube-streams/:id` | 스트림 중지 및 카메라 레코드 삭제 |
| POST | `/api/youtube-streams/:id/restart` | error 상태 스트림 수동 재시작 |

### 내부 API (localhost 전용)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/internal/mediamtx` | MediaMTX publish/unpublish 웹훅 (loopback 전용, body: { event, path }) |
| POST | `/api/internal/frame/:cameraId` | ingest-daemon → AI JPEG 프레임 콜백 (body: image/jpeg binary, ~10 FPS) |
| POST | `/api/internal/apprtp/:cameraId` | ingest-daemon → ONVIF Application RTP 콜백 (body: { pt, timestamp, seq, payload }) |

### 얼굴 갤러리 (`/api/galleries`)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/galleries` | 갤러리 목록 조회 (faceCount 포함) |
| POST | `/api/galleries` | 갤러리 생성 (body: name, description?, type?=general\|vip\|blocklist\|missing) |
| DELETE | `/api/galleries/:id` | 갤러리 삭제 (소속 얼굴 전체 삭제 포함) |
| GET | `/api/galleries/:id/faces` | 등록 얼굴 목록 조회 (embedding 제외) |
| POST | `/api/galleries/:id/faces` | 얼굴 등록 (multipart: photo — 감지→임베딩 추출→64×64 썸네일 생성) |
| DELETE | `/api/galleries/:id/faces/:faceId` | 얼굴 삭제 (GDPR 삭제권) |
| GET | `/api/galleries/cross-camera-stats` | 크로스카메라 Re-ID 통계 |
| GET | `/api/galleries/trajectories` | 인물 이동 궤적 조회 (query: maxAgeMs) |
| GET | `/api/galleries/match-history` | 얼굴 매칭 이력 조회 (query: limit(기본 50, 최대 200), cameraId?, galleryType?, from?, to? — cameraName 포함) |

### 스냅샷 · 검색 · 통계

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/snapshots` | 감지 스냅샷 목록 조회 (query: cameraId, objectId, className, isLoitering, from, to, q, limit, offset — cropData 제외) |
| GET | `/api/snapshots/:id` | 스냅샷 상세 조회 (cropData 포함) |
| DELETE | `/api/snapshots/:id` | 스냅샷 삭제 |
| GET | `/api/search` | 통합 검색 — alerts/detections/faces/events/matches/appearance(Implemented, opt-in — `QDRANT_ENABLED=true` 필요, 색상 사전필터 스크롤만 지원·임베딩 유사도 재랭킹 없음) (query: q(필수), types?, from?, to?, minConfidence?, maxConfidence?, upperColor?, lowerColor?(FR-CCFR-066 색상 사전필터, ✅ Done), limit?, offset?) |
| GET | `/api/stats` | 시스템 전체 통계 (카메라/구역/이벤트/알림/얼굴 요약) |
| GET | `/api/stats/items` | 특정 타입·날짜·시간대 아이템 목록 (query: type(필수)=detections\|alerts\|matches\|events, date(필수), hour(필수, 0-23)) |
| GET | `/api/stats/hourly` | 일자별 시간대 통계 (query: date, 기본 오늘) |

### AI 분석 (`/api/analysis`, analysis/combined 모드)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/analysis/metrics` | 분석 서버 대시보드 메트릭 |
| GET | `/api/analysis/client-status` | 분석 클라이언트 상태 (streaming 모드 전용 — 회로차단기 상태·통계) |
| GET | `/api/analysis/config/fire-smoke` | 화재/연기 감지 임계값 조회 |
| PATCH | `/api/analysis/config/fire-smoke` | 화재/연기 감지 임계값 런타임 변경 |
| GET | `/api/analysis/events` | 분석 이벤트 조회 (query: limit, type, cameraId, from, to — max 500) |
| DELETE | `/api/analysis/events` | 분석 이벤트 전체 삭제 |
| GET | `/api/analysis/detection-tracks` | 감지 트랙 이력 조회 (query: cameraId, from, to, class, limit — dwell≥1s 저장, inProgress 플래그) |
| DELETE | `/api/analysis/detection-tracks` | 감지 트랙 이력 전체 삭제 |
| GET | `/api/analysis/detection-snapshots` | bbox crop 이미지 조회 (query: objectId(필수), cameraId, from, to, limit — cropData base64 JPEG) |
| GET | `/api/analysis/face-trajectories` | 크로스카메라 얼굴 궤적 DB 조회 (query: faceId, alias, cameraId, from, to, limit — max 500) |
| DELETE | `/api/analysis/face-trajectories` | 얼굴 궤적 이력 전체 삭제 |
| GET | `/api/analysis/models` | AI 모델 카탈로그 조회 — YOLO 탐지기 + face/PPE/fire-smoke/cloth-PAR/Human Parsing(Proposed)/Appearance Re-ID(Proposed)/Age Estimation(Proposed) 전체 family 통합, 다운로드 상태·활성 모델 포함 |
| POST | `/api/analysis/models/switch` | family별 활성 모델 런타임 전환 (body: modelId — YOLO 탐지기 외 face-detection/face-recognition/ppe/fire-smoke/cloth-par/human-parsing/appearance-reid/age-estimation 지원) |
| POST | `/api/analysis/models/download` | 모델 다운로드/변환 시작 (body: modelId — HuggingFace `.pt`→ONNX 자동 변환(ultralytics export) 포함, non-YOLO HuggingFace 모델(ViT 등)은 `hfOptimumExport`로 `optimum` 기반 변환; `manualOnly` 모델은 409 반환) |
| POST | `/api/analysis/face-embed` | 얼굴 등록 사진 detect+embed 위임 수신 (streaming 모드가 로컬 얼굴 모델 없을 때 호출, raw JPEG → bbox/score/embedding/thumbnail) |
| POST | `/api/analysis/face-search-conditions/sync` | streaming 서버의 `faceGalleries`/`faceGalleryFaces` 전체 스냅샷 반영 (embedding 제외, `source:'synced'` 태그로 upsert/delete) |
| GET | `/api/analysis/face-search-conditions` | 활성 Face Search Condition 상세 조회 (Analysis Server Dashboard 드릴다운용) — `total`/`byType`는 `/api/analysis/metrics`의 `faceSearch` 필드에도 포함 |

### ONVIF 이벤트 & 로그 & 헬스체크

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/health` | 서버 상태 확인 (maxChannelNum — 현재 유효 MAX_CHANNEL_NUM 포함) |
| GET | `/api/client-logs` | 브라우저 콘솔 로그 조회 (query: level, sessionId, from, to, limit) |
| POST | `/api/client-logs` | 브라우저 콘솔 로그 수신 (HTTP 직접 전송 경로) |
| DELETE | `/api/client-logs` | 콘솔 로그 전체 삭제 |
| GET | `/api/client-logs/webrtc` | WebRTC PeerConnection 통계 조회 (query: cameraId, pcId, sessionId) |
| DELETE | `/api/client-logs/webrtc` | WebRTC 통계 전체 삭제 |
| GET | `/api/onvif-events` | ONVIF 이벤트 조회 (query: cameraId, type, severity, from, to, limit) |
| DELETE | `/api/onvif-events` | ONVIF 이벤트 삭제 (query: cameraId — 생략 시 전체 삭제) |
| GET | `/api/onvif-event-types` | ONVIF 이벤트 타입 레지스트리 전체 조회 (ever-seen topicTypes) |
| DELETE | `/api/onvif-event-types` | ONVIF 이벤트 타입 레지스트리 초기화 (Admin 페이지용) |
| GET | `/api/onvif-snapshots` | ONVIF 이벤트 시작 시점 프레임 조회 (query: eventId, cameraId, topicType, from, to, limit — frameData=base64 JPEG) |

---

## Socket.IO 이벤트

> 소스: `server/src/services/pipelineManager.js` (송신 대부분), `server/src/socket/streamHandler.js` (구독·발견 이벤트 수신), `client/src/App.tsx`/`hooks/`.

| 이벤트 | 방향 | 설명 |
|--------|------|------|
| `frame` | Server → Client | 카메라별 어노테이션 JPEG 프레임 (`io.to(cameraId).volatile.emit`) |
| `detections` | Server → Client | 프레임별 감지 박스 배열 (카메라 room 대상) |
| `loitering` | Server → Client | 배회 이벤트 발생 (카메라 room 대상) |
| `alert:new` | Server → Client | 신규 알림 발생 (전체 브로드캐스트) |
| `snapshot:new` | Server → Client | 신규 감지 스냅샷 생성 (카메라 room 대상) |
| `fire:alert` | Server → Client | 화재/연기 감지 알림 (카메라 room 대상) |
| `face_match` | Server → Client | 얼굴 갤러리 매칭 이벤트 (전체 브로드캐스트) |
| `missing_person_match` | Server → Client | 실종자 갤러리 매칭 시 `face_match`와 별도로 추가 브로드캐스트 |
| `face:reidentified` | Server → Client | 얼굴 Re-ID 크로스카메라 전환 감지 |
| `clothing:reidentified` | Server → Client | 의상 Appearance Re-ID 크로스카메라 전환 감지 |
| `person:trajectory-update` | Server → Client | 인물 이동 궤적(segments) 갱신 — 크로스카메라 얼굴/의상 추적 패널용 |
| `camera:status` | Server → Client | 카메라 연결 상태 변경 |
| `camera:error` | Server → Client | 카메라 파이프라인 오류 (카메라 room 대상) |
| `camera:stats` | Server → Client | 카메라 파이프라인 통계 (카메라 room 대상) |
| `camera:stream-unavailable` | Server → Client | 스트림 소스 unreachable (카메라 room 대상) |
| `camera:subscribe` / `camera:unsubscribe` | Client → Server | 카메라 스트림 구독/구독 해제 (body: `{ cameraId }`, ref-count 기반) |
| `camera:capabilities` | Server → Client | 카메라 WebRTC 지원 여부 오버라이드 (mediasoup 모드) — 클라이언트 리스너만 존재, 현재 서버 emit 코드 없음(사문화됨, 확인 필요) |
| `appRtp` | Server → Client | RTSP Application RTP 패킷 (ONVIF 메타데이터 등) |
| `discovery:trigger` / `discovery:start` / `discovery:rescan` / `discovery:stop` | Client → Server | ONVIF/UDP 자동 탐색 시작·재스캔·중지 요청 |
| `discovery:started` / `discovery:scanning` / `discovery:result` / `discovery:done` / `discovery:error` / `discovery:stopped` / `discovery:cleared` / `discovery:disabled` | Server → Client | 자동 탐색 진행 상태·결과 브로드캐스트 |
| `client:log` | Client → Server | 브라우저 콘솔 로그 배치 (clientLogger 백채널) |
| `client:webrtc-stats` | Client → Server | WebRTC PeerConnection getStats() 폴링 결과 |
| `onvif:event` | Server → Client | ONVIF 상태 변화 이벤트 (DB 저장 후 브로드캐스트) |
| `onvif:type-registered` | Server → Client | 신규 ONVIF topicType 최초 감지 시 브로드캐스트 (타입 레지스트리 실시간 동기화) |
| `onvif:temperature` | Server → Client | 열상 카메라 BoxTemperatureReading 실시간 스트림 (DB 미저장, ThermalOverlay 전용) |
| `server:log` | Server → Client | 실시간 서버 로그 항목 — `{ ts, level, msg, t }` (Admin Log Viewer, 브로드캐스트) |
| `admin:subscribe-logs` | Client → Server | Admin Log Viewer 구독 요청 — 서버가 최근 500개 버퍼 엔트리를 즉시 flush |

---

## 개발 명령어

```bash
# ── 서버 모드별 개발 명령어 ─────────────────────────────────────────────────
# 모든 서버 모드는 server/.env 파일 하나만 참조합니다.
# .env.example / .env.streaming.example / .env.analysis.example 은 참조용 문서이며 서버가 로드하지 않습니다.
cd server

npm run dev              # combined 모드 (캡처+AI+WebRTC)
npm run dev:streaming    # streaming 모드 (캡처 전용)
npm run dev:analysis     # analysis 모드  (AI 전용)

# 프로덕션 시작/중지
npm run start            # combined
npm run streaming        # streaming
npm run analysis         # analysis
npm run stop             # combined 중지
npm run stop:streaming   # streaming 중지
npm run stop:analysis    # analysis 중지

# ── 클라이언트 ──────────────────────────────────────────────────────────────
cd client && npm run dev          # Vite HMR 개발 서버
npm run build                     # 루트 workspace에서 프로덕션 빌드
cd client && npm run build        # 또는 client 경로에서 직접

# ── 테스트 ──────────────────────────────────────────────────────────────────
cd server && npm test
node test/run_all.js

# ── Docker 전체 스택 ─────────────────────────────────────────────────────────
docker compose up -d
docker compose logs -f server
docker compose build server && docker compose up -d server

# qdrant 서비스는 docker-compose.yml에 기본 포함되어 위 명령으로 함께 기동되지만,
# server/.env의 QDRANT_ENABLED=true 없이는 서버가 연결하지 않음 (opt-in, 미사용 시 무해)
docker compose up -d qdrant     # qdrant만 개별 기동 (AI-05 Phase-3 / CrossCamera Phase-2)

# ── GPU / ONNX Runtime / 진단 스크립트 ──────────────────────────────────────
cd server
npm run check:gpu             # CUDA/GPU 사용 가능 여부 점검
npm run download-models       # YOLOv8 ONNX 모델 다운로드 (linux/windows 변형 스크립트 포함)
npm run build-ort:auto        # onnxruntime CUDA 소스 빌드 자동화 (build-ort:auto:dry — dry-run)
npm run discover               # 카메라 ONVIF/UDP 탐색 CLI (discoverCameras.js)
npm run health                 # /health 헬스체크 CLI (healthCheck.js)
npm run ice-test                # WebRTC ICE 연결 테스트 (ice-test:headless — 헤드리스)
npm run turn-test               # TURN 서버 연결 테스트 (turn-test:headless — 헤드리스)
npm run setup-env:linux         # 초기 환경 설정 스크립트 (setup-env:windows — PowerShell 버전)
npm run check-capture-backend:linux  # CAPTURE_BACKEND 사전 점검 (check-capture-backend:windows)

# ── MongoDB 원격 서버 초기 설정 ──────────────────────────────────────────────
cd server && npm run install_db
# 비대화형 모드:
node src/scripts/installDb.js --host HOST --port 27017 \
  --admin-user admin --admin-pwd secret \
  --db lts --db-user ltsuser --db-pwd ltspwd

# ── Ingest Daemon (CAPTURE_BACKEND=ingest-daemon) ──────────────────────────
cd server
npm run ingest:start     # ingest-daemon 시작 (이미 실행 중이면 no-op)
npm run ingest:stop      # ingest-daemon 종료
npm run ingest:restart   # ingest-daemon 재시작 (종료 후 시작 + 카메라 재등록)

# ── 로그 설정 (프로덕션, npm run start 계열) ─────────────────────────────────
# 1회성: /var/log/lts 디렉토리 권한 설정 (root 필요)
sudo mkdir -p /var/log/lts && sudo chown $USER:$USER /var/log/lts

# 로그 실시간 확인 / 레벨별 필터
tail -f /var/log/lts/lts-$(date +%Y-%m-%d).log
grep '\[ERROR\]' /var/log/lts/lts-$(date +%Y-%m-%d).log

# server/.env 로그 설정 키 (docs/ops/Logging_Guide.md 참조)
#   LOG_TO_FILE=true            파일 저장 활성화 (기본 true)
#   LOG_DIR=/var/log/lts        저장 경로 (권한 없을 시 server/logs/ 자동 폴백)
#   LOG_LEVEL=INFO              최소 레벨: DEBUG|INFO|WARNING|ERROR|CRITICAL|NONE
#   LOG_FILTER_PATTERNS=<csv>   추가 억제 정규식 (쉼표 구분)

# ── MCP 서버 ─────────────────────────────────────────────────────────────────
cd mcp-server && npm start           # stdio 모드 (Claude Code 연동)
cd mcp-server && npm run start:http  # HTTP+SSE 모드 (원격 LLM 연동)

# server npm 스크립트로 HTTP 모드 MCP 서버 관리 (server/.env의 MCP_PORT 사용, 기본 3002)
cd server
npm run mcp:start    # MCP HTTP 서버 백그라운드 시작 (TRANSPORT=http)
npm run mcp:stop     # MCP HTTP 서버 종료
npm run mcp:restart  # MCP HTTP 서버 재시작

# 루트 workspace npm 스크립트 (cd 없이 사용 가능)
npm run mcp:start    # → server/npm run mcp:start
npm run mcp:stop     # → server/npm run mcp:stop
npm run mcp:restart  # → server/npm run mcp:restart

# ── TC 테스트 / 리포트 (서버 실행 중 필요) ───────────────────────────────────
# Admin Dashboard → Audit 와 동일한 TC-ID 단위 테스트 실행
# (LTS 서버가 먼저 실행 중이어야 합니다)
npm run test:tc                    # TC-ID 단위 전체 실행 + JSON/MD 리포트 생성
npm run test:tc -- --skip youtube  # 특정 스위트 제외
npm run test:tc -- --only face     # 특정 스위트만 실행
npm run test:all                   # 스위트 단위 전체 실행 (e2e 제외)
npm run test:report                # 스위트 단위 + MD/JSON 리포트 생성 (e2e 제외)

# 위 스크립트는 server/ 에서도 동일하게 사용 가능
cd server
npm run test:tc
npm run test:all
npm run test:report

# TC 리포트 출력 경로
# test/reports/tc-results-<runId>.json   — TC-ID 단위 JSON 결과
# test/reports/tc-report-<runId>.md      — Admin Dashboard 스타일 MD 리포트
# test/reports/ci-report.json            — generate_report.js 실행 결과 JSON
# test/reports/ci-report.md              — generate_report.js 실행 결과 MD
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

Claude에서 직접 사용 가능한 LTS-2026 MCP 도구 (v1.3 — 35종, 소스: `mcp-server/create-server.js`):

### 시스템
| 도구 | 설명 |
|------|------|
| `mcp_lts_get_server_status` | 서버 health, mode, uptime, DB 타입, 카메라 수 조회 |

### 배회 & 추적
| 도구 | 설명 |
|------|------|
| `mcp_lts_query_loitering_events` | 배회 이벤트 조회 |
| `mcp_lts_get_tracking_history` | 인물 추적 이력 조회 |
| `mcp_lts_query_face_trajectories` | 크로스카메라 얼굴 궤적 DB 조회 (faceId/alias/cameraId/from/to 필터) |

### 알림
| 도구 | 설명 |
|------|------|
| `mcp_lts_get_active_alerts` | 활성 알림 목록 조회 |
| `mcp_lts_acknowledge_alert` | 알림 확인 처리 |
| `mcp_lts_explain_alert` | 알림 상세 설명 생성 |

### 카메라 & 구역
| 도구 | 설명 |
|------|------|
| `mcp_lts_get_camera_status` | 카메라 연결 상태 조회 |
| `mcp_lts_get_zone_config` | 구역 설정 조회 |
| `mcp_lts_add_camera` | 신규 카메라 채널 등록 |
| `mcp_lts_update_camera` | 카메라 설정 업데이트 |
| `mcp_lts_delete_camera` | 카메라 채널 삭제 (비가역) |
| `mcp_lts_toggle_camera_ai` | AI 추론 ON/OFF 토글 |
| `mcp_lts_update_zone_threshold` | 구역 임계값 수정 |

### ONVIF 이벤트
| 도구 | 설명 |
|------|------|
| `mcp_lts_query_onvif_events` | ONVIF 이벤트 조회 (화재/움직임/라인크로싱 등) |
| `mcp_lts_get_onvif_event_types` | 시스템 ever-seen ONVIF topicType 레지스트리 조회 |
| `mcp_lts_get_onvif_snapshot` | ONVIF 이벤트 발생 시점 카메라 프레임(JPEG) 조회 |

### AI 감지 분석
| 도구 | 설명 |
|------|------|
| `mcp_lts_query_analysis_events` | AI 감지 이벤트 조회 (배회/화재/연기) |
| `mcp_lts_get_detection_tracks` | 객체 감지 트랙 이력 조회 |
| `mcp_lts_get_analysis_metrics` | AI 파이프라인 메트릭 (FPS/GPU/모델) |

### 분석 & 리포트
| 도구 | 설명 |
|------|------|
| `mcp_lts_get_analytics_summary` | 분석 요약 통계 조회 |
| `mcp_lts_generate_security_report` | 보안 리포트 생성 |
| `mcp_lts_get_stats_dashboard` | 시스템 전체 통계 대시보드 |
| `mcp_lts_get_object_snapshots` | 추적 객체 JPEG 스냅샷 |
| `mcp_lts_search_person` | 실종자 검색 (배회 이벤트 + 추적 이력 + 스냅샷) |

### 실종자 관리 (Missing Person Registry)
| 도구 | 설명 |
|------|------|
| `mcp_lts_register_missing_person` | 실종자 프로필 등록 (연락처·임베딩 포함) |
| `mcp_lts_search_missing_person` | 실종자 등록부 검색 (필터·자유 텍스트) |
| `mcp_lts_get_missing_person_detections` | 날짜·상태별 실종자 매칭 감지 조회 |
| `mcp_lts_update_missing_person_status` | 실종자 상태 변경 (FOUND/MISSING/UNCONFIRMED) |
| `mcp_lts_get_missing_person_statistics` | 실종자 등록부·감지 통계 조회 |

### AI / 검색 / 얼굴 갤러리 설정
| 도구 | 설명 |
|------|------|
| `mcp_lts_get_model_catalog` | 전체 AI 모델 카탈로그 조회 — YOLO 탐지기(26/12/11/v8) + 얼굴 감지·인식·PPE·화재연기·의상PAR·(제안)Human Parsing·Appearance Re-ID·Age Estimation (벤치마크·다운로드 상태·family별 활성 모델, combined/analysis 모드 전용) |
| `mcp_lts_get_fire_smoke_config` | 화재/연기 감지 confidence·NMS 임계값 조회 (combined/analysis 모드 전용) |
| `mcp_lts_get_tracker_config` | ByteTrack/Kalman 추적기 파라미터 조회 |
| `mcp_lts_search_all` | alerts/detections/faces/events/matches 통합 전문 검색 |
| `mcp_lts_list_face_galleries` | 얼굴 갤러리(general/vip/blocklist/missing) 목록·등록 얼굴 수 조회 |

> admin 전용 REST(`/admin/audit`, `/admin/tc-results`, `/admin/users`)는 MCP 도구로 노출하지 않음 — `LTSClient`가 Authorization 헤더를 보내지 않아 401/403 발생. 서비스 계정 인증 추가 전까지 범위 제외 (`docs/mrd/MRD_LLM_MCP_Tool_Expansion.md` §7).

---

## 메모리 참조

작업 시작 시 [`​.claude/memory/MEMORY.md`](../.claude/memory/MEMORY.md)를 확인하십시오. 과거 실제 버그·인시던트에서 얻은 재발 방지 규칙(예: history 스토어 시간 기반 만료 금지, 비동기 버튼 3-way 상태 관리 등)이 정리되어 있으며, 이 저장소를 어떤 환경에서 열더라도 동일하게 적용되어야 합니다.

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
| `llm-mcp-integration` | MCP 도구 개발·등록·테스트·서버 관리 |

**서버 아키텍처 참조 문서:** `docs/design/Design_Server_Architecture.md`
- combined / streaming / analysis 모드 설명
- DB 서버 (JSON / MongoDB) 구성
- MCP 서버 연동 방법
- 5가지 배포 시나리오 및 Mermaid 다이어그램

---

## SDLC 문서-코드 동기화 규칙

> **이 규칙은 Claude가 이 프로젝트에서 작업할 때 반드시 준수해야 합니다.**

### 코드 → 문서 방향 (코드 변경 시)

코드(`server/src/`, `client/src/`)를 수정하면 **같은 PR/커밋 내**에 관련 문서도 업데이트해야 합니다:

| 코드 변경 유형 | 업데이트 대상 문서 |
|---|---|
| 새 API 엔드포인트 추가/삭제 | `CLAUDE.md` API 표, 관련 `docs/design/`, `docs/srs/` |
| Socket.IO 이벤트 추가/변경 | `CLAUDE.md` 이벤트 표, `docs/design/` |
| 서비스 파일 추가/제거 (`services/*.js`) | `CLAUDE.md` 디렉토리 구조, `pipelineManager.js`에 등록 |
| DB 스키마/컬렉션 변경 (`db.js`) | `docs/design/Design_DB_Layer.md`, `docs/ops/MongoDB_Setup.md` |
| 환경변수 추가/변경 | `docs/ops/` 관련 설정 가이드, `docker-deploy/SKILL.md` `.env` 예시 |
| npm 스크립트 추가 (`package.json`) | `CLAUDE.md` 개발 명령어, `.github/copilot-instructions.md` |
| 새 AI 서비스 추가 | `ai-detection-pipeline/SKILL.md`, `docs/design/` |
| 인증/보안 로직 변경 | `docs/srs/SRS_User_Authentication.md`, 보안 규칙 섹션 |
| Docker/배포 설정 변경 | `docker-deploy/SKILL.md`, `docs/ops/` |
| `SERVER_MODE` 동작 변경 | `docs/design/Design_Server_Architecture.md`, `CLAUDE.md` 개발 명령어 |
| MediaMTX 설정 변경 (`mediamtx.yml`) | `docs/design/Design_Server_Architecture.md` 포트 요약 |
| MCP 도구 추가/삭제 | `CLAUDE.md` MCP 도구 목록, `docs/design/Design_LLM_MCP_Server.md` |
| TC 스위트 레지스트리 변경 (SUITES 추가/삭제/플래그 변경) | `test/tc_runner_cli.js`와 `server/src/services/TcRunnerService.js` **동시** 수정, `docs/design/Design_TC_Mode_Execution_Policy.md` §5 분류표 업데이트, `api-testing/SKILL.md` (.claude + .github 양쪽) 업데이트 |

### 문서 → 코드 방향 (문서/스킬 변경 시)

`docs/` 또는 `.claude/skills/`, `.github/skills/` 파일이 변경되면:

- **설계 문서(`docs/design/`)** 변경 → 해당 서비스 코드에 설계 반영 여부 확인
- **SRS(`docs/srs/`)** 요구사항 변경 → 구현 코드와 일치하는지 검증
- **스킬 파일 업데이트** → `.claude/skills/`와 `.github/skills/`는 항상 동일 내용으로 동기화

### 양방향 동기화 원칙

1. `.claude/skills/`와 `.github/skills/`는 **항상 동일**해야 합니다 — 한쪽 수정 시 반대쪽도 동시 수정
2. `CLAUDE.md`와 `.github/copilot-instructions.md`의 API 표·이벤트 표·명령어는 **코드 실제 상태와 항상 일치**
3. `docs/ops/MongoDB_Setup.md`와 `docker-deploy/SKILL.md`의 MongoDB 섹션은 `server/src/db.js`, `installDb.js`와 동기화
4. `test/tc_runner_cli.js`와 `server/src/services/TcRunnerService.js`의 `SUITES` 배열은 **항상 동일** — TC 실행 정책 변경 시 `docs/design/Design_TC_Mode_Execution_Policy.md`와 `api-testing/SKILL.md`도 동시 업데이트

### 문서 개정 이력 (Revision History) 규칙

> **모든 `docs/` 하위 문서를 생성하거나 수정할 때 반드시 이 규칙을 따릅니다.**

#### 표 형식

모든 `docs/design/`, `docs/srs/`, `docs/prd/`, `docs/ops/` 문서 **맨 아래**에 다음 표를 유지합니다:

```markdown
---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | YYYY-MM-DD | 초기 작성 |
```

#### 적용 규칙

| 상황 | 조치 |
|---|---|
| 문서 최초 생성 | `v1.0` 행 추가, 날짜 = 작성일 |
| 문서 내용 일부 수정 | 마이너 버전 +0.1 행 추가 (예: 1.0 → 1.1) |
| 구조적 대규모 개편 | 메이저 버전 +1.0 행 추가 (예: 1.x → 2.0) |
| 오타·서식 교정만 | 이력 추가 불필요 |

- 헤더의 `**Version**` 필드 값과 이력 표의 **최신 버전은 항상 일치**해야 합니다
- 변경 내용은 1~2줄 요약 (예: `ONNX 모델 섹션 추가`, `reconnected 로그 스팸 수정 반영`)
- 날짜는 `YYYY-MM-DD` 형식 사용
