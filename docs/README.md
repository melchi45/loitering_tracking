# LTS-2026 Documentation Index

## Development Process Overview

The project follows a gated stage-gate lifecycle. Each phase produces specific deliverables that serve as inputs to the next.

```
MRD → DIA → DV → DVR → PIA → PV → PVR → PR → PRA → SR → SRA
```

| Stage | Full Name | Description | Key Deliverables |
|---|---|---|---|
| **MRD** | Market Requirements | Define market/customer needs — *what* to build | MRD, draft RFP |
| **DIA** | Design Input Approval | Translate requirements into actionable development items | PRD, formal RFP, draft SRS |
| **DV** | Design Verification | Define and verify architecture and design | SRS, Design documents (HLD/LLD), TC design |
| **DVR** | Design Verification Report | Report design verification results | Design verification report, partial test results |
| **PIA** | Production Input Approval | Prepare for production/deployment | Deployment/operations design, environment setup docs |
| **PV** | Production Verification | Execute tests in production-equivalent environment | TC execution results, integration/performance/UAT reports, defect list |
| **PVR** | Production Validation Report | Consolidate test results and quality assessment | PVR report, consolidated test report, residual issue list, quality assessment |
| **PR** | Production Release | Release approval stage | Release plan, approval documents |
| **PRA** | Production Release Approval | Final release sign-off | Final approval document |
| **SR** | Service Release | Execute actual service deployment | Release notes, deployment plan, rollback plan, deployment checklist |
| **SRA** | Service Release Approval | Post-deployment stability confirmation and operations sign-off | Release validation report, smoke test results, operations stability report, go-live approval |

**Core document flow:** MRD → PRD → SRS → Design → TC → Test Results → Release Notes

> **MRD for this project:** [docs/mrd/MRD_LTS2026.md](mrd/MRD_LTS2026.md) — market problem, target segments, competitive landscape, module inventory, business requirements, success KPIs

---

## SDLC Document Hierarchy

```
RFP (Feature Overview)
  ↓
PRD (Product Requirements — Technical Approach)
  ↓
SRS (Software Requirements — Functional Specification)
  ↓
Design (Architecture & Code Structure)
  ↓
Code (Implementation)
  ↓
TC (Test Cases)  →  test/ (Test Scripts)
```

### Document Role Definitions

| Stage | Document | Role | Authored When |
|---|---|---|---|
| **RFP** | Request for Proposal | Feature definition · scope · schedule · acceptance criteria | Before project start |
| **PRD** | Product Requirements Document | Technology choices · methodology · implementation priorities | Planning phase |
| **SRS** | Software Requirements Specification | Per-feature specification · I/O contracts · non-functional requirements | Before design |
| **Design** | Design Document | Architecture · file structure · class/API design · sequence diagrams | Before implementation |
| **TC** | Test Cases | SRS-based test items · execution order · edge cases · pass criteria | After implementation |

---

## Directory Structure

```
docs/
├── mrd/           Market Requirements Document
├── rfp/           RFP documents (feature definition + schedule)
├── prd/           PRD documents (technical approach + methodology)
├── srs/           SRS documents (detailed functional specification)
├── design/        Design documents (architecture + code structure)
├── tc/            Test cases
├── ops/           Operations guides (MongoDB, HTTPS, MCP Server)
└── screenshots/   Dashboard screenshots

test/              Test scripts (TC-based automation)
├── api/           REST API tests
├── integration/   Integration tests (Phase-2)
├── e2e/           E2E tests (Phase-3, Playwright)
└── fixtures/      Test image files
```

---

## Module Documentation Status

### ✅ Fully Documented Modules (RFP + PRD + SRS + Design + TC)

