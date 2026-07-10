---
**Document:** TC_Admin_Dashboard  
**Version:** 1.3  
**Status:** Draft  
**Date:** 2026-07-10  
**Parent SRS:** [SRS_Admin_Dashboard](../srs/SRS_Admin_Dashboard.md)  
**Parent Design:** [Design_Admin_Dashboard](../design/Design_Admin_Dashboard.md)  
**Related TC:** [TC_AI_Model_Catalog](TC_AI_Model_Catalog.md)  
**Test Script:** `test/api/admin_dashboard.test.js`  
---

# TC — Admin Dashboard

## 1. Traceability Matrix

| TC ID | SRS FR | Description |
|---|---|---|
| TC-AD-001 | FR-AD-001 | Non-admin users cannot access Admin Dashboard |
| TC-AD-002 | FR-AD-002 | Profile dropdown shows "Admin Dashboard" label |
| TC-AD-003 | FR-AD-004 | Sidebar has 4 nav items (Users/AI Models/ONVIF/Audit) |
| TC-AD-004 | FR-AD-010 | AI Models shows catalog grouped by series |
| TC-AD-005 | FR-AD-013 | Active model shows filled indigo indicator |
| TC-AD-006 | FR-AD-014~016 | Download/Activate buttons shown conditionally |
| TC-AD-007 | FR-AD-017 | Activate calls switch API and refreshes |
| TC-AD-008 | FR-AD-018~020 | Download triggers polling; converting shown for YOLO12 |
| TC-AD-009 | FR-AD-030~035 | AI module toggles load from capabilities API |
| TC-AD-010 | FR-AD-032 | Toggle PUT updates analytics config |
| TC-AD-011 | FR-AD-033 | Failed/missing modules show badge, toggle disabled |

## 2. Test Cases

### TC-AD-001: Access Control

**Pre-condition:** User with `role === 'operator'` logged in  
**Steps:**
1. Navigate to `/#/admin` or trigger `navigateTo('admin')`
2. Observe rendered page

**Expected:** `AccessDeniedPage` renders; admin content is not shown  
**Priority:** P1

---

### TC-AD-002: Admin Dashboard Nav Label

**Pre-condition:** `admin` user logged in; App.tsx profile dropdown visible  
**Steps:**
1. Open profile dropdown (bottom-left user section)
2. Observe the admin navigation button label

**Expected:** Button shows "Admin Dashboard" (not "User Management")  
**Priority:** P1

---

### TC-AD-003: Sidebar Navigation Items

**Pre-condition:** Admin Dashboard open  
**Steps:**
1. Observe sidebar nav items

**Expected:** Up to seven items visible: 👥 Users · 🤖 AI Models · 📶 WebRTC / ICE · 📡 ONVIF · 📋 Audit Log · 📊 System · 🖥️ Server Logs — AI Models hidden when `SERVER_MODE=streaming`; WebRTC / ICE hidden when `SERVER_MODE=analysis`  
**Priority:** P1

---

### TC-AD-004: AI Models Catalog Display

**Pre-condition:** Analysis server running; Admin Dashboard → AI Models section  
**Steps:**
1. Click "AI Models" in sidebar
2. Observe the YOLO Detection Model table

**Expected:**
- Four series groups displayed: YOLO26, YOLO12, YOLO11, YOLOv8
- Each group has 5 model rows
- Columns: Model · mAP · CPU ms · T4 ms · Params · Size · Action

**Priority:** P1

---

### TC-AD-005: Active Model Indicator

**Pre-condition:** `yolov8n.onnx` is active model  
**Steps:**
1. Open Admin Dashboard → AI Models
2. Find `YOLOv8n` row

**Expected:** Filled indigo radio indicator + "● active" text; row has indigo background tint  
**Priority:** P1

---

### TC-AD-006: Conditional Action Buttons

**Pre-condition:** `yolov8n.onnx` exists (active); `yolov8s.onnx` exists (not active); `yolo12n.onnx` does not exist  
**Steps:**
1. Open AI Models section
2. Observe action column for each of the three models above

**Expected:**
- `yolov8n`: Shows "Active" text (no button)
- `yolov8s`: Shows "Activate" button
- `yolo12n`: Shows "↓ PT→ONNX" button

**Priority:** P1

---

### TC-AD-007: Activate Button

**Pre-condition:** `yolov8s.onnx` exists and is not active  
**Steps:**
1. Click "Activate" for YOLOv8s
2. Wait for action to complete

**Expected:** Button replaced by "Active" indicator; `yolov8n` loses active indicator  
**Priority:** P1

---

### TC-AD-008: Download + Polling

**Pre-condition:** `yolov8s.onnx` does NOT exist  
**Steps:**
1. Click "↓ Download" for YOLOv8s
2. Observe row during download

**Expected:**
- Action column shows download percent (e.g., "45%") while in progress
- Progress updates every ~2 seconds
- After completion: "Activate" button appears

**Priority:** P2 (requires network)

---

### TC-AD-009: AI Module Toggles Load

**Pre-condition:** Analysis server running with capabilities endpoint  
**Steps:**
1. Open AI Models section
2. Scroll to "AI Analysis Modules"

