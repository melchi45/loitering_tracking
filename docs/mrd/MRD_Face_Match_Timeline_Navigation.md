# MRD — Face Match → Detections Timeline Navigation

**Product:** LTS-2026 Loitering Detection & Tracking System
**Feature:** Click a Live Match to jump to that camera's Fullscreen Detections timeline
**Version:** 1.0
**Date:** 2026-07-08
**Author:** LTS Engineering Team

---

## 1. Executive Summary

The Face ID tab's Live Matches list (added and made persistent in a prior fix, see [MRD_Face_Match_History.md](MRD_Face_Match_History.md)) and the per-camera Fullscreen Detections timeline (which gained a face-match marker row in that same fix) are today two disconnected views of the same underlying fact. An operator who spots a match in the Face ID tab has no way to jump to that camera's broader detection context — they must manually reopen the camera and hunt for the right time window. This feature closes that loop: clicking a match navigates directly to that camera's Fullscreen view, opens the Detections tab, and centers the timeline on that exact match with its detail already visible.

Separately, the Face ID tab's Live Matches list can produce two competing scrollbars on a short sidebar (a fixed-height inner list nested inside an already-scrolling outer panel) — fixed alongside this feature since both touch the same component.

---

## 2. Market / Operational Need

| Pain Point | Impact |
|---|---|
| No path from "a match happened" to "what else was this camera seeing at that moment" | Operators manually reopen the camera and search by approximate time to correlate a match with surrounding activity |
| Face ID tab's match list scrollbar doesn't fit a short sidebar | Live Matches becomes hard to read/scroll on smaller screens or collapsed layouts |

---

## 3. Target Users

| User | Context |
|---|---|
| Security Operator | Spots a match in the Face ID tab and wants immediate camera-level context without manual navigation |
| Security Administrator / Investigator | Reviews a specific match in the context of that camera's full Detections timeline during an incident review |

---

## 4. Business Requirements

| ID | Requirement |
|---|---|
| BR-01 | Clicking a Live Match entry must open that match's camera in the Fullscreen view |
| BR-02 | The Fullscreen view must open directly on the Detections tab, not the default tab |
| BR-03 | The Detections timeline must be centered on the clicked match's timestamp, with that match's detail already visible, without further operator interaction |
| BR-04 | The Face ID tab's Live Matches list must fit within its available space without producing a second, competing scrollbar |

---

## 5. Success Metrics

- Clicking any Live Match entry results in the correct camera's Detections timeline, visibly containing that match, within one interaction
- No manual date-range adjustment is needed to see the clicked match on the timeline
- Live Matches list scrolls cleanly on sidebar heights where it previously produced overlapping scrollbars

---

## 6. Out of Scope

- Deep-linking via URL (e.g. a shareable link that reproduces this navigation) — in-session state only
- Any change to the matching pipeline, `faceMatchHistory` schema, or the `GET /api/galleries/match-history` endpoint contract established in the prior fix

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-08 | 초기 작성 — Live Match 클릭 시 카메라 Detections 타임라인 이동, Face ID 탭 스크롤바 수정 |
