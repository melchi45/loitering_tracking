# TEST CASES (TC)
# Face Match → Detections Timeline Navigation

| | |
|---|---|
| **Document ID** | TC-LTS-FMN-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-07-08 |
| **Parent SRS** | srs/SRS_Face_Match_Timeline_Navigation.md |
| **Test Scripts** | test/api/face_match_timeline_navigation.test.js |

---

## Table of Contents
1. [Test Strategy](#1-test-strategy)
2. [Test Group A — Join Key Contract](#2-test-group-a--join-key-contract)
3. [Test Group B — Manual Verification (UI)](#3-test-group-b--manual-verification-ui)
4. [Pass/Fail Criteria](#4-passfail-criteria)

---

## 1. Test Strategy

This feature is almost entirely client-side (prop plumbing + local React state); there is no new server endpoint. Automated coverage (Group A) verifies the API-level contract the navigation logic depends on — that `{faceId, timestamp}` is a usable join key and that the `from`/`to` window shape used for centering is accepted consistently by both `match-history` and `detection-tracks`. Group B documents the manual UI verification steps performed for AC-01~AC-07 (SRS `SRS_Face_Match_Timeline_Navigation.md`), since clicking a UI element and observing a component re-render isn't practical to assert from a pure API test.

## 2. Test Group A — Join Key Contract

**Script:** `test/api/face_match_timeline_navigation.test.js`

### TC-FMN-A-001 — Match Entries Carry faceId + timestamp
- **SRS:** FR-FMN-004, §6.1
- **Steps:**
  1. `GET /api/galleries/match-history?limit=20`
  2. If `data.length === 0` → SKIP with reason `'no match history available'`
  3. Else: assert every entry has a non-empty string `faceId` and a numeric `timestamp`

### TC-FMN-A-002 — ±30-Minute Window Round Trip
- **SRS:** FR-FMN-004
- **Steps:**
  1. `GET /api/galleries/match-history?limit=1` — take the first entry's `timestamp` (or SKIP if empty)
  2. Compute `from`/`to` as `timestamp ± 30min`, ISO-formatted (mirroring the client's centering logic)
  3. `GET /api/galleries/match-history?from=<from>&to=<to>`
  4. Assert the original entry's `id` appears in the response — confirms the exact window the navigation feature applies actually retrieves the target match

### TC-FMN-A-003 — Same Window Shape Accepted by detection-tracks
- **SRS:** FR-FMN-004, FR-FMN-020
- **Steps:**
  1. Using the same `from`/`to` pair from TC-FMN-A-002, `GET /api/analysis/detection-tracks?cameraId=<any>&from=<from>&to=<to>`
  2. Assert HTTP 200 and `Array.isArray(body.tracks)` — confirms both fetches `DetectionsTimelineInline.tsx` makes for a centered view accept an identical `from`/`to` format

## 3. Test Group B — Manual Verification (UI)

Not automated — performed via browser interaction per `PRD_Face_Match_Timeline_Navigation.md` §7:

| Case | SRS | Verification |
|---|---|---|
| Click navigates to correct camera | FR-FMN-001, FR-FMN-002 | Fullscreen view opens for the exact camera of the clicked match |
| Opens on Detections tab | FR-FMN-003 | `videoTab` is `'detections'` immediately, not `'onvif'` |
| Timeline centered on match | FR-FMN-004 | Match marker visible without manual pan/zoom |
| Detail auto-revealed | FR-FMN-005 | Popover visible without an additional click |
| Normal open unaffected | FR-FMN-006 | Double-click still opens on `'onvif'` / `'1H'` range |
| Scrollbar fit | FR-FMN-010 | Live Matches list scrolls independently at reduced sidebar height, no double scrollbar |

## 4. Pass/Fail Criteria

| Level | Meaning | Action |
|---|---|---|
| FAIL | Join key missing/unusable, or the shared window shape is rejected by either endpoint | **BLOCK** — must fix |
| SKIP | No match history present in the test environment | Acceptable — this suite verifies the contract, not live pipeline behavior |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-07-08 | LTS Engineering Team | Initial release — TC for Face Match Timeline Navigation |