**Expected:**
- Three groups shown: Core Detection / AI Attributes / Hazard Detection
- Human and Vehicle toggles are green (enabled by default)
- Modules with missing model files show "Model Missing" badge

**Priority:** P1

---

### TC-AD-010: Toggle Module

**Pre-condition:** `human` module is enabled  
**Steps:**
1. Click the toggle for "Human Detection"
2. Observe state change

**Expected:**
- Toggle switches to off (gray)
- `PUT /api/analytics/config { human: false }` is called
- Toggle shows "…" saving indicator briefly

**Priority:** P1

---

### TC-AD-011: Disabled Toggle for Failed Module

**Pre-condition:** `yolov8m_ppe.onnx` is missing (capStatus === 'missing')  
**Steps:**
1. Open AI Models section → AI Analysis Modules
2. Observe Mask and Hat module rows

**Expected:**
- "Model Missing" badge shown
- Toggle is visually disabled (opacity-30)
- Clicking toggle has no effect

**Priority:** P2

---

### TC-AD-012: Additional Model Family Tables

**Pre-condition:** Analysis server running; Admin Dashboard → AI Models section  
**Steps:**
1. Scroll below the YOLO Detection Model table
2. Observe each family table in order

**Expected:**
- Tables appear in order: Face Detection, Face Recognition, PPE Detection, Fire & Smoke Detection, Cloth Attribute (PAR), Human Parsing, Appearance Re-ID (only families present in the catalog response are rendered)
- Only "Human Parsing" and "Appearance Re-ID" show a purple "Proposed" badge; the other five do not
- Each table has columns: Model · License · Size · Action
- The Cloth Attribute (PAR) row shows a "Manual export" link (not a Download button) when the file does not exist
- Activating a model in one family (e.g. PPE) does not change the Active indicator shown for the YOLO Detection Model table or any other family table

**Priority:** P1

---

### TC-AD-013: WebRTC / ICE Nav Item Visibility by Server Mode

**Pre-condition:** Admin Dashboard open  
**Steps:**
1. Load Admin Dashboard against a `SERVER_MODE=combined` server; observe sidebar
2. Load against a `SERVER_MODE=streaming` server; observe sidebar
3. Load against a `SERVER_MODE=analysis` server; observe sidebar

**Expected:**
- combined and streaming: "WebRTC / ICE" nav item is visible
- analysis: "WebRTC / ICE" nav item is absent (no camera capture in analysis mode)

**Priority:** P1

---

### TC-AD-014: WebRTC / ICE Section — Configuration Shared With Settings Modal

**Pre-condition:** `SERVER_MODE=combined`; Admin Dashboard → WebRTC / ICE section  
**Steps:**
1. Add a STUN server URL and click Apply in the Admin Dashboard section
2. Open the dashboard's top-right Settings (⚙) modal on the same browser session
3. Observe the STUN server list in the modal

**Expected:** The newly added STUN URL appears in the Settings modal's STUN list (both surfaces read/write the same `useWebRTCConfigStore`, persisted to `localStorage` + `PUT /api/settings/webrtcConfig`)  
**Priority:** P1

---

### TC-AD-015: Settings Modal Simplified for Streaming/Analysis Modes

**Pre-condition:** Dashboard open against a `SERVER_MODE=streaming` or `SERVER_MODE=analysis` server  
**Steps:**
1. Click the top-right Settings (⚙) icon
2. Observe the modal contents

**Expected:**
- Only the Language selector is shown
- A note explains that WebRTC/ICE settings moved to the Administrator Dashboard
- If the logged-in user has `role === 'admin'`, a "Go to Admin Dashboard" button is shown and navigates to the Admin Dashboard's WebRTC / ICE section on click
- No STUN/TURN inputs or ICE Test controls are present

**Priority:** P1

---

### TC-AD-016: Settings Modal Unchanged for Combined Mode

**Pre-condition:** Dashboard open against a `SERVER_MODE=combined` server  
**Steps:**
1. Click the top-right Settings (⚙) icon
2. Observe the modal contents

**Expected:** Language, WebRTC enable toggle, STUN servers, TURN servers, Apply button, and ICE Connectivity Test are all present — unchanged from before the Admin Dashboard relocation  
**Priority:** P1

---

### TC-AD-017: WebRTC / ICE Section — ICE Connectivity Test

**Pre-condition:** Admin Dashboard → WebRTC / ICE section; at least one STUN server configured  
**Steps:**
1. Click "Run ICE Test"
2. Wait for the test to complete (or click again to abort)

**Expected:**
- Log textarea appears and streams timestamped lines for Phase 1 (ICE candidate gathering) and Phase 2 (WebRTC engine health check)
- "Download Report" and "Clear" buttons appear once the log has content
- If any configured STUN/TURN URL is unreachable, a yellow banner lists it with a "Remove unreachable servers" action

**Priority:** P1

---

## 3. Audit Page — TC Runner (TcRunnerService) Test Cases

