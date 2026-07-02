# SRS — Dashboard Channel Slot

**Product:** LTS-2026 Loitering Detection & Tracking System
**Feature:** Global Channel Slot Mapping for Cameras / YouTube Streams
**Document ID:** SRS-LTS-CHSLOT-01
**Version:** 1.11
**Date:** 2026-07-02
**Parent RFP:** rfp/RFP_Channel_Slot.md

---

## 1. Introduction

This Software Requirements Specification defines the functional and non-functional requirements for the Dashboard Channel Slot feature: a persistent, system-wide channel numbering scheme (distinct from the existing NVR sub-channel `channelIndex`) that determines a camera or YouTube stream's position in the Streaming Dashboard grid.

---

## 2. Data Model Requirements

### FR-CH-001 — Channel Slot field

Every camera/YouTube-stream record SHALL have an integer field `channelSlot` with range `1..MAX_CHANNEL_NUM` inclusive.

### FR-CH-002 — Global uniqueness

`channelSlot` SHALL be unique across all records in the `cameras` table (RTSP and YouTube types share one numbering space). The server SHALL enforce this on every insert and update, independent of any client-side validation.

### FR-CH-003 — MAX_CHANNEL_NUM configuration

The maximum valid `channelSlot` value SHALL be read from the `MAX_CHANNEL_NUM` environment variable at server startup, defaulting to `512` if unset or invalid (non-numeric, ≤0). A running server SHALL use the value read at its own startup for the lifetime of the process (standard `.env`-requires-restart behavior, consistent with all other env-driven config in this codebase).

### FR-CH-004 — Independence from NVR channelIndex

`channelSlot` SHALL be functionally independent of the existing `channelIndex` field (NVR physical sub-channel, 1-based, populated only via SUNAPI/ONVIF discovery). A single camera record MAY have both fields set simultaneously, and changing one SHALL NOT implicitly change the other.

### FR-CH-005 — Discovery metadata persistence

When a camera is added via the discovery flow with `maxChannel > 1`, the following SHALL be persisted on the camera record (previously discarded after add): `maxChannel` (number), `supportSunapi` (boolean), `nvrProfiles` (array of `{ channelIndex: number, rtspUrl: string }>`, one entry per discoverable physical channel).

---

## 3. Validation Requirements

### FR-CH-010 — Range validation

`POST /api/cameras` and `PUT /api/cameras/:id` SHALL reject any `channelSlot` value that is not an integer in `1..MAX_CHANNEL_NUM` with HTTP 400 and an error message stating the valid range.

### FR-CH-011 — Conflict validation

`POST /api/cameras` and `PUT /api/cameras/:id` SHALL reject a `channelSlot` value already assigned to a **different** camera record with HTTP 409 and an error message naming the conflicting camera. A `PUT` that resubmits a camera's own current `channelSlot` SHALL NOT be treated as a conflict.

### FR-CH-012 — Auto-assignment when omitted

`POST /api/cameras` SHALL accept requests that omit `channelSlot` (both RTSP and YouTube camera creation paths), for backward compatibility with existing integrations and test suites (e.g. `test/api/nvr_channel_discovery.test.js`, `test/api/camera_discovery.test.js`) that predate this feature and do not send it. When omitted, the server SHALL auto-assign the lowest currently-free slot using the same logic as the startup backfill (FR-CH-020), rather than rejecting the request. The Add Camera UI (§5) SHALL always send an explicit `channelSlot` regardless — this fallback exists for API-level backward compatibility, not as the primary UX path.

**Acceptance**: `POST /api/cameras` with `channelSlot: 9999` (exceeding a `MAX_CHANNEL_NUM=512` server) SHALL return 400. A second `POST` reusing a `channelSlot` already held by an existing camera SHALL return 409. `PUT /api/cameras/:id` with that same camera's own existing `channelSlot` unchanged SHALL return 200, not 409. `POST /api/cameras` with `channelSlot` entirely omitted SHALL return 201 with the auto-assigned slot present in the response.

---

## 4. Migration Requirements

### FR-CH-020 — Startup backfill

On server startup, for every camera record lacking a `channelSlot` (i.e. `null`/`undefined`), the server SHALL assign the lowest currently-unused slot in `1..MAX_CHANNEL_NUM`, processing candidate records in ascending `createdAt` order.

### FR-CH-021 — Backfill capacity limit

If the number of unassigned legacy camera records exceeds the number of free slots available under the current `MAX_CHANNEL_NUM`, the excess records SHALL remain with `channelSlot: null` and the server SHALL log a warning identifying each unassigned camera by id/name.

### FR-CH-022 — Idempotency

The backfill migration SHALL be safe to run on every server startup; once every camera has a `channelSlot`, subsequent runs SHALL be a no-op.

**Acceptance**: A JSON-mode DB seeded with 3 cameras with no `channelSlot` field, server started with default `MAX_CHANNEL_NUM=512`, SHALL result in those 3 cameras holding `channelSlot` values `1, 2, 3` (in `createdAt` ascending order) after the first startup, and unchanged on a second restart.

