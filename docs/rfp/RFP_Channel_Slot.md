# RFP — Dashboard Channel Slot

**Product:** LTS-2026 Loitering Detection & Tracking System
**Feature:** Global Channel Slot Mapping for Cameras / YouTube Streams
**Version:** 1.8
**Date:** 2026-07-02

---

## 1. Background

LTS-2026 currently positions cameras in the Streaming Dashboard grid purely by array order (`GET /api/cameras` sorted by `createdAt` descending) via `client/src/components/CameraGrid.tsx`. There is no persistent, operator-controlled channel numbering. Separately, SUNAPI (Wisenet/Hanwha) and ONVIF multi-channel NVR discovery already compute a `MaxChannel` value and let the operator pick a physical sub-channel — but only once, at add-time, only from the auto-discovery flow (`DiscoveredCameraPanel.tsx`); this is not available for manually-added cameras or from the Edit screen.

This RFP defines a new, persistent, system-wide **Channel Slot** field (distinct from the existing NVR sub-channel `channelIndex`) and the UI/API to assign, browse, and render by it.

---

## 2. Scope of Work

1. New camera/stream field `channelSlot` (1..`MAX_CHANNEL_NUM`, unique across all cameras) settable at Add and Edit time for both RTSP cameras and YouTube streams.
2. New `server/.env` variable `MAX_CHANNEL_NUM` (default `512`) bounding the valid Channel Slot range.
3. Add/Edit UI: dual channel-slot selection controls (numeric stepper + grid-size-based group browser with </> paging), always shown together.
4. Streaming Dashboard grid rendering rewritten to key off `channelSlot` instead of array order, with empty-slot placeholders and independent group-paging.
5. Extend the existing SUNAPI/ONVIF NVR sub-channel selection (`channelIndex`, `maxChannel`) so it is also available on the camera Edit screen, backed by discovery-time-resolved RTSP URLs persisted on the camera record (no live re-query needed).
6. One-time startup migration to backfill `channelSlot` for cameras that predate this feature.

---

## 3. Functional Requirements

### 3.1 Channel Slot — Data Model & Range

- `channelSlot`: integer, `1..MAX_CHANNEL_NUM`, unique across the `cameras` table (both RTSP and YouTube-type records share the same numbering space)
- `MAX_CHANNEL_NUM`: read from `server/.env`, default `512`; the server MUST reject any `channelSlot` value outside `1..MAX_CHANNEL_NUM` at request time, using the value in effect at that moment (no restart required to pick up a `.env` change other than the normal server restart already required for any `.env` edit)
- Every existing NVR sub-channel field (`channelIndex`, `maxChannel`) is unaffected and orthogonal — a single camera row MAY have both a `channelSlot` (global dashboard position) and a `channelIndex` (which physical NVR input it reads from)

### 3.2 Add Camera / Add YouTube Stream — Channel Slot Selection

- Both the RTSP "Add Camera" form and the YouTube "Add to System" form (`CameraList.tsx` add modal) MUST include a Channel Slot control
- **Stepper**: `[-] [ N ] [+]` — decrements/increments by 1, clamped to `1..MAX_CHANNEL_NUM`, direct numeric entry also allowed
- **Group browser**: page size = the `channels` count of the dashboard's currently active layout (e.g. 16 for a 4×4 grid); `</>` buttons move between `ceil(MAX_CHANNEL_NUM / pageSize)` pages; each page renders one button per slot in that page's range, labeled with the slot number, visually distinguished as: free (selectable), taken (disabled, camera name in tooltip), currently selected (highlighted)
- Both controls operate on the same underlying selected value — changing one updates the other
- On open, the form SHOULD pre-select the lowest free slot as a default (operator can override)
- Submitting with an already-taken `channelSlot` MUST be rejected by the server (409) and surfaced as an inline form error without closing the modal or discarding other entered fields

### 3.3 Edit Camera — Channel Slot Re-assignment

- `CameraEditModal.tsx` MUST include the same dual Channel Slot control (stepper + group browser) as the Add form, pre-populated with the camera's current slot, excluded from its own "taken" check (i.e. a camera editing itself back to its current slot is not a conflict)

### 3.4 SUNAPI / ONVIF NVR Channel — Add Screen (discovery flow, existing, unaffected)

