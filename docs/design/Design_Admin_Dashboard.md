# Design: Admin Dashboard

**Version:** 1.5
**Status:** Implemented
**Related:** [Design_ONVIF_Timeline.md](Design_ONVIF_Timeline.md) · [SRS_User_Authentication.md](../srs/SRS_User_Authentication.md) · [Design_AI_Model_Catalog.md](Design_AI_Model_Catalog.md)

---

## 1. Overview

Admin Dashboard는 `admin` 역할 사용자 전용 관리 화면입니다.
Dashboard 화면에서 사용자 프로필 드롭다운 → "Admin Dashboard" 메뉴를 통해 진입하며,
단일 파일(`AdminUsersPage.tsx`)이 좌측 사이드바 내비게이션과 섹션별 콘텐츠를 포함합니다.

**접근 제어:** `App.tsx`에서 `auth.page === 'admin'` 일 때 렌더링. `role !== 'admin'`이면 `AccessDeniedPage`로 차단.

---

## 2. 레이아웃 구조

```
┌─────────────────────────────────────────────────────────────────┐
│ ← Admin Dashboard                                    [Admin]    │  ← Header (fixed)
├──────────────────┬──────────────────────────────────────────────┤
│  👥 Users        │                                              │
│     Manage...    │   Section content (scrollable)               │
│                  │                                              │
│  🤖 AI Models    │                                              │
│     YOLO catalog │                                              │
│                  │                                              │
│  📡 ONVIF        │                                              │
│     Event type   │                                              │
│                  │                                              │
│  📋 Audit Log    │                                              │
│     Activity     │                                              │
└──────────────────┴──────────────────────────────────────────────┘
  ↑ Sidebar (w-52, fixed)
```

| 영역 | 설명 |
|------|------|
| Header | 뒤로가기(Dashboard), 제목, [Admin] 배지, Dashboard 링크 |
| Sidebar | `AdminSection` 상태에 따라 활성 탭 강조 (`bg-blue-600/20 border-blue-600/30`) |
| Content | 섹션별 독립 컴포넌트 (`UsersSection`, `AiModelsSection`, `OnvifSection`, `AuditSection`) |

---

## 3. 내비게이션 섹션

```typescript
type AdminSection = 'users' | 'ai-models' | 'webrtc' | 'onvif' | 'audit' | 'system' | 'logs';
```

| id | 아이콘 | 제목 | 설명 | 표시 조건 |
|----|--------|------|------|---------|
| `users` | 👥 | Users | Manage user accounts & roles | 항상 |
| `ai-models` | 🤖 | AI Models | YOLO model catalog & AI modules | `serverMode ≠ streaming` |
| `webrtc` | 📶 | WebRTC / ICE | STUN/TURN servers & ICE connectivity test | `serverMode ≠ analysis` |
| `onvif` | 📡 | ONVIF | Event type registry | 항상 |
| `audit` | 📋 | Audit Log | Activity history | 항상 |
| `system` | 📊 | System | CPU · Memory · Disk · DB metrics | 항상 |
| `logs` | 🖥️ | Server Logs | Real-time log viewer | 항상 |

> `serverMode === 'streaming'`이면 AI Models 탭이 숨겨집니다(로컬 AI 모델 없음). `serverMode === 'analysis'`이면 WebRTC/ICE 탭이 숨겨집니다(카메라 캡처 없음). `AdminUsersPage` 마운트 시 `GET /health` → `serverMode` 필드로 판별합니다.

---

## 4. 섹션별 설계

### 4.1 Users 섹션 (`UsersSection`)

**목적:** 사용자 계정 승인·거절·역할 변경·삭제