| Module | RFP | PRD | SRS | Design | TC |
|---|---|---|---|---|---|
| LTS-2026 Main System | [rfp/](rfp/RFP_LTS2026_Loitering_Tracking_System.md) | [prd/](prd/PRD_LTS2026_Loitering_Tracking_System.md) | [srs/](srs/SRS_LTS2026_Loitering_Tracking_System.md) | [design/](design/Design_LTS2026_Loitering_Tracking_System.md) | [tc/](tc/TC_LTS2026_Loitering_Tracking_System.md) |
| Face Recognition | [rfp/](rfp/RFP_AI_Face_Recognition.md) | [prd/](prd/PRD_AI_Face_Recognition.md) | [srs/](srs/SRS_AI_Face_Recognition.md) | [design/](design/Design_AI_Face_Recognition.md) | [tc/](tc/TC_AI_Face_Recognition.md) |
| Human Detection | [rfp/](rfp/RFP_AI_Human_Detection.md) | [prd/](prd/PRD_AI_Human_Detection.md) | [srs/](srs/SRS_AI_Human_Detection.md) | [design/](design/Design_AI_Human_Detection.md) | [tc/](tc/TC_AI_Human_Detection.md) |
| Vehicle Detection | [rfp/](rfp/RFP_AI_Vehicle_Detection.md) | [prd/](prd/PRD_AI_Vehicle_Detection.md) | [srs/](srs/SRS_AI_Vehicle_Detection.md) | [design/](design/Design_AI_Vehicle_Detection.md) | [tc/](tc/TC_AI_Vehicle_Detection.md) |
| Fire & Smoke Detection | [rfp/](rfp/RFP_AI_Fire_Smoke_Detection.md) | [prd/](prd/PRD_AI_Fire_Smoke_Detection.md) | [srs/](srs/SRS_AI_Fire_Smoke_Detection.md) | [design/](design/Design_AI_Fire_Smoke_Detection.md) | [tc/](tc/TC_AI_Fire_Smoke_Detection.md) |
| Mask Detection | [rfp/](rfp/RFP_AI_Mask_Detection.md) | [prd/](prd/PRD_AI_Mask_Detection.md) | [srs/](srs/SRS_AI_Mask_Detection.md) | [design/](design/Design_AI_Mask_Detection.md) | [tc/](tc/TC_AI_Mask_Detection.md) |
| Hard Hat Detection | [rfp/](rfp/RFP_AI_Hat_Detection.md) | [prd/](prd/PRD_AI_Hat_Detection.md) | [srs/](srs/SRS_AI_Hat_Detection.md) | [design/](design/Design_AI_Hat_Detection.md) | [tc/](tc/TC_AI_Hat_Detection.md) |
| Color Analysis | [rfp/](rfp/RFP_AI_Color_Analysis.md) | [prd/](prd/PRD_AI_Color_Analysis.md) | [srs/](srs/SRS_AI_Color_Analysis.md) | [design/](design/Design_AI_Color_Analysis.md) | [tc/](tc/TC_AI_Color_Analysis.md) |
| Clothing Analysis | [rfp/](rfp/RFP_AI_Cloth_Analysis.md) | [prd/](prd/PRD_AI_Cloth_Analysis.md) | [srs/](srs/SRS_AI_Cloth_Analysis.md) | [design/](design/Design_AI_Cloth_Analysis.md) | [tc/](tc/TC_AI_Cloth_Analysis.md) |
| Accessories Detection | [rfp/](rfp/RFP_AI_Accessories_Detection.md) | [prd/](prd/PRD_AI_Accessories_Detection.md) | [srs/](srs/SRS_AI_Accessories_Detection.md) | [design/](design/Design_AI_Accessories_Detection.md) | [tc/](tc/TC_AI_Accessories_Detection.md) |
| Animal Detection | [rfp/](rfp/RFP_AI_Animal_Detection.md) | [prd/](prd/PRD_AI_Animal_Detection.md) | [srs/](srs/SRS_AI_Animal_Detection.md) | [design/](design/Design_AI_Animal_Detection.md) | [tc/](tc/TC_AI_Animal_Detection.md) |
| Object Tracking | [rfp/](rfp/RFP_Object_Tracking.md) | [prd/](prd/PRD_Object_Tracking.md) | [srs/](srs/SRS_Object_Tracking.md) | [design/](design/Design_Object_Tracking.md) | [tc/](tc/TC_Object_Tracking.md) |
| Cross-Camera Face Tracking | [rfp/](rfp/RFP_CrossCamera_Face_Tracking.md) | [prd/](prd/PRD_CrossCamera_Face_Tracking.md) | [srs/](srs/SRS_CrossCamera_Face_Tracking.md) | [design/](design/Design_CrossCamera_Face_Tracking.md) | [tc/](tc/TC_CrossCamera_Face_Tracking.md) |
| YouTube RTSP Ingest | [rfp/](rfp/RFP_YouTube_RTSP_Ingest.md) | [prd/](prd/PRD_YouTube_RTSP_Ingest.md) | [srs/](srs/SRS_YouTube_RTSP_Ingest.md) | [design/](design/Design_YouTube_RTSP_Ingest.md) | [tc/](tc/TC_YouTube_RTSP_Ingest.md) |
| YouTube RTSP Ingest (LTS-2026) | — | [prd/](prd/PRD_LTS2026_YouTube_RTSP_Ingest.md) | [srs/](srs/SRS_LTS2026_YouTube_RTSP_Ingest.md) | [design/](design/Design_LTS2026_YouTube_RTSP_Ingest.md) | [tc/](tc/TC_LTS2026_YouTube_RTSP_Ingest.md) |
| WebRTC Media Gateway | [rfp/](rfp/RFP_WebRTC_Media_Gateway.md) | [prd/](prd/PRD_WebRTC_Media_Gateway.md) | [srs/](srs/SRS_WebRTC_Media_Gateway.md) | [design/](design/Design_WebRTC_Media_Gateway.md) | [tc/](tc/TC_WebRTC_Media_Gateway.md) |
| STUN/TURN ICE | [rfp/](rfp/RFP_STUN_TURN_ICE.md) | [prd/](prd/PRD_STUN_TURN_ICE.md) | [srs/](srs/SRS_STUN_TURN_ICE.md) | [design/](design/Design_STUN_TURN_ICE.md) | [tc/](tc/TC_STUN_TURN_ICE.md) |
| Camera Discovery | [rfp/](rfp/RFP_Camera_Discovery.md) | [prd/](prd/PRD_Camera_Discovery.md) | [srs/](srs/SRS_Camera_Discovery.md) | [design/](design/Design_Camera_Discovery.md) | [tc/](tc/TC_Camera_Discovery.md) |
| Dashboard Layout | [rfp/](rfp/RFP_Dashboard_Layout.md) | [prd/](prd/PRD_Dashboard_Layout.md) | [srs/](srs/SRS_Dashboard_Layout.md) | [design/](design/Design_Dashboard_Layout.md) | [tc/](tc/TC_Dashboard_Layout.md) |
| Dashboard Detection Display | [rfp/](rfp/RFP_Dashboard_Detection_Display.md) | [prd/](prd/PRD_Dashboard_Detection_Display.md) | [srs/](srs/SRS_Dashboard_Detection_Display.md) | [design/](design/Design_Dashboard_Detection_Display.md) | [tc/](tc/TC_Dashboard_Detection_Display.md) |
| Dashboard Sidebar — Cameras | [rfp/](rfp/RFP_Dashboard_Sidebar_Cameras.md) | [prd/](prd/PRD_Dashboard_Sidebar_Cameras.md) | [srs/](srs/SRS_Dashboard_Sidebar_Cameras.md) | [design/](design/Design_Dashboard_Sidebar_Cameras.md) | [tc/](tc/TC_Dashboard_Sidebar_Cameras.md) |
| Dashboard Sidebar — Alerts & Zones | [rfp/](rfp/RFP_Dashboard_Sidebar_Alerts_Zones.md) | [prd/](prd/PRD_Dashboard_Sidebar_Alerts_Zones.md) | [srs/](srs/SRS_Dashboard_Sidebar_Alerts_Zones.md) | [design/](design/Design_Dashboard_Sidebar_Alerts_Zones.md) | [tc/](tc/TC_Dashboard_Sidebar_Alerts_Zones.md) |
| Dashboard Sidebar — Face ID | [rfp/](rfp/RFP_Dashboard_Sidebar_Face_ID.md) | [prd/](prd/PRD_Dashboard_Sidebar_Face_ID.md) | [srs/](srs/SRS_Dashboard_Sidebar_Face_ID.md) | [design/](design/Design_Dashboard_Sidebar_Face_ID.md) | [tc/](tc/TC_Dashboard_Sidebar_Face_ID.md) |
| Mobile Layout | [rfp/](rfp/RFP_Mobile_Layout.md) | [prd/](prd/PRD_Mobile_Layout.md) | [srs/](srs/SRS_Mobile_Layout.md) | [design/](design/Design_Mobile_Layout.md) | [tc/](tc/TC_Mobile_Layout.md) |
| LLM / MCP Integration | [rfp/](rfp/RFP_LLM_MCP_Integration.md) | [prd/](prd/PRD_LLM_MCP_Server.md) | [srs/](srs/SRS_LLM_MCP_Server.md) | [design/](design/Design_LLM_MCP_Server.md) | [tc/](tc/TC_LLM_MCP_Server.md) |
| **Storage — JSON / MongoDB** | [rfp/](rfp/RFP_Storage_MongoDB.md) | [prd/](prd/PRD_Storage_MongoDB.md) | [srs/](srs/SRS_Storage_MongoDB.md) | [design/](design/Design_Storage_MongoDB.md) | [tc/](tc/TC_Storage_MongoDB.md) |
| **HTTPS / TLS Server** | [rfp/](rfp/RFP_HTTPS_TLS.md) | [prd/](prd/PRD_HTTPS_TLS.md) | [srs/](srs/SRS_HTTPS_TLS.md) | [design/](design/Design_HTTPS_TLS.md) | [tc/](tc/TC_HTTPS_TLS.md) |
| **Detection Snapshot & Search** | [rfp/](rfp/RFP_Detection_Snapshot_Search.md) | [prd/](prd/PRD_Detection_Snapshot_Search.md) | [srs/](srs/SRS_Detection_Snapshot_Search.md) | [design/](design/Design_Detection_Snapshot_Search.md) | [tc/](tc/TC_Detection_Snapshot_Search.md) |
| **Stats Dashboard Panel** | [rfp/](rfp/RFP_Stats_Panel.md) | [prd/](prd/PRD_Stats_Panel.md) | [srs/](srs/SRS_Stats_Panel.md) | [design/](design/Design_Stats_Panel.md) | [tc/](tc/TC_Stats_Panel.md) |
| **User Authentication** | [rfp/](rfp/RFP_User_Authentication.md) | [prd/](prd/PRD_User_Authentication.md) | [srs/](srs/SRS_User_Authentication.md) | [design/](design/Design_User_Authentication.md) | [tc/](tc/TC_User_Authentication.md) |

