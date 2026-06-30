# MRD — ONVIF Event Timeline Zoom Controls

**Product:** LTS-2026 Loitering Detection & Tracking System  
**Feature:** ONVIF Event Timeline — Zoom In / Zoom Out Button Controls  
**Version:** 1.0  
**Date:** 2026-06-30  
**Author:** LTS Engineering Team

---

## 1. Executive Summary

The ONVIF Event Timeline already supports mouse-wheel zoom, but this input method is unavailable on touch devices, kiosk terminals, and many laptop trackpads. Operators working during an incident cannot reliably zoom the timeline without a scroll wheel. Adding dedicated **+** (zoom in) and **−** (zoom out) buttons in the control bar makes zoom universally accessible alongside the existing wheel mechanism.

---

## 2. Market / Operational Need

| Pain Point | Impact |
|---|---|
| Wheel-only zoom inaccessible on touch / kiosk | Field operators cannot inspect specific time windows |
| No visual affordance for zoom | New users do not discover scroll-to-zoom |
| Cannot reach specific zoom level precisely | Repeated wheel scroll needed; imprecise on non-discrete devices |

---

## 3. Target Users

| User | Context |
|---|---|
| Security Operator | Reviews ONVIF fire/motion events on a desktop workstation |
| Field Technician | Uses a laptop trackpad or remote desktop session to inspect events |
| Kiosk / Wall Screen User | No mouse available; relies on on-screen controls only |

---

## 4. Business Requirements

| ID | Requirement |
|---|---|
| BR-01 | Operators must be able to zoom the ONVIF timeline without a scroll wheel |
| BR-02 | Zoom controls must be visible in the same control bar as Refresh |
| BR-03 | The − button must be visually disabled when zoom is already at minimum (1×) |
| BR-04 | Zoom step must match the existing scroll-wheel step for consistent UX |
| BR-05 | Zoom level badge (×N.N) must update immediately when buttons are pressed |

---

## 5. Success Metrics

- 100% of operators on touch/kiosk environments can change zoom level without a pointing device
- Button zoom step feels identical to one wheel click (subjective QA check)
- No regression in existing wheel zoom or drag-pan behaviour

---

## 6. Out of Scope

- Touch pinch-to-zoom gesture
- Zoom level input field (type exact value)
- Saving zoom preference between sessions

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-30 | 초기 작성 |