**API:**
| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/users?status=&search=` | 사용자 목록 조회 |
| PATCH | `/admin/users/:id` | 상태·역할 변경 (`action`: approve/reject/revoke/reactivate) |
| DELETE | `/admin/users/:id` | 사용자 삭제 |

**상태:**
| State | Type | Description |
|-------|------|-------------|
| `users` | `User[]` | 로드된 사용자 목록 |
| `filter` | `StatusFilter` | `all`/`pending`/`active`/`rejected`/`revoked` |
| `search` | string | 이메일·이름·조직 검색어 |
| `loading` | boolean | 데이터 로딩 중 |
| `actionId` | string\|null | 액션 진행 중인 사용자 ID (버튼 disabled 처리) |

**Actions per user status:**
- `pending` → Approve / Reject 버튼
- `active` → Role select (admin/operator/viewer) + Revoke 버튼
- `rejected` / `revoked` → Reactivate 버튼
- 모든 상태 → Delete 버튼 (red, 확인 다이얼로그)

### 4.2 AI Models 섹션 (`AiModelsSection`)

**목적:** 전체 AI 모델 카탈로그(YOLO 탐지기 + 얼굴/PPE/화재연기/의상PAR/Human Parsing/Appearance Re-ID) 관리 및 AI 분석 모듈 활성화/비활성화

**참조:** [Design_AI_Model_Catalog.md](Design_AI_Model_Catalog.md) · [SRS_AI_Model_Catalog](../srs/SRS_AI_Model_Catalog.md)

**상태:**

| State | Type | Description |
|-------|------|-------------|
| `catalog` | `ModelCatalogEntry[]` | 전체 카탈로그 28개 항목 — YOLO 감지기 20개(`family` undefined) + 비감지기 8개(`family` 지정, exists/active/downloading/converting은 family별 독립) |
| `switching` | string\|null | 전환 중인 modelId |
| `dlLoading` | string\|null | 다운로드 트리거 중인 modelId |
| `enabled` | `Record<string, boolean>` | AI 모듈 활성화 상태 |
| `caps` | `Record<string, boolean>` | 모듈 사용 가능 여부 |
| `capStatus` | `Record<string, string>` | 모듈 상세 상태 (`builtin`/`available`/`loaded`/`failed`/`missing`/`pending`) |

**UI 구성:**

1. **YOLO Detection Model** — 시리즈별(YOLO26→YOLO12→YOLO11→YOLOv8) 테이블
   - 컬럼: Model · mAP · CPU ms · T4 ms · Params · Size · Action
   - Action: 미다운로드 → `↓ Download` / `↓ PT→ONNX` (YOLO26/YOLO12), 다운로드됨 → `Activate`, 활성 → `Active`
   - 다운로드 진행 중: `converting…` (PT→ONNX 계열) 또는 `N%` (직접 ONNX) 텍스트
   - 2초 폴링: 다운로드 중인 모델이 있을 때 자동 갱신

2. **Additional Model Families** — `EXTENDED_SERIES_ORDER` 순서(Face Detection → Face Recognition → PPE Detection → Fire & Smoke Detection → Cloth Attribute (PAR) → Human Parsing → Appearance Re-ID)로 family별 테이블
   - 컬럼: Model · License · Size · Action
   - `manualOnly` 항목(cloth-PAR/OpenPAR)은 Download 버튼 대신 "Manual export" 참조 링크(`docRef`) 표시 — 공개된 사전학습 ONNX가 없어 자동 다운로드 불가
   - `human-parsing`/`appearance-reid`만 "Proposed" 배지 표시(자주색) — 나머지(face/ppe/fire-smoke)는 이미 프로덕션에서 사용되는 필수/기본 모델이므로 배지 없음
   - family별로 독립적인 Active 상태 — 예: PPE 모델 전환이 YOLO 감지기나 얼굴 모델의 Active 상태에 영향을 주지 않음

3. **AI Analysis Modules** — `ADMIN_MODULE_GROUPS` (Core / Attributes / Hazards)
   - Core Detection: Human, Vehicle
   - AI Attributes: Face, Color, Cloth, Human Parsing(Proposed), Mask, Hat
   - Hazard Detection: Fire, Smoke
   - 각 항목: 이름 + 설명 + `requires: <model>` + 토글 스위치 — 이 토글은 모델 선택이 아니라 모듈 자체의 on/off이며, 위 카탈로그 테이블(다운로드/전환)과는 별개의 API(`/api/analytics/config`)

**API:**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/analysis/models` | 카탈로그 조회 (`{ activeFile, catalog[] }`) |
| POST | `/api/analysis/models/switch` | 활성 모델 전환 (`{ modelId }`) |
| POST | `/api/analysis/models/download` | 모델 다운로드 시작 (`{ modelId }`) |
| GET | `/api/analytics/config` | 모듈 Enable/Disable 조회 |
| PUT | `/api/analytics/config` | 모듈 Enable/Disable 변경 |
| GET | `/api/capabilities` | 모듈 가용성 및 상태 조회 |

> **Note:** `/api/analysis/models` 응답 키는 `catalog` (not `models`). `exists` 필드로 다운로드 상태 확인.

### 4.3 WebRTC / ICE 섹션 (`WebRTCSection`)