---

## Test Script Status

> Icon legend: ✅ file exists · 📋 planned (not yet created) · 🕐 Phase-2 (integration, planned) · 🖥 Phase-3 (E2E Playwright, planned)

### Phase-1 — REST API Tests (`test/api/`)

| Script | Target TC Document(s) | Groups Covered | Run Command |
|---|---|---|---|
| ✅ `test/api/main_system.test.js` | [TC_LTS2026_Loitering_Tracking_System](tc/TC_LTS2026_Loitering_Tracking_System.md) | A–G (23 cases) | `node test/api/main_system.test.js` |
| ✅ `test/api/analytics_config.test.js` | [TC_AI_Animal_Detection](tc/TC_AI_Animal_Detection.md) · [TC_AI_Hat_Detection](tc/TC_AI_Hat_Detection.md) · [TC_AI_Mask_Detection](tc/TC_AI_Mask_Detection.md) · [TC_AI_Human_Detection](tc/TC_AI_Human_Detection.md) — Group C | Config toggle (15 cases) | `node test/api/analytics_config.test.js` |
| ✅ `test/api/ai_detection_modules.test.js` | [TC_AI_Accessories_Detection](tc/TC_AI_Accessories_Detection.md) · [TC_AI_Animal_Detection](tc/TC_AI_Animal_Detection.md) · [TC_AI_Cloth_Analysis](tc/TC_AI_Cloth_Analysis.md) · [TC_AI_Color_Analysis](tc/TC_AI_Color_Analysis.md) · [TC_AI_Fire_Smoke_Detection](tc/TC_AI_Fire_Smoke_Detection.md) · [TC_AI_Hat_Detection](tc/TC_AI_Hat_Detection.md) · [TC_AI_Mask_Detection](tc/TC_AI_Mask_Detection.md) · [TC_AI_Vehicle_Detection](tc/TC_AI_Vehicle_Detection.md) | Groups A, B, D, F (61 cases) | `node test/api/ai_detection_modules.test.js` |
| ✅ `test/api/human_detection.test.js` | [TC_AI_Human_Detection](tc/TC_AI_Human_Detection.md) | A–D (graceful skip if model absent) | `node test/api/human_detection.test.js` |
| ✅ `test/api/object_tracking.test.js` | [TC_Object_Tracking](tc/TC_Object_Tracking.md) | A (Zone CRUD), B (Tracker Config), G (22 cases) | `node test/api/object_tracking.test.js` |
| ✅ `test/api/camera_discovery.test.js` | [TC_Camera_Discovery](tc/TC_Camera_Discovery.md) | A (Discovery), B (Registration), G (15 cases) | `node test/api/camera_discovery.test.js` |
| ✅ `test/api/face_gallery.test.js` | [TC_AI_Face_Recognition](tc/TC_AI_Face_Recognition.md) · [TC_Dashboard_Sidebar_Face_ID](tc/TC_Dashboard_Sidebar_Face_ID.md) | Group A (Gallery CRUD), E (15 cases) | `node test/api/face_gallery.test.js` |
| ✅ `test/api/face_enrollment.test.js` | [TC_AI_Face_Recognition](tc/TC_AI_Face_Recognition.md) · [TC_Dashboard_Sidebar_Face_ID](tc/TC_Dashboard_Sidebar_Face_ID.md) | Group B (Enrollment), G (8 cases) | `node test/api/face_enrollment.test.js` |
| ✅ `test/api/missing_persons.test.js` | [TC_AI_Face_Recognition](tc/TC_AI_Face_Recognition.md) · [TC_Dashboard_Sidebar_Face_ID](tc/TC_Dashboard_Sidebar_Face_ID.md) | Groups C, D (2 pass + 4 skip) | `node test/api/missing_persons.test.js` |
| ✅ `test/api/cross_camera_tracking.test.js` | [TC_CrossCamera_Face_Tracking](tc/TC_CrossCamera_Face_Tracking.md) | A (Trajectory), B (Stats), C (Persons), G (15 cases) | `node test/api/cross_camera_tracking.test.js` |
| ✅ `test/api/youtube_streams.test.js` | [TC_YouTube_RTSP_Ingest](tc/TC_YouTube_RTSP_Ingest.md) | A–G (14 cases) | `node test/api/youtube_streams.test.js` |
| ✅ `test/api/youtube_streams_lts2026.test.js` | [TC_LTS2026_YouTube_RTSP_Ingest](tc/TC_LTS2026_YouTube_RTSP_Ingest.md) | A–C (8 cases) | `node test/api/youtube_streams_lts2026.test.js` |
| ✅ `test/api/stats_panel.test.js` | [TC_Stats_Panel](tc/TC_Stats_Panel.md) | A–J (aggregation accuracy, error handling, hourly breakdown, items API) | `node test/api/stats_panel.test.js` |
| ✅ `test/api/webrtc.test.js` | [TC_WebRTC_Media_Gateway](tc/TC_WebRTC_Media_Gateway.md) | A–C (7 cases) | `node test/api/webrtc.test.js` |
| ✅ `test/api/webrtc_ice.test.js` | [TC_STUN_TURN_ICE](tc/TC_STUN_TURN_ICE.md) | A–B (7 cases) | `node test/api/webrtc_ice.test.js` |
| ✅ `test/api/https_tls.test.js` | [TC_HTTPS_TLS](tc/TC_HTTPS_TLS.md) | A, B, D, G (6 pass; HTTPS cases skip when server not in TLS mode) | `node test/api/https_tls.test.js` |
| ✅ `test/api/mcp_server.test.js` | [TC_LLM_MCP_Server](tc/TC_LLM_MCP_Server.md) | A, B, C, D, E (29 cases) | `node test/api/mcp_server.test.js` |
| ✅ `test/api/sidebar_cameras.test.js` | [TC_Dashboard_Sidebar_Cameras](tc/TC_Dashboard_Sidebar_Cameras.md) | B (Cameras REST), C (Add Camera), D (Search), G (13 pass + 4 skip) | `node test/api/sidebar_cameras.test.js` |
| ✅ `test/api/sidebar_alerts_zones.test.js` | [TC_Dashboard_Sidebar_Alerts_Zones](tc/TC_Dashboard_Sidebar_Alerts_Zones.md) | B (Alert Ack REST), D (Zone REST) (11 pass + 8 skip) | `node test/api/sidebar_alerts_zones.test.js` |
| ✅ `test/api/detection_snapshot_search.test.js` | [TC_Detection_Snapshot_Search](tc/TC_Detection_Snapshot_Search.md) | B, C, F, I (REST API + search + regression + filter chip tooltips, 26 cases) | `node test/api/detection_snapshot_search.test.js` |
| ✅ `test/api/auth.test.js` | [TC_User_Authentication](tc/TC_User_Authentication.md) | A–G (registration, sign-in, JWT, logout, admin, RBAC, regression) | `node test/api/auth.test.js` |
| 📋 `test/api/face_match_history.test.js` | [TC_Dashboard_Sidebar_Face_ID](tc/TC_Dashboard_Sidebar_Face_ID.md) | Group E (Match History CRUD) | `node test/api/face_match_history.test.js` |
| 📋 `test/api/storage_json.test.js` | [TC_Storage_MongoDB](tc/TC_Storage_MongoDB.md) | Groups A, B (JSON mode unit) | `node test/api/storage_json.test.js` |

