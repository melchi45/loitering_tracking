# MRD — Dashboard Channel Slot

**Product:** LTS-2026 Loitering Detection & Tracking System
**Feature:** Global Channel Slot Mapping for Cameras / YouTube Streams
**Version:** 1.7
**Date:** 2026-07-02
**Author:** LTS Engineering Team

---

## 1. Executive Summary

Today, a camera's position in the Streaming Dashboard grid is an accident of insertion order (`createdAt` descending) — there is no way for an operator to say "this entrance camera is always Channel 12" the way NVR/CCTV control-room operators expect from every professional VMS. This makes site documentation, radio/phone communication ("check channel 12"), and camera relocation error-prone, and makes it impossible to reserve channel numbers for cameras that haven't been installed yet.

This feature introduces a persistent, system-wide **Channel Slot** (1..`MAX_CHANNEL_NUM`, default 512) that every camera or YouTube stream is mapped to at add-time and can be changed later. The Streaming Dashboard grid renders strictly by Channel Slot going forward — grid cell N always shows whichever source is mapped to channel N, empty if none — with group-paging controls to browse the full channel space regardless of the currently selected grid layout.

Separately, this feature also surfaces NVR sub-channel selection (already computed today via SUNAPI/ONVIF discovery, but currently only usable once, at add-time, only in the auto-discovery flow) in the camera Edit screen too, so operators can re-point an already-added camera at a different physical NVR channel without deleting and re-adding it.

---

## 2. Market / Operational Need

| Pain Point | Impact |
|---|---|
| Camera position in the dashboard grid changes whenever a new camera is added (insertion-order based) | Operators cannot memorize/document "channel N = location X"; radio communication during incidents is error-prone |
| No way to reserve a channel number for a not-yet-installed camera | Site documentation and channel numbering plans can't be prepared ahead of physical installation |
| NVR sub-channel (SUNAPI/ONVIF `MaxChannel`) can only be chosen once, during auto-discovery add | Re-pointing a camera record to a different NVR channel requires delete + re-discover + re-add, losing any AI/zone configuration tied to the old camera ID |
| Large sites (up to hundreds of cameras) have no way to browse "which channel numbers are still free" | Operators must scroll/search the full camera list to find an unused number |

---

## 3. Target Users

| User | Context |
|---|---|
| System Administrator / Installer | Assigns and documents channel numbers during site commissioning |
| Security Operator | Refers to cameras by channel number during incident response, matching site documentation/radio conventions |
| Integrator (SUNAPI/ONVIF NVR sites) | Adds NVR devices with many physical channels and needs to both pick and later re-point sub-channels |

---

## 4. Business Requirements

| ID | Requirement |
|---|---|
| BR-01 | Every camera and YouTube stream must be assignable to a persistent, system-wide Channel Slot (1..`MAX_CHANNEL_NUM`) |
| BR-02 | `MAX_CHANNEL_NUM` must be operator-configurable (`server/.env`), default 512, without requiring a code change |
| BR-03 | Two Channel Slot selection methods must both be available at the same time in the Add/Edit UI: a numeric up/down stepper, and a group browser that pages through the channel space in increments matching the current dashboard grid size, showing which slots are free vs taken |
| BR-04 | The Streaming Dashboard grid must render cameras by their assigned Channel Slot (grid cell N ⇔ Channel Slot N), showing an empty placeholder for unmapped slots, with group-paging (</>) to browse the full `MAX_CHANNEL_NUM` space independent of how many cameras exist |
| BR-05 | Two cameras must never be assigned the same Channel Slot — the system must reject a conflicting assignment and require the operator to pick a different value |
| BR-06 | For SUNAPI-capable or ONVIF multi-channel (NVR) sources, the Add screen must offer channel-select buttons for the discovered device's physical channels (0/1..MaxChannel, per existing discovery behavior) |
| BR-07 | The same physical-channel re-selection from BR-06 must also be available on the Edit screen for an already-added camera, without requiring a fresh discovery scan |
| BR-08 | Existing cameras (added before this feature) must not disappear from the dashboard after upgrade — they must be automatically backfilled with a Channel Slot on first startup after the upgrade |
| BR-09 | The Found-tab discovery panel (which already has channel data from its scan) must NOT duplicate the manual Add form's from-scratch "Detect Channels" flow — but it must let the operator force a fresh, single-IP re-probe if the scan's result looks stale or incomplete, without leaving the panel or re-running a full network scan |
| BR-10 | SUNAPI channel-count detection during automatic background discovery must prefer the UDP broadcast response's own data over an HTTP CGI round-trip — the CGI query (`GET /stw-cgi/attributes.cgi/attributes`) must only run as a secondary/fallback check, and only when real credentials are actually configured, not as an unauthenticated best-effort call fired for every SUNAPI-flagged device on every scan |

---

## 5. Success Metrics

- Zero cameras lost/hidden from the dashboard immediately after upgrading to a build with this feature (backfill correctness)
- Channel Slot assignment conflicts are always caught before being persisted (zero silent duplicate-slot cameras in the DB)
- Time to locate a free channel number for a new camera on a site with 100+ cameras: under 10 seconds using the group browser