- Unchanged from current behavior: `DiscoveredCameraPanel.tsx` continues to show `CH 1..MaxChannel` buttons when `SupportSunapi` or ONVIF multi-profile detection reports `MaxChannel > 1`, resolving RTSP via `channelIndex`-matched profile → positional profile → SUNAPI path-substitution fallback (unchanged three-tier resolution)

### 3.4a SUNAPI / ONVIF NVR Channel — Add Screen (manual entry, new)

> Added 2026-07-02: the manual "Add Camera" form (`CameraList.tsx`, RTSP tab) requires typing an RTSP URL directly and has no prior discovery scan behind it — §3.4 alone does not cover this path, which is where most operators actually add a single camera.

- The manual Add Camera (RTSP) form SHALL provide a "Detect Channels" button that queries `POST /api/cameras/probe-channels` for the IP parsed out of the entered RTSP URL, using the entered Username/Password if present
- On a successful detection reporting `maxChannel > 1`, the form SHALL show the same `CH 1..maxChannel` button grid as the discovery flow; selecting a channel SHALL update the RTSP URL field to the resolved per-channel URL when available
- The detected `maxChannel`, `supportSunapi`, and `profiles` SHALL be included in the `POST /api/cameras` submission so the new camera record has the same NVR metadata as one added via discovery

### 3.4b SUNAPI / ONVIF NVR Channel — Found-Tab Discovery Panel (new, does NOT duplicate §3.4a)

> Added 2026-07-02, in response to a design review question: `DiscoveredCameraPanel.tsx` (opened by clicking a device in the sidebar "Found" list) already has channel data from its own scan — it does NOT need §3.4a's "Detect Channels" button, which exists specifically because the manual RTSP-entry form has no discovery data at all. Confirmed: no such button was added there. However, the scan's result can be stale (device reconfigured after the scan) or incomplete (the scan's best-effort SUNAPI/ONVIF query timed out) — for that case, a Re-detect capability is warranted.

- `DiscoveredCameraPanel.tsx` SHALL provide a "Re-detect" button next to its existing channel-count display that calls `POST /api/cameras/probe-channels` for `camera.IPAddress`, reusing the panel's already-known `HttpPort`/`HttpsPort`/`HttpType`/`Username`/`Password` (no re-parsing from a URL needed, unlike §3.4a — this panel already has structured device fields)
- A successful re-detection SHALL update the panel's channel count and channel-selection button grid in place, without closing/reopening the panel or re-running the network-wide scan
- Per FR-CH-049a's established pattern, a re-detection that finds no multi-channel NVR SHALL still produce a visible result message (not leave the display unchanged) — the same three-way state (never attempted / attempted-empty / attempted-with-data) applies here as it does for the Edit screen's Re-detect
- The `+ Add to System` submission SHALL prefer the Re-detect result over the original scan data when both exist, since the operator explicitly asked for fresher data

### 3.5 SUNAPI / ONVIF NVR Channel — Edit Screen

- When a camera record has `maxChannel > 1` (persisted at add-time, or from a fresh on-demand detection — see §3.5a), `CameraEditModal.tsx` MUST show the same `CH 1..maxChannel` button row
- Selecting a different channel MUST update `channelIndex` and re-derive `rtspUrl` from the camera's known `nvrProfiles` array (per-channel RTSP URLs) — no live device re-query for this step
- If the target channel is not present in `nvrProfiles`, fall back to the SUNAPI path-substitution regex (`channelRtspUrl()`) against the camera's current `rtspUrl`; if that also cannot resolve, the button MUST be shown but disabled with an explanatory tooltip rather than silently producing a wrong URL

### 3.5a SUNAPI / ONVIF NVR Channel — Edit Screen On-Demand Re-detection (new)

> Added 2026-07-02: cameras added before this feature (or via the manual form before §3.4a existed) have no persisted `maxChannel`/`nvrProfiles`, so §3.5's NVR Channel section would never appear for them without this.

- The Edit Camera (RTSP) form SHALL always show a "Re-detect" button in the NVR Channel section, regardless of whether the camera currently has `maxChannel > 1`
- Clicking it SHALL call `POST /api/cameras/probe-channels` using the camera's stored `ip` (falling back to the hostname parsed from its `rtspUrl`) and `httpPort`
- A successful detection reporting `maxChannel > 1` SHALL immediately reveal the `CH 1..maxChannel` button row in the same modal session (no reopen required), and SHALL be persisted via `PUT /api/cameras/:id` (`maxChannel`, `supportSunapi`, `nvrProfiles`) only when the operator saves the form
- **(2026-07-02 addendum, fixes a defect)** A completed detection that reports `maxChannel ≤ 1` (no multi-channel NVR found) SHALL replace the pre-click prompt with a distinct, outcome-specific message. The UI MUST NOT leave the "click Re-detect to query..." prompt unchanged after a click completes — doing so is indistinguishable from the button not working, since a legitimate "nothing found" result and a client that silently ignored the click look identical to the operator

### 3.5b Re-detect SHALL Skip the SUNAPI Probe for a Camera Already Known to Have No Password (new, 2026-07-02)

> Raised by an operator: §3.5a's "Re-detect" was observed retrying an unauthenticated SUNAPI query — and logging its connection failure (visible via §3.8's new DEBUG logging) — against a camera added with no username/password on file at all. The camera's own DB record already answers "can this authenticate," so the retry-on-every-click was a guaranteed-failure network round-trip for no benefit.

