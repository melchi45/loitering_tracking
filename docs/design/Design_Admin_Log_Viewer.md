# Design — Admin Log Viewer

**Product:** LTS-2026 Loitering Detection & Tracking System  
**Feature:** Real-Time Server Log Viewer  
**Version:** 1.3  
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
│               ├── _bufferLog(entry)  →  _recentLogs[2000]       │
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
const _recentLogs = [];  // max LOG_BUFFER_MAX (2000) LogEntry objects — must stay
                          // >= the largest AdminLogPanel.tsx MAX_LINES_OPTIONS value
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
| `maxLines` | `100 \| 200 \| 500 \| 1000 \| 2000` | `500` (from localStorage `lts_admin_log_maxLines`) |

**maxLines 초기화 패턴:**
```typescript
const MAX_LINES_OPTIONS = [100, 200, 500, 1000, 2000] as const;
type MaxLines = typeof MAX_LINES_OPTIONS[number];

const [maxLines, setMaxLines] = useState<MaxLines>(() => {
  const saved = localStorage.getItem('lts_admin_log_maxLines');
  const n = saved ? parseInt(saved, 10) : 500;
  return (MAX_LINES_OPTIONS as readonly number[]).includes(n) ? n as MaxLines : 500;
});

useEffect(() => {
  localStorage.setItem('lts_admin_log_maxLines', String(maxLines));
}, [maxLines]);

// maxLines 감소 시 즉시(동기) 트림 — 네트워크 왕복을 기다리지 않고 체감 반응성 확보
useEffect(() => {
  setLogs(prev => prev.length > maxLines ? prev.slice(-maxLines) : prev);
}, [maxLines]);
```

**2026-07-02 버그 수정 — "표시 lines가 Max Lines와 일치하지 않음" (3개 원인 복합):**

1. **초기 로드 / polling fetch가 `limit=200` 고정값 사용** — `maxLines`가 500/1000/2000이어도 서버에서 최대 200개만 가져온 뒤 클라이언트에서 `.slice(-maxLines)`를 적용했기 때문에, 애초에 fetch가 200개 이상을 절대 가져오지 않아 `maxLines`가 상한으로 작동한 적이 없었음. → `limit=${maxLines}`로 수정 (Data Flow §4.3 참조)
2. **실시간 소켓 핸들러의 stale closure** — `useSocket()`이 반환하는 `socket`은 모듈 레벨 싱글톤이라 `useEffect(..., [socket])`은 컴포넌트 생애주기 동안 단 한 번만 실행됨. 그 안의 `handler`가 마운트 시점의 `maxLines` 값을 영구히 클로저로 캡처해서, 이후 드롭다운으로 `maxLines`를 바꿔도 실시간 스트림은 계속 예전 값으로 자름. Ingest/MediaMTX 폴링의 `setInterval` 클로저도 `[source]`만 의존해 동일한 문제가 있었음. → 두 effect 모두 `maxLines`를 의존성 배열에 포함 (스트림 재구독 없이 핸들러/인터벌만 재생성되므로 부작용 없음)
3. **서버 ring buffer(`LOG_BUFFER_MAX=500`)가 클라이언트 옵션 최댓값(2000)보다 작음** — `Max Lines`를 1000/2000으로 설정해도 서버가 애초에 500개 이상을 보관/응답하지 않아 구조적으로 충족 불가능했음. → `LOG_BUFFER_MAX`를 2000으로, `admin.js`의 `limit` clamp도 2000으로 상향

세 가지가 개별적으로도, 함께도 "표시 lines ≠ Max Lines" 증상을 만들었음. 상세: `docs/srs/SRS_Admin_Log_Viewer.md` FR-LOG-017 §Server ring buffer sizing 참조.

### 4.3 Data Flow

```
On mount / source change / maxLines change:
  GET /admin/logs/recent?source=<source>&limit=<maxLines>
    → setLogs(data.logs.slice(-maxLines))
    → setRuntimeLevel(data.level)
  // Re-running on maxLines change (not just source) is required so that
  // INCREASING Max Lines backfills older buffered history immediately,
  // instead of only growing as new live entries happen to arrive.

source === 'server':
  socket.emit('admin:subscribe-logs')  → receives buffered entries   [effect deps: socket, source]
  socket.on('server:log', handler)     → appends to logs (if !paused) [effect deps: socket, maxLines]
  // `handler` must be re-created whenever maxLines changes — see the
  // stale-closure note above. It is NOT re-created on `source` change
  // (sourceRef is read instead), since `socket` never changes and
  // re-subscribing per source switch is unnecessary churn.

source === 'ingest' | 'mediamtx':
  setInterval(2000) → GET /admin/logs/recent?source=<source>&limit=<maxLines> → setLogs(data.logs.slice(-maxLines))
  // [effect deps: source, maxLines] — interval is restarted on either change.

On unmount:
  socket.off('server:log', handler)
  clearInterval(pollInterval)

filteredLogs derivation (useMemo):
  logs                          ← already trimmed to maxLines by setLogs
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
| Search is client-side only | Searches the currently loaded buffer (up to maxLines); does not search the full log file on disk |
| Server ring buffer must track UI options | `LOG_BUFFER_MAX` (logger.js) and the `/admin/logs/recent` limit clamp (admin.js) must both stay ≥ the largest `MAX_LINES_OPTIONS` value (currently 2000) — if a larger Max Lines option is ever added to the UI without raising these, that option becomes unsatisfiable again (this is exactly what caused the 2026-07-02 defect) |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-29 | 초기 작성 |
| 1.1 | 2026-06-30 | 4.1 고정 레이아웃 구조, 4.3 filteredLogs 파이프라인, 4.4 검색 하이라이트 구현, 7 제한사항 업데이트 |
| 1.2 | 2026-06-30 | 4.2 maxLines 상태 추가 (localStorage 영속·즉시 트림 패턴), 4.3 filteredLogs 주석 추가, 7 Max Lines 제한사항 추가 |
| 1.3 | 2026-07-02 | "표시 lines ≠ Max Lines" 버그 수정 반영: 2. Architecture/3.1 ring buffer 500→2000, 4.2 원인 3가지 기록, 4.3 Data Flow를 fetch limit=maxLines + effect 의존성(maxLines 포함)으로 수정, 7 제한사항 갱신 |
