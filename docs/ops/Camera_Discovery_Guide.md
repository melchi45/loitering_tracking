# Operations Guide — Camera Discovery & RTSP URL Resolution

**Product:** LTS-2026 Loitering Detection & Tracking System
**Feature:** Automatic IP Camera Discovery (WiseNet UDP + ONVIF) & RTSP URL Resolution
**Version:** 1.5
**Date:** 2026-07-03

---

## 1. Overview

This guide covers running/diagnosing camera discovery (WiseNet UDP broadcast + ONVIF WS-Discovery), the on-demand channel probe (`POST /api/cameras/probe-channels`, used by the Add/Edit/Found UIs' "Detect Channels"/"Re-detect" buttons), and the RTSP URL conventions the system resolves against real hardware. See `docs/design/Design_Camera_Discovery.md` for the full technical design and `docs/design/Design_Channel_Slot.md` §4.6 for the on-demand probe's request/credential-gating flow.

---

## 1a. UDP Discovery protocol ("IP Scan for SUNAPI")

WiseNet/Hanwha camera discovery broadcasts a fixed-format request to `255.255.255.255:7701` and listens for unicast replies on port `7711`, per the vendor's own **SUNAPI IP Installer** protocol spec, §3.4 "IP Scan for SUNAPI" (internal reference: `http://55.101.56.209:8080/site/SUNAPI/SUNAPI_ipinstaller.html#_ip_scan_for_sunapi`). The actual implementation lives in `submodules/WiseNetChromeIPInstaller/nodejs/` (`request.js`/`response.js`/`protocol.js`/`udpDiscovery.js`), reachable two ways — **both point at the same code, no more independent fallback implementation** (2026-07-03; see `docs/design/Design_Camera_Discovery.md` §3.1f):

| Install path | How | Notes |
|---|---|---|
| Git submodule | `git submodule update --init submodules/WiseNetChromeIPInstaller` | Original path; still supported and tried first |
| npm `optionalDependencies` | `cd server && npm install` (fetches `wisenet-chrome-ip-installer` — same repo/branch as the submodule) | New 2026-07-03; no separate submodule-init step. `optionalDependencies` so a failed install of just this package doesn't abort `npm install` for the rest of the server |

`server/src/utils/udpDiscovery.js` is now a ~20-line re-export trying the submodule path first, then the npm package — **prior to 2026-07-03 this file also contained a full independent fallback implementation** (`UDPDiscoveryFallback`, ~300 lines) for when the submodule wasn't initialised; before *that* (prior to 2026-07-02) that fallback was itself a broken ONVIF-XML-only stub that silently discovered zero SUNAPI cameras. Both historical implementations are gone — if neither the submodule nor the npm package is available, `require()` now fails loudly instead of silently degrading. If UDP discovery finds nothing at all, confirm at least one install path succeeded: `git submodule status` (should show a commit hash, not `-` prefixed) or `ls server/node_modules/wisenet-chrome-ip-installer` after `npm install`.

**Request opcode note (updated 2026-07-03)**: both implementations now send the spec-documented opcode `6` (`DEF_REQ_SCAN_EX`), built via `UdpRequest` (`submodules/WiseNetChromeIPInstaller/nodejs/request.js`) — see `docs/design/Design_Camera_Discovery.md` §3.1e. The previous default, `1` (an earlier/undocumented opcode this fleet also responds to identically), is kept in `udpDiscovery.js`, **commented out, not deleted**, as an immediate rollback: a prior live comparison found sending `nMode=6` draws responses from a much broader, largely unrelated portion of the network in addition to this project's own camera fleet. **If UDP discovery on a given deployment starts surfacing unrelated/unexpected hosts, or another network-hygiene issue traces back to this broadcast, restore the commented-out `nMode=1` packet (or pass `{ nMode: 1 }` to `UdpRequest` in `_sendDiscovery()`) before investigating further** — this is a one-line revert, not a re-implementation. The socket's `'message'` handler emits a `'scanExtConfirmed'` event (via `UdpResponse.parse()`, `response.js`) whenever a genuine `nMode=12` (`DEF_RES_SCAN_EXT`) reply confirms the opcode-6 round-trip is working as documented — useful for confirming discovery is still healthy after this switch on a given network.

**Response `nMode` drives parsing (2026-07-03)**: the vendor spec's Table 1/2 defines the full `nMode` enum (`NMODE` constant in both parsers). A response's `nMode` byte — not its length — decides how the rest of it is parsed:

| `nMode` | Meaning | Behavior |
|---|---|---|
| `11` | Base scan response (undocumented in this spec revision, but what every camera on this network actually sends) | Base fields only (IP/MAC/ports/name/DDNS); no extended block |
| `12` (`DEF_RES_SCAN_EXT`) | Extended scan response | Base fields **plus** the extended block (alias, model type, HTTPS port, `supportedProtocol`, etc.) |
| `13, 23, 24, 25, 33, 66, 77` | RSA key exchange / password-apply responses (§3.5–§3.7 — a different exchange entirely, sharing the same UDP ports) | Parser returns nothing for these — they use an incompatible wire struct and are not camera-scan data |

If a device is known to support the extended fields (alias/model type) but they never appear in discovery results, check its actual response `nMode` via a raw packet capture — if it's sending `11` (base mode) rather than `12`, the extended fields are genuinely absent on the wire for that firmware, not a parsing gap.

**Field offset note**: the extended block's last two 1-byte fields, `supported_protocol` and `no_password`, sit adjacent in the wire format — a prior implementation bug (fixed 2026-07-03) read only one value at that position into `noPassword`, silently consuming the `supported_protocol` byte and never reading the real trailing `no_password` byte. Fixed by reading both as distinct fields, in the vendor's documented order.

**`reserved2`/`reserved3` offset note (2026-07-03)**: the vendor spec's §3.2/§3.3 field *tables* omit two 1-byte fields that Annex A's authoritative C structs (`DATAPACKET_(EXT_)IPv4_T`) do include — one right after `chDeviceName` (offset 119), one right after `nHttpMode` (offset 329). Every field from `nHttpPort` onward was shifted one byte and silently wrong until this was found (a real device's `nHttpPort` decoded as `20596` instead of `80`). The struct is 334 bytes total, not 332 — see `docs/design/Design_Camera_Discovery.md` §3.1e/§3.1f and `submodules/WiseNetChromeIPInstaller/nodejs/protocol.js`'s `FIELDS`, the single source of truth for the byte layout.

**RTSP port note (2026-07-03) — `nTcpPort` and `nPort` are not the RTSP port**: `nTcpPort`'s own spec description is "Port number to get stream via tcp. This port is valid only if Client uses VNP" (a legacy WiseNet protocol, not RTSP/SUNAPI); `nPort` is "HTTP port for web-connection" (real devices report `443` there — their HTTPS web port). **No field in the UDP discovery response reliably carries the real RTSP port.** The discovery packet's `rtspUrl` now always defaults to SUNAPI's documented standard (`554`) rather than reading either field — see §3 below for how the real port (when it differs) is confirmed instead.

---

## 2. RTSP URL conventions

Real WiseNet/Hanwha devices on this network use two distinct RTSP path conventions — `channelRtspUrl()` (`server/src/utils/channelRtsp.js`, client twin `client/src/utils/channelRtsp.ts`) recognizes both and substitutes only within whichever shape a given base URL already uses:

| Convention | Example | Notes |
|---|---|---|
| `/profileN/` (1-based) | `rtsp://192.168.214.32:10030/profile1/media.smp` | WiseNet Profile S encoders (observed: TID-A800) |
| `/N/H.264/` (0-based channel) | `rtsp://192.168.214.40/0/H.264/media.smp` | The majority of cameras/NVRs surveyed on this network |

When there is no base URL to pattern-match against at all (e.g. probing a bare IP that hasn't been added), the system synthesizes a fresh default using the `/N/H.264/` convention and the confirmed (or default) RTSP port — see §3.

**If a Re-detect/channel switch produces the wrong URL for a specific camera model**, check which convention its existing `rtspUrl` actually uses (open the camera's web UI or check its stream settings) and compare against the table above — a third convention not yet supported would explain a silent no-op (the URL comes back unchanged after clicking a different channel).

---

## 3. RTSP port confirmation

By default the system assumes SUNAPI's standard RTSP port, `554`. When credentials are available for a device, the actually-configured port can be confirmed via:

```bash
curl --digest -u admin:<password> \
  'http://<ip>/stw-cgi/network.cgi?msubmenu=portconf&action=view'
```

Response is **plain text**, one `key=value` pair per line (not XML):

```
FixedPorts=3702,49152
UsedPorts=
HTTPPort=80
HTTPSPort=443
WebSessionTimeout=10
RTSPPort=554
RTSPTimeout=60s
```

The system's `querySunapiRtspPort()` (`discoveryService.js`) parses `RTSPPort` from this response and uses it when synthesizing a default channel URL (§2). This requires admin-level authentication — a request with no credentials gets `HTTP 401`, and the system does not attempt this query at all when no credentials are resolvable (request body / saved camera record / `RTSP_DEFAULT_*` env), to avoid a guaranteed-failure network round-trip.

**Digest auth detection note (2026-07-03)**: this endpoint (like `attributes.cgi`'s `querySunapiMaxChannel()`) tries Basic first and retries with Digest only when the `WWW-Authenticate` challenge advertises it. If a device sends more than one `WWW-Authenticate` header (Node joins them: `Basic realm="x", Digest realm="y", ...`), earlier code only recognized Digest when it was the *first* scheme listed — fixed to a word-boundary match so Digest is recognized anywhere in a combined header.

**Known real-world discrepancy (root cause identified 2026-07-03)**: a camera's *saved* `rtspUrl` port and its *actual* configured RTSP port can differ — found live on this network (192.168.214.32 stores port `10030` in its DB record, but the device itself reports `RTSPPort=554`). This is almost certainly explained by the `nTcpPort`-is-not-the-RTSP-port bug (§1a) — `10030` was never a real RTSP port, just whatever `nTcpPort` (a VNP-only field) happened to contain in that device's UDP discovery response at the time it was added. Cameras added *after* the 2026-07-03 fix will save `554` (or the CGI-confirmed port) instead; existing saved cameras with a stale port are unaffected until Re-detected. Re-detecting against an existing camera surfaces the confirmed port in the SUNAPI URL row (§4), but does **not** automatically rewrite the saved camera — the operator must Re-detect, review, and Save.

---

## 4. Reading the SUNAPI/ONVIF URL rows

The Found-tab discovery panel and the Edit modal's NVR Channel section both show two rows for the currently selected channel, populated by `POST /api/cameras/probe-channels`'s `sunapiProfiles`/`onvifProfiles` response fields (independent of which protocol "won" the merged channel count):

```
SUNAPI URL (Ch2)   rtsp://192.168.214.40:554/1/H.264/media.smp
ONVIF URL (Ch2)    not detected
```

- **Both populated, same URL** — both protocols agree; either is safe to use.
- **Only SUNAPI populated** — most common when the device has no configured admin auth for ONVIF, or ONVIF discovery's unauthenticated SOAP calls are being rejected (see §5 troubleshooting).
- **Only ONVIF populated** — SUNAPI credentials unavailable/rejected, or the device isn't a SUNAPI/WiseNet device at all (third-party ONVIF-only camera).
- **Neither populated ("not detected" both rows)** — click Re-detect; if it stays empty after a completed probe, the device may need credentials, or may be genuinely single-channel.

---

## 5. Troubleshooting

| Symptom | Likely cause | Check |
|---|---|---|
| Re-detect/channel switch returns the same URL every time (no-op) | Camera's RTSP path doesn't match either convention in §2 | Compare the camera's actual `rtspUrl` against the two patterns; a third vendor convention isn't yet supported |
| SUNAPI query works for MaxChannel but RTSP port always shows unconfirmed/554 | No credentials resolvable for this camera, or `network.cgi?msubmenu=portconf&action=view` itself failing | `LOG_LEVEL=DEBUG`, then `grep 'Discovery.*SUNAPI.*portconf'` in the server log — see exact HTTP status/auth failure reason |
| Every SUNAPI/ONVIF call against one specific device fails with a bare `HTTP 301`/`302` | Device forces HTTP→HTTPS (or another scheme change) at the web-server layer for every path | Confirm with `curl -I http://<ip>/stw-cgi/attributes.cgi/attributes` — a `301`/`302` response confirms this; the system follows same-host redirects automatically as of 2026-07-02 (FR-CAM-076/077), so this should now resolve itself — if it doesn't, the redirect target may be a different host (deliberately not followed, SSRF hardening) |
| `RTSPPort`/`MaxChannel` CGI queries always 401 | No credentials configured/available for this device | Check the camera's saved `username`/`password`, the request body (Add/Found flows), or `RTSP_DEFAULT_USERNAME`/`RTSP_DEFAULT_PASSWORD` env — all three are checked in that priority order |
| Camera added but stream never connects, despite discovery reporting success | Saved `rtspUrl` uses a stale port (see §3's known discrepancy) | Re-detect the camera and compare the confirmed SUNAPI URL row's port against the saved `rtspUrl` |
| MaxChannel/RTSP port keeps flip-flopping between requests to the same IP, with no code change | **Two physical devices sharing the same IP** (LAN misconfiguration, not a code defect) — observed live: 192.168.214.37 answered UDP discovery as two distinct devices (different `chMac`, different `chDeviceName`) | Run a UDP discovery capture and check for more than one `chMac` reporting the same `chIP`; cross-check with `arp -n <ip>` / `ip neigh show <ip>` to see which device the OS currently resolves that IP to — HTTP-based queries (SUNAPI CGI, ONVIF) go to whichever device wins that resolution, which can change between requests. Fix by assigning the conflicting device a unique IP; this cannot be safely worked around in software |
| Found panel shows no "Type" (Camera/Encoder/Recorder/...) for a device | Device's UDP response is a short/legacy packet with no Device Type field at all (not detectable via ONVIF/SUNAPI either — UDP-only field) | Expected for many real cameras on this network (verified: a 262-byte response has no room for this field) — not a bug; "Type" simply doesn't render when absent, same convention as other optional Found-panel fields |

Diagnostic script (no running server/DB required — queries a real camera directly):
```bash
node test/api/probe_camera_maxchannel.js --ip <ip> --username <user> --password '<pass>'
```

---

## 6. API Reference

See `docs/design/Design_Camera_Discovery.md` §5.3 for the full `POST /api/cameras/probe-channels` request/response shape. Quick reference:

```bash
curl -X POST http://localhost:3080/api/cameras/probe-channels \
  -H 'Content-Type: application/json' \
  -d '{"ip":"192.168.1.10","username":"admin","password":"<password>"}'
```

Response includes `maxChannel`, `protocol`, merged `profiles`, plus (2026-07-02) `sunapiProfiles`, `onvifProfiles`, `sunapiRtspPort`.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-02 | 초기 작성 — Channel_Slot_Guide와 동일한 7종 문서 체계로 Camera_Discovery 세트 확장, RTSP URL 컨벤션·포트 확인·SUNAPI/ONVIF URL 구분 표시 트러블슈팅 포함 |
| 1.1 | 2026-07-02 | §5 트러블슈팅에 2행 추가 — 동일 IP를 공유하는 물리 카메라 2대(192.168.214.37) 실측 발견(MaxChannel/포트가 요청마다 바뀌는 원인), Found 패널 "Type" 미표시가 정상인 경우(UDP 응답에 Device Type 필드 자체가 없는 짧은 패킷) |
| 1.2 | 2026-07-02 | §1a 신규 추가 — 벤더 SUNAPI IP Installer 스펙 §3.4 "IP Scan for SUNAPI" 프로토콜 개요, 서브모듈/폴백 두 구현체의 parity 요구사항, 폴백이 그동안 ONVIF XML만 파싱하던 결함 수정 안내, nMode=6 요청 옵코드 실측 관찰(네트워크 범위 주의사항) |
| 1.3 | 2026-07-03 | §1a에 "응답 nMode가 파싱을 결정" 표 추가 — nMode=11(base)/12(extended)/13~77(RSA·password-apply, 파싱 안 함) 분류 및 확장 필드가 안 보일 때 확인 방법; `supported_protocol`/`no_password` 오프셋 버그 수정 안내 |
| 1.4 | 2026-07-03 | §1a "Request opcode note" 갱신 — 요청 옵코드를 `nMode=1`에서 스펙 문서화값 `nMode=6`(`DEF_REQ_SCAN_EX`)으로 전환(`request.js`의 `UdpRequest`), 과거 `nMode=1` 패킷은 주석 처리로 롤백 경로 보존, `'scanExtConfirmed'` 이벤트로 옵코드 6→12 왕복 검증 안내 추가 |
| 1.5 | 2026-07-03 | §1a 구현 경로 표 갱신 — 서브모듈/인라인 폴백 이중 구조를 서브모듈+npm `optionalDependencies`(`wisenet-chrome-ip-installer`)로 교체, 인라인 폴백(`UDPDiscoveryFallback`) 완전 제거 안내; `reserved2`/`reserved3` 오프셋(334바이트) 안내 추가; §3에 RTSP 포트 필드 버그(`nTcpPort`/`nPort`는 RTSP 포트 아님, 항상 554로 고정) 및 192.168.214.32 불일치 근본 원인 규명 반영; §3 Digest Auth 감지 보강(콤바인드 `WWW-Authenticate` 헤더 대응) 안내 추가 |