### Phase-2 — Integration Tests (`test/integration/`)

| Script | Target TC Document(s) | Groups Covered | Run Command |
|---|---|---|---|
| 🕐 `test/integration/storage_mongo.test.js` | [TC_Storage_MongoDB](tc/TC_Storage_MongoDB.md) | Groups C, D, E, F, G, H, I (MongoDB mode) | `node test/integration/storage_mongo.test.js` |
| 🕐 `test/integration/face_pipeline.test.js` | [TC_AI_Face_Recognition](tc/TC_AI_Face_Recognition.md) | Groups D, F (Socket.IO face_match event) | `node test/integration/face_pipeline.test.js` |
| 🕐 `test/integration/main_pipeline.test.js` | [TC_LTS2026_Loitering_Tracking_System](tc/TC_LTS2026_Loitering_Tracking_System.md) | Groups G, H (Socket.IO events, pipeline E2E) | `node test/integration/main_pipeline.test.js` |

### Phase-3 — E2E Tests (`test/e2e/`)

| Script | Target TC Document(s) | Groups Covered | Run Command |
|---|---|---|---|
| 🖥 `test/e2e/dashboard_e2e.test.js` | [TC_Dashboard_Layout](tc/TC_Dashboard_Layout.md) · [TC_Dashboard_Detection_Display](tc/TC_Dashboard_Detection_Display.md) · [TC_Mobile_Layout](tc/TC_Mobile_Layout.md) | All groups (Playwright browser automation) | `node test/e2e/dashboard_e2e.test.js` |

