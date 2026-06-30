# TC — ONVIF Event Timeline Zoom Controls

**Product:** LTS-2026 Loitering Detection & Tracking System  
**Feature:** ONVIF Event Timeline — Zoom In / Zoom Out Buttons  
**Version:** 1.0  
**Date:** 2026-06-30  
**SRS Reference:** SRS_ONVIF_Timeline_Zoom.md

---

## Test Cases

### TC-ZM-001: Zoom In button is present in control bar

**SRS:** FR-ZM-001, FR-ZM-003  
**Precondition:** FullscreenCameraView open, ONVIF Timeline tab selected  
**Steps:**
1. Observe the control bar

**Expected:** A `+` button is visible to the left of the Refresh (↺) button; tooltip reads "Zoom in"

---

### TC-ZM-002: Zoom Out button is present in control bar

**SRS:** FR-ZM-002, FR-ZM-003  
**Precondition:** FullscreenCameraView open, ONVIF Timeline tab selected  
**Steps:**
1. Observe the control bar

**Expected:** A `−` button is visible between `+` and Refresh; tooltip reads "Zoom out"; button appears grayed (disabled) at initial 1× zoom

---

### TC-ZM-003: Clicking + zooms in

**SRS:** FR-ZM-001, FR-ZM-005  
**Precondition:** zoom = 1 (default)  
**Steps:**
1. Click the `+` button once

**Expected:**
- Zoom badge `×1.4` appears in the control bar
- The visible time window narrows (overview bars become wider)
- `−` button becomes enabled

---

### TC-ZM-004: Repeated + clicks accumulate zoom

**SRS:** FR-ZM-001  
**Steps:**
1. Click `+` five times from zoom = 1

**Expected:** Zoom badge shows approximately `×5.4` (1.4⁵ ≈ 5.38); visible window narrows progressively

---

### TC-ZM-005: Clicking − zooms out

**SRS:** FR-ZM-002, FR-ZM-005  
**Precondition:** zoom > 1 (e.g. after clicking + twice → ×1.96)  
**Steps:**
1. Click the `−` button once

**Expected:** Zoom decreases by ÷1.4 (≈ ×1.4 from ×1.96); visible window widens

---

### TC-ZM-006: − button disabled at zoom = 1

**SRS:** FR-ZM-002  
**Precondition:** zoom = 1 (initial state or after full zoom-out)  
**Steps:**
1. Observe `−` button
2. Attempt to click it

**Expected:** Button is visually grayed (opacity reduced); click has no effect; zoom remains at 1

---

### TC-ZM-007: − button at zoom ≈ 1.4 returns to 1×

**SRS:** FR-ZM-002, FR-ZM-006  
**Precondition:** zoom = 1.4 (one + click from default)  
**Steps:**
1. Click `−` once

**Expected:** Zoom returns to exactly 1×; zoom badge disappears; pan resets to 0; `−` button becomes disabled

---

### TC-ZM-008: Zoom step matches wheel zoom

**SRS:** FR-ZM-005  
**Steps:**
1. From zoom = 1, scroll wheel up once on the overview strip
2. Note the zoom badge value
3. Reset (click range button), then click `+` once
4. Compare the zoom badge values

**Expected:** Both show the same value (≈ ×1.4); visual width of event bars is identical

---

### TC-ZM-009: Button zoom does not reset pan

**SRS:** FR-ZM-006  
**Precondition:** zoom > 1; pan ≠ 0 (dragged left or right)  
**Steps:**
1. Click `+` once more

**Expected:** Pan position is preserved; the visible window moves in, not snapping back to the latest time

---

### TC-ZM-010: Button zoom at maximum (500×)

**SRS:** FR-ZM-001  
**Steps:**
1. Click `+` repeatedly until badge shows ×500 or stops changing

**Expected:** Badge shows `×500.0` (or maximum); further clicks have no visible effect; no error thrown

---

### TC-ZM-011: Range preset button resets zoom

**SRS:** FR-ZM-006 (interaction)  
**Precondition:** zoom > 1 via + button  
**Steps:**
1. Click any range preset (e.g. `1H`)

**Expected:** zoom resets to 1; zoom badge disappears; `−` button becomes disabled again

---

### TC-ZM-012: Existing wheel zoom still works after + / − buttons added

**SRS:** NFR-ZM-03  
**Steps:**
1. Scroll wheel up on the overview strip
2. Scroll wheel down

**Expected:** Wheel zoom still works as before; no regression

---

### TC-ZM-013: Control bar does not wrap on standard width

**SRS:** NFR-ZM-01  
**Precondition:** Fullscreen view on a 1280 px wide display  
**Steps:**
1. Open ONVIF Timeline tab

**Expected:** Control bar fits in a single row; no line wrap visible; all buttons accessible without scrolling

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-30 | 초기 작성 — TC-ZM-001 ~ TC-ZM-013 |