**목적:** STUN/TURN 서버 설정 및 ICE 연결 테스트 — 기존 대시보드 상단 "설정(⚙)" 모달에 있던 항목 중 언어를 제외한 전부가 이 섹션으로 이전됨 (streaming/analysis 모드 대상; combined 모드는 설정 모달에도 동일 UI를 유지)

**배경:** `App.tsx`의 `SettingsModal`은 streaming/analysis 서버의 대시보드 상단에서도 동일하게 열렸고, 언어 외에 WebRTC 활성화·STUN·TURN·ICE 테스트까지 전부 노출되어 있었다. 이 설정들은 운영자(admin) 단위로 한 곳에서 관리하는 것이 적절하므로 Admin Dashboard로 이전한다. `combined` 모드는 카메라를 직접 다루는 단일 서버이므로 빠른 접근성을 위해 설정 모달에도 동일 UI를 유지한다(§8 참고).

**참조:** [Design_STUN_TURN_ICE.md](Design_STUN_TURN_ICE.md), [Design_ICE_Test_UI.md](Design_ICE_Test_UI.md)

**상태:** `App.tsx`의 `SettingsModal`에 있던 상태·핸들러를 그대로 이식(`useWebRTCConfigStore` 재사용).

| State | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | WebRTC 활성화 여부 (draft, Apply 클릭 시 저장) |
| `stunUrls` | `string[]` | STUN 서버 URL 목록 |
| `turns` | `TurnServer[]` | TURN 서버(`url`/`username`/`credential`) 목록 |
| `saved` | boolean | Apply 후 저장 완료 표시 |
| `iceRunning` | boolean | ICE 테스트 진행 중 |
| `iceLog` | `string[]` | ICE 테스트 로그 라인 |
| `iceFailedUrls` | `string[]` | 연결 실패한 STUN/TURN URL (제거 제안 배너용) |

**UI 구성:**

1. **WebRTC Configuration 패널** — Enable 토글, STUN 서버 목록(추가/삭제), TURN 서버 목록(url/username/credential, 추가/삭제), Apply 버튼
2. **ICE Connectivity Test 패널** — Run/Abort 버튼, 실패 서버 배너(제거 버튼 포함), 로그 textarea, Download Report/Clear 버튼

**영속성:** `useWebRTCConfigStore.setConfig()` — `localStorage`(`lts-webrtc-config`) + `PUT /api/settings/webrtcConfig` 양쪽에 기록. 이 섹션과 combined 모드의 설정 모달은 같은 스토어를 공유하므로 어느 쪽에서 수정하든 즉시 동기화된다.

**표시 조건:** `serverMode === 'analysis'`일 때 숨김 (분석 서버는 카메라 캡처가 없어 WebRTC/ICE 설정이 무의미).

### 4.4 ONVIF 섹션 (`OnvifSection`)

**목적:** ONVIF 이벤트 타입 전역 레지스트리 조회 및 초기화

**참조:** [Design_ONVIF_Timeline.md §3.4](Design_ONVIF_Timeline.md)

**API:**
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/onvif-event-types` | 등록된 모든 타입 조회 |
| DELETE | `/api/onvif-event-types` | 레지스트리 전체 초기화 |

**요약 카드:**

| 카드 | 색상 | 값 |
|------|------|----|
| Registered Types | blue | `types.length` |
| Critical | red | `types.filter(t => t.severity === 'critical').length` |
| Warning | yellow | `types.filter(t => t.severity === 'warning').length` |

**테이블 컬럼:** Type Key · Label · Severity · Topic URI · First Seen

**Zustand 연동:** `useOnvifEventStore()` → `types`, `setTypes`, `clearTypes`

### 4.5 Audit Log 섹션 (`AuditSection`)

**목적:** 시스템 활동 이력 조회 (최근 200건)

**API:**
| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/audit?limit=200` | 감사 로그 조회 |

**기능:**
- 키워드 필터: `event`, `userEmail`, `detail` 필드에 대한 클라이언트 사이드 필터링
- ↺ Refresh 버튼으로 수동 재조회

**테이블 컬럼:** Time · User · Event (monospace) · Detail

---

## 5. 공유 서브컴포넌트

같은 파일 내에 재사용 컴포넌트로 정의합니다.

| 컴포넌트 | Props | 역할 |
|---------|-------|------|
| `SectionHeader` | `title`, `subtitle` | 섹션 제목 + 부제목 |
| `StatCard` | `label`, `value`, `color` | 숫자 요약 카드 (blue/red/yellow) |
| `ErrorBar` | `msg` | 빨간 에러 배너 |
| `EmptyState` | `msg` | 빈 상태 텍스트 (py-16 centered) |