---

## 6. Known Issues — Resolved

| Date | Issue | Resolution |
|---|---|---|
| 2026-07-02 | BR-07's Edit-screen re-selection originally only worked for cameras already carrying persisted NVR metadata (`maxChannel`/`nvrProfiles` from the original discovery add) — cameras added before this feature, or added manually, had no way to discover their NVR channels from the Edit screen at all. | Added `POST /api/cameras/probe-channels`, an on-demand SUNAPI+ONVIF detection endpoint keyed off IP alone (no discovery scan needed). The Edit modal's "Re-detect" button and the manual Add form's "Detect Channels" button both call it. See `docs/design/Design_Channel_Slot.md` §4.6. |
| 2026-07-02 | The Edit modal's "Re-detect" button appeared to do nothing when clicked against a camera that genuinely has no multi-channel NVR (or an ONVIF device behind authentication, which this project's ONVIF client cannot authenticate against) — the static "No NVR channel data yet — click Re-detect..." prompt stayed on screen unchanged after the click completed, with no way to tell the request had run at all. | The prompt now distinguishes "never attempted" from "attempted, found nothing" — a distinct message ("Re-detect ran (...) — single-channel or no multi-channel NVR found") appears once a detection completes, regardless of outcome. See `docs/design/Design_Channel_Slot.md` §5.4a. |
| 2026-07-02 | The Add modal's "Detect Channels" reported "single-channel" for a device that had already been confirmed multi-channel by a prior UDP SUNAPI Discovery scan, because it never reused that scan's known `httpPort`/`httpType` and instead blind-guessed port 80/HTTP. | The Add form now looks up a matching IP in the discovery store and forwards its known port/scheme/credentials to the detection request. See `docs/design/Design_Channel_Slot.md` §5.3a. |
| 2026-07-02 | Because `querySunapiMaxChannel()`/`enrichDevice()` fail silently by design (any error collapses to the same "single-channel" result), an operator debugging a failed detection — including the two issues above — had no way to see *why* it failed (wrong port, rejected auth, timeout, vs. a genuinely single-channel device) without reading source code. | `POST /api/cameras/probe-channels` now emits `DEBUG`-level log lines (opt-in via `LOG_LEVEL=DEBUG`, no effect on default log volume) tracing every SUNAPI/ONVIF call it makes and why each one succeeded or failed. See `docs/design/Design_Channel_Slot.md` §4.6a and `docs/ops/Channel_Slot_Guide.md` §5.2. |
| 2026-07-02 | The Edit modal's "Re-detect" (surfaced by FR-CH-063's new DEBUG logging) turned out to be attempting an unauthenticated SUNAPI query — and logging its connection failure — against a camera that was added with no username/password on file at all; the camera's own DB record already made that outcome certain, so retrying on every click was pure noise. | `POST /api/cameras/probe-channels` now looks up the target camera's stored credentials by `cameraId` and skips the SUNAPI probe entirely when neither the request, the camera record, nor `RTSP_DEFAULT_PASSWORD` can supply one. Applies only when re-probing a specific already-added camera (`cameraId` present) — a fresh, not-yet-added IP still gets the original best-effort unauthenticated attempt. See `docs/design/Design_Channel_Slot.md` §4.6b. |
| 2026-07-02 | The automatic background discovery scan fired an unauthenticated SUNAPI CGI request for *every* SUNAPI-flagged device on *every* scan cycle, even with no configured credentials — on modern auth-required firmware this is a guaranteed 401, wasting a network round-trip per device per scan for no benefit, and duplicating what BR-06's own UDP discovery response should be able to report directly. The Socket.IO-triggered manual rescan (`streamHandler.js`) had the identical unguarded pattern. | The CGI query is now gated behind `hasConfiguredSunapiCredentials()` (`RTSP_DEFAULT_USERNAME`/`RTSP_DEFAULT_PASSWORD` both set) and only runs when the primary source (the UDP response) hasn't already reported `MaxChannel > 1` — i.e. it is now a true secondary/fallback, per BR-10 — applied identically to both the background scan and the manual rescan path. See `docs/design/Design_Channel_Slot.md` §4.6c. |
| 2026-07-02 | The SUNAPI CGI query itself (`querySunapiMaxChannel()`, the secondary/fallback path from BR-10 above) was pointed at two endpoints that don't exist on real SUNAPI devices — `/stw-cgi/media.cgi?msubmenu=channellist&action=view` and `/stw-cgi/system.cgi?msubmenu=systeminfo&action=view` — so it always returned `404`/connection errors and never once succeeded, regardless of whether credentials were configured. Reported directly by the customer, who identified the correct endpoint from the vendor's own documentation. | Corrected to the real SUNAPI capability endpoint, `GET /stw-cgi/attributes.cgi/attributes` — an XML document, not JSON — parsing `MaxChannel` from `<group name="System"><category name="Limit"><attribute name="MaxChannel" value="N"/>`, matching the vendor IP Installer's own query path (`System/Limit/MaxChannel`). This is what makes the credential-gating above (and BR-10 generally) actually functional in practice, not just correct on paper. See `docs/srs/SRS_Camera_Discovery.md` FR-CAM-062a, `docs/design/Design_Camera_Discovery.md` §3.1. |
| 2026-07-02 | Code review caught that `probe-channels`' `sunapiMax` value comes from a fresh HTTP CGI query (`querySunapiMaxChannel()`) — a mechanism completely independent of the UDP Discovery broadcast scan, despite both being labeled "SUNAPI." When the exact IP had already been found and channel-counted by the background/manual scan, `probe-channels` had no way to know that and always re-queried over HTTP from scratch, ignoring information already sitting in the discovery service's own cache. | `DiscoveryService` gained a synchronous `getByIp(ip)` lookup (no network I/O); `probe-channels` now checks it first and reuses a cached `MaxChannel` directly — skipping the CGI query (and the credential requirement above) entirely — when the IP was already scanned and reported as a multi-channel SUNAPI device. Falls through to the CGI query exactly as before when there's no cache hit, so BR-01/FR-CH-045's "no prior scan required" guarantee is unaffected. See `docs/design/Design_Channel_Slot.md` §4.6d. |

