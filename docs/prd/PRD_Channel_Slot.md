# PRD — Dashboard Channel Slot

**Product:** LTS-2026 Loitering Detection & Tracking System
**Feature:** Global Channel Slot Mapping for Cameras / YouTube Streams
**Version:** 1.8
**Date:** 2026-07-02

---

## 1. Overview

Cameras and YouTube streams gain a persistent **Channel Slot** number (1..`MAX_CHANNEL_NUM`, default 512) that determines where they appear in the Streaming Dashboard grid, independent of insertion order. Operators pick the slot at Add time (or change it later at Edit time) using either a numeric stepper or a group browser that pages through the channel space in the same increments as the current grid layout. NVR sub-channel selection (SUNAPI/ONVIF `MaxChannel`) — already available at Add time via auto-discovery — becomes available at Edit time too.

---

## 2. User Stories

| ID | Story |
|---|---|
| US-01 | As an installer, I want to assign camera "Front Gate" to Channel 1 so operators always find it there, regardless of when it was added relative to other cameras |
| US-02 | As an installer, I want to reserve Channel 5 for a camera that will be physically installed next week, without adding a placeholder camera |
| US-03 | As an operator, I want the dashboard grid to show an empty "CH 5 — Unassigned" tile instead of silently skipping the number, so I know 5 is reserved and not just missing |
| US-04 | As an installer on a 300-camera site, I want to page through channel groups (e.g. 1-16, 17-32, ...) to quickly find the next free number, instead of scrolling a flat camera list |
| US-05 | As an installer adding a Wisenet 32-channel NVR, I want to pick which physical NVR channel (0/1..32) a given dashboard entry reads from, same as today |
| US-06 | As an installer, I want to later realize channel 7 on that NVR was mis-wired and switch an already-added camera to read from channel 8 instead, without deleting and re-adding it (losing its zone/AI config) |
| US-07 | As an operator, I want the Channel Group paging arrows on the live dashboard to say which group I'm viewing (e.g. "Channels 17–32 of 512"), not just a bare arrow |

---

## 3. Feature Requirements

### 3.1 Channel Slot Field

- Range: `1..MAX_CHANNEL_NUM` (integer), unique across every camera/YouTube-stream record in the system
- `MAX_CHANNEL_NUM` is a server operator setting (`server/.env`, default `512`), not user-editable from the UI
- Distinct from, and independent of, the existing NVR sub-channel field (`channelIndex`) — a camera may have both

### 3.2 Add / Edit Form — Channel Section

```
┌─ Channel ──────────────────────────────────────────────────────────┐
│  Slot:  [ - ]  [   17   ]  [ + ]                                    │
│                                                                       │
│  Browse:            ◀  Group 2 of 32 (CH 17–32)  ▶                 │
│  [17][18][19][20][21][22][23][24][25][26][27][28][29][30][31][32]  │
│   ▲free  ▓taken(Front Gate)  ■selected                              │
└───────────────────────────────────────────────────────────────────┘
```

- Stepper and group-browser grid are always both visible together, always in sync
- Taken slots in the group grid are disabled buttons showing the occupying camera's name on hover; clicking a free slot selects it and updates the stepper value
- Group page size = the `channels` value of the layout currently active on the dashboard the operator came from (falls back to a sensible default, e.g. 16, if opened from a context with no active layout)
- Default selection on opening "Add Camera": lowest currently-free slot

### 3.3 NVR Channel Section

The channel button grid appears once `maxChannel > 1` is known (from SUNAPI or ONVIF), either because the camera came from a discovery scan, or because the operator triggered an on-demand detection:

```
┌─ NVR Channel (Wisenet 32CH, max 32)              [🔍 Re-detect]     ─┐
│  [CH1][CH2][CH3]...[CH8]▓...[CH32]     ▓ = currently selected        │
└───────────────────────────────────────────────────────────────────┘
```

- Present in the discovery-based Add flow (existing), the manual Add flow (new — see 3.3a), and the Edit modal (new — see 3.3b)
- Changing the NVR channel updates `channelIndex` and re-resolves `rtspUrl` automatically; the operator sees the new RTSP URL reflected in the (read-only, in Edit) URL preview before saving

### 3.3a On-Demand Detection — Manual Add Form