- `POST /api/cameras/probe-channels` SHALL accept an optional `cameraId` field. When present, the server SHALL look up that camera's stored `username`/`password` and use them for the SUNAPI probe whenever the request body itself does not supply credentials — this is the only way for the client to authenticate the probe, since `GET /api/cameras`/`GET /api/cameras/:id` strip the password from every response
- If no password is resolvable from any source (request body, the camera record, nor the `RTSP_DEFAULT_PASSWORD` environment fallback), the server SHALL skip the SUNAPI network call entirely rather than attempt it unauthenticated
- This gate SHALL apply **only** when `cameraId` is present — §3.4a's manual Add form (no camera record yet) and §3.4b's Found-tab panel (uses the scan's own captured credentials, no DB record either) are unaffected and continue attempting an unauthenticated probe when no credentials are otherwise available, per §3.4a/§3.4b's original behavior
- `CameraEditModal.tsx`'s "Re-detect" (§3.5a) SHALL send `cameraId` in its request going forward

### 3.5c probe-channels SHALL Reuse a Cached UDP Discovery Result Before Querying SUNAPI CGI (new, 2026-07-02)

> Raised by code review: `probe-channels`' `sunapiMax` value comes exclusively from `querySunapiMaxChannel()` — an HTTP CGI query targeted at one known IP — which is a mechanism entirely separate from the UDP Discovery broadcast scan (§3.9). When the exact IP had already been found and channel-counted by that scan, `probe-channels` had no way to know it and always re-queried over HTTP from scratch.

- The discovery service SHALL expose a synchronous, no-network-I/O lookup (`getByIp(ip)`) into its in-memory scan cache
- `POST /api/cameras/probe-channels` SHALL check this cache before deciding whether to query SUNAPI CGI at all: if a cached device exists for `ip` with `SupportSunapi: true` and `MaxChannel > 1`, that cached value SHALL be used directly as `sunapiMax`, and the SUNAPI CGI query SHALL NOT be attempted for that request
- This cache check SHALL take priority over §3.5b's credential gate — a cache hit requires no credentials at all, since the scan already established the channel count independently
- A cache miss (IP never scanned, scan reported single-channel, or discovery disabled) SHALL fall through to the existing behavior (§3.5b's gate, then the CGI query) unchanged — this MUST NOT regress the "no prior scan required" guarantee of §3.4a/FR-CH-045

### 3.6 Streaming Dashboard Grid Rendering

- Grid cell assignment changes from `cameras[startIndex + idx]` (array order) to a `channelSlot`-keyed lookup: cell at logical position `groupStart + idx` shows the camera whose `channelSlot === groupStart + idx + 1` (1-based), or an empty placeholder if none
- Empty placeholder cells show the channel number and an "unassigned" indicator, distinguishable from a camera that is assigned but currently offline
- The existing desktop arrow (`<`/`>`) and mobile swipe paging are reinterpreted as **Channel Group** paging over `1..MAX_CHANNEL_NUM` (page size = current layout's `channels`), not array-offset paging over the camera list
- This applies uniformly to equal-grid layouts and to the "N Main + Sub" featured layouts (main cells and sub cells both draw from the same channel-slot-keyed lookup, contiguous within the current group)

### 3.7 Migration

- On first server startup after this feature ships, any camera record without a `channelSlot` MUST be backfilled with the lowest available unused slot, processed in ascending `createdAt` order, capped at `MAX_CHANNEL_NUM` (cameras beyond the cap remain unassigned and are logged as a warning)
- Migration MUST be idempotent (safe to run on every startup; a no-op once all cameras have a `channelSlot`)

### 3.8 SUNAPI / ONVIF Detection — Diagnostic Logging (new, 2026-07-02)

> Added in response to an operator question about why "Detect Channels"/"Re-detect" reported single-channel for a device already confirmed multi-channel by a prior discovery scan (root cause: a missing port/scheme parameter, since fixed — §3.4a). The underlying issue for operators is that `querySunapiMaxChannel()`/`enrichDevice()` fail *silently* by design (any error, from any cause, collapses to the same "single-channel" result), so diagnosing *why* a detection found nothing required reading source code.

- `POST /api/cameras/probe-channels` SHALL log, at `DEBUG` level only (no effect on default `LOG_LEVEL=INFO` log volume): the resolved request parameters (`ip`, `httpPort`, `httpType`, `onvifPort`, whether credentials were supplied — never the credential values themselves), the outcome of each individual SUNAPI endpoint path attempted, the outcome of each individual ONVIF SOAP call attempted (`GetDeviceInformation`/`GetCapabilities`/`GetProfiles`/`GetStreamUri`), and the endpoint's final protocol/channel-count decision
- This logging SHALL apply uniformly regardless of which UI entry point triggered the request (Add modal's "Detect Channels" §3.4a, Edit modal's "Re-detect" §3.5a, Found-tab panel's "Re-detect" §3.4b) since all three call the same endpoint
- Credentials (SUNAPI Basic-Auth username/password) MUST NOT appear in these logs, consistent with the existing rule against logging RTSP URL credentials

### 3.9 SUNAPI Channel Detection — Binary Response as Primary Source, CGI as Secondary Only (new, 2026-07-02)

> Raised by design review: the SUNAPI IP Installer protocol's UDP discovery response reportedly already carries a `MaxChannel` field (per the vendor spec, §3.4.2 Response) — the automatic background scan should not need an additional HTTP CGI round-trip (`GET /stw-cgi/attributes.cgi/attributes`) to learn something the discovery broadcast itself already answers.

- The automatic background discovery scan (`discoveryService.js` `_runScan()`) SHALL treat the UDP discovery response's own channel-count data as the **primary** source for `MaxChannel` — no network round-trip required
- The SUNAPI CGI query (`querySunapiMaxChannel()`) SHALL be attempted only as a **secondary/fallback** source, and only when BOTH of the following hold: (a) the primary (UDP response) source did not already report `MaxChannel > 1`, AND (b) real SUNAPI credentials are configured (`RTSP_DEFAULT_USERNAME`/`RTSP_DEFAULT_PASSWORD` both set) — an unauthenticated CGI request against a modern, auth-required device is a guaranteed failure and SHALL NOT be attempted by default for every scanned device
- **Status: partially implemented.** The credential-gating half (b) SHALL ship immediately (`hasConfiguredSunapiCredentials()`). The primary-source half (a) — extracting `MaxChannel` from the UDP binary response itself — is BLOCKED pending confirmation of the field's exact byte offset/size/encoding from the vendor protocol spec (not accessible to the implementing agent — internal-only host); `mapUDPDevice()` has been made forward-compatible (reads `raw.MaxChannel` if present, defaults to `1` otherwise) so wiring in the confirmed offset requires no further design change
- This requirement does NOT apply to the manual on-demand `POST /api/cameras/probe-channels` flows (§3.4a/§3.4b/§3.5a) — those are explicit, operator-triggered actions where credentials are supplied directly in the UI at the moment of the request, not a background best-effort call repeated for every device on every scan cycle

### 3.9a SUNAPI CGI Endpoint Correction (new, 2026-07-02)

> Raised by the customer directly: nobody requested the `/stw-cgi/system.cgi?msubmenu=systeminfo&action=view` endpoint used by §3.9's secondary/fallback path — it is not a real SUNAPI CGI path. The correct endpoint is `/stw-cgi/attributes.cgi/attributes`, whose XML response contains the channel count at `attributes > group[name=System] > category[name=Limit] > attribute[name=MaxChannel]`'s `value` attribute.

- `querySunapiMaxChannel()` SHALL query `GET /stw-cgi/attributes.cgi/attributes` and parse the `MaxChannel` value from `<group name="System"><category name="Limit"><attribute name="MaxChannel" value="N"/>`, matching the vendor SUNAPI IP Installer client's own query path (`System/Limit/MaxChannel`)
- The response is XML (`Content-Type: application/xml`), not JSON — the implementation SHALL NOT `JSON.parse()` the body
- **Impact of the prior (incorrect) implementation**: the two paths originally specified in §3.9 (`media.cgi?msubmenu=channellist`, `system.cgi?msubmenu=systeminfo`) do not exist on real SUNAPI devices and always returned `404`/connection errors — meaning the secondary/fallback CGI path described in §3.9 never actually succeeded in production, independent of whether credentials were configured. This correction is what makes §3.9(b)'s credential-gating meaningful in practice, not just in the failure-path logging.

---

## 4. Non-Functional Requirements

| Category | Requirement |
|---|---|
| Compatibility | Feature applies to `combined` and `streaming` `SERVER_MODE` (camera-bearing modes); not applicable to `analysis` mode (no camera capture) |
| Performance | Channel-slot lookup for grid rendering must be O(1) per cell (client builds a `Map<channelSlot, Camera>` once per camera-list update, not a linear scan per cell) |
| Data integrity | Uniqueness of `channelSlot` enforced server-side on every insert/update, independent of client-side validation |
| Backward compatibility | Cameras added via the legacy flow (no `channelSlot` in the request body) continue to work during the migration window; the feature ships with the startup backfill from §3.7 |

---

## 5. API Contracts

### POST /api/cameras (extended)

```
Body (RTSP, new field marked ★):
{
  "name": string, "rtspUrl": string, "username"?: string, "password"?: string,
  "webrtcEnabled"?: boolean,
  "channelSlot"?: number,           ★ optional, 1..MAX_CHANNEL_NUM — auto-assigned (lowest free slot)
                                      if omitted, for backward compatibility with pre-existing
                                      integrations/tests; the Add Camera UI always sends it explicitly
  "channelIndex"?: number,             (existing — NVR sub-channel)
  "maxChannel"?: number,            ★ (existing discovery response value, now persisted)
  "supportSunapi"?: boolean,        ★ (existing discovery response value, now persisted)
  "nvrProfiles"?: [{ "channelIndex": number, "rtspUrl": string }]   ★ new — per-channel RTSP URLs
}

Response 201: { success: true, data: Camera }
Response 409: { success: false, error: "Channel slot N is already assigned to camera <name>" }
Response 400: { success: false, error: "channelSlot must be between 1 and <MAX_CHANNEL_NUM>" }
```

### PUT /api/cameras/:id (extended)

```
Body (new fields marked ★, all optional — partial update):
{
  ...(existing fields unchanged)...
  "channelSlot"?: number,           ★
  "channelIndex"?: number,          ★ (now editable — was add-only before)
  "maxChannel"?: number,            ★ (from a fresh POST /api/cameras/probe-channels result)
  "supportSunapi"?: boolean,        ★
  "nvrProfiles"?: [{ "channelIndex": number, "rtspUrl": string }]   ★
}

Response 200: { success: true, data: Camera, restarted: boolean }
Response 409: { success: false, error: "Channel slot N is already assigned to camera <name>" }
```

### POST /api/cameras/probe-channels (new)

```
On-demand SUNAPI + ONVIF MaxChannel re-detection for a single IP — no prior
discovery scan required. Used by the manual Add Camera form (§3.4a) and by
CameraEditModal's "Re-detect" button (§3.5a). Each protocol probe is
independently time-boxed (8s) so an unreachable device cannot stall the
request; ONVIF results are preferred over SUNAPI when both report channels,
since GetStreamUri yields verified RTSP URLs rather than a synthesized guess.

Body:
{
  "ip": string,                required
  "httpPort"?: number,         SUNAPI CGI port (default 80, or 443 if httpType set)
  "httpType"?: boolean,        true = https for the SUNAPI probe
  "onvifPort"?: number,        ONVIF device_service port (default 80)
  "username"?: string, "password"?: string,
  "baseRtspUrl"?: string       used to synthesize per-channel URLs for SUNAPI via
                                path substitution (/profile1/ → /profileN/); not
                                needed for ONVIF, which returns real GetStreamUri results
  "cameraId"?: string          (§3.5b) when set and username/password are omitted, the
                                camera's own stored credentials are used for the SUNAPI
                                probe; if no credential is resolvable from any source,
                                the SUNAPI probe is skipped entirely (gate applies only
                                when cameraId is present)
}

Response 200:
{
  "success": true,
  "maxChannel": number,                 // 1 if neither protocol detected multiple channels
  "supportSunapi": boolean,
  "protocol": "sunapi" | "onvif" | "none",
  "profiles": [{ "channelIndex": number, "rtspUrl": string }]
}
Response 400: { "success": false, "error": "ip is required" }
```

Side effect (§3.8): with `LOG_LEVEL=DEBUG`, this endpoint also emits `console.debug()` lines tracing every SUNAPI/ONVIF call it makes — no effect on the response body or on default-configuration log volume.

Side effect (§3.5c): before attempting the SUNAPI CGI query, the endpoint checks the UDP Discovery service's in-memory cache for `ip` — a cache hit (already-scanned multi-channel SUNAPI device) short-circuits straight to the response with no CGI call and no dependency on §3.5b's credential gate.

### GET /health (extended)

```
Response 200 (existing fields + new):
{ ..., "maxChannelNum": number }
```

---

## 6. UI Placement

- Add Camera modal (`CameraList.tsx`) — new "Channel" section in both RTSP and YouTube tabs, above the existing WebRTC toggle
- Edit Camera modal (`CameraEditModal.tsx`) — same "Channel" section, plus conditional "NVR Channel" button row
- Streaming Dashboard (`App.tsx` / `CameraGrid.tsx`) — existing `< >` arrow controls relabeled to show "Channel Group X of Y" instead of a bare page indicator; mobile swipe unchanged in gesture, reinterpreted in semantics per §3.6

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-02 | 초기 작성 |
| 1.1 | 2026-07-02 | §3.4a/§3.5a 추가 — 수동 Add 화면·Edit 화면에서 discovery 스캔 없이 즉시 SUNAPI/ONVIF 채널 감지(`POST /api/cameras/probe-channels`), §5 API Contracts에 신규 엔드포인트 추가, PUT /api/cameras/:id에 maxChannel/supportSunapi/nvrProfiles 필드 추가 |
| 1.2 | 2026-07-02 | §3.5a에 결과 피드백 요구사항 추가 — Re-detect가 NVR을 못 찾아도 클릭 전 문구를 그대로 두면 안 됨(무반응처럼 보이는 결함 수정) |
| 1.3 | 2026-07-02 | §3.4b 추가 — Found 탭 discovery 패널에는 Detect Channels가 불필요함을 확인·명문화하되, 스캔 결과가 오래되거나 불완전할 경우를 위한 Re-detect 버튼 요구사항 신설 |
| 1.4 | 2026-07-02 | §3.8 추가 — probe-channels의 SUNAPI/ONVIF 호출을 DEBUG 레벨로 로그하는 요구사항 신설, §5 API Contracts에 side effect 명시 |
| 1.5 | 2026-07-02 | §3.9 추가 — SUNAPI 채널 감지는 UDP discovery 응답을 1차 소스로 사용하고 CGI 조회는 자격증명이 실제 설정된 경우에만 2차 수단으로 사용해야 함(자격증명 게이팅은 구현 완료, UDP 바이너리 파싱은 외부 스펙 데이터 대기 중 — 부분 구현 상태 명시) |
| 1.6 | 2026-07-02 | §3.5b 추가 — Re-detect는 카메라 레코드에 비밀번호가 없으면 SUNAPI probe를 생략해야 함(cameraId 파라미터 신설); §3.4a/§3.4b는 영향 없음 |
| 1.7 | 2026-07-02 | §3.9a 추가 — SUNAPI CGI 엔드포인트 정정. §3.9에 기재된 `system.cgi`/`media.cgi` 경로는 실제 SUNAPI에 존재하지 않아 항상 실패했음 — 실제 엔드포인트 `GET /stw-cgi/attributes.cgi/attributes`(XML, System/Limit/MaxChannel)로 수정 |
| 1.8 | 2026-07-02 | §3.5c 추가 — probe-channels가 SUNAPI CGI 쿼리 전에 UDP Discovery 캐시(`getByIp()`)를 우선 확인해야 함, §3.5b 자격증명 게이트보다 우선순위 높음, §5 API Contracts에 side effect 명시 |
