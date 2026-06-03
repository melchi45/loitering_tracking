# DESIGN DOCUMENT
# WebRTC Connection — STUN / TURN / ICE

| | |
|---|---|
| **Document ID** | DESIGN-LTS-ICE-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-27 |
| **Parent SRS** | srs/SRS_STUN_TURN_ICE.md |

---

## Table of Contents
1. [Architecture Overview](#1-architecture-overview)
2. [File Structure](#2-file-structure)
3. [Server-Side Design — ICE Config Endpoint](#3-server-side-design--ice-config-endpoint)
4. [Client-Side Design — ICE Injection](#4-client-side-design--ice-injection)
5. [ice-test Tool Design](#5-ice-test-tool-design)
6. [Socket.IO Trigger Protocol](#6-socketio-trigger-protocol)
7. [Configuration & Environment](#7-configuration--environment)
8. [Sequence Diagrams](#8-sequence-diagrams)
9. [Error Handling & Diagnostics](#9-error-handling--diagnostics)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     STUN/TURN/ICE System                         │
│                                                                   │
│  Environment Variables (.env)                                    │
│   STUN_URLS=stun:stun.l.google.com:19302,stun:stun.company.lan  │
│   TURN_URL=turn:turn.company.lan:3478                           │
│   TURN_USERNAME=lts                                              │
│   TURN_CREDENTIAL=secret                                         │
│   SERVER_IP=192.168.1.100                                        │
└─────────────────────────────────────┬───────────────────────────┘
                                      │
┌─────────────────────────────────────▼───────────────────────────┐
│                 SERVER (Node.js, port 3080)                      │
│                                                                   │
│  GET /api/webrtc/ice-config                                      │
│   └─ parseIceConfig(env) → { stunUrls, turns }                  │
│                                                                   │
│  Socket.IO Handlers (webrtcSignaling.js)                         │
│   ├─ webrtc:ice-test-start → emit webrtc:ice-test-trigger        │
│   └─ webrtc:ice-test-done  → emit webrtc:ice-test-stop          │
│                                                                   │
│  mediasoup WebRtcTransport                                        │
│   └─ getAllListenIps() → auto-detect LAN IPs + SERVER_IP         │
└─────────────────────────────────────┬───────────────────────────┘
                                      │ HTTP + Socket.IO
                                      │
┌─────────────────────────────────────▼───────────────────────────┐
│                    BROWSER (mediasoup-client)                     │
│                                                                   │
│  useWebRTCConfigStore                                            │
│   ├─ fetchIceServers() → GET /api/webrtc/ice-config              │
│   └─ iceServers: RTCIceServer[]                                  │
│                                                                   │
│  useWebRTC hook                                                   │
│   ├─ getIceServers() from store                                  │
│   └─ device.createRecvTransport({ ...params, iceServers })       │
│                                                                   │
│  IceTestTrigger component                                         │
│   ├─ activated by webrtc:ice-test-trigger event                  │
│   └─ creates loopback RTCPeerConnection + reports candidates     │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│          npm run ice-test  (server/src/scripts/iceTest.js)       │
│                                                                   │
│  Phase 1 — Server Pre-check                                      │
│   ├─ GET /api/cameras (health check)                             │
│   ├─ GET /api/webrtc/ice-config (print STUN/TURN count)          │
│   ├─ STUN UDP ping (LAN servers only)                            │
│   └─ PUT /api/cameras/:id (auto-enable WebRTC)                  │
│                                                                   │
│  Phase 2 — Browser Automation (Playwright)                       │
│   ├─ addInitScript: RTCPeerConnection interceptor                │
│   ├─ Loopback RTCPeerConnection (two PCs, local SDP exchange)   │
│   └─ Socket.IO trigger path (optional)                           │
│       webrtc:ice-test-start → webrtc:ice-test-trigger            │
│                                                                   │
│  Phase 3 — ICE Candidate Report                                  │
│   ├─ getStats() × 5 at 2s intervals                              │
│   ├─ Path classification: host / srflx / relay                  │
│   └─ ASCII bar chart + throughput report                         │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. File Structure

```
server/src/
├── api/
│   └── webrtcIce.js              # GET /api/webrtc/ice-config route
├── webrtcSignaling.js            # Socket.IO event handlers incl. ice-test
├── webrtcGateway.js              # mediasoup Worker + getAllListenIps()
└── scripts/
    └── iceTest.js                # 3-phase ice-test CLI tool

client/src/
├── stores/
│   └── webrtcConfigStore.ts     # Zustand store: fetchIceServers, iceServers[]
├── hooks/
│   └── useWebRTC.ts             # ICE server injection into RecvTransport
└── components/
    └── IceTestTrigger.tsx       # Browser-side loopback RTCPeerConnection test
```

---

## 3. Server-Side Design — ICE Config Endpoint

### 3.1 parseIceConfig(env)

```javascript
// server/src/api/webrtcIce.js

function parseIceConfig(env = process.env) {
  // STUN: comma-separated list
  const stunUrls = (env.STUN_URLS || 'stun:stun.l.google.com:19302')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

  // TURN: iterate TURN_URL, TURN_URL_2, TURN_URL_3, ...
  const turns = []
  const suffixes = ['', '_2', '_3', '_4', '_5']
  for (const suffix of suffixes) {
    const url = env[`TURN_URL${suffix}`]
    if (!url) break
    turns.push({
      url,
      username: env[`TURN_USERNAME${suffix}`] || '',
      credential: env[`TURN_CREDENTIAL${suffix}`] || '',
    })
  }

  return { stunUrls, turns }
}

// Route
router.get('/api/webrtc/ice-config', (req, res) => {
  res.json(parseIceConfig())
})
```

### 3.2 getAllListenIps() — mediasoup Transport IPs

```javascript
// server/src/webrtcGateway.js

function getAllListenIps() {
  if (process.env.SERVER_IP) {
    return [
      { ip: '0.0.0.0', announcedIp: process.env.SERVER_IP },
      // TCP fallback
    ]
  }

  // Auto-detect: skip docker bridges, veth interfaces, loopback
  const interfaces = os.networkInterfaces()
  const listenIps = []
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (/^(docker|veth|lo)/.test(name)) continue
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        listenIps.push({ ip: '0.0.0.0', announcedIp: addr.address })
      }
    }
  }
  return listenIps.length ? listenIps : [{ ip: '0.0.0.0' }]
}
```

---

## 4. Client-Side Design — ICE Injection

### 4.1 webrtcConfigStore (Zustand)

```typescript
// client/src/stores/webrtcConfigStore.ts

interface WebRTCConfigStore {
  iceServers: RTCIceServer[]
  stunUrls: string[]
  turns: Array<{ url: string; username: string; credential: string }>
  fetchIceServers: () => Promise<void>
  getIceServers: () => RTCIceServer[]
}

const useWebRTCConfigStore = create<WebRTCConfigStore>((set, get) => ({
  iceServers: [],
  stunUrls: [],
  turns: [],

  async fetchIceServers() {
    const data = await fetch('/api/webrtc/ice-config').then(r => r.json())
    const iceServers: RTCIceServer[] = [
      ...data.stunUrls.map((urls: string) => ({ urls })),
      ...data.turns.map((t: any) => ({
        urls: t.url,
        username: t.username,
        credential: t.credential,
      })),
    ]
    set({ iceServers, stunUrls: data.stunUrls, turns: data.turns })
  },

  getIceServers() {
    return get().iceServers
  },
}))
```

### 4.2 useWebRTC Hook — ICE Injection

```typescript
// client/src/hooks/useWebRTC.ts (relevant section)

async function connectToCamera(cameraId: string) {
  const iceServers = useWebRTCConfigStore.getState().getIceServers()

  // ... get capabilities and createTransport params from server

  const transport = device.createRecvTransport({
    ...transportParams,
    ...(iceServers.length ? { iceServers } : {}),
  })

  // ... create consumers and resume
}
```

### 4.3 IceTestTrigger Component

```tsx
// client/src/components/IceTestTrigger.tsx
// Activated by webrtc:ice-test-trigger Socket.IO event

export function IceTestTrigger({ active }: { active: boolean }) {
  useEffect(() => {
    if (!active) return
    // Create two RTCPeerConnection instances for loopback test
    const pc1 = new RTCPeerConnection()
    const pc2 = new RTCPeerConnection()
    // Exchange SDP locally and report candidate types
    // ...
  }, [active])

  return null  // headless component
}
```

---

## 5. ice-test Tool Design

### 5.1 CLI Entry Point

```
server/src/scripts/iceTest.js
```

**Usage:**
```bash
npm run ice-test              # headed Playwright
npm run ice-test:headless     # headless (CI)
```

### 5.2 Phase 1 — Server Pre-check

```javascript
async function phase1() {
  // 1. HTTP health check
  const cameras = await fetch(`${BASE_URL}/api/cameras`).then(r => r.json())
  console.log(`✓ Server reachable (${cameras.length} cameras)`)

  // 2. Print ICE config
  const ice = await fetch(`${BASE_URL}/api/webrtc/ice-config`).then(r => r.json())
  console.log(`  STUN: ${ice.stunUrls.length} URL(s)`)
  console.log(`  TURN: ${ice.turns.length} server(s)`)

  // 3. STUN UDP ping (LAN servers only)
  for (const url of ice.stunUrls) {
    if (isPublicStun(url)) { console.log(`  Skipping public STUN: ${url}`); continue }
    await stunUdpPing(url)  // RFC 5389 Binding Request
  }

  // 4. Auto-enable WebRTC on first camera if needed
  if (cameras.length > 0 && !cameras[0].webrtcEnabled) {
    await fetch(`${BASE_URL}/api/cameras/${cameras[0].id}`, {
      method: 'PUT',
      body: JSON.stringify({ webrtcEnabled: true }),
    })
    console.log(`  Auto-enabled WebRTC on camera ${cameras[0].id}`)
  }
}
```

### 5.3 Phase 2 — Playwright Browser Automation

```javascript
async function phase2(browser) {
  const page = await browser.newPage()

  // Inject RTCPeerConnection interceptor
  await page.addInitScript(() => {
    const OrigPC = window.RTCPeerConnection
    window.RTCPeerConnection = function(...args) {
      const pc = new OrigPC(...args)
      window.__icePCs = window.__icePCs || []
      window.__icePCs.push(pc)
      return pc
    }
  })

  await page.goto(BASE_URL)

  // Loopback test: two PCs exchange SDP in page context
  const result = await page.evaluate(async () => {
    const pc1 = new RTCPeerConnection({ iceServers: window.__iceServers })
    const pc2 = new RTCPeerConnection({ iceServers: window.__iceServers })
    // ... local SDP exchange
    return await waitForConnected(pc1, pc2)  // max 30s
  })

  // Adaptive wait strategy
  // Phase A: wait RTCPeerConnection created (max 3s)
  // Phase B: wait connectionState=connected (max 30s, early exit on 'failed')
}
```

### 5.4 Phase 3 — ICE Candidate Report

```javascript
async function phase3(page) {
  const stats = []
  for (let i = 0; i < 5; i++) {
    await sleep(2000)
    stats.push(await page.evaluate(() => {
      const pc = window.__icePCs[0]
      return pc.getStats()
    }))
  }

  // Classify connection path
  // host     → direct LAN connection (no NAT traversal)
  // srflx    → STUN NAT traversal (public IP)
  // relay    → TURN relay (restrictive NAT)

  // ASCII bar chart
  const kbps = calculateThroughput(stats)
  console.log(`Throughput: ${renderBar(kbps)} ${kbps} kbps`)
}
```

### 5.5 STUN UDP Ping (RFC 5389)

```javascript
async function stunUdpPing(stunUrl, timeoutMs = 3000) {
  const { host, port } = parseStunUrl(stunUrl)
  const buf = Buffer.alloc(20)
  buf.writeUInt16BE(0x0001, 0)   // Binding Request
  buf.writeUInt16BE(0x0000, 2)   // Length
  buf.writeUInt32BE(0x2112A442, 4) // Magic Cookie
  crypto.randomFillSync(buf, 8, 12) // Transaction ID
  // ... UDP send + response wait
}
```

---

## 6. Socket.IO Trigger Protocol

### 6.1 Server Handlers

```javascript
// webrtcSignaling.js
socket.on('webrtc:ice-test-start', () => {
  // Broadcast to all browser clients to run IceTestTrigger
  io.emit('webrtc:ice-test-trigger')
})

socket.on('webrtc:ice-test-done', () => {
  // Signal IceTestTrigger to clean up
  io.emit('webrtc:ice-test-stop')
})
```

### 6.2 Client Handling (App.tsx)

```typescript
// client/src/App.tsx
socket.on('webrtc:ice-test-trigger', () => setIceTestActive(true))
socket.on('webrtc:ice-test-stop',    () => setIceTestActive(false))

// Render
<IceTestTrigger active={iceTestActive} />
```

### 6.3 ice-test Script Socket.IO Path

```javascript
// iceTest.js — optional Socket.IO trigger path
const ws = new WebSocket(`${BASE_URL}/socket.io/?EIO=4&transport=websocket`)
ws.on('open', () => {
  ws.send('42["webrtc:ice-test-start"]')
})
ws.on('message', (data) => {
  if (data.includes('webrtc:ice-test-trigger')) {
    // Browser is running the test; wait for results
  }
})
```

---

## 7. Configuration & Environment

| Variable | Default | Description |
|---|---|---|
| `STUN_URLS` | `stun:stun.l.google.com:19302` | Comma-separated STUN URLs |
| `TURN_URL` | (none) | Primary TURN server URL |
| `TURN_USERNAME` | (none) | TURN auth username |
| `TURN_CREDENTIAL` | (none) | TURN auth credential |
| `TURN_URL_2` | (none) | Secondary TURN server URL |
| `TURN_USERNAME_2` | (none) | Secondary TURN username |
| `TURN_CREDENTIAL_2` | (none) | Secondary TURN credential |
| `SERVER_IP` | auto-detect | Server's LAN IP for mediasoup `announcedIp` |
| `RTC_MIN_PORT` | `40000` | mediasoup WebRTC port range start |
| `RTC_MAX_PORT` | `49999` | mediasoup WebRTC port range end |

---

## 8. Sequence Diagrams

### 8.1 Browser ICE Negotiation

```
Browser                   Server                STUN/TURN
   │                         │                      │
   │── GET /api/webrtc/ice-config ──────────────────│
   │◄─ { stunUrls, turns } ──│                      │
   │                         │                      │
   │── webrtc:createTransport ──────────────────────│
   │◄─ { iceParameters, iceCandidates, dtls } ──────│
   │                         │                      │
   │── ICE Gathering ─────────────────────────────>│
   │   (host + srflx via STUN + relay via TURN)      │
   │                         │                      │
   │── webrtc:connectTransport (dtls) ──────────────│
   │◄─ DTLS-SRTP established ──────────────────────│
   │◄─ RTP/RTCP flowing ─────│                      │
```

### 8.2 ice-test Phase Sequence

```
iceTest.js            Server               Playwright           Browser
    │                    │                      │                   │
    │── Phase 1 ─────────│                      │                   │
    │   GET /cameras      │                      │                   │
    │   GET /ice-config   │                      │                   │
    │   STUN UDP ping ────────────────────────────────────────────> STUN
    │                    │                      │                   │
    │── Phase 2 ──────────────────────────────> │                   │
    │                    │               launch browser page        │
    │                    │                      │── addInitScript──>│
    │                    │                      │── page.goto() ───>│
    │                    │                      │                   │
    │── webrtc:ice-test-start ──────────────────────────────────>  │
    │                    │◄── io.emit trigger ──────────────────── │
    │                    │                      │                   │
    │── Phase 3 ──────────────────────────────> │                   │
    │                    │               getStats() × 5            │
    │                    │               ASCII bar chart            │
```

---

## 9. Error Handling & Diagnostics

### 9.1 Known Failure Diagnostics (ice-test)

| Symptom | Diagnosis | Suggested Fix |
|---|---|---|
| Phase 1 fails immediately | Server not running | `npm run dev` in server/ |
| STUN ping timeout | STUN server unreachable on LAN | Check firewall UDP port |
| `connectionState: 'failed'` | No viable ICE path | Configure TURN server |
| Phase 3: relay candidates | Behind restrictive NAT | TURN working, but latency may be higher |
| Phase 3: only host candidates | Direct LAN path, optimal | No action needed |

### 9.2 TURN Credential Security

- TURN credentials are served only via `GET /api/webrtc/ice-config` (server-side env vars).
- Credentials must **never** appear in:
  - Client-side TypeScript/JavaScript source files
  - Browser-accessible static assets
  - HTML or inline scripts

### 9.3 CI Integration

```bash
# Exit 0 on success, non-zero on failure
npm run ice-test:headless
echo "Exit code: $?"
```

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Technical design for STUN TURN ICE |
