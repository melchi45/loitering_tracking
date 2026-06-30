# Design — Admin Log Viewer

**Product:** LTS-2026 Loitering Detection & Tracking System  
**Feature:** Real-Time Server Log Viewer  
**Version:** 1.1  
**Date:** 2026-06-29

---

## 1. Overview

The Admin Log Viewer streams Node.js server logs directly to the Administrator Dashboard via Socket.IO, and reads Ingest Daemon / MediaMTX logs from the daily log file via HTTP polling. It provides runtime log-level control and display-level filtering without server restarts.

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Node.js Server (index.js)                    │
│                                                                 │
│  console.log/info/warn/error/debug                              │
│       │                                                         │
│       ▼                                                         │
│  installSocketRelay(io)  ◄── called once on server start        │
│       │                                                         │
│       ├── original console method (stdout → startServer relay)  │
│       └── _relay(level, args)                                   │
│               │                                                 │
│               ├── _bufferLog(entry)  →  _recentLogs[500]        │
│               └── io.emit('server:log', entry)                  │
│                                                                 │
│  GET /admin/logs/recent?source=server   →  getRecentLogs()      │
│  GET /admin/logs/recent?source=ingest   →  tailLogFile([Ingest])│
│  GET /admin/logs/recent?source=mediamtx →  tailLogFile([MediaMTX])
│  PATCH /admin/logs/level { level }      →  setLogLevel()        │
└─────────────────────────────────────────────────────────────────┘
                            │ Socket.IO  │ HTTP
                            ▼            ▼
┌─────────────────────────────────────────────────────────────────┐
│                      AdminLogPanel.tsx                          │
│                                                                 │
│  Source: [Server] [Ingest Daemon] [MediaMTX]                    │
│  Level : [DEBUG▾]     Show: [ERROR][WARNING][INFO][DEBUG]       │
│  ──────────────────────────────────────────────────────────     │
│  [26-06-29 14:30:00.123] [ERROR]  Camera disconnected           │
│  [26-06-29 14:30:01.456] [WARNING] ONVIF parse timeout          │
│  …                                                              │
│  ──────────────────────────────────────────────────────────     │
│  145 / 200 lines · ERROR:2 WARNING:5                            │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Backend Design

### 3.1 logger.js — New Exports

```javascript
// Ring buffer
const _recentLogs = [];  // max 500 LogEntry objects
let _runtimeMinLevel = MIN_LEVEL;  // mutable runtime threshold

function installSocketRelay(io) {
  // Wraps current console.log/info/warn/error/debug
  // Each call → _relay(level, args)
  //   → check _runtimeMinLevel
  //   → _bufferLog(entry)
  //   → io.emit('server:log', entry)
  // Also: io.on('connection') → socket.on('admin:subscribe-logs') → flush buffer
}

function setLogLevel(level)   { /* updates _runtimeMinLevel */ }
function getLogLevel()        { /* returns level string     */ }
function getRecentLogs()      { /* returns [..._recentLogs] */ }
function tailLogFile(opts)    { /* reads /var/log/lts/lts-YYYY-MM-DD.log */ }
```

### 3.2 admin.js — New Endpoints

```javascript
// GET /admin/logs/recent
// source=server  → getRecentLogs().slice(-limit)
// source=ingest  → tailLogFile({ prefix: '[Ingest]', limit })
// source=mediamtx → tailLogFile({ prefix: '[MediaMTX]', limit })
// Response: { logs, level, total }

// PATCH /admin/logs/level
// Body: { level: string }
// → setLogLevel(level)
// → AuditService.log({ event: 'log_level_changed', ... })
// Response: { ok: true, level }
```

### 3.3 index.js — Relay Wiring

```javascript
// After `const io = new SocketIOServer(httpServer, ...)`
try {
  const { installSocketRelay } = require('./utils/logger');
  installSocketRelay(io);
} catch (_) { /* safe guard */ }
```

### 3.4 Production Mode Behaviour

In production, `startServer.js` spawns `index.js` as a child process:

- `patchConsole()` runs in `startServer.js` process (file logging)
- `installSocketRelay(io)` runs in `index.js` process (Socket.IO relay)
- They are independent — file logging is controlled by `MIN_LEVEL` env var; socket relay is controlled by `_runtimeMinLevel` (runtime adjustable)
- Ingest Daemon logs flow via `startServer.js`'s `makeLineRelay('[Ingest]', ...)` → log file → `tailLogFile()` in `index.js`

---

## 4. Frontend Design

### 4.1 Component Structure

```
AdminUsersPage.tsx
└── section === 'logs'
    └── AdminLogPanel.tsx  (root: flex flex-col h-full overflow-hidden)
        ├── Fixed control area (flex-shrink-0, never scrolls)
        │   ├── Header + connection indicator
        │   ├── Error bar (conditional)
        │   ├── Toolbar
        │   │   ├── Source selector (buttons)
        │   │   ├── Runtime level selector (select)
        │   │   ├── View level filters (toggle buttons)
        │   │   └── Action buttons (auto-scroll, pause, download, clear)
        │   ├── Search bar (input + match count + clear button)
        │   └── Stats row
        └── Log area (flex-1 min-h-0 overflow-y-auto) ← ONLY this scrolls
            └── LogRow (React.memo, highlight prop) × N
```