---

## 5. Add / Edit UI Requirements

### FR-CH-030 — Channel Slot control (Add)

The Add Camera modal (`CameraList.tsx`), in both the RTSP and YouTube tabs, SHALL present a Channel Slot section containing:
(a) a numeric stepper (`[-] [value] [+]`, direct entry allowed, clamped to `1..MAX_CHANNEL_NUM`), and
(b) a group browser paging through `1..MAX_CHANNEL_NUM` in increments equal to the `channels` count of the currently active dashboard layout, with `</>` navigation and one button per slot in the visible page, each rendered as free/taken/selected.

### FR-CH-031 — Synchronized dual controls

The stepper and group browser SHALL always reflect the same underlying selected value — changing either one SHALL update the other's displayed state within the same render.

### FR-CH-032 — Default selection

On opening the Add Camera modal, the Channel Slot SHALL default to the lowest currently-free slot.

### FR-CH-033 — Taken-slot indication

In the group browser, a slot already assigned to another camera SHALL be rendered disabled (not clickable) with the occupying camera's name shown on hover/focus.

### FR-CH-034 — Channel Slot control (Edit)

`CameraEditModal.tsx` SHALL present the same dual Channel Slot control as FR-CH-030/031, pre-populated with the camera's current `channelSlot`, with that camera's own current slot excluded from the "taken" set shown by the group browser.

### FR-CH-035 — Inline conflict error

If a `channelSlot` submission is rejected by the server (409), the modal SHALL display the error inline without closing and SHALL preserve all other entered field values.

---

## 6. NVR Sub-Channel (SUNAPI/ONVIF) Requirements

### FR-CH-040 — Add-flow behavior unchanged

The existing NVR sub-channel selection behavior in `DiscoveredCameraPanel.tsx` (three-tier RTSP resolution: `channelIndex`-matched profile → positional profile index → SUNAPI path-substitution) SHALL remain unchanged by this feature.

### FR-CH-040a — Background discovery scan: UDP response as primary MaxChannel source, CGI as gated secondary (2026-07-02)

The automatic background discovery scan (`discoveryService.js` `_runScan()`, UDP device handler) SHALL treat `MaxChannel` derived from the UDP discovery response itself as the primary source. It SHALL only additionally query the SUNAPI capability CGI endpoint (`querySunapiMaxChannel()`, `GET /stw-cgi/attributes.cgi/attributes` — see FR-CAM-062a for the endpoint spec) when **both**:
(a) the primary source did not already report `MaxChannel > 1` for that device, AND
(b) `hasConfiguredSunapiCredentials()` returns `true` (i.e. `RTSP_DEFAULT_USERNAME` and `RTSP_DEFAULT_PASSWORD` are both set and non-empty in `server/.env`).

The scan SHALL NOT attempt an unauthenticated CGI query for a device when no credentials are configured — an unauthenticated request against an auth-required device predictably fails, and the round-trip provides no information the scan didn't already have.

**Implementation status**: condition (b) is implemented (`hasConfiguredSunapiCredentials()`, exported from `discoveryService.js`). The CGI endpoint itself was corrected 2026-07-02 (`docs/srs/SRS_Camera_Discovery.md` FR-CAM-062a) — the two paths originally used (`media.cgi?msubmenu=channellist`, `system.cgi?msubmenu=systeminfo`) do not exist on real SUNAPI devices and never returned data, so condition (b)'s gating had no observable effect on `MaxChannel` detection until this fix landed (only on log volume). Condition (a) — decoding `MaxChannel` from the UDP binary response inside `mapUDPDevice()`/the underlying packet parser — requires confirming the field's exact byte offset, size, and encoding against the vendor's SUNAPI IP Installer protocol specification, which was not available to confirm at implementation time. `mapUDPDevice()` already reads `raw.MaxChannel` if the parser ever populates it (`MaxChannel: raw.MaxChannel > 1 ? raw.MaxChannel : 1`), so completing (a) requires only a parser change, no further design work, once the field location is confirmed.

### FR-CH-040b — Manual/on-demand flows unaffected

FR-CH-040a's gating applies only to the automatic background scan. It SHALL NOT change the behavior of `POST /api/cameras/probe-channels` (FR-CH-045) — the manual Add form's "Detect Channels" (FR-CH-048), the Found-tab panel's "Re-detect" (FR-CH-048a), and the Edit modal's "Re-detect" (FR-CH-049) all remain explicit, operator-triggered single requests that pass through whatever credentials the operator has supplied in that moment, independent of `hasConfiguredSunapiCredentials()`.

**Acceptance**: With `RTSP_DEFAULT_USERNAME`/`RTSP_DEFAULT_PASSWORD` unset, running a background discovery scan against a SUNAPI-flagged device SHALL NOT produce any `[Discovery][SUNAPI] querying ...` DEBUG log line for that device (the CGI call is skipped entirely) — verified via `hasConfiguredSunapiCredentials()` unit test (TC-CH-G-001) rather than a live scan.