The manual "Add Camera" form (typed RTSP URL, no discovery scan) shows a **Detect Channels** button next to the RTSP URL field:

```
RTSP URL *  [ rtsp://192.168.1.10:554/profile1/media.smp        ]
            [ 🔍 Detect Channels ]
            SUNAPI — 8CH NVR detected
            [CH1]▓[CH2][CH3][CH4][CH5][CH6][CH7][CH8]
```

Clicking it queries the IP parsed from the typed RTSP URL (plus Username/Password if filled in) for SUNAPI/ONVIF channel info, without requiring the operator to first run a network-wide discovery scan. If no multi-channel NVR is found, a small "single-channel camera" note is shown instead of the button grid.

### 3.3b On-Demand Re-detection — Edit Modal

The Edit modal's NVR Channel section always shows a **Re-detect** button, even for cameras with no channel data yet (e.g. added before this feature, or added manually before 3.3a existed):

```
┌─ NVR Channel                                     [🔍 Re-detect]     ─┐
│  No NVR channel data yet — click Re-detect to query SUNAPI/ONVIF     │
│  for this camera's IP.                                               │
└───────────────────────────────────────────────────────────────────┘
```

A successful re-detection reveals the channel button grid immediately (same modal session), and is only written to the camera's stored record when the operator saves the form.

### 3.3c Found-Tab Discovery Panel — Re-detect (does not duplicate 3.3a)

The Found-tab panel (`DiscoveredCameraPanel.tsx`) already carries channel data from its own network scan, so it does not need a "Detect Channels" button like the manual Add form (3.3a) — that would just repeat work already done. It does get a **Re-detect** button next to the existing channel-count field, for the case where the scan's result has gone stale or was incomplete:

```
┌─ Channels ────────────────────────────────────────────────────────┐
│ [8 CH]  [ 8 ] manual  [🔍 Re-detect]                                │
│ Re-detect (SUNAPI) — 8CH confirmed                                  │
└───────────────────────────────────────────────────────────────────┘
```

- Clicking it re-queries the same IP directly (reusing the panel's already-known HTTP port/scheme/credentials — no re-parsing needed, unlike 3.3a which only has a raw RTSP URL string to work with)
- Result updates the channel-count and channel-selection grid in place; a "nothing found" result still shows a message (same three-way feedback rule as 3.3b, not a silent no-op)
- `+ Add to System` uses the Re-detect result over the original scan data when the operator ran one

### 3.4 Streaming Dashboard Grid

- Grid cell N always shows the camera whose Channel Slot is `groupStart + N`; empty if none
- Empty cells: dashed border, channel number, "Unassigned" label, no camera controls
- `< >` navigation relabeled "Channel Group X of Y (CH a–b)"; mobile swipe gesture unchanged, now moves between channel groups instead of array pages

### 3.5 Conflict Handling

- Selecting an already-taken slot in either control marks it clearly (disabled/highlighted red) before submit; if a race condition still produces a conflict at submit time, the server 409 is shown as an inline error and the form stays open with all other fields intact

### 3.6 Detection Diagnostics (operator-facing, log-based, 2026-07-02)

"Detect Channels"/"Re-detect" (3.3a/3.3b/3.3c) report only a pass/fail result to the UI — a device that's unreachable on the guessed port, one that rejected the supplied credentials, and one that is genuinely single-channel all render as the same "no multi-channel NVR found" message, by design (there's no useful further breakdown to show a non-technical operator in the modal itself). For an admin/installer who needs to know *which* of those it actually was, setting `LOG_LEVEL=DEBUG` in `server/.env` makes the server log the individual SUNAPI/ONVIF calls each detection makes and why each one succeeded or failed — viewable via the Admin Dashboard's Server Logs panel or the log file directly. This is off by default (`LOG_LEVEL=INFO`) and adds no UI surface of its own; see `docs/ops/Channel_Slot_Guide.md` §5.2 for the operator-facing walkthrough.

### 3.6a Edit Modal "Re-detect" No Longer Retries a Camera It Already Knows Has No Password (2026-07-02)

