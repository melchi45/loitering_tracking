# TC — Dashboard Channel Slot

**Product:** LTS-2026 Loitering Detection & Tracking System
**Feature:** Global Channel Slot Mapping for Cameras / YouTube Streams
**Version:** 1.13
**Date:** 2026-07-02
**SRS Reference:** SRS_Channel_Slot.md

---

## Test Cases

### TC-CH-A-001: POST /api/cameras auto-assigns channelSlot when omitted

**SRS:** FR-CH-012
**Steps:** `POST /api/cameras` with a valid `name`/`rtspUrl` and no `channelSlot` field at all
**Expected:** `201` (not `400`) — for backward compatibility with pre-existing integrations/tests (e.g. `nvr_channel_discovery.test.js`) that predate this feature; response `data.channelSlot` is the lowest currently-free slot

---

### TC-CH-A-002: channelSlot out of range rejected

**SRS:** FR-CH-010
**Precondition:** `MAX_CHANNEL_NUM=512` (default)
**Steps:** `POST /api/cameras` with `channelSlot: 0`, then `channelSlot: 513`
**Expected:** Both return `400` with the valid range in the error message

---

### TC-CH-A-003: Duplicate channelSlot rejected

**SRS:** FR-CH-011
**Steps:**
1. `POST /api/cameras` with `channelSlot: 50` → succeeds
2. `POST /api/cameras` (different name/rtspUrl) with `channelSlot: 50`

**Expected:** Step 2 returns `409`, error names the camera from step 1

---

### TC-CH-A-004: PUT resubmitting own channelSlot is not a conflict

**SRS:** FR-CH-011
**Steps:**
1. `POST /api/cameras` with `channelSlot: 51` → note returned `id`
2. `PUT /api/cameras/:id` with `channelSlot: 51` (same value) and an unrelated field change (e.g. `name`)

**Expected:** `200`, not `409`

---

### TC-CH-A-005: PUT to a slot taken by a different camera is rejected

**SRS:** FR-CH-011
**Steps:**
1. Camera A at `channelSlot: 52`, Camera B at `channelSlot: 53`
2. `PUT /api/cameras/:B_id` with `channelSlot: 52`

**Expected:** `409`, names Camera A

---

### TC-CH-A-006: GET /health includes maxChannelNum

**SRS:** FR-CH-062
**Steps:** `GET /health`
**Expected:** Response includes `maxChannelNum` as a positive integer (512 unless overridden)

---

### TC-CH-A-007: PUT accepts channelIndex update

**SRS:** FR-CH-061
**Steps:** `PUT /api/cameras/:id` with `channelIndex: 4` on a camera with `maxChannel: 8`
**Expected:** `200`; subsequent `GET /api/cameras` shows `channelIndex: 4` for that camera

---

### TC-CH-B-001: Startup backfill assigns sequential slots

**SRS:** FR-CH-020, FR-CH-022
**Precondition:** JSON-mode DB with 3 camera records lacking `channelSlot`, inserted with distinct `createdAt` timestamps
**Steps:** Start the server; `GET /api/cameras`
**Expected:** The 3 cameras have `channelSlot` values `1, 2, 3` matching ascending `createdAt` order; a second restart leaves them unchanged (idempotency)

---

### TC-CH-B-002: Backfill respects existing assignments

**SRS:** FR-CH-020
**Precondition:** 2 cameras, one already has `channelSlot: 1`, the other has none
**Steps:** Start the server
**Expected:** The unassigned camera receives `channelSlot: 2` (not `1`, which is taken)

---

### TC-CH-B-003: Backfill capacity exhaustion is logged, not crashed

**SRS:** FR-CH-021
**Precondition:** `MAX_CHANNEL_NUM=2`, 3 unassigned camera records
**Steps:** Start the server; check logs
**Expected:** 2 cameras get slots `1` and `2`; the 3rd remains `channelSlot: null`; a `[channelSlotService] No free channel slot ...` warning is logged for it; server starts successfully (no crash)

---

### TC-CH-C-001: Add Camera modal shows Channel section (RTSP tab)

**SRS:** FR-CH-030
**Precondition:** Admin on Streaming Dashboard, Add Camera modal open, RTSP tab
**Steps:** Observe the modal
**Expected:** A "Channel" section is visible with a `[-][value][+]` stepper and a group-browser grid with `</>` paging

---

### TC-CH-C-002: Add Camera modal shows Channel section (YouTube tab)

**SRS:** FR-CH-030
**Steps:** Switch to the YouTube tab within the same Add modal
**Expected:** Same Channel section present; selected value carried over from the RTSP tab if one was already chosen

---

### TC-CH-C-003: Stepper and group browser stay in sync

**SRS:** FR-CH-031
**Steps:**
1. Click `[+]` on the stepper 3 times from the default value
2. Observe the group browser

