# Operations Guide — Dashboard Channel Slot

**Product:** LTS-2026 Loitering Detection & Tracking System
**Feature:** Global Channel Slot Mapping for Cameras / YouTube Streams
**Version:** 1.9
**Date:** 2026-07-02

---

## 1. Overview

Every camera or YouTube stream now has a Channel Slot (1..`MAX_CHANNEL_NUM`) that fixes its position in the Streaming Dashboard grid. This guide covers configuring the channel range, assigning/changing channels, and the SUNAPI/ONVIF NVR sub-channel switcher.

---

## 2. Configuring MAX_CHANNEL_NUM

In `server/.env`:

```env
# ── RTSP Camera Defaults ─────────────────────────────────────────────────────
...
MAX_CHANNEL_NUM=512    # Max Channel Slot value (1..MAX_CHANNEL_NUM). Default 512.
```

- Applies to `SERVER_MODE=combined` and `SERVER_MODE=streaming` (camera-bearing modes). Not needed in `analysis` mode.
- Requires a server restart to take effect, like any other `.env` change.
- Lowering this value below a currently-assigned Channel Slot does **not** unassign that camera — it just blocks any *new* assignment above the new limit. Existing over-limit cameras keep working and stay visible in the dashboard.

---

## 3. Assigning a Channel Slot

When adding a camera or YouTube stream (Add Camera / Add to System), a **Channel** section appears with two linked controls:

- **Stepper**: `[-] [ N ] [+]` — click to nudge by 1, or type a number directly
- **Group browser**: `◀ Group 2 of 32 (CH 17–32) ▶` with one button per slot in the visible range — free slots are clickable, taken slots are greyed out and show the occupying camera's name on hover

Both controls always show the same value — use whichever is faster for your situation (stepper for "channel 42 specifically," group browser for "show me what's free around channel 20").

The form opens with the lowest free channel pre-selected, so if you don't care which number you get, you can just submit.

> **Tip:** Group page size follows whatever grid layout (4×4, 3×3, ...) is currently active on the Streaming Dashboard — switch the dashboard's layout first if you want a different group size while adding cameras.

---

## 4. Changing a Channel Slot Later

Open **Edit** on any camera — the same Channel section appears, pre-filled with its current slot. Pick a new free slot and save. This only changes where the camera appears on the dashboard grid; it does **not** restart the camera's capture pipeline (no RTSP/credential change involved).

---

## 5. NVR Sub-Channel (SUNAPI / ONVIF Wisenet, multi-channel devices)

If a camera is (or might be) part of a Wisenet/SUNAPI NVR or a multi-channel ONVIF device, an **NVR Channel** section appears in both the Add Camera and Edit Camera screens:

```
NVR Channel (max 32):  [CH1][CH2][CH3]...[CH8]▓...[CH32]     [🔍 Re-detect]
```

Selecting a different channel updates which physical NVR input this camera record reads from, and automatically recomputes the RTSP URL — no re-scan needed. If a channel button is greyed out, the system could not determine an RTSP URL for that channel (rare — typically means the NVR reported fewer profiles than its stated channel count); use **Re-detect** to refresh, or contact the NVR vendor's RTSP path documentation.

> **Note:** this is a *different* number from the Channel Slot in §3. The NVR Channel is "which physical wire on the NVR," the Channel Slot is "where it shows up on your dashboard." A camera can be NVR Channel 5 and Dashboard Channel Slot 112 at the same time — they're unrelated.

### 5.1 Detecting channels without running a network scan (2026-07-02)

You don't need to run a full network discovery scan just to see a camera's NVR channels — both screens can detect them directly from a single IP:

- **Add Camera (manual entry)**: type the RTSP URL first (so the camera's IP is known), then click **🔍 Detect Channels**. If the device reports multiple channels, a `CH 1..N` button row appears and picking one updates the RTSP URL field automatically.
- **Edit Camera**: click **🔍 Re-detect** in the NVR Channel section — this works even for cameras that show no channel data yet (e.g. added before this feature existed, or added manually without running Detect Channels first). A successful detection reveals the channel buttons immediately in the same dialog; nothing is saved to the camera until you press Save.
- **Found tab (device discovered by a network scan)**: opening a device already shows its channel info from the scan itself — no Detect Channels button needed there, it would just repeat work already done. If the scan result looks wrong (e.g. you know the NVR has more channels than shown, or you just reconfigured it), click **🔍 Re-detect** next to the channel count to force one fresh check against that IP without re-running the whole network scan.

Detection tries SUNAPI and ONVIF in parallel and times out after ~8 seconds per protocol, so an unreachable camera won't hang the button indefinitely — it will just report "single-channel" (or show an error if the IP itself couldn't be reached).

