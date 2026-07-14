# MRD — Camera Discovery & Network Search Subsystem

**Product:** LTS-2026 Loitering Detection & Tracking System
**Feature:** Automatic IP Camera Discovery (WiseNet UDP + ONVIF WS-Discovery) & RTSP URL Resolution
**Version:** 1.4
**Date:** 2026-07-14
**Author:** LTS Engineering Team

---

## 1. Executive Summary

Manually typing RTSP URLs, IP addresses, and credentials for every camera on a site is slow and error-prone, especially for NVR/DVR devices exposing many physical channels behind a single IP. The Camera Discovery subsystem finds cameras automatically over the LAN (WiseNet/Hanwha proprietary UDP broadcast and standards-based ONVIF WS-Discovery), enumerates their multi-channel structure, and resolves a working RTSP URL for each channel — reducing camera onboarding from "look up the RTSP URL format for this model" to "click Add."

This document also covers the subsystem's ongoing accuracy work: getting the *right* RTSP URL and channel count out of real, heterogeneous vendor firmware is where most of this feature's engineering effort has actually gone — vendor CGI endpoints that don't match documentation, authentication scheme mismatches, self-signed certificates, forced HTTP→HTTPS redirects, and (most recently) two different RTSP path conventions in simultaneous use across this site's own camera fleet.

---

## 2. Market / Operational Need

| Pain Point | Impact |
|---|---|
| Every IP camera/NVR vendor has its own RTSP URL path convention, port defaults, and authentication quirks | Manual camera onboarding requires vendor documentation or trial-and-error per model; error-prone at scale |
| NVR/DVR devices expose many physical channels behind one IP address | Operators can't discover or select individual channels without vendor-specific tooling |
| SUNAPI (WiseNet/Hanwha) and ONVIF (industry standard) often disagree — different schemes (HTTP/HTTPS), different channel counts, different URL shapes on the very same device | A discovery mechanism that only speaks one protocol misses devices or under-reports channels |
| Real-world firmware deviates from vendor documentation (wrong CGI paths, Basic-only vs Digest auth, self-signed TLS certs, forced redirects) | A discovery implementation written strictly to spec silently fails against real hardware without extensive live-device testing |
| A camera's actually-configured RTSP port can differ from the protocol default (554) without any visible indication | Camera added with the wrong port never connects, with no diagnostic short of packet capture |

---

## 3. Target Users

| User | Context |
|---|---|
| System Administrator / Installer | Adds cameras during site commissioning; needs discovery to "just work" across mixed-vendor sites without per-model research |
| Security Operator | Relies on live video from every configured channel; a wrong RTSP URL or port is a silent failure they have to escalate |
| Integrator (SUNAPI/ONVIF NVR sites) | Adds NVR devices with many physical channels; needs accurate channel enumeration and per-channel URLs, not just a device-level connection |

---

## 4. Business Requirements

| ID | Requirement |
|---|---|
| BR-01 | The system must discover cameras on the LAN via both WiseNet/Hanwha proprietary UDP broadcast and standards-based ONVIF WS-Discovery, without requiring the operator to know which protocol a given device speaks |
| BR-02 | For NVR/DVR devices, the system must detect the physical channel count (`MaxChannel`) and let the operator add any individual channel, not just the device as a whole |
| BR-03 | The system must resolve a working, channel-specific RTSP URL automatically — from live ONVIF `GetStreamUri` data when available, from SUNAPI CGI queries when credentials are available, or from a best-effort default pattern otherwise |
| BR-04 | RTSP URL synthesis must recognize the actual path conventions in use by real deployed hardware, not only the vendor's documented default — including cases where the same "SUNAPI" label covers multiple distinct URL shapes across different device models |
| BR-05 | When the RTSP port is not the protocol default, the system must be able to confirm the actual configured port via an authenticated device query rather than guessing |
| BR-06 | Discovery/detection must remain best-effort and non-blocking — a single unreachable, slow, or misbehaving device must never stall discovery for the rest of the network, and every network call the subsystem makes must be individually time-boxed |
| BR-07 | Every discovery/detection call must fail closed on authentication and redirect handling — never attempt an authenticated query with a device the caller already knows has no credentials on file, and never follow an HTTP redirect to a different host (SSRF hardening) |
| BR-08 | Operators must be able to see which protocol (SUNAPI or ONVIF) actually produced a given piece of information (channel count, RTSP URL), not only a merged "best guess," to diagnose cases where the two disagree or where only one is reachable |

---

## 5. Success Metrics