### Utility Scripts

| Script | Purpose | Run Command |
|---|---|---|
| `test/generate_report.js` | Run full test suite and generate markdown report (`test/reports/report_YYYY-MM-DD_HH-MM.md`) | `node test/generate_report.js` |
| `test/run_all.js` | Run all Phase-1 suites at once; use `--skip e2e` to exclude Phase-3 | `node test/run_all.js --skip e2e` |

### Phase Coverage Summary

| Phase | Scope | Scripts | Status |
|---|---|---|---|
| Phase-1 (API) | REST API tests — 21 scripts (✅ exist) + 2 (📋 planned) | 23 | ✅ 265+ pass, 0 fail (existing) |
| Phase-2 (Integration) | Socket.IO / MongoDB integration tests — 3 scripts | 3 | 🕐 Planned |
| Phase-3 (E2E) | Playwright browser automation — 1 script (placeholder exists) | 1 | 🖥 Planned |

### Prerequisites

```bash
# 1. Verify server is running
curl https://localhost:3443/health

# 2. Place a real face photo for enrollment tests (TC-B-001)
cp /path/to/face_photo.jpg test/fixtures/face_clear.jpg

# 3. Run all Phase-1 tests
node test/run_all.js --skip e2e

# 4. Run a single suite
node test/api/camera_discovery.test.js

# 5. Generate test report (output: test/reports/report_YYYY-MM-DD_HH-MM.md)
node test/generate_report.js
```