> **ONVIF caveat**: detection guesses the device's ONVIF service address as `http://{ip}/onvif/device_service`, the convention used by most vendors (Hanwha, Axis, Dahua, Hikvision). A small number of devices expose it elsewhere and won't be found this way. Also, this project's ONVIF client does not send authentication — a password-protected ONVIF device will report "single-channel" even if it's actually a multi-channel NVR. SUNAPI detection does support Username/Password.

### 5.1a Edit Camera "Re-detect" no longer retries a camera it already knows has no password (2026-07-02)

If you click **🔍 Re-detect** on a camera that was added with no Username/Password on file at all, the SUNAPI half of the detection is now skipped outright (the ONVIF half still runs) — you'll see a result faster than before, and you won't see a `[Discovery][SUNAPI] ... connection error` line for it in the log (§5.2). This is intentional: the camera's own saved settings already establish that it has no way to authenticate, so retrying the same doomed request on every click added nothing but a delay and log noise.

This only applies to **Edit's Re-detect specifically** — it's the one flow re-probing a camera the system already has a record for. The Add modal's "Detect Channels" (no camera saved yet) and the Found tab's "Re-detect" (uses whatever credentials the network scan itself captured) are unaffected and still attempt an unauthenticated SUNAPI request when no credentials are otherwise available — for those, "no credentials yet" isn't evidence the device will never respond.

If you want Re-detect to actually succeed against a password-protected camera, save the correct Username/Password on the camera first (Edit → RTSP fields → Save), then click Re-detect.

### 5.1b Detect Channels / Re-detect now reuse an already-scanned device's channel count (2026-07-02)

If the IP you're detecting/re-detecting against was already found by a Found-tab scan (background or manual) and reported as a multi-channel SUNAPI device, clicking **🔍 Detect Channels** or **🔍 Re-detect** now returns that channel count **instantly** instead of running a fresh SUNAPI query — no network round-trip, no credentials needed for that part. You'll see `cachedMaxChannel=N` and `using cached UDP Discovery MaxChannel=N — skipping SUNAPI CGI query entirely` in the DEBUG log (§5.2) instead of a `[Discovery][SUNAPI] querying ...` line.

This only kicks in when the exact IP is already sitting in the Found tab's scan results with `MaxChannel > 1`. Anything else (never scanned, or the scan reported single-channel) falls back to the normal query behavior described in §5.1/§5.1a — this is purely a shortcut for the case where the answer is already known, not a new detection method.

### 5.1c Found-tab detail panel now shows SUNAPI's and ONVIF's channel counts separately (2026-07-02)

Opening a device in the Found tab (click it in the sidebar list) now shows two extra rows in the Device section — **SUNAPI MaxCh** and **ONVIF MaxCh** — next to the existing SUNAPI/ONVIF Yes/No indicators:

```
SUNAPI          Yes
SUNAPI MaxCh    4 CH
ONVIF           No
ONVIF MaxCh     not detected
```

Previously, the panel only showed one combined channel-count badge (`N CH`), which is the larger of whatever SUNAPI and ONVIF each separately reported — you couldn't tell which protocol actually found the multi-channel NVR. These two new rows always show a value (or the literal text "not detected"), letting you see, e.g., that a device you thought was ONVIF-capable actually only got its channel count from SUNAPI, which matters if you're troubleshooting why a per-channel RTSP URL didn't resolve the way you expected (ONVIF resolves real per-channel URLs via `GetStreamUri`; SUNAPI's are synthesized by substituting the profile number in the URL path). Clicking **🔍 Re-detect** (§5.1) updates both rows live, same as the combined badge.

The compact sidebar list (before you click into a device) still shows just the one combined `N CH` badge; this breakdown is only in the detail panel. See §5.1d for how a Re-detect result now also corrects that sidebar badge, not just the open panel.

### 5.1d A successful Re-detect now corrects the Found list permanently, not just the open panel (2026-07-02)

Before this change, a successful **🔍 Re-detect** only updated the numbers shown *inside that panel, for that session* — close it and reopen the same device (or just glance at the sidebar's `N CH` badge without opening it), and it would revert to whatever the original network scan found, even if Re-detect had just proven a better answer. This mattered in practice for devices whose background-scan channel count is stuck low (the automatic scan's UDP-broadcast-only source currently can't read the channel count itself — §5.3's known limitation) but whose real count is discoverable once you supply that specific camera's own credentials to Re-detect.