**Expected:** The group browser's highlighted/selected slot matches the stepper's new value (auto-paging to the containing group if needed)

---

### TC-CH-C-004: Default channel is lowest free slot

**SRS:** FR-CH-032
**Precondition:** Channels 1–5 all taken
**Steps:** Open Add Camera modal
**Expected:** Channel section defaults to `6`

---

### TC-CH-C-005: Taken slots shown disabled with occupant name

**SRS:** FR-CH-033
**Precondition:** Channel 7 assigned to camera "Front Gate"
**Steps:** Navigate the group browser to the page containing channel 7; hover/focus its button
**Expected:** Button is disabled (not clickable); tooltip/label shows "Front Gate"

---

### TC-CH-C-006: Edit modal pre-populates current channel, excludes self from conflicts

**SRS:** FR-CH-034
**Precondition:** Camera "Lobby" at `channelSlot: 10`
**Steps:** Open Edit on "Lobby"; observe the Channel section, then re-save without changing the value
**Expected:** Stepper/group browser show `10` selected; `10` is NOT shown as "taken" (it's this camera's own slot); save succeeds

---

### TC-CH-C-007: Server-side conflict surfaces as inline error, modal stays open

**SRS:** FR-CH-035
**Precondition:** Channel 20 taken by another camera (simulate a race: two browser tabs)
**Steps:** In tab A, start adding a camera with channel 20 selected (not yet submitted); in tab B, add a different camera to channel 20 and submit successfully; in tab A, submit
**Expected:** Tab A's submission fails with an inline error naming the conflict; the modal remains open with all other entered fields (name, RTSP URL, etc.) intact

---

### TC-CH-D-001: Edit modal shows NVR Channel section when applicable

**SRS:** FR-CH-041
**Precondition:** Camera added from a Wisenet NVR discovery with `maxChannel: 8`
**Steps:** Open Edit on that camera
**Expected:** An "NVR Channel" button row `CH1..CH8` is shown, current `channelIndex` highlighted

---

### TC-CH-D-002: NVR Channel section absent for single-channel cameras

**SRS:** FR-CH-041
**Precondition:** Manually-added RTSP camera, no discovery metadata (`maxChannel` null/1)
**Steps:** Open Edit
**Expected:** No "NVR Channel" section rendered

---

### TC-CH-D-003: Selecting a resolvable NVR channel updates RTSP preview, no network call

**SRS:** FR-CH-042, FR-CH-044
**Precondition:** Camera with `nvrProfiles` containing an entry for `channelIndex: 5`
**Steps:** In Edit, click "CH 5"; observe the RTSP URL preview and network activity (dev tools)
**Expected:** Preview URL updates to the `nvrProfiles` entry's `rtspUrl`; no additional HTTP/discovery request is fired

---

### TC-CH-D-004: Fallback resolution via path substitution

**SRS:** FR-CH-043
**Precondition:** SUNAPI camera (`supportSunapi: true`) with `rtspUrl` containing `/profile1/`, but `nvrProfiles` missing an entry for `channelIndex: 6`
**Steps:** Click "CH 6"
**Expected:** RTSP preview updates via regex substitution to a `/profile6/` URL (not disabled)

---

### TC-CH-D-005: Unresolvable channel button is disabled

**SRS:** FR-CH-043
**Precondition:** Non-SUNAPI camera, `nvrProfiles` missing an entry for the target channel
**Steps:** Attempt to select that channel
**Expected:** Button rendered disabled with an explanatory tooltip; cannot be selected

---

### TC-CH-D-006: Manual Add form "Detect Channels" button reveals CH grid

**SRS:** FR-CH-048
**Precondition:** Manual Add Camera modal open, RTSP tab, a SUNAPI NVR's RTSP URL typed into the RTSP URL field
**Steps:** Click "🔍 Detect Channels"
**Expected:** After the request resolves, a `CH 1..maxChannel` button row appears with a "SUNAPI — NCH NVR detected" label; clicking a channel updates the RTSP URL field to the resolved per-channel URL

---

### TC-CH-D-007: Manual Add form shows "single-channel" message when no NVR detected

**SRS:** FR-CH-048
**Precondition:** RTSP URL of a single-channel camera typed into the form
**Steps:** Click "🔍 Detect Channels"
**Expected:** No channel button grid appears; a "No multi-channel NVR detected — single-channel camera." message is shown instead

---

### TC-CH-D-008: Edit modal "Re-detect" is always visible, even with no prior NVR data

**SRS:** FR-CH-049
**Precondition:** Camera record with `maxChannel` unset (e.g. legacy camera predating this feature)
**Steps:** Open Edit on that camera; observe the NVR Channel section
**Expected:** A "🔍 Re-detect" button is shown along with "No NVR channel data yet — click Re-detect..." — this section is present even though `hasNvrChannels` would otherwise be false