**In progress (2026-07-02, blocked on external spec data):** BR-10's "primary source" — reading `MaxChannel` directly out of the UDP discovery binary response — could not be completed this pass. The current parser (`submodules/WiseNetChromeIPInstaller/nodejs/udpDiscovery.js` and the inline fallback) stops at byte 333 of the response and does not decode a channel-count field; the two single-byte gaps within that range (`Reserved2` at offset 119, `Reserved3` at offset 329) are candidates, but confirming which — or whether the real field lies beyond byte 333 — requires the exact SUNAPI IP Installer protocol spec, which could not be retrieved (internal-only host). `mapUDPDevice()` has been made forward-compatible (`MaxChannel: raw.MaxChannel > 1 ? raw.MaxChannel : 1`) so wiring in the real offset later is a one-line parser change with no other code to touch. Until then, the secondary CGI path (with real credentials configured) remains the only way to detect `MaxChannel > 1` automatically.

---

## 7. Out of Scope

- Automatically re-numbering/compacting Channel Slots when a camera is deleted (gaps are expected and fine — Channel Slot is a stable identity, not a dense index)
- ONVIF WS-Security authenticated `GetProfiles`/`GetStreamUri` calls — today's ONVIF discovery sends no authentication at all (pre-existing limitation, unrelated to this feature); on-demand detection (§6) works around it only insofar as it still can't authenticate — a password-protected ONVIF NVR will simply report no channels found
- Bulk/CSV import of Channel Slot assignments across many cameras at once
- Renumbering channel slots via drag-and-drop directly on the dashboard grid (Add/Edit modal only, for this phase)

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-02 | 초기 작성 |
| 1.1 | 2026-07-02 | §6 Known Issues — Resolved 섹션 신설 (probe-channels 온디맨드 감지 도입, Re-detect 무반응처럼 보이던 결함 수정 기록), §7로 Out of Scope 재번호 |
| 1.2 | 2026-07-02 | BR-09 추가 — Found 탭 discovery 패널은 별도 "Detect Channels"가 불필요(이미 스캔 데이터 보유)하지만, 스캔 결과가 오래됐거나 불완전할 때를 위한 즉시 재감지(Re-detect)는 필요함을 명문화 |
| 1.3 | 2026-07-02 | §6에 두 항목 추가 — Add 모달이 기존 UDP SUNAPI Discovery 결과를 재사용하지 않던 결함, 그리고 그 근본 진단을 위한 DEBUG 레벨 discovery 로깅 도입 |
| 1.4 | 2026-07-02 | BR-10 추가 — SUNAPI 채널 감지는 UDP discovery 응답을 1차 소스로 사용해야 하며, CGI 조회는 자격증명이 실제 설정된 경우에만 2차 수단으로 사용해야 함. `hasConfiguredSunapiCredentials()` 게이팅 완료(§6), UDP 바이너리 파싱 자체는 외부 스펙 데이터 대기 중(In progress 항목) |
| 1.5 | 2026-07-02 | §6에 두 항목 추가 — probe-channels가 cameraId 있는 Re-detect 요청에서 비밀번호 없는 카메라의 SUNAPI probe를 생략하도록 수정, streamHandler.js 수동 rescan 경로도 hasConfiguredSunapiCredentials() 게이팅 적용 |
| 1.6 | 2026-07-02 | BR-10·§6 SUNAPI CGI 엔드포인트 정정 — 존재하지 않는 `media.cgi?msubmenu=channellist`/`system.cgi?msubmenu=systeminfo` 대신 실제 엔드포인트 `GET /stw-cgi/attributes.cgi/attributes`(XML, System/Limit/MaxChannel) 반영. 고객이 직접 정확한 엔드포인트를 지적함 |
| 1.7 | 2026-07-02 | §6에 항목 추가 — probe-channels의 sunapiMax가 UDP Discovery 결과가 아니라는 코드 리뷰 지적을 계기로, 이미 스캔된 IP는 discovery 캐시를 우선 재사용하도록 확장 (FR-CH-065) |