Now, whenever a Detect Channels/Re-detect result (any of the three entry points — Add, Edit, or Found) finds a **higher** channel count than what the Found list already has on file for that IP, the correction is written back into the shared scan results — the sidebar badge updates immediately for everyone looking at the dashboard (not just the browser tab that ran Re-detect), and it stays corrected until the next full scan cycle re-confirms or supersedes it. A result that's lower than or equal to what's already known is ignored — Re-detect only ever improves the Found list's information, it never makes it worse (e.g. a flaky response on one attempt doesn't erase a good result from an earlier one).

### 5.2 Diagnosing a failed detection with DEBUG-level logs (2026-07-02)

`querySunapiMaxChannel()` and `enrichDevice()` (the functions behind Detect/Re-detect) fail *silently* by design — an unreachable port, rejected auth, and a genuinely single-channel camera all end up reporting the same "single-channel" result to the UI, so you can't tell which one happened from the screen alone. To see what actually happened on the wire:

1. Set `LOG_LEVEL=DEBUG` in `server/.env` (default is `INFO`, which suppresses these lines) and restart the server (`npm run start` / `npm run streaming` — the dev servers, `npm run dev*`, don't load the production logger at all, so this only applies to a production-style start)
2. Click Detect Channels / Re-detect (any of the three entry points — Add modal, Edit modal, or the Found-tab panel all funnel through the same endpoint)
3. Tail the log:
   ```bash
   tail -f /var/log/lts/lts-$(date +%Y-%m-%d).log | grep -E 'probe-channels|\[Discovery\]\[SUNAPI\]|ONVIFDiscovery.*enrichDevice'
   ```
   or view it live in **Admin Dashboard → Server Logs** with the level filter set to DEBUG.

Example output for a camera whose SUNAPI web port is 8080 (not the default 80) but the client only knows port 80 — this is exactly the failure mode described in `Design_Channel_Slot.md` §5.3a:

```
[cameras][probe-channels] request ip=192.168.1.50 httpPort=(default) httpType=http onvifPort=80 auth=no
[Discovery][SUNAPI] querying http://192.168.1.50:80/stw-cgi/attributes.cgi/attributes auth=no timeoutMs=4000
[Discovery][SUNAPI] 192.168.1.50 /stw-cgi/attributes.cgi/attributes → connection error: connect ECONNREFUSED
[Discovery][SUNAPI] 192.168.1.50 → attributes.cgi did not report a MaxChannel; defaulting to 1
[ONVIFDiscovery][enrichDevice] 192.168.1.50 — starting probe at http://192.168.1.50:80/onvif/device_service
[ONVIFDiscovery][enrichDevice] 192.168.1.50 GetDeviceInformation failed: connect ECONNREFUSED
...
[cameras][probe-channels] ip=192.168.1.50 SUNAPI maxChannel=1; ONVIF maxChannel=1, profiles-with-rtsp=0
[cameras][probe-channels] ip=192.168.1.50 decision → protocol=none, maxChannel=1, profiles=0
```

The repeated `ECONNREFUSED` on the default port is the tell — the camera is refusing connections on 80, meaning its real SUNAPI/ONVIF port is something else. Nothing in the plain "single-channel" UI message would have told you that; this is exactly what these logs are for. `NOTE:` this same logging also fires from ordinary background WS-Discovery scans (not just Detect/Re-detect clicks), since both paths call the same `enrichDevice()`/`querySunapiMaxChannel()` functions — expect log volume from active scanning too when `LOG_LEVEL=DEBUG` is on.

### 5.3 Background scan channel detection now requires configured default credentials (2026-07-02)

Unlike the manual Detect/Re-detect flows (§5.1 — the Add form and Found-tab panel always try, since the operator is actively working with a specific device and credentials at that moment; Edit's Re-detect has its own narrower gate, §5.1a), the *automatic* background discovery scan and the Found-tab's manual rescan no longer attempt the SUNAPI CGI channel query (`GET /stw-cgi/attributes.cgi/attributes`) for every SUNAPI-flagged device by default. It only runs that query when **both**:

1. The UDP discovery response itself didn't already report more than 1 channel, AND
2. `RTSP_DEFAULT_USERNAME` / `RTSP_DEFAULT_PASSWORD` are both set in `server/.env`

If you rely on the Found tab's `N CH` badge populating automatically for password-protected NVRs during a routine scan (without clicking Re-detect on each one by hand), make sure both env vars are set to a credential valid across your NVR fleet:

```env
# server/.env
RTSP_DEFAULT_USERNAME=admin
RTSP_DEFAULT_PASSWORD=your-nvr-password
```

Without them configured, multi-channel NVRs still show up in the Found list and can still be added — you'll just need to click **🔍 Re-detect** (§5.1) once per device to populate the channel count, since the scan itself now skips the doomed unauthenticated CGI attempt rather than logging a connection failure for it. This is why you may see fewer `[Discovery][SUNAPI] querying ...` DEBUG lines (§5.2) during passive scanning than before this change — that's expected, not a regression.

> **Endpoint correction (2026-07-02):** the CGI query itself was pointed at two non-existent SUNAPI paths (`media.cgi?msubmenu=channellist`, `system.cgi?msubmenu=systeminfo`) until this date — meaning it never actually succeeded, with or without credentials configured. It now queries the real endpoint, `GET /stw-cgi/attributes.cgi/attributes`, an XML capability document; `MaxChannel` is read from `<group name="System"><category name="Limit"><attribute name="MaxChannel" value="N"/>`. If you had configured `RTSP_DEFAULT_USERNAME`/`RTSP_DEFAULT_PASSWORD` before this date expecting automatic multi-channel detection to work, it wasn't — this fix is what actually makes that configuration effective. See `docs/srs/SRS_Camera_Discovery.md` FR-CAM-062a.

> **Known limitation:** ideally the UDP discovery response alone would report the channel count with zero network round-trips (not even the gated CGI fallback above), matching how the response already reports the device's IP/port/model. That parsing is not yet implemented — it depends on confirming an exact byte offset in the vendor's binary protocol that wasn't available at implementation time. See `docs/design/Design_Channel_Slot.md` §4.6c for the technical detail if you're able to supply that spec.

---

## 6. Reading the Dashboard Grid

Each grid cell always corresponds to a specific Channel Slot. If a slot has no camera assigned, the cell shows a dashed placeholder with the channel number and "Unassigned" — this is different from a camera that's assigned but offline (which shows the camera name and a red/gray status indicator).

Use the `◀ Channel Group X of Y ▶` control (desktop arrows, or swipe on mobile) to page through the full `1..MAX_CHANNEL_NUM` range — this is independent of how many cameras you actually have, so you can browse to reserved-but-empty channels too.

---

## 7. Upgrading from a version without Channel Slot

On first startup after upgrading, existing cameras are automatically assigned the lowest free Channel Slot, in the order they were originally added — nothing disappears from the dashboard. If you have more existing cameras than `MAX_CHANNEL_NUM` allows, the excess ones are logged as unassigned (check server logs for `[channelSlotService] No free channel slot for camera ...`) and you'll need to either raise `MAX_CHANNEL_NUM` or manually free up slots via Edit.

---

## 8. Troubleshooting

### "Channel slot N is already assigned to camera X"

Someone else (or a previous edit) already claimed that slot. Pick a different one from the group browser — taken slots are shown greyed out with the occupant's name.

### New camera doesn't appear on the dashboard grid

Check its Channel Slot (Edit modal) falls within the range you're currently viewing — use the Channel Group `◀ ▶` control to navigate to it, or check it wasn't left unassigned due to a migration capacity issue (§7).

### NVR Channel button is greyed out

The system couldn't resolve an RTSP URL for that specific channel from what was captured at discovery time. Re-run device discovery and re-add (or contact the NVR vendor docs for its RTSP path convention) rather than guessing a URL manually.

### Clicking "Re-detect" (or "Detect Channels") seems to do nothing

Fixed 2026-07-02 — previously, if the detection ran successfully but genuinely found no multi-channel NVR at that IP, the screen looked identical before and after the click, which was indistinguishable from the button being broken. Now a result message appears either way ("Re-detect ran (...) — single-channel or no multi-channel NVR found..."). If you still see no change at all after clicking:

1. Check the connection indicator / browser console for a network error — a failed request shows a red inline error instead of the result message
2. Confirm the camera actually has an `ip` or a parseable `rtspUrl` — the button needs one of these to know what to probe
3. If the camera is ONVIF and password-protected, this project's ONVIF client sends no authentication, so it will always report "no multi-channel NVR found" for that device even if it truly has multiple channels — SUNAPI detection does support Username/Password, ONVIF does not (§5.1)
4. For anything beyond "it reported single-channel and I don't know why," turn on `LOG_LEVEL=DEBUG` and re-click — §5.2 walks through reading the resulting per-protocol log lines (wrong port, rejected auth, timeout, etc. are all distinguishable there, even though the UI collapses them to one message)
5. If it's Edit's Re-detect specifically and it now returns noticeably *faster* than it used to against a camera with no saved credentials, that's expected (§5.1a) — the SUNAPI half is being skipped intentionally, not silently failing. It's only a problem if the *ONVIF* half also reports nothing for a device you know is multi-channel; see point 3

---

## 9. API Reference

| Endpoint | Description |
|---|---|
| `POST /api/cameras { ..., channelSlot }` | `channelSlot` optional — auto-assigned to the lowest free slot if omitted; 400 if out of `1..MAX_CHANNEL_NUM`, 409 if taken |
| `PUT /api/cameras/:id { channelSlot?, channelIndex?, maxChannel?, supportSunapi?, nvrProfiles? }` | All optional; `channelSlot` uses the same validation as POST |
| `POST /api/cameras/probe-channels { ip, httpPort?, httpType?, onvifPort?, username?, password?, baseRtspUrl?, cameraId? }` | On-demand SUNAPI/ONVIF channel detection for one IP — powers the Detect/Re-detect buttons; returns `{ maxChannel, supportSunapi, protocol, profiles, sunapiMaxChannel, onvifMaxChannel }` — the last two report each protocol's own count independently of which one "won" as `maxChannel`/`protocol` (§5.1c). `cameraId` (Edit's Re-detect only) resolves that camera's own stored credentials server-side and skips the SUNAPI probe entirely if none are on file (§5.1a). Before querying SUNAPI at all, checks the UDP Discovery scan cache for `ip` and reuses its `MaxChannel` if already known (§5.1b) |
| `GET /health` | Now includes `maxChannelNum` |

All endpoints follow the existing camera-management authentication requirements — no new role introduced.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-02 | 초기 작성 |
| 1.1 | 2026-07-02 | §5.1 추가 — Detect Channels(Add)/Re-detect(Edit) 버튼으로 discovery 스캔 없이 즉시 채널 감지, §9 `POST /api/cameras/probe-channels` 추가 |
| 1.2 | 2026-07-02 | §8 트러블슈팅에 "Re-detect가 무반응처럼 보임" 항목 추가 (결함 수정 반영) |
| 1.3 | 2026-07-02 | §5.1에 Found 탭 discovery 패널의 Re-detect 안내 추가 (Detect Channels와 중복이 아님을 명시) |
| 1.4 | 2026-07-02 | §5.2 신규 추가 — LOG_LEVEL=DEBUG로 SUNAPI/ONVIF 탐지 실패 원인 진단하는 방법, §8 트러블슈팅에 링크 추가 |
| 1.5 | 2026-07-02 | §5.3 신규 추가 — 백그라운드 스캔의 SUNAPI CGI 채널 조회가 RTSP_DEFAULT_USERNAME/PASSWORD 설정 시에만 동작하도록 변경 (자격증명 미설정 시 Re-detect로 수동 확인 필요), 바이너리 우선 파싱 미구현 한계 명시 |
| 1.6 | 2026-07-02 | §5.1a 신규 추가 — Edit Re-detect가 비밀번호 없는 카메라에 대해 SUNAPI를 더 이상 재시도하지 않음, §5.3 문구 정정(Edit Re-detect는 "항상 시도" 그룹에서 제외), §8/§9에 cameraId 반영 |
| 1.7 | 2026-07-02 | §5.2/§5.3 SUNAPI CGI 엔드포인트 정정 — 존재하지 않는 `media.cgi?msubmenu=channellist`/`system.cgi?msubmenu=systeminfo` 대신 실제 엔드포인트 `GET /stw-cgi/attributes.cgi/attributes` 반영 (로그 예시·설명 문구 갱신, FR-CAM-062a) |
| 1.8 | 2026-07-02 | §5.1b 신규 추가 — Detect Channels/Re-detect가 이미 스캔된 IP의 채널 수를 캐시에서 재사용, §9 API Reference 갱신 (FR-CH-065) |
| 1.9 | 2026-07-02 | §5.1c 신규 추가 — Found 탭 상세 패널에 SUNAPI/ONVIF 각 프로토콜의 MaxChannel을 별도 행으로 항상 표시 (FR-CH-066). Found 패널에 SUNAPI MaxChannel 표시를 요청 받아 도입 |