TcRunnerService는 서버 시작 시 TC 스크립트를 자동 실행하고 결과를 `tc_results` DB에 저장합니다.
Admin Dashboard의 **Audit** 탭에서 결과를 확인할 수 있습니다.

### TC-AUDIT-001: HTTPS 프로토콜 전파 (TcRunnerService)

**조건:** `HTTPS_ENABLED=true`, `HTTPS_PORT=3443`  
**동작:**  
1. `index.js`가 `runOnStartup(ACTIVE_PORT, ACTIVE_PROTO)` 호출
2. `TcRunnerService._run(port, 'https')` 실행
3. 생성된 `LTS_URL = https://localhost:3443`이 자식 프로세스에 전달
4. 자식 프로세스 환경에 `NODE_TLS_REJECT_UNAUTHORIZED=0` 자동 설정

**기대:** TC 스크립트가 `fetch failed` 없이 정상 실행됨  
**관련 버그:** HTTPS 서버에서 `http://localhost:3443`으로 접근하여 모든 TC 실패하던 문제  
**Priority:** P1

---

### TC-AUDIT-002: SERVER_MODE별 스위트 스킵

| 스위트 | `streaming` 모드 | `analysis` 모드 | `combined` 모드 |
|---|---|---|---|
| `analysisOnly: true` 스위트 | SKIP | 실행 | 실행 |
| `streamingOnly: true` 스위트 | 실행 | SKIP | SKIP |
| 플래그 없음 | 실행 | 실행 | 실행 |

**기대:** 모드에 맞지 않는 스위트는 `TC-SKIP`으로 표시됨  
**Priority:** P1

---

### TC-AUDIT-003: MCP 서버 도구·리소스 카탈로그 검증

**현재 카탈로그 (2026-06-24 기준):**
- **도구 수:** 18개 (`query_loitering_events` ~ `get_missing_person_statistics`)
- **리소스 수:** 7개 (`lts://cameras` ~ `missing-persons://detections/{date}`)

**기대:** `TC-A-001` 및 `TC-A-003` 검증이 실제 카탈로그 크기와 일치  
**Priority:** P2

---

### TC-AUDIT-004: Auth 테스트 — 기존 DB 환경 대응

**전제:** DB에 이미 사용자가 존재하는 환경  
**동작:**
- 신규 등록 사용자가 `pending` 상태로 생성됨 → `existingDbMode = true`
- `LTS_ADMIN_EMAIL` + `LTS_ADMIN_PASSWORD` 환경변수로 admin 로그인 대체
- 환경변수 미설정 시 admin 의존 TC 자동 SKIP

**기대:** TC-AUTH-A-001이 FAIL 대신 PASS (환경 인식 후 조건부 통과)  
**Priority:** P1

---

### TC-AUDIT-005: ONVIF Dedup — 메모리 캐시 격리

**전제:** TC-PARSER-008과 TC-PARSER-009이 동일 세션에서 순차 실행  
**문제 원인:** `_lastStates` Map이 서버 메모리에 유지됨; `DELETE /api/onvif-events`로 DB를 지워도 캐시는 보존됨  
**수정:** TC-PARSER-009에 별도 `CAM_ID`와 `SourceToken` 사용으로 캐시 오염 방지  
**기대:** TC-PARSER-009 `events.length === 1` 검증 통과  
**Priority:** P1

---

### TC-AUDIT-006: WebRTC 로그 파일 없을 때 TC-H 그룹 SKIP

**조건:** `WEBRTC_LOG_PATH` 환경변수 미설정 AND `--log` 인수 미제공  
**기대:** TC-H-001~004가 FAIL이 아닌 SKIP으로 표시됨  
**Priority:** P2

---

### TC-AUDIT-007: capture-backend.test.js Jest-only 가드

**조건:** `run_all.js`에서 plain node로 실행  
**동작:** `typeof jest === 'undefined'` 검사 후 `process.exit(0)` 실행  
**기대:** `TC_RTSP_Capture_Backend` 스위트가 PASS(exit 0)로 집계됨  
**참고:** Jest로 실행: `cd server && npx jest ../test/api/capture-backend.test.js`  
**Priority:** P2

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-17 | 초기 작성 — TC-AD-001~011, AI Models 섹션 및 접근 제어 테스트 |
| 1.1 | 2026-06-24 | TC-AUDIT-001~007 추가 — Streaming/Analysis 모드 TC 구분, HTTPS 프로토콜 전파, MCP 카탈로그 업데이트, Auth/Dedup/WebRTC/capture-backend 수정 내용 반영 |
| 1.2 | 2026-07-09 | TC-AD-004 YOLO26 시리즈 반영, TC-AD-012 신규 — 전체 모델 파일(face/ppe/fire-smoke/cloth-par/human-parsing/appearance-reid) 테이블 표시 및 family별 독립 전환 테스트 |
| 1.3 | 2026-07-10 | TC-AD-003 정정(System/Logs 반영), TC-AD-013~017 신규 — WebRTC/ICE 섹션 신설(모드별 표시 조건, 설정 모달과 상태 공유, streaming/analysis 모달 간소화, combined 모달 무변경, ICE 테스트) |
