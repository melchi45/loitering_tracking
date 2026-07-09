---
**Document:** SRS_Admin_Dashboard  
**Version:** 1.2  
**Status:** Draft  
**Date:** 2026-07-09  
**Child Design:** [Design_Admin_Dashboard](../design/Design_Admin_Dashboard.md)  
**Child TC:** [TC_Admin_Dashboard](../tc/TC_Admin_Dashboard.md)  
**Related SRS:** [SRS_AI_Model_Catalog](SRS_AI_Model_Catalog.md) · [SRS_User_Authentication](SRS_User_Authentication.md)  
---

# SRS — Admin Dashboard

## 1. Introduction

This SRS specifies software requirements for the LTS-2026 Admin Dashboard (`AdminUsersPage.tsx`), accessible only to users with the `admin` role.

## 2. Scope

Admin Dashboard provides four management sections accessible via left sidebar navigation:
- Users — account management
- AI Models — full AI model catalog (YOLO detector + face/PPE/fire-smoke/cloth-PAR/human-parsing/appearance-reid) and AI module control
- ONVIF — event type registry
- Audit Log — activity history

## 3. Functional Requirements — Navigation & Access

| ID | Requirement |
|---|---|
| FR-AD-001 | The Admin Dashboard shall only be accessible when `auth.user.role === 'admin'`; non-admin users shall see `AccessDeniedPage`. |
| FR-AD-002 | The admin entrypoint in `App.tsx` profile dropdown shall be labeled "Admin Dashboard". |
| FR-AD-003 | Pressing `Escape` while the Admin Dashboard is open shall navigate back to the main dashboard. |
| FR-AD-004 | The sidebar shall have four nav items: Users, AI Models, ONVIF, Audit Log. The AI Models item shall be hidden when `SERVER_MODE=streaming`. |
| FR-AD-005 | On mount, `AdminUsersPage` shall fetch `GET /health` to determine `serverMode`. If `serverMode === 'streaming'`, the AI Models nav item shall not be rendered. |

## 4. Functional Requirements — AI Models Section

> Implementation: `AiModelsSection` component in `AdminUsersPage.tsx`  
> Related: [SRS_AI_Model_Catalog](SRS_AI_Model_Catalog.md) · [Design_AI_Model_Catalog](../design/Design_AI_Model_Catalog.md)

### 4.1 YOLO Detection Model Catalog

| ID | Requirement |
|---|---|
| FR-AD-010 | The AI Models section shall display all YOLO detector models from `GET /api/analysis/models` (response key: `catalog`, filtered to entries with no `family`), grouped by series: YOLO26 → YOLO12 → YOLO11 → YOLOv8. |
| FR-AD-011 | Each model row shall display: label, mAP, CPU ms, T4 ms, params, file size (MB). |
| FR-AD-012 | Color coding: mAP ≥ 51 → green, ≥ 44 → yellow, < 44 → gray; CPU ms ≤ 90 → green, ≤ 240 → yellow, > 240 → red. |
| FR-AD-013 | The active model shall be indicated by a filled indigo radio indicator and "● active" label. |
| FR-AD-014 | A model where `exists === false` and not downloading shall show a Download button. |
| FR-AD-015 | A YOLO26/YOLO12 series model (download requiring PT→ONNX conversion) shall show "↓ PT→ONNX" button label. |
| FR-AD-016 | A model where `exists === true` and not active shall show an "Activate" button. |
| FR-AD-017 | Clicking "Activate" shall call `POST /api/analysis/models/switch { modelId }` and refresh the catalog. |
| FR-AD-018 | Clicking "Download" shall call `POST /api/analysis/models/download { modelId }` and start 2-second polling until no model is `downloading` or `converting`. |
| FR-AD-019 | While a model is converting, the action column shall show "Converting…" with amber text. |
| FR-AD-020 | While a model is downloading (not converting), the action column shall show the percent progress. |
| FR-AD-021 | Download errors from `downloadError` field shall be displayed via `ErrorBar`. |

### 4.1b Additional Model Family Tables