### FR-CH-041 — Edit-flow NVR channel control

When a camera record has `maxChannel > 1`, `CameraEditModal.tsx` SHALL show a "NVR Channel" button row (`CH 1..maxChannel`, 1-based) mirroring the Add-flow control's visual style, with the camera's current `channelIndex` highlighted.

### FR-CH-042 — Edit-flow RTSP re-resolution without live query

Selecting a different NVR channel in Edit mode SHALL resolve the new `rtspUrl` from the camera's persisted `nvrProfiles` array (FR-CH-005) by matching `channelIndex`, without any live network call to the device.

### FR-CH-043 — Fallback resolution

If the target channel is absent from `nvrProfiles`, the client SHALL attempt the SUNAPI path-substitution regex (`channelRtspUrl()`) against the camera's current `rtspUrl` as a fallback. If that also does not change the URL (i.e. the URL does not match the `/profileN/` convention), the corresponding channel button SHALL be shown but disabled with a tooltip explaining that RTSP could not be resolved for that channel.

### FR-CH-044 — Preview before save

The Edit modal SHALL show the resolved `rtspUrl` (read-only) reflecting the newly selected NVR channel before the operator saves, so the change is visible prior to commit.

**Acceptance**: Editing a camera with `maxChannel=8`, `channelIndex=3`, and an `nvrProfiles` entry for `channelIndex: 5` present, selecting "CH 5" SHALL update the preview URL to that entry's `rtspUrl` without any network request being made (verifiable in dev tools / no additional discovery API call fired).

### FR-CH-045 — On-demand channel probe endpoint

The server SHALL expose `POST /api/cameras/probe-channels` accepting `{ ip, httpPort?, httpType?, onvifPort?, username?, password?, baseRtspUrl? }` and returning `{ success, maxChannel, supportSunapi, protocol: 'sunapi'|'onvif'|'none', profiles: [{channelIndex, rtspUrl}] }`. This endpoint SHALL probe a single, caller-supplied IP directly — it SHALL NOT require or trigger a network-wide discovery scan.

### FR-CH-046 — Independent per-protocol time-boxing

Each protocol probe (SUNAPI via `querySunapiMaxChannel()`, ONVIF via `enrichDevice()` against a guessed `http://{ip}:{onvifPort}/onvif/device_service` service URL) SHALL be wrapped in an independent timeout (`PROBE_TIMEOUT_MS`, 8000ms) that resolves to a "not detected" fallback rather than propagating a hang, so an unreachable or slow-responding device cannot stall the HTTP response.

### FR-CH-047 — Protocol preference on conflicting results

When both protocols report `maxChannel > 1`, the response SHALL prefer ONVIF's result (`protocol: 'onvif'`) if it has at least one profile with a non-empty `rtspUrl`, since `GetStreamUri` yields a verified URL rather than a synthesized guess. Otherwise SUNAPI's result SHALL be used, with `profiles` synthesized via `channelRtspUrl()` path-substitution against `baseRtspUrl` (only when `baseRtspUrl` is provided).

### FR-CH-048 — Manual Add screen on-demand detection

The manual Add Camera (RTSP) form (`CameraList.tsx`) SHALL provide a "Detect Channels" button that parses the IP from the entered `rtspUrl` and calls FR-CH-045's endpoint. A result with `maxChannel > 1` SHALL reveal a `CH 1..maxChannel` button grid (same interaction pattern as FR-CH-041); the detected `maxChannel`/`supportSunapi`/`profiles` SHALL be included in the subsequent `POST /api/cameras` request.

### FR-CH-048a — Found-tab discovery panel on-demand re-detection (does not duplicate FR-CH-048)

`DiscoveredCameraPanel.tsx` (opened from the sidebar "Found" list) already has channel data from the scan that discovered it — it SHALL NOT include FR-CH-048's "Detect Channels" button, which exists to compensate for the manual Add form having no discovery data at all. Instead:

- `DiscoveredCameraPanel.tsx` SHALL provide a "Re-detect" button next to its channel-count display, calling FR-CH-045's endpoint with `camera.IPAddress` and the panel's already-known `HttpPort`/`HttpsPort`/`HttpType`/`Username`/`Password` (structured fields already on the `DiscoveredCamera` object — no URL parsing required, unlike FR-CH-048)
- A successful result SHALL update the panel's `channelCount` and channel-selection button grid state in place, without closing/reopening the panel
- A result with `maxChannel ≤ 1` SHALL still change the panel's visible state per FR-CH-049a's rule (never leave a "click to detect" style prompt unchanged after a completed request)
- `+ Add to System`'s RTSP-URL resolution (`resolveRtspUrl()`) SHALL prefer a Re-detect result's profiles over the original scan's `camera.profiles` when both exist

