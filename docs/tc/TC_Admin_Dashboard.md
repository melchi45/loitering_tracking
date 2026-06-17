---
**Document:** TC_Admin_Dashboard  
**Version:** 1.0  
**Status:** Draft  
**Date:** 2026-06-17  
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

**Expected:** Four items visible: 👥 Users · 🤖 AI Models · 📡 ONVIF · 📋 Audit Log  
**Priority:** P1

---

### TC-AD-004: AI Models Catalog Display

**Pre-condition:** Analysis server running; Admin Dashboard → AI Models section  
**Steps:**
1. Click "AI Models" in sidebar
2. Observe the YOLO Detection Model table

**Expected:**
- Three series groups displayed: YOLO12, YOLO11, YOLOv8
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

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-17 | 초기 작성 — TC-AD-001~011, AI Models 섹션 및 접근 제어 테스트 |