---

### TC-CH-D-009: Edit modal Re-detect reveals channel grid without reopening the modal

**SRS:** FR-CH-049
**Precondition:** Same as TC-CH-D-008; the camera's IP is a reachable SUNAPI 8CH NVR
**Steps:** Click "🔍 Re-detect"; wait for the response
**Expected:** Within the same modal session (no close/reopen), the NVR Channel section updates to show `CH 1..8` buttons; saving without touching NVR Channel does not send `maxChannel`/`nvrProfiles` in the PUT body unless Re-detect was clicked first

---

### TC-CH-D-010: Re-detect that finds no NVR gives visible feedback, not silence

**SRS:** FR-CH-049
**Precondition:** Camera whose IP is reachable but is not a multi-channel SUNAPI/ONVIF NVR (or is ONVIF behind auth, which this project's client cannot authenticate — see Design_Channel_Slot.md §7)
**Steps:** Click "🔍 Re-detect"; wait for the response
**Expected:** The static "No NVR channel data yet — click Re-detect..." prompt is replaced with a result-specific message (e.g. "Re-detect ran (no SUNAPI/ONVIF response) — single-channel or no multi-channel NVR found at this camera's IP") — the operator can tell the click was processed, rather than the UI looking unchanged/unresponsive. Regression case for a 2026-07-02 defect where a legitimate "nothing found" result produced no visible state change at all.

---

### TC-CH-D-011: Found-tab discovery panel does NOT show a "Detect Channels" button

**SRS:** FR-CH-048a
**Precondition:** Sidebar Found tab, a discovered device selected (`DiscoveredCameraPanel.tsx` open)
**Steps:** Inspect the panel's Channels row
**Expected:** No "Detect Channels" button is present (that control only exists on the manual Add form, FR-CH-048, which has no discovery data). Only a "🔍 Re-detect" button appears, next to the manual channel-count override input.

---

### TC-CH-D-012: Found-tab panel Re-detect updates channel count/grid in place, without a full re-scan

**SRS:** FR-CH-048a
**Precondition:** Discovered device whose scan reported `MaxChannel: 1` (e.g. a timed-out best-effort SUNAPI query), but the device is in fact an 8CH NVR
**Steps:** Click "🔍 Re-detect" against a mock endpoint reporting 8 channels; observe without closing the panel or triggering `discovery:trigger`/a new network scan
**Expected:** The channel-count badge updates to "8 CH", the manual override input's max raises accordingly, and a `CH 1..8` selection grid appears — all within the same panel session. Adding the camera afterward (`+ Add to System`) submits `maxChannel: 8` (the Re-detect result), not the original scan's `MaxChannel: 1`. A result with `maxChannel ≤ 1` instead shows a distinct "no multi-channel NVR found" message (same rule as TC-CH-D-010), not a silent no-op.

---

### TC-CH-F-001: POST /api/cameras/probe-channels requires ip

**SRS:** FR-CH-045
**Steps:** `POST /api/cameras/probe-channels` with an empty body
**Expected:** `400`, error mentions `ip`

---

### TC-CH-F-002: Unreachable IP responds within the timeout, not hanging

**SRS:** FR-CH-046
**Steps:** `POST /api/cameras/probe-channels` with `{ ip: "192.0.2.1" }` (TEST-NET-1, guaranteed unreachable); measure response time
**Expected:** `200` within `PROBE_TIMEOUT_MS + ε` (~8–9s, not indefinite); `{ maxChannel: 1, protocol: 'none', profiles: [] }`

---

### TC-CH-F-003: SUNAPI detection synthesizes per-channel profiles from baseRtspUrl

**SRS:** FR-CH-047
**Precondition:** Mock/test SUNAPI endpoint at `GET /stw-cgi/attributes.cgi/attributes` returning XML `<attributes><group name="System"><category name="Limit"><attribute name="MaxChannel" type="int" value="4"/></category></group></attributes>` at a known IP (2026-07-02: corrected mock endpoint/format — see FR-CAM-062a; was previously `media.cgi?msubmenu=channellist` returning JSON, a non-existent path)
**Steps:** `POST /api/cameras/probe-channels` with `{ ip, baseRtspUrl: "rtsp://ip:554/profile1/media.smp" }`
**Expected:** `200`, `protocol: 'sunapi'`, `maxChannel: 4`, `profiles` contains 4 entries with `rtspUrl` values `/profile1/`..`/profile4/` substituted

---

### TC-CH-F-004: ONVIF result preferred over SUNAPI when both report multiple channels

**SRS:** FR-CH-047
**Precondition:** A device answering both a SUNAPI channel-list probe (`MaxChannel: 4`) and ONVIF `GetProfiles` (4 distinct SourceTokens, all `GetStreamUri` calls succeed)
**Steps:** `POST /api/cameras/probe-channels` with matching `ip`
**Expected:** `protocol: 'onvif'` in the response (not `'sunapi'`), `profiles` contain the ONVIF-resolved `rtspUrl` values

---

### TC-CH-F-005: probe-channels logs SUNAPI/ONVIF discovery data at DEBUG level

**SRS:** FR-CH-063
**Precondition:** `server/.env` has `LOG_TO_FILE=true`, `LOG_LEVEL=DEBUG`; server started via `npm run start` (production logger active — `devServer.js`/plain `node` runs do not load `utils/logger.js`, see FR-CH-063 note); a camera IP reachable over SUNAPI and/or ONVIF (or a mock endpoint per TC-CH-F-003/004)
**Steps:**
1. From the UI, click "Detect Channels" (Add modal), "Re-detect" (Edit modal), or "Re-detect" (Found-tab `DiscoveredCameraPanel`) against the known IP — any of the three trigger the same server endpoint
2. Tail the log file: `tail -f /var/log/lts/lts-$(date +%Y-%m-%d).log | grep 'probe-channels\|SUNAPI\|ONVIFDiscovery\]\[enrichDevice'` (or view via Admin Dashboard → Server Logs with level filter = DEBUG)

**Expected:** The log contains, in order: (1) a `[cameras][probe-channels] request ip=...` line with the resolved `httpPort`/`httpType`/`onvifPort` and whether credentials were supplied (never the password value itself); (2) one `[Discovery][SUNAPI] ...` line per SUNAPI endpoint path attempted, each reporting HTTP status/timeout/connection-error and any parsed `MaxChannel`; (3) `[ONVIFDiscovery][enrichDevice] ...` lines for each ONVIF SOAP call attempted (`GetDeviceInformation`, `GetCapabilities`, `GetProfiles`, `GetStreamUri` per profile) with success/failure and a final `result → MaxChannel=N, profiles=M` summary; (4) a closing `[cameras][probe-channels] ... decision → protocol=..., maxChannel=..., profiles=...` line. With `LOG_LEVEL=INFO` (the default), none of these lines appear — only the JSON response to the client is observable, confirming the logging is DEBUG-gated and does not spam production logs at the default level.

**Manual** — verifying log file content and log-level gating end-to-end requires a running server with a non-default `LOG_LEVEL` and file/console inspection; no HTTP-only assertion exists for this (the `/admin/logs/recent` endpoint that could read logs back over HTTP requires `admin` role auth, which this suite's unauthenticated harness does not carry — consistent with how other log-inspection cases, e.g. `TC_Admin_Log_Viewer.md`, are documented as manual).

---

### TC-CH-F-006: SUNAPI 401 (auth rejected) is treated as not-detected, not an error

**SRS:** FR-CH-063
**Precondition:** Mock HTTP server responding `401` to every request, on a known port
**Steps:** `POST /api/cameras/probe-channels` with `{ ip: "127.0.0.1", httpPort: <mock port> }`
**Expected:** `200`, `maxChannel: 1`, `protocol: 'none'` — exercises the same `res.statusCode === 401` branch that now also emits a `[Discovery][SUNAPI] ... (auth rejected)` DEBUG line (TC-CH-F-005), confirming the added logging didn't change the branch's existing behavior. Automated in `test/api/channel_slot.test.js`.

---

### TC-CH-F-007: SUNAPI malformed/unparseable response body does not crash probe-channels

**SRS:** FR-CH-063
**Precondition:** Mock HTTP server responding `200` with an unparseable body (`not-xml{{{ <unterminated`) to every request (2026-07-02: since the corrected endpoint parses XML via regex, not `JSON.parse()`, the failure mode this exercises is "no `<group>/<category>/<attribute>` match found," not a JSON syntax error — see FR-CAM-062a)
**Steps:** `POST /api/cameras/probe-channels` with `{ ip: "127.0.0.1", httpPort: <mock port> }`
**Expected:** `200` (not `500`), `maxChannel: 1`, `protocol: 'none'` — exercises the regex-no-match / `parseInt(null)` fallback branch that also emits a `[Discovery][SUNAPI] ... XML parse failed: ...` DEBUG line (TC-CH-F-005), confirming the endpoint correction didn't introduce an unhandled exception. Automated in `test/api/channel_slot.test.js`.

---

### TC-CH-F-008: probe-channels skips the SUNAPI network call for an added camera with no password on file

**SRS:** FR-CH-064
**Precondition:** Mock SUNAPI endpoint reporting `MaxChannel: 4`; a camera added via `POST /api/cameras` with no `username`/`password`
**Steps:** `POST /api/cameras/probe-channels` with `{ ip: "127.0.0.1", httpPort: <mock port>, cameraId: <added camera's id> }` (no `username`/`password` in the request body)
**Expected:** `200`, `maxChannel: 1`, `protocol: 'none'` — the mock reports 4 but the server never queries it, since `cameraId` resolves to a camera record with no password and no `RTSP_DEFAULT_PASSWORD` is configured. If this server does have `RTSP_DEFAULT_PASSWORD` set, this specific assertion doesn't apply (by design — see FR-CH-064) and is skipped by the automated test. Automated in `test/api/channel_slot.test.js`.

---

### TC-CH-F-009: probe-channels uses the camera record's stored password when cameraId is given

**SRS:** FR-CH-064
**Precondition:** Mock SUNAPI endpoint reporting `MaxChannel: 4`; a camera added via `POST /api/cameras` with `username: "admin"`, `password: "secret123"`
**Steps:** `POST /api/cameras/probe-channels` with `{ ip: "127.0.0.1", httpPort: <mock port>, cameraId: <added camera's id> }` (deliberately no `username`/`password` in the request body — must come from the camera record)
**Expected:** `200`, `protocol: 'sunapi'`, `maxChannel: 4` — proves the server resolved and used the camera record's own stored credentials, since the request body carried none. Automated in `test/api/channel_slot.test.js`.

---

### TC-CH-F-010: probe-channels reuses a cached UDP Discovery result instead of querying SUNAPI CGI

**SRS:** FR-CH-065
**Precondition:** A UDP Discovery scan has already run and found a device at a known IP reporting `SupportSunapi: true`, `MaxChannel: 8` (visible in the Found tab)
**Steps:** With `LOG_LEVEL=DEBUG`, `POST /api/cameras/probe-channels` with `{ ip: <that IP> }` (no `httpPort`/credentials needed)
**Expected:** `200`, `maxChannel: 8`, `supportSunapi: true`, `protocol: 'sunapi'`, returned near-instantly (no `PROBE_TIMEOUT_MS`-bounded network wait for the SUNAPI half). The log shows `[cameras][probe-channels] ... cachedMaxChannel=8` and `using cached UDP Discovery MaxChannel=8 — skipping SUNAPI CGI query entirely`, and does **not** show a `[Discovery][SUNAPI] querying ...` line for this call (proving the CGI query was never attempted). Calling the same endpoint for an IP the scan has never seen behaves exactly as TC-CH-F-003/F-008/F-009 (unchanged).

---

### TC-CH-F-011: probe-channels returns sunapiMaxChannel/onvifMaxChannel independently of which protocol wins as maxChannel/protocol

**SRS:** FR-CH-066
**Precondition:** Mock SUNAPI endpoint (per TC-CH-F-003) reporting `MaxChannel: 6`; no ONVIF service present at the same IP
**Steps:** `POST /api/cameras/probe-channels` with `{ ip: "127.0.0.1", httpPort: <mock port> }`
**Expected:** `200`, `protocol: 'sunapi'`, `maxChannel: 6` (SUNAPI wins — no ONVIF profiles present), `sunapiMaxChannel: 6` (matches the combined `maxChannel` exactly here, since SUNAPI is the sole source), `onvifMaxChannel` present as a number (the ONVIF probe completed against 127.0.0.1 and returned its own — losing — result, rather than the field being absent or mirroring the SUNAPI value). Automated in `test/api/channel_slot.test.js`.

**Manual** — exercising this requires seeding `discoveryService.js`'s in-memory `DiscoveryService` singleton (`_upsert()`/`getByIp()`) with a fake discovered device, which lives in the same process as the running LTS server; this suite's HTTP-only, separate-process test harness (see file header) has no way to inject into another process's in-memory cache without either a test-only debug endpoint or restructuring the harness to run in-process. Verify manually: run a UDP Discovery scan (or use a mock UDP responder), confirm the device appears in the Found tab with `MaxChannel > 1`, then click "Detect Channels" against that same IP from the Add form and confirm via DEBUG logs that no fresh SUNAPI CGI request was made.

---

### TC-CH-F-012: probe-channels retries with computed HTTP Digest auth when SUNAPI challenges for it, not just Basic

**SRS:** FR-CH-067
**Precondition:** Mock SUNAPI endpoint that 401s any Basic-authenticated (or unauthenticated) request with `WWW-Authenticate: Digest qop="auth", realm="...", nonce="..."`, and only returns `200`+`MaxChannel` XML when the retry's computed `response` hash is correct for the given username/password (i.e. the mock genuinely validates the credential, not just "some Digest header was sent")
**Steps:** `POST /api/cameras/probe-channels` with `{ ip: "127.0.0.1", httpPort: <mock port>, username: "admin", password: "digestpass123" }`
**Expected:** `200`, `protocol: 'sunapi'`, `maxChannel` matches the mock's configured value — only obtainable via the authenticated Digest retry, since the initial Basic attempt is always challenged. Automated in `test/api/channel_slot.test.js`. Also independently verified against a real camera (192.168.214.32, nginx-fronted iPolis firmware) — see `test/api/probe_camera_maxchannel.js` and `docs/design/Design_Channel_Slot.md` §4.6g.

**TC-CH-F-012b (negative case):** same mock server configured with a different real password than the one sent in the request. **Expected:** `200`, `protocol: 'none'`, `maxChannel: 1` — a genuinely wrong password is still rejected after the Digest retry; FR-CH-067 only fixes the auth-scheme mismatch, not the credential check itself. Automated alongside TC-CH-F-012.

---

### TC-CH-E-001: Grid cell shows camera matching its channelSlot

**SRS:** FR-CH-050
**Precondition:** Camera "Front Gate" at `channelSlot: 3`, 4×4 (16-channel) layout active, Channel Group 1 (CH 1–16) shown
**Steps:** Observe cell 3
**Expected:** Cell 3 shows "Front Gate", regardless of its `createdAt` relative to other cameras

---

### TC-CH-E-002: Empty channel slot shows placeholder

**SRS:** FR-CH-051
**Precondition:** Channel 7 has no camera assigned, within the currently visible group
**Steps:** Observe cell 7
**Expected:** Dashed placeholder, channel number "7", "Unassigned" label; no camera controls rendered

---

### TC-CH-E-003: Channel Group paging shows correct range label and cameras

**SRS:** FR-CH-052
**Precondition:** `MAX_CHANNEL_NUM=512`, 4×4 layout (16/page), camera at `channelSlot: 20`
**Steps:** Click `▶` once from Group 1
**Expected:** Label reads "Channel Group 2 of 32 (CH 17–32)"; the camera at slot 20 appears in the corresponding cell; this works even if fewer than 20 cameras exist in total

---

### TC-CH-E-004: Featured (N Main + Sub) layout also respects channelSlot

**SRS:** FR-CH-050
**Precondition:** "1+3" featured layout active, 4 cameras at `channelSlot` 1, 2, 3, 4
**Steps:** Observe main and sub cells
**Expected:** Main cell shows `channelSlot: 1`'s camera, sub cells show `channelSlot: 2, 3, 4` in order — consistent with equal-grid behavior, not array-order

---

### TC-CH-E-005: Mobile swipe pages by channel group, not camera count

**SRS:** FR-CH-052
**Precondition:** Mobile viewport, 3 cameras total spread across `channelSlot` 1, 50, 100; 9-channel layout, `MAX_CHANNEL_NUM=512`
**Steps:** Swipe right (next) repeatedly
**Expected:** Swiping pages over `ceil(512/9)=57` channel groups (not `ceil(3/9)=1`), reaching the group containing slot 50 and slot 100 showing those cameras with empty cells around them; the "CH a–b" counter badge reflects the current group's range. The dot-per-page indicator is only shown when `totalPages ≤ 12` (57 is above that threshold, so dots are hidden and the CH counter badge is the sole position indicator — avoids rendering 57 illegibly small dots)

---

### TC-CH-G-001: `hasConfiguredSunapiCredentials()` gates the background-scan CGI fallback

**SRS:** FR-CH-040a, FR-CH-040b
**Precondition:** `require('../../server/src/services/discoveryService')` directly; no live server or network needed (pure function, no I/O at require-time)
**Steps:**
1. Neither `RTSP_DEFAULT_USERNAME` nor `RTSP_DEFAULT_PASSWORD` set → call `hasConfiguredSunapiCredentials()`
2. Only `RTSP_DEFAULT_USERNAME` set (e.g. `'admin'`) → call again
3. Both set (e.g. `'admin'`/`'pass'`) → call again
4. Both set to empty strings `''` → call again

**Expected:** Step 1 → `false`. Step 2 → `false` (partial credentials do not count). Step 3 → `true`. Step 4 → `false` (empty string is falsy, same as unset — guards against an accidentally-blank `.env` line silently enabling unauthenticated CGI probing). Implemented as a single test with all four steps in `test/api/channel_slot.test.js`.

---

### TC-CH-G-002: `DiscoveryService.getByIp()` returns a cached device by IP, `null` on a miss

**SRS:** FR-CH-065
**Precondition:** `require('../../server/src/services/discoveryService')` directly, call `getDiscoveryService({ emit: () => {} })` with a minimal mock `io` — no live server or network needed
**Steps:**
1. `svc.getByIp('203.0.113.99')` on a fresh instance with nothing scanned yet
2. `svc._upsert({ IPAddress: '203.0.113.99', SupportSunapi: true, MaxChannel: 8, ... })` to seed the cache
3. `svc.getByIp('203.0.113.99')` again

**Expected:** Step 1 → `null` (no throw, no network I/O). Step 3 → the upserted device object, with `MaxChannel: 8` and `SupportSunapi: true` intact. Implemented in `test/api/channel_slot.test.js` — this verifies the lookup method itself in isolation; it does **not** exercise the full `probe-channels` HTTP integration against a live server's own singleton (see TC-CH-F-010, manual, for that).

---

### TC-CH-G-003: `DiscoveryService.applyProbeResult()` raises a stale registry value, never lowers it, and no-ops for unknown IPs

**SRS:** FR-CH-068
**Precondition:** Same direct-require/mock-`io` approach as TC-CH-G-002 — no live server or network needed
**Steps:**
1. Seed the registry with a device at `203.0.113.100` reporting `MaxChannel: 1, SunapiMaxChannel: 1` (simulating a UDP-only scan result)
2. `svc.applyProbeResult('203.0.113.100', { maxChannel: 2, sunapiMaxChannel: 2, supportSunapi: true, onvifMaxChannel: null })` — a genuine improvement
3. `svc.applyProbeResult('203.0.113.100', { maxChannel: 1, sunapiMaxChannel: 1, supportSunapi: true, onvifMaxChannel: null })` — a lower/equal follow-up result
4. `svc.applyProbeResult('203.0.113.200', { maxChannel: 5, sunapiMaxChannel: 5 })` — an IP the registry has never seen

**Expected:** Step 2 → returns the updated device with `MaxChannel: 2`/`SunapiMaxChannel: 2`; `svc.getByIp('203.0.113.100')` reflects the raise; exactly one `discovery:result` event is emitted via the mock `io`. Step 3 → returns `null`; the registry's `MaxChannel` remains `2` (not regressed to `1`); no additional event is emitted. Step 4 → returns `null`; no event is emitted (nothing to correct — `applyProbeResult()` only updates entries the registry already knows about, it does not create new ones). Implemented in `test/api/channel_slot.test.js`.

---

## Automated Coverage

Automated API-level tests for TC-CH-A-*, TC-CH-B-*, and TC-CH-F-001~003/F-006~009/F-011~F-012 are implemented in `test/api/channel_slot.test.js`. TC-CH-G-001 (`hasConfiguredSunapiCredentials()`) is also implemented there as a plain unit test — pure function, no HTTP/DB fixture needed. TC-CH-C-*/D-*/E-* (UI/interaction) are manual/exploratory for this phase — no component test harness exists yet for `CameraList.tsx`/`CameraGrid.tsx`/`CameraEditModal.tsx` in this repo (consistent with how other UI-only TC groups, e.g. TC-LOG-021~028 in `TC_Admin_Log_Viewer.md`, are documented as manual). TC-CH-F-004 (ONVIF-preferred-over-SUNAPI) has no mock-ONVIF-server harness yet and remains manual/exploratory — a pre-existing gap, not introduced by this revision. TC-CH-F-005 (DEBUG-level discovery logging) is manual for a different reason: log output can only be observed by a client with `admin` role auth or direct file access, neither of which this suite's unauthenticated HTTP harness carries — TC-CH-F-006/F-007 are its automated proxy, exercising the same error branches (auth-rejected, malformed/unparseable response body) that the new logging runs through without asserting the log content itself. TC-CH-F-003/F-006~F-009's mock SUNAPI server serves the real endpoint (`GET /stw-cgi/attributes.cgi/attributes`, XML) as of the 2026-07-02 endpoint correction (FR-CAM-062a) — previously it mocked a non-existent JSON path. TC-CH-F-008/F-009 (FR-CH-064's credential gate) are fully automated black-box tests — they use a mock SUNAPI server to prove the probe was actually skipped (F-008) or actually attempted with the camera record's credentials (F-009), not just that the response shape looks right. TC-CH-F-010 (FR-CH-065's UDP Discovery cache reuse, full HTTP integration against a live server) is manual — it needs to seed `discoveryService.js`'s in-process `DiscoveryService` singleton, which lives inside the running LTS server process and isn't reachable from this suite's separate-process HTTP harness. TC-CH-G-002 automates the underlying `getByIp()` lookup method itself in isolation (same direct-require, no-live-server approach as TC-CH-G-001), which is the part of FR-CH-065 that doesn't require a live server to verify. TC-CH-F-011 (FR-CH-066's per-protocol `sunapiMaxChannel`/`onvifMaxChannel` fields) reuses the TC-CH-F-003 mock SUNAPI server and is fully automated — the ONVIF half is inherently exercised too, since `enrichDevice()` always runs in parallel against the same IP and never throws (see Design_Channel_Slot.md §4.6f), so `onvifMaxChannel` reliably comes back as a real (losing) number rather than needing a separate mock-ONVIF harness (unlike TC-CH-F-004, which needs ONVIF to actually *win*). TC-CH-F-012/F-012b (FR-CH-067's HTTP Digest auth retry) use a new mock server (`startMockDigestSunapiServer()`) that challenges every Basic-authenticated request with a genuine RFC 7616 `WWW-Authenticate: Digest` header and independently recomputes the expected MD5 response server-side to validate the client's retry — a wrong password still fails even though a Digest challenge is offered, so this isn't just "checks a Digest header was sent." TC-CH-G-003 (FR-CH-068's registry write-back) is fully automated in the same direct-require, no-live-server style as TC-CH-G-001/G-002 — `applyProbeResult()` is a synchronous, no-I/O method, so its raise/no-regress/unknown-IP branches are all exercised without needing an actual `probe-channels` HTTP round-trip; the full HTTP-triggered path (a real `POST /api/cameras/probe-channels` call actually invoking `applyProbeResult()` against the live server's own singleton and the resulting `discovery:result` reaching a real Socket.IO client) remains manual, for the same reason TC-CH-F-010 does.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-02 | 초기 작성 |
| 1.1 | 2026-07-02 | TC-CH-D-006~009 추가 (수동 Add Detect Channels / Edit Re-detect UI), TC-CH-F-001~004 추가 (`POST /api/cameras/probe-channels` 자동화 테스트) |
| 1.2 | 2026-07-02 | TC-CH-D-010 추가 — Re-detect가 NVR을 못 찾았을 때도 결과 피드백이 표시되어야 함 (기존엔 "아직 클릭 안 함" 문구가 그대로 남아 클릭이 무반응처럼 보이는 결함) |
| 1.3 | 2026-07-02 | TC-CH-D-011~012 추가 — Found 탭 discovery 패널에 Detect Channels가 없어야 함(중복 방지), Re-detect가 패널 내에서 즉시 갱신되어야 함 |
| 1.4 | 2026-07-02 | TC-CH-F-005 추가 — probe-channels가 SUNAPI/ONVIF discovery 데이터를 DEBUG 레벨로 로그 남기는지 검증 (FR-CH-063) |
| 1.5 | 2026-07-02 | TC-CH-F-006~007 추가 — FR-CH-063 로깅이 추가된 401/malformed-JSON 분기의 자동화된 회귀 테스트 (F-005의 로그 내용 검증을 대신하는 프록시), Automated Coverage 문구를 실제 구현 범위(F-001~003/006~007)에 맞게 정정 |
| 1.6 | 2026-07-02 | TC-CH-G-001 추가 — `hasConfiguredSunapiCredentials()` 단위 테스트 (백그라운드 스캔의 CGI 폴백 게이팅, FR-CH-040a/040b), Automated Coverage에 반영 |
| 1.7 | 2026-07-02 | TC-CH-F-008~009 추가 — probe-channels의 cameraId 기반 SUNAPI 자격증명 게이팅(FR-CH-064) 자동화 테스트, Automated Coverage 갱신 |
| 1.8 | 2026-07-02 | TC-CH-F-003/007 SUNAPI 목 서버 엔드포인트 정정 — 존재하지 않는 `media.cgi?msubmenu=channellist` JSON 경로 대신 실제 엔드포인트 `GET /stw-cgi/attributes.cgi/attributes`(XML)로 수정 (FR-CAM-062a), TC-CH-G-001 서술을 실제 테스트(단일 케이스, 4단계, 빈 문자열 케이스 포함)와 일치시킴 |
| 1.9 | 2026-07-02 | TC-CH-F-010 추가 — probe-channels가 UDP Discovery 캐시를 SUNAPI CGI 쿼리보다 우선 사용해야 함 (FR-CH-065), 수동 테스트로 명시 |
| 1.10 | 2026-07-02 | TC-CH-G-002 추가 — `DiscoveryService.getByIp()` 자동화 단위 테스트 (FR-CH-065의 순수 로직 부분), Automated Coverage 갱신 |
| 1.11 | 2026-07-02 | TC-CH-F-011 추가 — probe-channels가 sunapiMaxChannel/onvifMaxChannel을 병합된 maxChannel/protocol과 별개로 반환해야 함 (FR-CH-066), Automated Coverage 갱신 |
| 1.12 | 2026-07-02 | TC-CH-F-012/F-012b 추가 — SUNAPI가 Digest 챌린지를 보낼 때 Basic 대신 계산된 Digest로 재시도해야 함(FR-CH-067), 자격증명 자체가 틀린 경우엔 재시도해도 여전히 실패해야 함(F-012b), 신규 mock `startMockDigestSunapiServer()` 반영, Automated Coverage 갱신 |
| 1.13 | 2026-07-02 | TC-CH-G-003 추가 — `DiscoveryService.applyProbeResult()`가 레지스트리 값을 올려주되 낮추지 않고, 미지의 IP는 무시해야 함(FR-CH-068), Automated Coverage 갱신 |
