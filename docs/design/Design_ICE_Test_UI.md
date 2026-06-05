# DESIGN DOCUMENT
# In-App ICE Connectivity Test UI

| | |
|---|---|
| **Document ID** | DESIGN-LTS-ICE-UI-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-06-05 |
| **Parent SRS** | srs/SRS_ICE_Test_UI.md |
| **Related PRD** | prd/PRD_ICE_Test_UI.md |

---

## Table of Contents
1. [Architecture Overview](#1-architecture-overview)
2. [File Structure](#2-file-structure)
3. [Server-Side Design — ICE Test Endpoints](#3-server-side-design--ice-test-endpoints)
4. [Client-Side Design — SettingsModal ICE Test Section](#4-client-side-design--settingsmodal-ice-test-section)
5. [Two-Phase Test Flow](#5-two-phase-test-flow)
6. [State Machine](#6-state-machine)
7. [Log Format Specification](#7-log-format-specification)
8. [i18n Design](#8-i18n-design)
9. [Sequence Diagrams](#9-sequence-diagrams)
10. [Error Handling & Edge Cases](#10-error-handling--edge-cases)

---

## 1. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Settings Modal (React)                         │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │  WebRTC Settings (STUN/TURN inputs + Apply button)           │    │
│  ├──────────────────────────────────────────────────────────────┤    │
│  │  ICE Connectivity Test                                        │    │
│  │  ┌──────────────────────────────┐  [Download] [Clear]        │    │
│  │  │  Run ICE Test                │                            │    │
│  │  └──────────────────────────────┘                            │    │
│  │  ┌────────────────────────────────────────────────────────┐  │    │
│  │  │ [HH:MM:SS.mmm] === Phase 1: ICE Candidate Gathering …  │  │    │
│  │  │ [HH:MM:SS.mmm]   + host  192.168.1.50:48120  udp      │  │    │
│  │  │ [HH:MM:SS.mmm]   + srflx 203.0.113.5:12345  udp      │  │    │
│  │  │ [HH:MM:SS.mmm] --- Phase 1 Summary ---                  │  │    │
│  │  │ [HH:MM:SS.mmm]   srflx (STUN): 1  ✓ STUN reachable    │  │    │
│  │  │ [HH:MM:SS.mmm] === Phase 2: Server Transport Test ===   │  │    │
│  │  │ [HH:MM:SS.mmm]   ✓ Transport created: id=ab12cd34      │  │    │
│  │  └────────────────────────────────────────────────────────┘  │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                        │
│               RTCPeerConnection (STUN/TURN servers)                   │
│                    │                          │                        │
│               STUN servers              TURN servers                  │
│                    │                          │                        │
│         POST /api/webrtc/ice-test ──────────► LTS Server              │
│                                               └ mediasoup             │
│                                                 WebRtcTransport        │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 2. File Structure

| File | Change | Description |
|------|--------|-------------|
| `server/src/index.js` | Modified | Added `POST /api/webrtc/ice-test` and `DELETE /api/webrtc/ice-test/:testId` |
| `client/src/App.tsx` | Modified | Added ICE test state, `runIceTest()`, `downloadIceReport()`, UI section in `SettingsModal` |
| `client/src/i18n/translations/en.ts` | Modified | Added 5 new translation keys |
| `client/src/i18n/translations/ko.ts` | Modified | Added 5 Korean translations |
| `client/src/i18n/translations/*.ts` | Modified | Added 5 keys (English values) to 13 other locale files |

---

## 3. Server-Side Design — ICE Test Endpoints

### 3.1 In-Memory Session Store

```javascript
const iceTestSessions = new Map();
// key:   testId (string)  e.g. "icetest-1717600000000-abc123"
// value: { transport: WebRtcTransport, timer: NodeJS.Timeout }
```

### 3.2 `POST /api/webrtc/ice-test`

```
Guard: webrtcGateway.enabled === false → 503
       ↓
router = await webrtcGateway.getOrCreateRouter('__ice-test__')
       ↓
transport = await router.createWebRtcTransport({
  listenIps:  webrtcGateway.getListenIps(''),
  enableUdp:  true,
  enableTcp:  true,
  preferUdp:  true,
  enableSctp: false,
})
       ↓
testId = "icetest-<timestamp>-<random6>"
timer  = setTimeout(autoCleanup, 90_000)
iceTestSessions.set(testId, { transport, timer })
       ↓
res.json({ testId, transportId, iceParameters, iceCandidates, dtlsParameters })
```

### 3.3 `DELETE /api/webrtc/ice-test/:testId`

```
s = iceTestSessions.get(testId)
if (s):
  clearTimeout(s.timer)
  s.transport.close()          (guarded: if !s.transport.closed)
  iceTestSessions.delete(testId)
res.json({ ok: true })          (always 200)
```

### 3.4 Auto-Cleanup Rationale

90 seconds was chosen to:
- Exceed the maximum ICE gather + connection time (typically < 30 s)
- Prevent port exhaustion if the client crashes mid-test
- Stay within mediasoup's default worker keepalive window

### 3.5 Shared `__ice-test__` Router

Using a dedicated, shared router avoids polluting camera routers with test traffic. Multiple concurrent tests share the same router (codec capabilities only), but each has its own transport with distinct ports. The router is never deleted between tests; it persists for the lifetime of the server process.

---

## 4. Client-Side Design — SettingsModal ICE Test Section

### 4.1 New State Variables (inside `SettingsModal`)

```typescript
const [iceRunning, setIceRunning] = useState(false);
const [iceLog,     setIceLog]     = useState<string[]>([]);
const iceLogRef   = useRef<HTMLTextAreaElement>(null);
const iceAbortRef = useRef(false);
```

### 4.2 Log Entry Helper

```typescript
const ts  = () => new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
const log = (msg: string) => {
  lines.push(`[${ts()}] ${msg}`);
  setIceLog([...lines]);
  requestAnimationFrame(() => {
    if (iceLogRef.current)
      iceLogRef.current.scrollTop = iceLogRef.current.scrollHeight;
  });
};
```

### 4.3 ICE Server Construction

The ICE servers array is built from the **local draft state** (may differ from saved state):

```typescript
const iceServers: RTCIceServer[] = [
  ...stunUrls.map(u => u.trim()).filter(Boolean).map(urls => ({ urls })),
  ...turns.filter(t => t.url.trim()).map(t => ({
    urls: t.url.trim(), username: t.username, credential: t.credential,
  })),
];
```

This allows testing values before clicking Apply.

### 4.4 UI Rendering Conditions

| Element | Rendered when |
|---------|---------------|
| Section header | Always (in WebRTC settings group) |
| Action button | Always |
| Log textarea | `iceLog.length > 0` |
| Download button | `iceLog.length > 0` |
| Clear button | `iceLog.length > 0` |

### 4.5 Button State Mapping

| `iceRunning` | Button label | Button color | Click action |
|-------------|--------------|--------------|--------------|
| `false` | `t.settingsIceTestRun` | Indigo | Start `runIceTest()` |
| `true` | `t.settingsIceTestRunning` | Yellow/amber | Set abort flag |

### 4.6 Textarea Styling

```
bg-black/60        → near-black terminal background
text-green-300     → classic terminal green text
font-mono          → monospace for columnar alignment
text-[10px]        → small enough to show ~20 lines in the h-40 box
resize-none        → fixed height, no user resize
border-gray-700    → subtle border matching modal chrome
```

---

## 5. Two-Phase Test Flow

### 5.1 Phase 1 — Client ICE Gathering

```
createRTCPeerConnection({ iceServers })
  └─ createDataChannel('lts-ice-check')
  └─ createOffer() → setLocalDescription()
  └─ onicecandidate
  │    ├─ log candidate: type / address / port / protocol
  │    └─ push to gathered[]
  └─ onicecandidateerror
  │    └─ log error code + url + text
  └─ onicegatheringstatechange
       ├─ 'gathering' → (continue waiting)
       └─ 'complete'  → resolve
  └─ (fallback) setTimeout 15_000 → resolve with timeout message
  └─ close()
  └─ log summary: host/srflx/relay counts with pass/fail indicators
```

### 5.2 Phase 2 — Server Transport Test

```
if (iceAbortRef.current) { log('Aborted.'); return; }

try {
  res = await fetch('POST /api/webrtc/ice-test')
  data = await res.json()
  if error → log ✗ message
  else:
    testId = data.testId
    log ✓ transport id, candidate count
    for each candidate → log type/ip/port/protocol
} finally {
  if (testId)
    await fetch('DELETE /api/webrtc/ice-test/:testId')
    log 'Server transport cleaned up.'
}
log '=== ICE Test Complete ==='
```

---

## 6. State Machine

```
         idle
          │
          │ [Run ICE Test] clicked
          ▼
       running ──────────────────────► aborted
          │  [button clicked]              │
          │                               │
          │ Phase 1 complete               │ (no Phase 2)
          │ Phase 2 complete               │
          ▼                               ▼
      complete                        complete
         (iceRunning = false)        (iceRunning = false)
```

---

## 7. Log Format Specification

### 7.1 Timestamp

All entries use `HH:MM:SS.mmm` extracted from `new Date().toISOString().slice(11, 23)`.

### 7.2 Line Types

| Prefix | Meaning |
|--------|---------|
| `=== … ===` | Phase header |
| `--- … ---` | Summary header |
| `  + <type> <addr>:<port>  proto=<p>` | ICE candidate |
| `  ! ICE error: code=N url=… "…"` | ICE error |
| `  ✓ …` | Success indicator |
| `  ✗ …` | Failure indicator |
| `  (no TURN configured)` | Informational |

### 7.3 Example Output

```
[10:23:44.001] === Phase 1: ICE Candidate Gathering ===
[10:23:44.002] STUN servers  : stun:stun.l.google.com:19302
[10:23:44.003] TURN servers  : turn:192.168.214.3:3478
[10:23:44.004] Total ICE servers: 2
[10:23:44.210]   + host  192.168.214.50:54321  proto=udp
[10:23:44.310]   + host  192.168.214.50:54322  proto=tcp
[10:23:44.890]   + srflx 203.0.113.10:12345   proto=udp
[10:23:45.120]   + relay 203.0.113.5:49152    proto=udp
[10:23:45.200] 
[10:23:45.200] --- Phase 1 Summary ---
[10:23:45.201]   host  (local)   : 2
[10:23:45.201]   srflx (STUN)    : 1  ✓ STUN reachable
[10:23:45.201]   relay (TURN)    : 1  ✓ TURN reachable
[10:23:45.202] 
[10:23:45.202] === Phase 2: Server Transport Test ===
[10:23:45.310]   ✓ Transport created: id=ab12cd34
[10:23:45.311]   Server ICE candidates: 2
[10:23:45.311]     + host  192.168.214.100:40001  proto=udp
[10:23:45.312]     + host  192.168.214.100:40002  proto=tcp
[10:23:45.400]   Server transport cleaned up.
[10:23:45.401] 
[10:23:45.401] === ICE Test Complete ===
```

---

## 8. i18n Design

### 8.1 New Keys

Five keys are added to the `Translations` type interface in `en.ts`:

```typescript
settingsIceTest: string;          // Section header
settingsIceTestRun: string;       // Button label (idle)
settingsIceTestRunning: string;   // Button label (running)
settingsIceTestDownload: string;  // Download button
settingsIceTestClear: string;     // Clear button
```

### 8.2 Korean Translations

| Key | Korean |
|-----|--------|
| `settingsIceTest` | `ICE 연결 테스트` |
| `settingsIceTestRun` | `ICE 테스트 실행` |
| `settingsIceTestRunning` | `테스트 중… (클릭하여 중단)` |
| `settingsIceTestDownload` | `리포트 다운로드` |
| `settingsIceTestClear` | `지우기` |

### 8.3 Other Locales

13 remaining locales use English values as placeholders. All satisfy the TypeScript `Translations` interface constraint.

---

## 9. Sequence Diagrams

### 9.1 Successful ICE Test (STUN + TURN available)

```
Browser                 STUN Server          TURN Server       LTS Server
  │                         │                    │                  │
  │──createOffer()──────────►                   │                  │
  │──STUN Binding Request──►│                   │                  │
  │◄─STUN Binding Response──│                   │                  │
  │  (srflx candidate)      │                   │                  │
  │──TURN Allocate Request─────────────────────►│                  │
  │◄─TURN Allocate Response──────────────────────│                  │
  │  (relay candidate)      │                   │                  │
  │──icegatheringstate='complete'               │                  │
  │                                                                  │
  │──POST /api/webrtc/ice-test──────────────────────────────────────►
  │◄─{ testId, iceCandidates }──────────────────────────────────────│
  │  (log server candidates)                                         │
  │──DELETE /api/webrtc/ice-test/:testId────────────────────────────►
  │◄─{ ok: true }───────────────────────────────────────────────────│
```

### 9.2 STUN Only (no TURN configured)

```
Phase 1: srflx candidates present, relay = 0, log shows "(no TURN configured)"
Phase 2: normal server transport test
```

### 9.3 Server mediasoup unavailable (Phase 2 failure)

```
Phase 2: POST /api/webrtc/ice-test → HTTP 503
Log:     ✗ Server transport creation failed: WebRTC gateway not available (…)
```

---

## 10. Error Handling & Edge Cases

| Scenario | Handling |
|----------|----------|
| STUN server unreachable | `onicecandidateerror` logged; no srflx candidates; summary shows `✗ STUN unreachable` |
| TURN server unreachable | No relay candidates; summary shows `✗ TURN unreachable` |
| ICE gather timeout (15 s) | Log `ICE gathering timed out after 15 s`; proceed to Phase 2 |
| `createOffer()` throws | Log error; resolve Phase 1; proceed to Phase 2 |
| mediasoup not installed | POST returns 503; Phase 2 logs failure message |
| testId cleanup fails | Swallowed silently (best-effort cleanup via `catch(() => {})`) |
| User aborts before Phase 2 | `iceAbortRef.current = true`; log `Aborted.`; set `iceRunning = false` |
| User closes modal during test | State updates continue in background; no memory leak (no intervals/timeouts outside React state) |
| Concurrent ICE tests | Each browser session gets a unique `testId`; shared `__ice-test__` router supports multiple transports |
| TURN credential in log | TURN `username` and `credential` are passed to `RTCIceServer` but are never echoed in log lines |
