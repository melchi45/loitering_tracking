# GitHub Copilot Instructions — LTS-2026

## 프로젝트 개요

**LTS-2026**은 AI 기반 배회(Loitering) 감지 및 추적 시스템입니다.

- IP 카메라(RTSP/ONVIF/WebRTC)에서 영상을 수집하고 YOLOv8 ONNX 모델로 실시간 객체 감지
- ByteTrack MOT으로 다중 객체 추적, 배회 행동 분석 후 경보 발생
- **서버**: Node.js 18+ (Express + Socket.IO + mediasoup)
- **클라이언트**: React 18 + TypeScript + Tailwind CSS + Zustand
- **저장소**: JSON 파일 DB (`storage/lts.json`) + 선택적 MongoDB Atlas
- **MCP 서버**: LLM 연동용 별도 프로세스 (`mcp-server/`)

---

## 디렉토리 구조

```
loitering_tracking/
├── server/src/            # Node.js 백엔드
│   ├── index.js           # Express 앱 진입점 (기본 HTTP 포트 3080)
│   ├── db.js              # JSON 파일 DB 추상화 레이어
│   ├── services/          # 핵심 비즈니스 로직
│   │   ├── detection.js        # YOLOv8n ONNX 추론 (640×640)
│   │   ├── tracking.js         # ByteTracker + KalmanFilter
│   │   ├── behaviorEngine.js   # 배회 점수 산출
│   │   ├── zoneManager.js      # 다각형 구역 관리
│   │   ├── alertService.js     # 경보 생성 및 중복 제거
│   │   ├── pipelineManager.js  # AI 파이프라인 오케스트레이션
│   │   ├── attributePipeline.js # 얼굴/PPE/색상/의류 분석
│   │   ├── faceService.js      # 얼굴 인식 및 Re-ID
│   │   ├── rtspCapture.js      # RTSP 스트림 캡처 (10 FPS)
│   │   ├── webrtcGateway.js    # WebRTC 미디어 게이트웨이
│   │   └── fireSmokeService.js # 화재/연기 감지
│   ├── api/               # Express API 라우터
│   ├── routes/            # 인증/관리자 라우터
│   ├── socket/            # Socket.IO 이벤트 핸들러
│   └── middleware/        # 인증, 에러 핸들링
├── client/src/            # React 프론트엔드
│   ├── App.tsx
│   ├── components/        # UI 컴포넌트
│   │   ├── CameraGrid.tsx      # 멀티 카메라 그리드 뷰
│   │   ├── AlertPanel.tsx      # 경보 목록 패널
│   │   ├── ZoneEditor.tsx      # 구역 다각형 편집기
│   │   ├── ZonesPanel.tsx      # 구역 목록 사이드바
│   │   └── CameraView.tsx      # 단일 카메라 뷰
│   ├── stores/            # Zustand 상태 관리
│   ├── hooks/             # 커스텀 React 훅
│   ├── i18n/              # 다국어(ko/en) 리소스
│   └── types/             # TypeScript 타입 정의
├── mcp-server/            # LLM MCP 통합 서버
├── test/                  # Jest 테스트 (api/ integration/ e2e/)
├── docs/                  # 설계 문서 (design/ srs/ prd/ rfp/)
└── storage/               # JSON 파일 DB
```

---

## 기술 스택 및 코딩 규칙

### 서버 (Node.js)

- **ES Modules 비사용** — `require()` / `module.exports` CommonJS 사용
- 비동기 코드는 `async/await` 사용, Promise 체인 지양
- `server/src/db.js`를 통해서만 `storage/lts.json` 접근 (직접 파일 I/O 금지)
- 환경 변수는 `server/.env`에서 로드 (`dotenv`)
- 포트 3080 기본값; `process.env.HTTP_PORT`로 재정의 가능
- Socket.IO 이벤트 이름은 `camelCase` 사용 (예: `frameData`, `newAlert`)

### 클라이언트 (React/TypeScript)

- **Zustand** 스토어에서 전역 상태 관리 (`client/src/stores/`)
- 컴포넌트는 함수형 + 훅 방식, 클래스 컴포넌트 사용 금지
- Tailwind CSS 유틸리티 클래스 사용; 인라인 스타일 최소화
- 모든 신규 컴포넌트는 `.tsx` 확장자, 타입 정의 필수
- i18n 텍스트는 `useTranslation()` 훅으로 처리 (`client/src/i18n/`)
- Socket.IO 이벤트 수신은 커스텀 훅(`hooks/useSocket.ts` 등)으로 캡슐화

### AI 파이프라인

- YOLOv8 모델 파일: `yolov8s.pt` (루트), ONNX 변환 후 서버에서 사용
- 감지 임계값은 `server/src/services/detection.js` 상단 상수로 관리
- 배회 점수(riskScore) 계산 로직: `behaviorEngine.js`
- 트래커 파라미터(IoU 임계값, 최대 유실 프레임 등): `trackerConfig.js`
- 새 AI 서비스 추가 시 반드시 `pipelineManager.js`에 등록

---

