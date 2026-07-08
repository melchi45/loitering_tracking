# MRD — Face Match History Persistence & Display

**Product:** LTS-2026 Loitering Detection & Tracking System
**Feature:** Persisted, camera-named face match history + Fullscreen Detections timeline integration
**Version:** 1.0
**Date:** 2026-07-08
**Author:** LTS Engineering Team

---

## 1. Executive Summary

The Face ID tab's "Live Matches" panel only ever reflects events received over the live `face_match` Socket.IO connection since the page was opened — refreshing the browser clears it, even though every match is already durably written to the `faceMatchHistory` DB table (MongoDB or JSON depending on `DB_TYPE`). Separately, each match entry identifies its camera by a raw internal ID rather than the camera's configured name, and matches are invisible from the per-camera Fullscreen view's Detections timeline, where an operator reviewing a specific camera's activity would most naturally look for "was anyone recognized here, and when."

This MRD covers making match history durable-and-readable end-to-end (not just written), human-readable (camera name, not ID), and visible in the one other place operators already look for time-correlated camera activity.

---

## 2. Market / Operational Need

| Pain Point | Impact |
|---|---|
| Live Matches list empties on every page refresh | Operators lose the incident record the moment they reload, hand off a shift, or the browser tab restarts — despite the data existing in the DB |
| Camera identified by internal ID/hash in the match log | Operators cannot tell which physical camera raised a match without cross-referencing the camera list separately |
| Face matches are invisible in the per-camera Fullscreen Detections timeline | An operator reviewing one camera's history has no way to correlate "a recognized identity" with that camera's other detection activity at a glance |

---

## 3. Target Users

| User | Context |
|---|---|
| Security Operator | Monitors the Face ID tab's Live Matches for real-time recognition; needs the same record to survive a page reload and to name the camera plainly |
| Security Administrator / Investigator | Reviews a specific camera's Fullscreen Detections timeline after an incident; needs face-match events correlated with that camera's other activity, not just the isolated matching gallery record |

---

## 4. Business Requirements

| ID | Requirement |
|---|---|
| BR-01 | Face match events must be retrievable via REST API from the already-existing `faceMatchHistory` persistence, not solely observable through the live Socket.IO stream |
| BR-02 | The Face ID tab must load recent match history on page load/refresh, not start empty |
| BR-03 | Every match record (live and historical) must identify its camera by name, falling back to ID only when no name is resolvable |
| BR-04 | A camera's Fullscreen Detections timeline must show that camera's face-match events, time-correlated with its other detection activity, with the matched face's captured image reachable from the marker |

---

## 5. Success Metrics

- Reloading the Face ID tab shows the same recent matches that were visible before the reload
- Every visible match entry (live or historical) shows a real camera name for any camera still configured in the system
- Opening a camera's Fullscreen view → Detections tab shows a marker for every face match recorded against that camera within the visible time range, clickable to reveal the matched thumbnail

---

## 6. Out of Scope

- Changing the `face_match`/`missing_person_match` Socket.IO event names, cooldown behavior, or matching threshold
- Retroactively backfilling `cameraName` onto match records persisted before this feature ships (historical rows without it fall back to a client-side camera-store lookup, then to the raw ID)
- Joining face-match markers onto a specific person's Gantt bar in the Detections timeline (a dedicated marker row is used instead — see Design doc)

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-08 | 초기 작성 — 얼굴 매칭 이력 영속화·조회, 카메라 이름 표시, Detections 타임라인 연동 |