---

## 6. API 요약

> Admin 섹션의 모든 API는 `apiFetch()` 래퍼를 통해 호출됩니다.
> 래퍼는 `Authorization: Bearer <accessToken>` 헤더와 `credentials: 'include'`를 자동 첨부합니다.

```typescript
async function apiFetch(path: string, opts: RequestInit = {}): Promise<unknown>
```

---

## 7. 키보드 단축키

| 키 | 동작 |
|----|------|
| `Escape` | 메인 Dashboard로 이동 (`navigateTo('dashboard')`) |

`AdminUsersPage` 마운트 시 `window.addEventListener('keydown', ...)` 등록, 언마운트 시 제거.

---

## 8. App.tsx 연동

```typescript
// App.tsx 진입 조건
if (auth.page === 'admin') return <AdminUsersPage />;
if (auth.user?.role !== 'admin') return <AccessDeniedPage />;

// 프로필 드롭다운 진입점 (combined 모드에서만 표시)
Admin Dashboard → auth.navigateTo('admin')  // admin 역할 전용
```

**`SettingsModal`과의 관계 (§4.3 WebRTC/ICE 섹션 신설에 따른 변경):**

```typescript
// App.tsx — SettingsModal(serverMode)
const isCombined = serverMode === 'combined';

isCombined
  ? <>{/* 언어 + WebRTC/STUN/TURN/ICE 테스트 전체 UI (기존과 동일) */}</>
  : <>{/* 언어만 + "WebRTC/ICE 설정은 Administrator Dashboard에서 관리합니다" 안내
         + admin 역할이면 "Go to Admin Dashboard" 버튼 (auth.navigateTo('admin')) */}</>
```

`serverMode !== 'combined'`(streaming/analysis)일 때 모달은 언어 설정만 남고, WebRTC/STUN/TURN/ICE 테스트는 §4.3의 `WebRTCSection`으로 완전히 이전된다.

---

## 9. 파일 구조

```
client/src/pages/admin/
└── AdminUsersPage.tsx     — Admin Dashboard 전체 (단일 파일)
    ├── export default AdminUsersPage  — 진입점 (App.tsx 참조)
    ├── UsersSection                   — 사용자 관리
    ├── AiModelsSection                — YOLO 모델 카탈로그 + AI 모듈 토글
    ├── WebRTCSection                  — STUN/TURN 서버 + ICE 연결 테스트
    ├── OnvifSection                   — ONVIF 타입 레지스트리
    ├── AuditSection                   — 감사 로그
    ├── SystemSection                  — CPU·메모리·GPU·디스크·DB 메트릭
    ├── AdminLogPanel (컴포넌트)        — 실시간 서버 로그 뷰어
    ├── SectionHeader                  — 공유 헤더 컴포넌트
    ├── StatCard                       — 공유 요약 카드
    ├── ErrorBar                       — 공유 에러 배너
    └── EmptyState                     — 공유 빈 상태
```

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-16 | 초기 작성 — Admin Dashboard 좌측 사이드바 구조, Users/ONVIF/Audit 3개 섹션 설계 문서화 |
| 1.5 | 2026-07-10 | §3 nav 표에 System/Logs 섹션 반영(코드와 동기화), §4.3 WebRTC/ICE 섹션 신규(SettingsModal에서 언어 제외 전체 이전, combined 모드는 모달에도 유지), §8 SettingsModal serverMode 분기 추가, §9 파일 구조 업데이트 |
| 1.1 | 2026-06-16 | Escape 키 → 메인 Dashboard 이동 단축키 추가 |
| 1.2 | 2026-06-17 | AI Models 섹션 추가 — YOLO 카탈로그(v8/11/12) 다운로드·전환, AI 모듈 Enable/Disable; 내비 "User Management" → "Admin Dashboard" 수정 |
| 1.3 | 2026-06-17 | AI Models 탭 — SERVER_MODE=streaming 시 숨김 처리 (streaming 서버는 원격 analysis 서버에 AI 위임) |
| 1.4 | 2026-07-09 | §4.2 전면 개정 — 전체 모델 카탈로그(face/ppe/fire-smoke/cloth-par/human-parsing/appearance-reid)로 확대, "Additional Model Families" 테이블(family별 독립 Download/Activate, manualOnly 안내) 문서화 |