## 중요 API 엔드포인트

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/cameras` | 카메라 목록 조회 |
| POST | `/api/cameras` | 카메라 추가 |
| POST | `/api/cameras/discover` | 카메라 탐색 트리거 |
| GET | `/api/alerts` | 경보 목록 조회 |
| POST | `/api/alerts/:id/acknowledge` | 경보 확인 처리 |
| GET | `/api/cameras/:cameraId/zones` | 카메라별 구역 목록 조회 |
| POST | `/api/cameras/:cameraId/zones` | 카메라별 구역 생성 |
| GET | `/api/events` | 이벤트 목록 조회 |
| GET | `/api/stats` | 시스템 통계 조회 |
| GET | `/api/search` | 전역 검색 |
| GET | `/api/analysis/metrics` | 분석 서버 대시보드용 트래픽/모듈/결과 메트릭 조회 |
| GET | `/api/analysis/config/fire-smoke` | 화재/연기 감지 임계값 조회 |
| PATCH | `/api/analysis/config/fire-smoke` | 화재/연기 감지 임계값 런타임 변경 |

---

## Socket.IO 이벤트

| 이벤트 | 방향 | 설명 |
|--------|------|------|
| `frame` | Server → Client | 카메라 룸 대상 프레임 전송 |
| `alert:new` | Server → Client | 신규 경보 발생 |
| `person:trajectory-update` | Server → Client | 인물 궤적 업데이트 |
| `camera:status` | Server → Client | 카메라 상태 변경 |
| `camera:subscribe` | Client → Server | 카메라 룸 구독 |

---

## 개발 명령어

```bash
# 서버 개발 모드 (nodemon)
cd server && npm run dev

# 클라이언트 개발 서버
cd client && npm run dev

# 클라이언트 프로덕션 빌드 (루트에서 실행 가능)
npm run build          # 루트 workspace에서
cd client && npm run build  # 또는 client 경로에서 직접

# 전체 테스트 실행
cd server && npm test

# Docker로 전체 스택 실행
docker compose up -d

# MongoDB 원격 서버 초기 설정 (컬렉션·인덱스·.env 자동 구성)
cd server && npm run install_db
# 비대화형 모드:
node src/scripts/installDb.js --host HOST --port 27017 \
  --admin-user admin --admin-pwd secret \
  --db lts --db-user ltsuser --db-pwd ltspwd
```

---

## 스킬 파일 참조

복잡한 작업은 `.github/skills/` 아래의 스킬 파일을 참고합니다:

- `ai-detection-pipeline/SKILL.md` — YOLOv8 감지, 행동 엔진, 속성 파이프라인
- `camera-stream-setup/SKILL.md` — RTSP/ONVIF/WebRTC 스트림 설정
- `zone-alert-management/SKILL.md` — 구역 및 경보 관리
- `react-dashboard-dev/SKILL.md` — React UI 개발
- `cross-camera-face-reid/SKILL.md` — 얼굴 인식 및 Re-ID
- `docker-deploy/SKILL.md` — Docker 배포 및 MongoDB 원격 설정
- `api-testing/SKILL.md` — 테스트 작성 및 실행

---

## SDLC 문서-코드 동기화 규칙

> **Copilot이 이 프로젝트에서 코드 또는 문서를 수정할 때 반드시 준수해야 합니다.**

### 코드 → 문서 방향 (코드 변경 시)

| 코드 변경 유형 | 업데이트 대상 문서 |
|---|---|
| 새 API 엔드포인트 추가/삭제 | `copilot-instructions.md` API 표, `docs/design/`, `docs/srs/` |
| Socket.IO 이벤트 추가/변경 | `copilot-instructions.md` 이벤트 표, `docs/design/` |
| 서비스 파일 추가/제거 | `copilot-instructions.md` 디렉토리 구조, `pipelineManager.js` 등록 |
| DB 스키마/컬렉션 변경 | `docs/design/Design_Storage_MongoDB.md`, `docs/ops/MongoDB_Setup.md` |
| 환경변수 추가/변경 | 관련 `docs/ops/` 가이드, `docker-deploy/SKILL.md` `.env` 예시 |
| npm 스크립트 추가 | `copilot-instructions.md` 개발 명령어 섹션 |
| Docker/배포 설정 변경 | `docker-deploy/SKILL.md`, `docs/ops/` |

### 문서/스킬 → 코드 방향

- **설계 문서(`docs/design/`)** 변경 → 해당 서비스 코드에 설계 반영 여부 확인
- **스킬 파일 업데이트** → `.github/skills/`와 `.claude/skills/`는 항상 동일 내용으로 동기화
- `CLAUDE.md`와 `copilot-instructions.md`의 API 표·이벤트 표·명령어는 코드 실제 상태와 항상 일치

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

---

## 보안 지침

- 입력 검증은 모든 API 엔드포인트 진입점에서 수행
- JWT 토큰은 `TokenService.js`로 관리
- 민감 정보(비밀번호, API 키)는 절대 소스 코드에 하드코딩 금지 → `.env` 사용
- RTSP URL에 포함된 자격증명은 로그에 출력 금지
- OWASP Top 10 기준 준수