| ID | Requirement |
|---|---|
| FR-AD-022 | Below the YOLO Detection Model table, the AI Models section shall render one table per non-detector `family` present in the catalog, in the order: Face Detection → Face Recognition → PPE Detection → Fire & Smoke Detection → Cloth Attribute (PAR) → Human Parsing → Appearance Re-ID (`EXTENDED_SERIES_ORDER`). |
| FR-AD-023 | Each row in these tables shall display: label, license, file size (MB), and an action control — Download / Activate / Active / percent-progress, following the same rules as FR-AD-014~020. |
| FR-AD-024 | An entry with `manualOnly === true` shall show a "Manual export" reference link (to `docRef`) instead of a Download button when `exists === false`, and shall never render a Download button for that entry. |
| FR-AD-025 | Only the `Human Parsing` and `Appearance Re-ID` family tables shall display a "Proposed" badge; Face Detection, Face Recognition, PPE Detection, Fire & Smoke Detection, and Cloth Attribute (PAR) shall not, since they are production models already required or optionally enabled by the pipeline. |
| FR-AD-026 | Each family's active/downloading/converting state shall be independent of every other family's — activating a model in one family shall not change the displayed active model of any other family. |

### 4.2 AI Analysis Module Toggles

| ID | Requirement |
|---|---|
| FR-AD-030 | The AI Models section shall show module enable/disable toggles for: Human, Vehicle, Face, Color, Cloth, Mask, Hat, Fire, Smoke. |
| FR-AD-031 | Toggle state shall be loaded from `GET /api/analytics/config` and capability availability from `GET /api/capabilities`. |
| FR-AD-032 | Toggling a module shall call `PUT /api/analytics/config { [moduleId]: boolean }`. |
| FR-AD-033 | Modules with `capStatus === 'failed'` or `'missing'` shall show a status badge and have the toggle disabled. |
| FR-AD-034 | Modules with `capStatus === 'pending'` shall show "Phase-2" badge and have the toggle disabled. |
| FR-AD-035 | Each module row shall show: label, description, required model file (if applicable), toggle switch. |

## 5. Functional Requirements — Users Section

| ID | Requirement |
|---|---|
| FR-AD-040 | Users section shall list accounts filterable by status (all/pending/active/rejected/revoked) and searchable by email/name/organization. |
| FR-AD-041 | Actions per status: pending → Approve/Reject; active → Role change + Revoke; rejected/revoked → Reactivate; all → Delete (with confirm). |
| FR-AD-042 | All user management operations shall use `apiFetch()` with `Authorization: Bearer <token>`. |

## 6. Functional Requirements — ONVIF Section

| ID | Requirement |
|---|---|
| FR-AD-050 | ONVIF section shall display the event type registry from `GET /api/onvif-event-types`. |
| FR-AD-051 | A "Clear Registry" button shall call `DELETE /api/onvif-event-types`. |

## 7. Functional Requirements — Audit Log Section

| ID | Requirement |
|---|---|
| FR-AD-060 | Audit section shall display the last 200 audit log entries from `GET /admin/audit?limit=200`. |
| FR-AD-061 | Client-side keyword filter on `event`, `userEmail`, and `detail` fields. |

## 8. Non-Functional Requirements

| ID | Requirement |
|---|---|
| NFR-AD-001 | Catalog polling interval during download shall be 2000 ms. |
| NFR-AD-002 | Polling shall stop automatically when no model is `downloading` or `converting`. |
| NFR-AD-003 | All API calls in `AiModelsSection` shall use the global fetch (no auth header — analysis API is not auth-gated). |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-17 | 초기 작성 — AI Models 섹션(FR-AD-010~035), Users/ONVIF/Audit 기능 요구사항 정의 |
| 1.1 | 2026-06-17 | FR-AD-005 추가 — streaming 모드에서 AI Models 탭 숨김 (`GET /health` serverMode 판별) |
| 1.2 | 2026-07-09 | §4.1b 신규 — 전체 모델 파일(face/ppe/fire-smoke/cloth-par/human-parsing/appearance-reid) 테이블 요구사항(FR-AD-022~026) 추가, FR-AD-010/015 YOLO26 반영 |