**Key layout rule:** the root div uses `overflow-hidden` + `flex flex-col h-full`. The fixed control area uses `flex-shrink-0`. Only the log area div has `overflow-y-auto`. Auto-scroll uses `logAreaRef.current.scrollTop = logAreaRef.current.scrollHeight` (NOT `scrollIntoView`) to prevent document-level scrolling.

### 4.2 State Management

All state is local to `AdminLogPanel.tsx` — no Zustand store needed.

| State | Type | Default |
|---|---|---|
| `source` | `'server' \| 'ingest' \| 'mediamtx'` | `'server'` |
| `logs` | `LogEntry[]` | `[]` |
| `visibleLevels` | `Set<LogLevel>` | all four |
| `runtimeLevel` | `string` | `'INFO'` (from server) |
| `autoScroll` | `boolean` | `true` |
| `paused` | `boolean` | `false` |
| `loading` | `boolean` | `false` |
| `searchQuery` | `string` | `''` |

### 4.3 Data Flow

```
On mount / source change:
  GET /admin/logs/recent?source=<source>&limit=200
    → setLogs(data.logs)
    → setRuntimeLevel(data.level)

source === 'server':
  socket.emit('admin:subscribe-logs')  → receives buffered entries
  socket.on('server:log', handler)     → appends to logs (if !paused)

source === 'ingest' | 'mediamtx':
  setInterval(2000) → GET /admin/logs/recent?source=<source> → setLogs(data.logs)

On unmount:
  socket.off('server:log', handler)
  clearInterval(pollInterval)

filteredLogs derivation (useMemo):
  logs
    .filter(l => visibleLevels.has(l.level))
    .filter(l => !searchQuery || l.msg.toLowerCase().includes(lowerQuery)
                               || l.ts.includes(searchQuery))
```

### 4.4 Search Highlight Implementation

`highlightText(text, query)` is a recursive function that returns `React.ReactNode`:

```typescript
function highlightText(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query);
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-yellow-400/30 text-yellow-200 rounded-sm">
        {text.slice(idx, idx + query.length)}
      </mark>
      {highlightText(text.slice(idx + query.length), query)}
    </>
  );
}
```

`LogRow` receives a `highlight: string` prop (the lowercased query). When non-empty, `msg` is rendered through `highlightText()` instead of as a plain string.

### 4.5 Level Color Scheme

| Level | Row background | Badge |
|---|---|---|
| CRITICAL | `bg-red-950/60 text-red-200` | `bg-red-700 text-red-100` |
| ERROR | `bg-red-900/30 text-red-300` | `bg-red-800/80 text-red-200` |
| WARNING | `bg-yellow-900/20 text-yellow-300` | `bg-yellow-800/80 text-yellow-200` |
| INFO | `text-blue-300` (no bg) | `bg-blue-800/60 text-blue-200` |
| DEBUG | `text-gray-400` (no bg) | `bg-gray-700/60 text-gray-300` |

### 4.6 Admin Page Integration

```typescript
// AdminUsersPage.tsx
type AdminSection = 'users' | 'ai-models' | 'onvif' | 'audit' | 'system' | 'logs';

const NAV = [
  ...
  { id: 'logs', label: 'Server Logs', icon: '🖥️', desc: 'Real-time log viewer' },
];

// In <main>:
<main className={`flex-1 bg-gray-950 ${
  section === 'logs' ? 'overflow-hidden flex flex-col' : 'overflow-y-auto'
}`}>
  {section === 'logs' && <AdminLogPanel apiFetch={apiFetch} serverMode={serverMode} />}
```

The `overflow-hidden flex flex-col` on `<main>` when on the logs section allows `AdminLogPanel`'s inner `flex-1 min-h-0` log area to fill the available height.

---

## 5. Socket.IO Events

### server:log (Server → Client)

```typescript
{ ts: string; level: string; msg: string; t: number; }
```

Emitted by `io.emit('server:log', entry)` — broadcast to all connected sockets.

### admin:subscribe-logs (Client → Server)

No payload. Triggers flush of `_recentLogs` ring buffer to the requesting socket.

---

## 6. Security

- Both REST endpoints guarded by `verifyAccessToken` + `requireRole('admin')` middleware
- `PATCH /admin/logs/level` change is audit-logged (actor + new level)
- `server:log` socket event is broadcast to all sockets; the admin gate is at the HTTP/WS authentication layer — only authenticated admin users can view the admin page

---

## 7. Limitations

| Limitation | Rationale |
|---|---|
| Ingest Daemon logs not real-time (2 s poll) | Ingest runs in a different process; log file is the shared channel |
| Socket relay only covers `index.js`-process logs | startServer.js child-process relay re-logs these; they appear in both server socket and log file |
| Ring buffer reset on server restart | In-memory only; logs before restart accessed via log file API |
| Search is client-side only | Searches the currently loaded 500-line buffer; does not search the full log file on disk |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-29 | 초기 작성 |
| 1.1 | 2026-06-30 | 4.1 고정 레이아웃 구조, 4.3 filteredLogs 파이프라인, 4.4 검색 하이라이트 구현, 7 제한사항 업데이트 |