### Test Fixture Files

| File | Purpose | Status |
|---|---|---|
| `test/fixtures/no_face.jpg` | Image with no human face (error path tests) | ✅ Auto-generated |
| `test/fixtures/face_clear.jpg` | Clear frontal face photo (enrollment success path) | ⚠ Manual placement required |
| `test/fixtures/face_side.jpg` | Side-angle face photo (angle filter test) | ⚠ Phase-2, manual |
| `test/fixtures/multi_face.jpg` | Photo with multiple faces (max-area selection test) | ⚠ Phase-2, manual |

---

## Changelog

| Date | Description |
|---|---|
| 2026-05-26 | Documentation hierarchy established — rfp/prd/srs/design/tc directories created |
| 2026-05-26 | Face Recognition module SRS, Design, TC authored |
| 2026-05-26 | test/ directory created + 3 initial API test scripts |
| 2026-05-27 | SDLC chain completed — missing Design (×4) and TC (×15) documents authored; all 25 modules fully covered |
| 2026-05-27 | Face ID Sidebar module extracted as standalone SDLC chain — RFP/PRD/SRS/Design/TC_Dashboard_Sidebar_Face_ID.md authored; pipelineManager.js face_tracking.json persistence implemented |
| 2026-05-27 | docs/README.md converted to English; test script status table updated with all 18 suites |
| 2026-05-27 | Storage — JSON/MongoDB module SDLC chain authored — RFP/PRD/SRS/Design/TC_Storage_MongoDB.md; dual-mode db.js + mongoDbService.js specification, index strategy, migration script design |
| 2026-05-27 | HTTPS/TLS module SDLC chain authored — RFP/PRD/SRS/Design/TC_HTTPS_TLS.md; `server/src/index.js` updated with conditional https.createServer, HTTP→HTTPS redirect, HSTS middleware; `server/.env` HTTPS variables added; test script `test/api/https_tls.test.js` created |
| 2026-05-27 | Detection Snapshot & Search module SDLC chain authored — RFP/PRD/SRS/Design/TC_Detection_Snapshot_Search.md; `sharp`-based JPEG bbox crop design; `detectionSnapshots` DB table schema; `snapshotService.js`, `api/snapshots.js`, `api/search.js` specification; client `SearchBar.tsx` + `useSearch.ts` design; pipelineManager hook design; test script `test/api/detection_snapshot_search.test.js` |
| 2026-05-27 | Face ID Sidebar v1.1 SDLC amendment — RFP/PRD/SRS/Design/TC_Dashboard_Sidebar_Face_ID.md all updated to v1.1; added Live Match Crop feature (`liveCropData` in `face_match` event via `setImmediate` + `sharp` crop of detected face bbox), `faceMatchHistory` DB table persistence, `GET /api/search?types=matches` endpoint, SearchBar `match` result type, MatchLog dual-photo layout |
| 2026-05-27 | **DB persistence hardening** — `server/src/db.js` redesigned: `persistJson()` now debounced (2 s, coalesces rapid inserts), `_flushJson()` uses atomic write (`writeFileSync` → `renameSync` via `lts.json.tmp`), `flushNow()` exported for graceful shutdown; `server/src/index.js` calls `flushNow()` on `SIGTERM`/`SIGINT` before `httpServer.close()`; verified `server/storage/lts.json` (36.3 MB, 9 tables) as active DB path |
| 2026-05-27 | **Search API improvements** — `server/src/api/search.js`: `DEFAULT_TYPES` extended with `events`, new events-table search branch (type/cameraName/className/zoneName/message), `isLoitering=true` keyword detection for `q=loitering`, all sort comparators replaced with `new Date(ts).getTime()` to fix `localeCompare` TypeError on Unix ms timestamps |
| 2026-05-27 | **SDLC v1.1 amendments** — Design/SRS/TC_Detection_Snapshot_Search.md updated to v1.1 (§11 search improvements + persistence NFRs + Groups G/H test cases); Design/SRS/TC_Storage_MongoDB.md updated to v1.1 (§15 atomic write + debounce design, NFR-STORE-015/016/017, Group J test cases TC-J-001~006) |
| 2026-05-27 | **SearchFullscreen filter chip i18n + search API bug fix** — `SearchFullscreen.tsx` `TYPE_CHIPS` replaced with `getTypeChips(t)` function so chip labels and tooltips reflect the selected language; search placeholder, sort, date, result-count strings fully i18n-ized; 15 language translation files updated with `searchChip*`, `searchPlaceholder`, etc. keys; `server/src/api/search.js` bug fixed where `types=faces` requests incorrectly included `faceMatchHistory` (`_type:match`) results |
| 2026-05-28 | **docs/README.md restored to English** — all sections converted back from Korean to English |
| 2026-05-28 | **User Authentication SDLC chain completed** — `RFP_User_Authentication.md` authored (FR-AUTH-001–030, NFR-AUTH-001–009, AC-001–010); `test/api/auth.test.js` created (Groups A–G: registration, sign-in, JWT, logout, admin mgmt, RBAC, regression); `docs/README.md` updated with module row and test script row |
| 2026-05-28 | **Stats Dashboard Panel v1.2** — Full-screen layout (remove max-w-[420px]); drill-down navigation (Overview → Section → HourList → ItemDetail); `GET /api/stats/items` endpoint added; `BreadcrumbNav`, `OverviewGrid`, `SectionDrillView`, `HourListView`, `ItemDetailView` components; ESC key navigation; Design/SRS/TC_Stats_Panel.md all updated to v1.2 (FR-STATS-031–042, NFR-STATS-009–010, Group J TC-J-001–14, Group K TC-K-001–20) |
| 2026-05-28 | **MongoDB 5.0 adopted as primary storage** — installed on Ubuntu 18.04 (Bionic) via official apt repo; `mongod` service enabled; existing `server/storage/lts.json` data migrated via `mongoimport` (cameras ×9, detectionSnapshots ×431, total 419 docs); `DB_TYPE=mongodb` set in `server/.env`; setup guide moved to `docs/ops/MongoDB_Setup.md` |
| 2026-05-28 | **`docs/development_process.md` integrated into `docs/README.md`** — Development Process Overview section added (MRD→DIA→DV→DVR→PIA→PV→PVR→PR→PRA→SR→SRA stage-gate table, key deliverables, core document flow); source file retired |
| 2026-05-28 | **`docs/MRD_LTS2026.md` created** — Market Requirements Document synthesized from all RFP/PRD/codebase status (Phase 1–11); covers market problem, TAM/SAM/SOM, customer segments, competitive matrix, 11 core + 11 AI modules, business requirements, 7 market use cases, regulatory compliance, KPIs, roadmap alignment |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — README |
