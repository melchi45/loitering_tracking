# SRS — ONVIF Event Timeline Zoom Controls

**Product:** LTS-2026 Loitering Detection & Tracking System  
**Feature:** ONVIF Event Timeline — Zoom In / Zoom Out Button Controls  
**Version:** 1.0  
**Date:** 2026-06-30

---

## 1. Introduction

This document specifies the software requirements for adding explicit zoom-in and zoom-out button controls to the `OnvifTimelineInline` component in the LTS-2026 ONVIF Event Timeline.

---

## 2. Scope

- **In scope**: + / − zoom buttons in `OnvifTimelineInline` control bar; disabled state for − at minimum zoom
- **Out of scope**: `OnvifTimelineOverlay`, touch pinch gesture, persistent zoom preference

---

## 3. Functional Requirements

### FR-ZM-001 — Zoom In Button

The control bar SHALL include a `+` button that, when clicked, calls `applyZoom(1.4)`.

- The button SHALL always be rendered (not conditionally hidden)
- The button SHALL use `title="Zoom in"` for tooltip accessibility
- `applyZoom(1.4)` SHALL multiply the current `zoom` state by `1.4`, clamped at `500`

**Acceptance**: Clicking `+` once at zoom = 1 SHALL result in zoom = 1.4. Clicking at zoom = 500 SHALL leave zoom at 500.

### FR-ZM-002 — Zoom Out Button

The control bar SHALL include a `−` button that, when clicked, calls `applyZoom(1/1.4)`.

- The button SHALL be disabled (`disabled` HTML attribute) when `zoom ≤ 1`
- When disabled, the button SHALL have `opacity-30` and `cursor-not-allowed` styling
- The button SHALL use `title="Zoom out"` for tooltip accessibility
- `applyZoom(1/1.4)` SHALL divide the current `zoom` by `1.4`, floored at `1`

**Acceptance**: Clicking `−` once at zoom = 1.4 SHALL result in zoom ≈ 1.0 (minimum). Clicking when disabled SHALL have no effect.

### FR-ZM-003 — Button Placement

The `+` and `−` buttons SHALL be placed in the existing control bar (`flex items-center gap-1`) immediately to the left of the Refresh (↺) button.

Order from left to right: `[zoom badge]` `[+]` `[−]` `[↺]` `[count]`

The zoom badge (`×N.N`) MUST appear to the left of the `+` button (existing conditional render unchanged).

### FR-ZM-004 — Shared applyZoom Logic

Both buttons SHALL call the existing `applyZoom(factor: number)` helper:

```typescript
const applyZoom = useCallback((factor: number) =>
  setZoom(z => Math.max(1, Math.min(z * factor, 500))), []);
```

No new zoom calculation logic SHALL be introduced — buttons reuse the wheel handler's helper.

### FR-ZM-005 — Zoom Factor Consistency

The zoom step for both buttons SHALL be `1.4` — identical to one mouse wheel tick on the overview strip — so that the two input methods feel equivalent.

### FR-ZM-006 — Pan State Preservation

Clicking `+` or `−` SHALL NOT reset `pan`. Existing pan clamp behaviour (`useEffect(() => { if (zoom === 1) setPan(0); }, [zoom])`) remains in force: when zoom returns to 1 via `−`, pan resets to 0 automatically.

---

## 4. Non-Functional Requirements

### NFR-ZM-01 — Layout Stability

Adding the two buttons SHALL NOT cause the control bar to wrap at viewport widths ≥ 1280 px.

### NFR-ZM-02 — No Additional State

The buttons SHALL reuse the existing `zoom` state. No new state variables SHALL be added for the zoom buttons.

### NFR-ZM-03 — No Regression

All existing zoom interactions (wheel, drag-pan, ◀ ▶ buttons, range reset, ✕ reset) SHALL continue to function identically after the change.

---

## 5. Component Map

| Component | File | Change |
|---|---|---|
| ONVIF Timeline (inline) | `client/src/components/OnvifTimelineInline.tsx` | Add `+` / `−` buttons in control bar |

No server-side, store, or API changes required.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-30 | 초기 작성 |