- A newly discovered multi-channel NVR's `MaxChannel` and per-channel RTSP URLs are correct (verified against the device's own web UI) for every model type present on the deployment's test network
- Zero discovery/detection requests hang indefinitely — every SUNAPI/ONVIF call resolves (success, timeout, or explicit failure) within its configured time box
- An operator can add a camera and get a working video stream without consulting vendor documentation, for every model surveyed on this site's network

---

## 6. Known Issues — Resolved

| Date | Issue | Resolution |
|---|---|---|
| 2026-07-02 | `channelRtspUrl()`'s channel-switch URL synthesis only recognized the `/profileN/` (1-based) SUNAPI path convention. A survey of this deployment's own camera DB records found that convention in use on only one of six surveyed devices — the rest use `/<channel 0-based>/H.264/media.smp` — so channel switching silently no-op'd (returned the URL unchanged) for the majority of real cameras on this network. | `channelRtspUrl()` now detects which convention a given base URL already uses and substitutes only within that shape; a new `defaultSunapiRtspUrl()` synthesizes a fresh URL with the `/N/H.264/` convention when no base URL is known at all. See `docs/design/Design_Camera_Discovery.md` §3.1a, FR-CAM-078. |
| 2026-07-02 | The default RTSP port assumption (554) can be wrong for a specific device without any way to detect it — found live on 192.168.214.32 (TID-A800), whose own DB record stores port `10030` while the device's own SUNAPI configuration reports `RTSPPort=554`. | New `querySunapiRtspPort()` confirms the actual configured RTSP port via `GET /stw-cgi/network.cgi?msubmenu=portconf&action=view` when credentials are available (verified live via `curl --digest` against two real devices before implementation, in the plain `key=value` response shape the CGI actually returns — not XML). Falls back to 554 when unconfirmed. See `docs/design/Design_Camera_Discovery.md` §3.1a, FR-CAM-079. |
| 2026-07-02 | The SUNAPI CGI client (`sunapiRequest()`) did not follow HTTP redirects — a device that force-redirects its plain-HTTP web port to HTTPS (observed live: 192.168.214.37) made every SUNAPI query fail with a bare `HTTP 301`, indistinguishable from the device not supporting SUNAPI at all. The ONVIF SOAP client had the identical gap. | Both clients now follow one same-host redirect (SSRF-hardened — a redirect to a different host is never followed). See `docs/design/Design_Camera_Discovery.md` §3.1a/§8, FR-CAM-076 (ONVIF) and FR-CAM-077 (SUNAPI). |
| 2026-07-02 | `probe-channels`' response only exposed the "winning" protocol's channel URLs — an operator debugging a mismatch (e.g. SUNAPI reports 4 channels, ONVIF reports 1) had no way to see what each protocol actually returned. | Response now includes `sunapiProfiles`/`onvifProfiles` independently, alongside the existing merged `profiles`. Displayed as separate rows in the Found panel and Edit modal. See `docs/design/Design_Camera_Discovery.md` §5.3, FR-CAM-080. |
| 2026-07-02 | UDP discovery's extended fields (`modelType`, `alias`, etc.) silently defaulted to a false `0`/`''` instead of `undefined` when a response packet was too short — a genuine, real-world case (262-byte responses observed live carry none of these fields), not a hypothetical edge case. `modelType: 0` is indistinguishable from a real Device Type "Camera." | Parser now gates each extended field on its own remaining-byte count in sequence, stopping at the first one that doesn't fit — leaves fields honestly `undefined` instead. Also added `DeviceType`, a human-readable Device Type label, surfaced in the Found panel. See `docs/design/Design_Camera_Discovery.md` §3.1b, FR-CAM-081. |
| 2026-07-02 | **Not a software defect, but discovered during this investigation and worth recording**: two physical cameras (different MAC addresses and models) were found answering WiseNet UDP discovery from the same IP address (192.168.214.37) — a LAN configuration conflict. This was the actual root cause of channel-count/port results that appeared to change unpredictably between requests to "the same" camera — whichever device the network's ARP resolution currently pointed to for that IP was the one any HTTP-based query actually reached. | Not resolvable in software — flagged for the network team to assign the conflicting device a unique IP. Diagnostic method (raw UDP capture + `arp -n`) documented in `docs/ops/Camera_Discovery_Guide.md` §5. |
| 2026-07-02 | The inline UDP discovery fallback (used when `submodules/WiseNetChromeIPInstaller` isn't initialised) parsed responses as ONVIF XML while broadcasting on WiseNet's own ports (7701/7711) — it could not discover a real SUNAPI/WiseNet camera at all, with no error surfaced (indistinguishable from "no cameras on the LAN"). Found while documenting the vendor's SUNAPI IP Installer protocol spec (§3.4 "IP Scan for SUNAPI") at the user's request. | Fallback now implements the same WiseNet binary protocol as the submodule, byte-for-byte (including the bounds-check fix above). Verified live: run standalone (no submodule), it discovered all 13 known cameras on this network. See `docs/design/Design_Camera_Discovery.md` §3.1c, FR-CAM-082. |
| 2026-07-03 | A customer review comparing the parser directly against the vendor's own Annex A C structs found the extended block's final two fields, `supported_protocol` and `no_password`, had silently collapsed into one — the parser read `noPassword` from the byte belonging to the preceding `supported_protocol` field and never advanced to read the real trailing `no_password` byte. Separately, whether the extended block was parsed at all was decided purely by remaining packet length, not by the response's own declared `nMode` as the vendor spec documents (Table 1/2) — every device on this network happens to make length-based and mode-based decisions agree today, but the two are not the same check, and the parser didn't recognize seven other documented `nMode` values belonging to an entirely different exchange (RSA key exchange, password-apply) at all. | Both fixed: `supportedProtocol` and `noPassword` are now read as two distinct fields at their correct offsets; the parser now checks the response's `nMode` first — parsing the extended block only for `nMode=12` (`DEF_RES_SCAN_EXT`), and rejecting outright (returning no device) any response whose `nMode` belongs to a different exchange. Applied identically to both the submodule and the self-contained fallback. See `docs/design/Design_Camera_Discovery.md` §3.1d, FR-CAM-083/084. |
| 2026-07-03 | Building a new `UdpResponse` parser (see next row) against the vendor's own §3.2/§3.3 summary field tables reproduced the same class of gap FR-CAM-083 already found once: those tables omit two 1-byte reserved fields that Annex A's authoritative C structs do include, silently shifting every field from `nHttpPort` onward by one byte (e.g. a real device's HTTP port `80` decoded as `20596`). | `FIELDS` (the shared struct definition) now includes both `reserved2`/`reserved3` (334 bytes total, not 332) — verified identical to the pre-existing, already-correct parser on both a real captured packet and live traffic from 100+ devices. See `docs/design/Design_Camera_Discovery.md` §3.1e/§3.1f, FR-CAM-085. |
| 2026-07-03 | The inline UDP discovery fallback (2026-07-02 row above) kept SUNAPI discovery working without the git submodule, but at the cost of an independently-maintained duplicate of the entire wire protocol — which had already drifted once (an endianness bug caught only by a parity test). Separately, the request opcode remained the undocumented `nMode=1` (FR-CAM-082's informational, non-adopted finding) rather than the vendor-documented `nMode=6`. | The duplicate fallback was retired entirely — `server/src/utils/udpDiscovery.js` now re-exports either the git submodule or a new `wisenet-chrome-ip-installer` npm `optionalDependencies` package (same source, installed via ordinary `npm install`, no separate submodule-init step). The request opcode now defaults to `nMode=6`, live-verified against 100+ real devices with no discovery regression; the prior `nMode=1` packet remains in the source, commented out, as an immediate rollback. **Known tradeoff, accepted explicitly**: `wisenet-chrome-ip-installer` is a private GitHub repository, and this same effort hit real, repeated authentication failures pushing to it — the npm path is a convenience on top of, not a replacement for, keeping the git submodule path working. See `docs/design/Design_Camera_Discovery.md` §3.1f, FR-CAM-086/087. |
| 2026-07-03 | Synthesized RTSP URLs (both the raw discovery response's `rtspUrl` and `mapUDPDevice()`'s `Port`/`rtspUrl`, the latter surfaced to operators as "RTSP Port" in the Found/Edit panels) used `nTcpPort`/`nPort` as if either were the RTSP port. Neither is — per the vendor spec's own field descriptions, `nTcpPort` is valid "only if Client uses VNP" (a legacy, unrelated protocol) and `nPort` is the HTTP(S) web port (confirmed live: real devices report `443` there). This is almost certainly the root cause of an already-recorded discrepancy (2026-07-02 row above): a device whose saved `rtspUrl` port (`10030`) didn't match its CGI-confirmed `RTSPPort` (`554`) — `10030` was never a real RTSP port. | Both call sites now default straight to SUNAPI's standard port `554`, never reading `nTcpPort`/`nPort` for this purpose. The real port, when it differs, continues to come only from `querySunapiRtspPort()`'s CGI query. See `docs/design/Design_Camera_Discovery.md` §3.1f, FR-CAM-088. |
| 2026-07-14 | On the Streaming server's Dashboard, the Cameras sidebar's **Found** sub-tab kept stealing focus from **Added** every time a `discovery:result` event fired after the operator had already registered cameras — e.g. clicking "Clean" (which resets `autoSwitched` and re-triggers `discovery:rescan`) mid-session caused the very next discovered device to yank the operator back to Found, away from the Added list they were actively working in. The one-shot `autoSwitched` guard only prevented *repeat* switches within a single discovery pass; it never accounted for whether the operator already had cameras configured. | `CameraList.tsx`'s `discovery:result` handler now also requires zero registered cameras (`cameras.length === 0`, tracked via a render-synced ref) before auto-switching to Found — once at least one camera is Added, the panel stays pinned to Added regardless of how many discovery events or Found-tab resets occur afterward. The auto-switch remains for the true first-run case (no cameras yet) so a fresh install still surfaces discovered devices automatically. See `docs/srs/SRS_Dashboard_Sidebar_Cameras.md` FR-UI-CAM-003 (updated), `docs/design/Design_Dashboard_Sidebar_Cameras.md` §5.2/§9.2. |

*Earlier resolved issues (SUNAPI CGI endpoint corrections, Digest auth, self-signed certificates, ONVIF `GetVideoSources`-based MaxChannel, HTTP/HTTPS dual-scheme probing) are tracked directly in `docs/srs/SRS_Camera_Discovery.md` FR-CAM-062a/072/073/074/075 and `docs/design/Design_Camera_Discovery.md`'s Document History — this MRD is new as of this pass and does not restate them. A related, narrower auth-detection fix (FR-CAM-089 — SUNAPI CGI Digest-challenge detection now recognizes combined multi-scheme `WWW-Authenticate` headers) is tracked in the SRS/Design docs directly, not restated here as a full row.*

---

## 7. Out of Scope

- ONVIF WS-Security authenticated `GetProfiles`/`GetStreamUri` calls — ONVIF discovery currently sends no authentication at all; a password-protected ONVIF device will report no channels regardless of the fixes in §6
- Reading `MaxChannel` directly out of the WiseNet UDP discovery binary response — further investigated 2026-07-03 (see `docs/design/Design_Camera_Discovery.md` §3.1f): the vendor's response table's positional layout suggests `MaxChannel`/`Nonce` reinterpret the `nMulticastPort`/`chPassword` slots when `nVersion` bit `0x08` is set, but no device captured on this network has that bit set, so the hypothesis remains unverified and unimplemented; the SUNAPI CGI query remains the only automatic secondary source
- mDNS/Bonjour discovery
- WAN/inter-subnet discovery (broadcast/multicast is not routed)
- Automated correction of a *saved* camera's stale RTSP port/URL — Re-detect surfaces the discrepancy but only Save persists it

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-02 | 초기 작성 — Channel_Slot MRD와 동일한 7종 문서 체계로 Camera_Discovery 세트 확장 |
| 1.1 | 2026-07-02 | §6에 3건 추가 — UDP 확장 필드 bounds-check 버그(FR-CAM-081), 동일 IP를 공유하는 물리 카메라 2대 발견(네트워크 이슈, 소프트웨어로 해결 불가), UDP Discovery 인라인 폴백이 ONVIF XML만 파싱해 SUNAPI 카메라를 전혀 못 찾던 결함 수정(FR-CAM-082) |
| 1.2 | 2026-07-03 | §6에 1건 추가 — 고객이 Annex A 구조체 대조로 발견한 `supported_protocol`/`no_password` 오프셋 버그, 확장 필드 블록 파싱이 패킷 길이가 아닌 응답의 `nMode`로 결정되어야 함(FR-CAM-083/084) |
| 1.3 | 2026-07-03 | §6에 3건 추가 — `reserved2`/`reserved3` 구조체 반영(334바이트, FR-CAM-085), 인라인 폴백 완전 제거+npm 패키지 설치 경로 도입+요청 옵코드 nMode=6 전환(중복 유지 부담 해소, 알려진 트레이드오프 명시, FR-CAM-086/087), RTSP URL이 nTcpPort/nPort를 오용하던 버그 수정(FR-CAM-088); §7 MaxChannel 관련 서술을 이번 세션의 추가 조사 결과(미확정, 미채택)로 갱신 |