The diagnostics in 3.6 surfaced a specific case worth fixing outright rather than just logging: clicking "Re-detect" (3.3b) against a camera that was added with no username/password on file was silently attempting — and failing — a SUNAPI query on every single click. The camera's own record already answers "can this authenticate," so the retry added nothing but a delay and a failed-connection log line every time. Re-detect now checks the camera's stored credentials first and skips the SUNAPI half of the probe outright when none are on file (falling through to the ONVIF half only) — no visible UI change, the result message (3.6/§4 Edge Cases) is unaffected, just fewer pointless network attempts. This does not apply to 3.3a (manual Add, no camera record yet) or 3.3c (Found-tab, uses the scan's own captured credentials) — both keep trying an unauthenticated probe since, for those, "no credentials yet" isn't evidence of "will never work."

### 3.7 Background Discovery — Channel Detection Now Prefers Broadcast Data Over CGI Query (2026-07-02)

This is an internal efficiency/correctness change with no new UI, but it does change what an installer sees during a network scan: the "Found" tab's channel-count badge (`N CH`) now populates from the UDP discovery broadcast itself wherever possible, instead of from a follow-up HTTP request to the camera's SUNAPI web interface. Practically:

- **Fewer failed lookups on password-protected NVRs.** Previously, every SUNAPI-flagged device on every scan triggered an unauthenticated CGI probe that would simply 401 against any camera with authentication enabled (the common case on modern firmware) — that probe is no longer attempted unless the installer has configured default SUNAPI credentials (`server/.env` `RTSP_DEFAULT_USERNAME`/`RTSP_DEFAULT_PASSWORD`)
- If those credentials ARE configured, the CGI probe still runs, but now only as a fallback — i.e. only for devices where the broadcast data alone didn't already report multiple channels
- The same fix applies to the Found tab's manual "rescan" trigger (Socket.IO path), not just the automatic periodic scan — both shared the identical unguarded call
- **Known limitation, tracked for follow-up:** extracting the channel count directly from the UDP broadcast itself requires confirming an exact field position in the vendor's binary protocol spec, which is still pending (see `docs/design/Design_Channel_Slot.md` §4.6c). Until that lands, the CGI fallback (gated on configured credentials, above) remains the only automatic way multi-channel NVRs get detected during a background scan — the manual "Detect Channels"/"Re-detect" buttons (3.3a/3.3b/3.3c) are unaffected by any of this and continue to work as already documented

### 3.7a "Detect Channels"/"Re-detect" Reuse an Already-Discovered Device's Channel Count (2026-07-02)

Code review caught an inconsistency: the manual on-demand flows (3.3a/3.3b/3.3c) always queried the camera's SUNAPI web interface fresh over HTTP, even when a background/manual scan (3.7) had *already* found and channel-counted that exact IP — the two mechanisms never talked to each other. Now, before running the HTTP query, the on-demand flows check whether the IP is already known from a scan; if so, the previously-established channel count is reused directly (instant, no network call, no credentials needed) instead of querying again. If the IP hasn't been scanned (or the scan reported single-channel), behavior is unchanged from 3.3a/3.3b/3.3c's existing description — no regression to "works without any prior scan." Purely an efficiency/correctness improvement; no new UI.

### 3.8 Found-Tab Detail Panel — SUNAPI/ONVIF MaxChannel Shown Separately (new, 2026-07-02)

> Requested directly: show the SUNAPI-reported MaxChannel info in the Found panel. The existing `{N} CH` badge (3.3c) already shows a channel count once detected, but it's the *merged* max of whatever SUNAPI and ONVIF each separately reported (3.7's badge, or 3.3a/3.3b/3.3c's on-demand detection) — there was no way to see which protocol actually reported what.

The Found-tab detail panel (`DiscoveredCameraPanel.tsx`, opened by clicking a device in the sidebar list) now shows two additional, always-visible rows in its Device info section, next to the existing "SUNAPI: Yes/No" and "ONVIF: Yes/No" indicators:

```
┌─ Device ──────────────────────────────────────────────────────────┐
│ SUNAPI          Yes                                                 │
│ SUNAPI MaxCh    4 CH                                                │
│ ONVIF           No                                                  │
│ ONVIF MaxCh     not detected                                        │
└───────────────────────────────────────────────────────────────────┘
```

- Unlike the existing merged `{N} CH` badge, which only appears when the count is `> 1`, these two rows are always shown — reporting the literal value each protocol determined (including `1 CH`, meaning "queried and confirmed single-channel") or "not detected" (that protocol was never queried, or never returned a response at all)
- Clicking **Re-detect** (3.3c) updates both rows immediately in the same panel session, exactly as it already updates the merged badge
- The sidebar list view (the compact one-line-per-device list, not the detail panel) is unchanged — it keeps the single merged `N CH` badge; the per-protocol breakdown is detail-panel-only, matching the existing pattern where the list stays compact and the detail panel carries the full picture

---

## 4. Edge Cases

| Scenario | Behavior |
|---|---|
| `MAX_CHANNEL_NUM` lowered below the highest currently-assigned `channelSlot` | Existing over-limit assignments are left untouched (not auto-unassigned) but flagged in the Admin/ops view; new assignments above the new limit are rejected |
| Camera deleted | Its `channelSlot` becomes free immediately; no renumbering/compaction of other cameras |
| Two admins add a camera to the same slot at nearly the same time | Second `POST` receives `409`; first succeeds |
| Legacy camera predating this feature, migration hasn't run yet (server not restarted) | Grid falls back to treating it as unassigned (not shown in channel-slot grid) until the next server start runs the backfill migration |
| Channel Slot changed on Edit while the camera is actively streaming | Slot change alone does not require a pipeline restart (no RTSP/webrtc/credential change); grid position updates on the next camera-list refresh |
| NVR channel changed on Edit, `nvrProfiles` doesn't cover the new channel | Channel button shown disabled with tooltip explaining RTSP could not be resolved for that channel |
| Re-detect / Detect Channels clicked, but the device is not a multi-channel NVR (or is ONVIF behind auth this client can't authenticate) | A completed-detection message replaces the pre-click prompt ("...single-channel or no multi-channel NVR found"), never leaving the pre-click prompt unchanged — an unchanged prompt after a click is indistinguishable from the button being broken (2026-07-02 fix; previously this was a real defect) |

---

## 5. Access Control

Unchanged from existing camera management — `POST`/`PUT /api/cameras` already require an authenticated session with camera-management permission; no new role is introduced by this feature.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-02 | 초기 작성 |
| 1.1 | 2026-07-02 | §3.3a/§3.3b 추가 — 수동 Add 폼 Detect Channels 버튼, Edit 모달 Re-detect 버튼 (discovery 스캔 없이 즉시 SUNAPI/ONVIF 채널 감지) |
| 1.2 | 2026-07-02 | §4 Edge Cases에 "Re-detect가 NVR을 못 찾았을 때 무반응처럼 보이던 결함" 행 추가 |
| 1.3 | 2026-07-02 | §3.3c 추가 — Found 탭 discovery 패널의 Re-detect 버튼 (Detect Channels와 중복 아님을 명시) |
| 1.4 | 2026-07-02 | §3.6 추가 — DEBUG 레벨 로그를 통한 탐지 실패 진단 기능 (LOG_LEVEL=DEBUG) |
| 1.5 | 2026-07-02 | §3.7 추가 — 백그라운드 스캔의 채널 감지가 UDP 브로드캐스트 데이터를 우선 사용하도록 변경, CGI 조회는 자격증명 설정 시에만 폴백으로 동작 (바이너리 파싱 자체는 후속 과제로 명시) |
| 1.6 | 2026-07-02 | §3.6a 추가 — Edit 모달 Re-detect가 비밀번호 없는 카메라에 대해 더 이상 SUNAPI를 재시도하지 않음, §3.7의 Design 참조를 §4.6b→§4.6c로 정정, 수동 rescan 경로도 동일 수정 적용 명시 |
| 1.7 | 2026-07-02 | §3.7a 추가 — Detect Channels/Re-detect가 이미 스캔된 IP의 채널 수를 재사용하도록 개선(FR-CH-065) |
| 1.8 | 2026-07-02 | §3.8 추가 — Found 탭 상세 패널에 SUNAPI/ONVIF 각 프로토콜의 MaxChannel을 별도 행으로 항상 표시 (병합된 배지와 별개, FR-CH-066). Found 패널에 SUNAPI MaxChannel 표시를 요청 받아 도입 |