**Acceptance**: Opening a discovered device whose scan reported `MaxChannel: 1` (e.g. the scan's best-effort SUNAPI query timed out), clicking "Re-detect" against a mock endpoint reporting 8 channels, SHALL update the channel-count badge to "8 CH" and reveal `CH 1..8` buttons without closing the panel; adding the camera afterward SHALL submit `maxChannel: 8`, not the original `MaxChannel: 1`.

### FR-CH-049 — Edit screen always-available re-detection

`CameraEditModal.tsx`'s NVR Channel section SHALL always render a "Re-detect" button, regardless of whether the camera currently has `maxChannel > 1` — unlike FR-CH-041, this control is NOT conditional on pre-existing NVR metadata, so cameras added before this feature (or via the manual form before FR-CH-048 existed) can still discover their channels. A successful re-detection SHALL update the modal's in-session state immediately (revealing the channel grid without closing/reopening the modal) and SHALL only be persisted via `PUT /api/cameras/:id` (`maxChannel`, `supportSunapi`, `nvrProfiles`) when the operator saves.

**Acceptance**: `POST /api/cameras/probe-channels` with an unreachable `ip` SHALL respond within `PROBE_TIMEOUT_MS + ε` (not hang indefinitely) with `{ maxChannel: 1, protocol: 'none' }`. Editing a camera with no persisted `maxChannel`, clicking "Re-detect" against a mock SUNAPI endpoint reporting 4 channels, SHALL reveal `CH 1..4` buttons in the same modal session without a page reload.

### FR-CH-049a — Re-detect result MUST always change visible state (fixes a defect)

A completed `POST /api/cameras/probe-channels` request triggered by "Re-detect" SHALL always produce a visible change in the NVR Channel section's message, regardless of outcome:
- `maxChannel > 1`: the `CH 1..maxChannel` button grid (FR-CH-049) SHALL appear.
- `maxChannel ≤ 1` (`protocol: 'none'` or a single-channel result): the pre-click prompt ("No NVR channel data yet — click Re-detect...") SHALL be replaced by a distinct, outcome-specific message. The client SHALL NOT leave the pre-click prompt unchanged after a completed request — an unreachable device, an unauthenticated ONVIF NVR, and a genuinely single-channel camera all currently resolve to the same `{ maxChannel: 1, protocol: 'none'|'sunapi'|'onvif' }` shape, and all three MUST be distinguishable from "the click did nothing" from the operator's perspective, even if not from each other.
- A request that fails outright (network error, non-2xx) SHALL continue to use the existing `redetectError` inline error path (FR-CH-045's error contract) — this requirement covers only the *successful-but-empty* case, which previously had no feedback path at all.

**Defect history**: prior to this requirement, `CameraEditModal.tsx` rendered the "No NVR channel data yet..." prompt whenever `hasNvrChannels` was false, with no distinction between "never attempted" and "attempted, found nothing" — reported by an operator as "clicking Re-detect does nothing."

**Acceptance**: Clicking "Re-detect" against an IP that responds but reports no multi-channel NVR (`protocol: 'none'`) SHALL result in the section's text changing from the pre-click prompt to a result message mentioning the detection ran, within one render after the request resolves.

---

## 7. Dashboard Grid Rendering Requirements

### FR-CH-050 — Channel-slot-keyed cell assignment

`CameraGrid.tsx` SHALL determine each rendered cell's camera by `channelSlot` lookup (`groupStart + cellIndex + 1`), not by array-index offset into the `cameras` list, for both equal-grid layouts and the "N Main + Sub" featured layouts.

### FR-CH-051 — Empty slot placeholder

A grid cell whose corresponding `channelSlot` has no assigned camera SHALL render a placeholder showing the channel number and an "Unassigned" indicator, visually distinct from an assigned-but-offline camera tile.

### FR-CH-052 — Channel Group paging

The existing desktop arrow (`<`/`>`) and mobile swipe navigation SHALL be reinterpreted to page over channel groups of `1..MAX_CHANNEL_NUM` (page size = current layout's `channels` count) rather than over array offsets into the camera list. The current position SHALL be displayed as "Channel Group X of Y (CH a–b)".

### FR-CH-053 — O(1) lookup

The client SHALL build a `Map<channelSlot, Camera>` once per camera-list update (not per render/per cell) to back the lookups in FR-CH-050.

**Acceptance**: With `MAX_CHANNEL_NUM=512` and a 4×4 (16-channel) layout active, navigating to "Channel Group 2" (CH 17–32) SHALL show cameras with `channelSlot` in `17..32` in their corresponding cells and empty placeholders for any slot in that range with no camera, regardless of how many total cameras exist or their `createdAt` order.

---

## 8. API Requirements

### FR-CH-060 — POST /api/cameras extension

`POST /api/cameras` SHALL accept `channelSlot` (required), `maxChannel`, `supportSunapi`, `nvrProfiles` (all optional, discovery-sourced) in addition to existing fields, and SHALL persist all of them on the created record.

### FR-CH-061 — PUT /api/cameras/:id extension

`PUT /api/cameras/:id` SHALL accept `channelSlot` and `channelIndex` as optional partial-update fields (both currently unsupported by this endpoint) in addition to its existing accepted fields, applying FR-CH-010/011 validation to `channelSlot` when present.

### FR-CH-062 — GET /health extension

`GET /health` SHALL include `maxChannelNum` (the server's current effective `MAX_CHANNEL_NUM`) in its response, so the client can render correct stepper/group-browser bounds without a dedicated config endpoint.

### FR-CH-063 — probe-channels SHALL log SUNAPI/ONVIF discovery data at DEBUG level

`POST /api/cameras/probe-channels` (triggered by the Add modal's "Detect Channels", the Edit modal's "Re-detect", and the Found-tab `DiscoveredCameraPanel`'s "Re-detect" — FR-CH-045/048/048a/049) SHALL emit `console.debug()` log lines (gated by `LOG_LEVEL=DEBUG` per the existing production logger, `utils/logger.js`; suppressed at the default `LOG_LEVEL=INFO`) covering:

- The incoming request's resolved `ip`, `httpPort`, `httpType`, `onvifPort`, and whether credentials were supplied (the credential *values* — username/password — SHALL NOT be logged, consistent with the existing rule against logging RTSP URL credentials)
- Each SUNAPI endpoint path attempted (`querySunapiMaxChannel()`), with its outcome (HTTP status, timeout, connection error, or parsed `MaxChannel`)
- Each ONVIF SOAP call attempted (`enrichDevice()`: `GetDeviceInformation`, `GetCapabilities`, `GetProfiles`, `GetStreamUri` per profile), with success/failure and a final summary (`MaxChannel`, profile count, resolved-RTSP-URI count)
- The endpoint's final decision (`protocol`, `maxChannel`, `profiles.length`)

**Rationale**: `querySunapiMaxChannel()` and `enrichDevice()` fail silently by design (return `1`/best-effort partial data on any error, so a single unreachable protocol doesn't fail the whole probe — see FR-CH-046) — which also means an operator debugging "why did detection find nothing" has no visibility into *which* step failed (wrong port, auth rejected, timeout, no SourceToken in the ONVIF response, etc.) without this logging. DEBUG-gating (not INFO) keeps default-configuration log volume unaffected, since this same code path fires from ordinary background WS-Discovery scans (`ONVIFDiscovery` class) in addition to on-demand probes.

**Acceptance**: With `LOG_LEVEL=DEBUG`, clicking any of the three "detect/re-detect" UI entry points against a real or mocked device produces a traceable sequence of log lines from request to decision, as described in TC-CH-F-005. With the default `LOG_LEVEL=INFO`, none of these lines appear in the log file or Admin Log Viewer.

### FR-CH-064 — probe-channels SHALL skip the SUNAPI probe for an already-added camera with no resolvable password

When `POST /api/cameras/probe-channels` is called with a `cameraId` (currently only `CameraEditModal.tsx`'s "Re-detect" sends this — FR-CH-049), the server SHALL look up that camera's own stored `username`/`password` and use them for the SUNAPI probe when the request body does not already supply credentials. If no password is resolvable from **any** source — request body, the camera's DB record, nor the `RTSP_DEFAULT_PASSWORD` environment fallback (existing behavior per `docs/srs/SRS_Camera_Discovery.md` §"SUNAPI with auth") — the server SHALL skip the SUNAPI network call entirely (`querySunapiMaxChannel()` is not invoked; the SUNAPI contribution to `maxChannel` resolves to `1` immediately, without a network round-trip) rather than attempt an unauthenticated request.

This gate SHALL apply **only** when `cameraId` is present in the request. A `probe-channels` call with no `cameraId` (the Add modal's "Detect Channels" against a not-yet-added IP, or the Found-tab `DiscoveredCameraPanel`'s "Re-detect" — neither has an added-camera DB record to consult) SHALL continue to attempt the SUNAPI probe unauthenticated when no credentials are otherwise available, unchanged from FR-CH-045's original behavior — some devices do answer the unauthenticated channel-list query (see TC-CH-F-003).

**Rationale**: an operator reported the server logging repeated `ECONNREFUSED`/failed SUNAPI queries (visible via FR-CH-063's new DEBUG logging) against a camera that was added with no username/password on file — from the camera record alone, the server already knows this specific device has no way to authenticate against SUNAPI's Basic-Auth-gated `stw-cgi` endpoints, so retrying on every Re-detect click is a guaranteed-failure network round-trip that produces log noise for no benefit. This does not change FR-CH-045's behavior for a fresh IP with no prior record (there, "try once unauthenticated" is still a legitimate detection strategy, not a known-doomed retry).

**Acceptance**: Re-detecting a camera (`cameraId` set) whose DB record has `password: null`, no `RTSP_DEFAULT_PASSWORD` configured, and no explicit `password` in the request body SHALL return within milliseconds for the SUNAPI half of the probe (no network I/O attempted) and SHALL NOT emit a SUNAPI connection-error DEBUG line (FR-CH-063) — instead a distinct "skipping SUNAPI probe" DEBUG line SHALL appear. Re-detecting a camera whose record has a non-null `password` SHALL use it to authenticate the probe even though the request body itself carries no credentials. See TC-CH-F-008/F-009.

### FR-CH-065 — probe-channels SHALL reuse a cached UDP Discovery result instead of querying SUNAPI CGI when available

`POST /api/cameras/probe-channels`'s SUNAPI channel count (`sunapiMax`) SHALL first check whether the requested `ip` has already been discovered by the UDP Discovery scan (`discoveryService.js`'s in-memory cache, exposed via a new `DiscoveryService.getByIp(ip)` lookup — synchronous, no network I/O). If a cached device exists with `SupportSunapi: true` and `MaxChannel > 1`, that cached value SHALL be used directly as `sunapiMax`, and `querySunapiMaxChannel()` (the HTTP CGI query) SHALL NOT be invoked for that request. The SUNAPI CGI query (and FR-CH-064's credential gate, which only applies once the CGI path is reached) SHALL only run when no such cache hit exists.

**Rationale**: `sunapiMax` was previously always sourced from a fresh `querySunapiMaxChannel()` HTTP CGI call — a mechanism entirely independent of the UDP Discovery broadcast scan, despite both being labeled "SUNAPI." When the exact IP had already been found and channel-counted by the background/manual scan, `probe-channels` had no way to know that and always re-queried over HTTP, ignoring information already sitting in `discoveryService.js`'s cache.

**Precedence**: this cache check runs *before* FR-CH-064's credential gate — a cache hit requires no credentials at all, since the scan already established the channel count independently.

**Acceptance**: Calling `probe-channels` for an `ip` that a prior UDP Discovery scan already reported as an 8-channel SUNAPI device SHALL return `{ maxChannel: 8, supportSunapi: true, protocol: 'sunapi' }` without any DEBUG log line indicating a SUNAPI CGI request was attempted (`[Discovery][SUNAPI] querying ...` SHALL NOT appear for that call) — a `cachedMaxChannel=8` marker SHALL appear instead. Calling `probe-channels` for an IP with no discovery-cache entry SHALL behave exactly as before this requirement (FR-CH-045/046/047/064 unchanged).

### FR-CH-066 — Per-protocol MaxChannel SHALL be tracked and surfaced independently of the merged/winning value (2026-07-02)

Every location that currently derives a single, merged `MaxChannel` (§7's `mergeDevices()` `Math.max()` rule; `probe-channels`'s "ONVIF preferred, else SUNAPI" `maxChannel`/`protocol` decision, FR-CH-047) SHALL additionally track and expose each protocol's own independently-determined channel count, so an operator can see what SUNAPI and ONVIF each actually reported, not just whichever one "won":

- `mapUDPDevice()` and the SUNAPI CGI fallback (`querySunapiMaxChannel()`, via `_runScan()`/`streamHandler.js`'s manual rescan) SHALL set a `SunapiMaxChannel` field on the device object, distinct from the existing merged `MaxChannel`
- `onvifDiscovery.js`'s `enrichDevice()` SHALL set an `OnvifMaxChannel` field on its result, distinct from the existing `MaxChannel` it already sets
- `mergeDevices()` SHALL merge `SunapiMaxChannel` and `OnvifMaxChannel` independently (each is a `Math.max()` of its own existing/incoming value — never cross-contaminated with the other protocol's value, since only that protocol's own code path ever sets it)
- `POST /api/cameras/probe-channels`'s response SHALL include `sunapiMaxChannel` (a number — the SUNAPI probe's own result, `1` when not attempted/not detected) and `onvifMaxChannel` (a number, or `null` when the ONVIF probe never returned a response at all — e.g. timed out — as opposed to responding with a genuine single-channel result) alongside the existing combined `maxChannel`/`protocol`/`profiles` fields, which remain unchanged for backward compatibility with existing callers
- The Found-tab discovery detail panel (`DiscoveredCameraPanel.tsx`) SHALL display both values as separate, always-visible rows (not conditional on `> 1` the way the existing combined `{MaxChannel} CH` badge is) — showing "not detected" when the corresponding field is `undefined`/`null`, so an operator can distinguish "this protocol was never queried/never responded" from "queried and confirmed single-channel"

**Rationale**: prior to this requirement, `MaxChannel` was a single value produced by taking the max across whatever SUNAPI and ONVIF each separately reported (`mergeDevices()`) — once merged, there was no way to tell an operator "SUNAPI reported 4, ONVIF reported 1" versus "SUNAPI reported 1, ONVIF reported 4"; both collapse to the same displayed "4 CH". For a mixed-protocol device (e.g. a Wisenet NVR that also answers ONVIF `GetDeviceInformation` but not `GetProfiles` per-channel), this ambiguity made it impossible to tell from the UI alone which protocol's detection actually succeeded, which matters when diagnosing why channel-select buttons in the Add/Edit flows resolve real per-channel RTSP URLs (ONVIF, via `GetStreamUri`) versus synthesized ones (SUNAPI path-substitution, `channelRtspUrl()`).

**Acceptance**: Probing an IP whose mock SUNAPI endpoint reports 6 channels (no ONVIF service present) SHALL return `{ maxChannel: 6, protocol: 'sunapi', sunapiMaxChannel: 6, onvifMaxChannel: <a number> }` — `sunapiMaxChannel` matching the combined `maxChannel` exactly (SUNAPI is the sole source here), and `onvifMaxChannel` present and independently correct (not equal to 6, since ONVIF never reported that). See TC-CH-F-011.

### FR-CH-067 — `querySunapiMaxChannel()` SHALL retry with HTTP Digest authentication when the SUNAPI endpoint challenges for it

When the SUNAPI CGI query (`GET /stw-cgi/attributes.cgi/attributes`) receives a `401`/`403` whose `WWW-Authenticate` response header advertises the `Digest` scheme, and credentials (`username`+`password`) are available, the server SHALL compute an RFC 7616 Digest `Authorization` header (MD5, `qop=auth` when offered by the challenge) and retry the request once before treating the probe as failed. A request that only ever received a `Basic` challenge, or that still 401s after the Digest retry, SHALL be treated as a genuine authentication failure exactly as before (`maxChannel` resolves to `1`).

**Rationale**: a real device (SUNAPI web UI fronted by nginx, `WWW-Authenticate: Digest ...`) was reported as single-channel/unauthenticated on every probe despite the operator's credentials being independently confirmed correct (accepted by the same device's own web UI login, and by `curl --digest`). The prior implementation only ever sent `Authorization: Basic ...`, which this firmware never accepts regardless of whether the password is correct — every such device silently and permanently failed the credential-gated paths added by FR-CH-064/FR-CH-040a, indistinguishable in the logs from a truly wrong password.

**Acceptance**: Probing a mock SUNAPI endpoint that responds `401` with `WWW-Authenticate: Digest qop="auth", realm="...", nonce="..."` to a Basic-authenticated request, then `200` with a valid `MaxChannel` body to a correctly-computed Digest-authenticated retry, SHALL return the XML's `MaxChannel` value — not `1`. A mock endpoint that 401s both the Basic attempt and a well-formed Digest retry (i.e. genuinely wrong credentials) SHALL still resolve to `1`, unchanged from prior behavior. See TC-CH-F-012.

### FR-CH-068 — `POST /api/cameras/probe-channels` SHALL write a corrected MaxChannel back into the discovery registry (2026-07-02)

When an on-demand probe (Add's "Detect Channels", Edit's "Re-detect", or the Found-tab panel's "Re-detect" — all three share this one endpoint) determines a `maxChannel`, `sunapiMaxChannel`, or `onvifMaxChannel` value **higher** than what the background-scan discovery registry (`DiscoveryService`'s in-memory `_known` map) already has on file for that IP, the server SHALL update the registry entry to the higher value and broadcast the correction via the existing `discovery:result` Socket.IO event, exactly as a fresh scan discovery would. This SHALL apply only when the IP is already present in the registry (i.e. this corrects a known entry — it does not create a new registry entry for an IP the scan has never seen). A probe result that is lower than, or equal to, what the registry already has SHALL NOT modify the registry or emit any event.

**Rationale**: FR-CH-066 added per-protocol MaxChannel display in the Found-tab detail panel, but a successful Re-detect only updated that panel's own local component state (`redetected`) — the correction was never written back into the shared `DiscoveryService` registry that the Found-tab's compact sidebar list (and every other connected client) reads from. Concretely: the automatic background scan reports `MaxChannel: 1` for a device whose binary-broadcast channel-count field isn't parsed yet (FR-CH-040a's known limitation); an operator who has the device's actual credentials clicks Re-detect and correctly determines `MaxChannel: 2` via `attributes.cgi` — but closing the panel (or looking at the list badge without opening it) reverted back to showing `1`, since nothing outlived the panel's local React state. This SHALL no longer happen: a genuine improvement in what's known about a device SHALL persist for the rest of that scan session and be visible to every connected dashboard, not just the browser tab that ran the probe.

**Acceptance**: With a device already present in the discovery registry reporting `MaxChannel: 1`, calling `probe-channels` for that IP with credentials that resolve a real `MaxChannel: 2` from `attributes.cgi` SHALL result in the registry's entry for that IP subsequently reporting `MaxChannel: 2` (verified via `DiscoveryService.getByIp()`), and SHALL trigger exactly one `discovery:result` broadcast reflecting the corrected value. Calling `probe-channels` again with a result of `1` (e.g. a subsequent unauthenticated attempt) SHALL leave the registry's `MaxChannel: 2` unchanged and SHALL NOT broadcast anything. Calling `probe-channels` for an IP that has never been discovered by any scan SHALL have no effect on the registry (nothing to correct). See TC-CH-G-003.

---

## 9. Non-Functional Requirements

| ID | Requirement |
|---|---|
| NFR-CH-01 | Channel Slot validation (range + uniqueness) adds no more than one additional DB scan (`db.all('cameras')` or equivalent) per `POST`/`PUT` request |
| NFR-CH-02 | The feature applies only when `SERVER_MODE` is `combined` or `streaming`; `analysis` mode (no camera capture) is unaffected and MAY omit `MAX_CHANNEL_NUM` from its `.env` |
| NFR-CH-03 | Startup migration (FR-CH-020) SHALL complete before the server begins accepting camera-management API requests, to avoid a race between migration and a concurrent `POST`/`PUT` |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-02 | 초기 작성 |
| 1.1 | 2026-07-02 | FR-CH-045~049 추가 — `POST /api/cameras/probe-channels` (discovery 스캔 없이 즉시 감지), per-protocol 타임박스, ONVIF/SUNAPI 우선순위, 수동 Add/Edit 화면 상시 감지 버튼 |
| 1.2 | 2026-07-02 | FR-CH-049a 추가 — Re-detect 결과가 "채널 없음"이어도 클릭 전 문구가 그대로 남으면 안 됨(무반응처럼 보이던 결함 수정) |
| 1.3 | 2026-07-02 | FR-CH-048a 추가 — Found 탭 discovery 패널에 Re-detect 버튼 (Detect Channels와 중복 아님을 SHALL NOT으로 명문화) |
| 1.4 | 2026-07-02 | FR-CH-063 추가 — probe-channels가 SUNAPI/ONVIF discovery 데이터를 DEBUG 레벨로 로그 남겨야 함 (Add/Edit/Found 세 진입점 공통) |
| 1.5 | 2026-07-02 | FR-CH-064 추가 — cameraId가 있고 카메라 레코드에 비밀번호가 없으면 SUNAPI probe 자체를 생략(불필요한 ECONNREFUSED/401 방지); cameraId 없는 Add/Found 흐름은 기존 무인증 시도 동작 유지 |
| 1.6 | 2026-07-02 | FR-CH-040a/040b 추가 — 백그라운드 discovery 스캔은 UDP 응답을 1차 MaxChannel 소스로, SUNAPI CGI 조회는 `hasConfiguredSunapiCredentials()`가 true일 때만 2차 폴백으로 사용해야 함(FR-CH-040a); 수동/온디맨드 흐름(FR-CH-045/048/048a/049)은 이 게이팅의 영향을 받지 않음(FR-CH-040b). TC-CH-G-001a~d 자동화 테스트 참조 |
| 1.7 | 2026-07-02 | FR-CH-065 추가 — probe-channels가 SUNAPI CGI 쿼리 전에 UDP Discovery 캐시(`DiscoveryService.getByIp()`)를 우선 확인해야 함; FR-CH-064 자격증명 게이트보다 우선순위 높음 |
| 1.8 | 2026-07-02 | FR-CH-040a SUNAPI CGI 엔드포인트 정정 — 존재하지 않는 `media.cgi?msubmenu=channellist`/`system.cgi?msubmenu=systeminfo` 대신 실제 엔드포인트 `GET /stw-cgi/attributes.cgi/attributes`(FR-CAM-062a) 반영; TC-CH-G-001 표기를 실제 테스트(단일 케이스)와 일치하도록 정정 |
| 1.9 | 2026-07-02 | FR-CH-066 추가 — SUNAPI/ONVIF 각 프로토콜의 MaxChannel을 병합된 값과 별개로 추적·노출해야 함 (`SunapiMaxChannel`/`OnvifMaxChannel` 필드, probe-channels 응답의 `sunapiMaxChannel`/`onvifMaxChannel`, Found 상세 패널에 항상 표시되는 행). Found 패널에 SUNAPI MaxChannel을 표시해 달라는 요청에 따라 도입 |
| 1.10 | 2026-07-02 | FR-CH-067 추가 — SUNAPI 쿼리가 Basic 인증만 지원해 Digest를 요구하는 펌웨어에서 정상 자격증명도 401로 거부되던 버그 수정. 실 카메라(192.168.214.32)를 `curl --digest`로 독립 검증해 자격증명 자체는 정상임을 확인 후 도입 |
| 1.11 | 2026-07-02 | FR-CH-068 추가 — probe-channels의 결과가 discovery 레지스트리 값보다 높으면 레지스트리를 갱신하고 discovery:result를 재브로드캐스트해야 함 (UDP 스캔이 MaxChannel:1로 보고한 실제 다채널 장치를 Re-detect로 확인했을 때, 그 정정이 패널을 닫아도 유지되도록). 실 카메라(192.168.214.32, UDP=1 vs attributes.cgi=2)로 직접 검증 |
