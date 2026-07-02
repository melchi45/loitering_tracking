# Operations Guide — Admin Log Viewer

**Product:** LTS-2026 Loitering Detection & Tracking System  
**Feature:** Real-Time Server Log Viewer  
**Version:** 1.3  
**Date:** 2026-06-29

---

## 1. Overview

The Admin Log Viewer is a real-time browser-based log panel in the Administrator Dashboard. This guide covers how to use it, how the log relay works, and how to configure logging.

---

## 2. Accessing the Log Viewer

1. Log in with an **admin** account
2. Click your profile icon → **Admin Dashboard**
3. In the left sidebar, click **🖥️ Server Logs**

---

## 3. Log Sources

| Tab | What it shows | Update method |
|---|---|---|
| **Server** | Node.js server logs (all modules) | Real-time via Socket.IO |
| **Ingest Daemon** | Python ingest-daemon (`[Ingest]` tagged lines) | Polls log file every 2 s |
| **MediaMTX** | MediaMTX proxy (`[MediaMTX]` tagged lines) | Polls log file every 2 s |

> **Note:** The Ingest Daemon tab is hidden when the server is running in `analysis` mode.

---

## 4. Changing the Server Log Level

The **Server Log Level** dropdown controls the minimum severity relayed to the browser **in real time, without restarting the server**.

| Setting | What you see |
|---|---|
| `DEBUG` | All log lines including verbose debug output |
| `INFO` | Informational messages and above (default) |
| `WARNING` | Warnings and errors only |
| `ERROR` | Errors and critical messages only |
| `NONE` | No log relay (disables the stream) |

> **This only affects the Socket.IO relay.** File logging is controlled by the `LOG_LEVEL` environment variable in `server/.env` and requires a server restart to change.

Every level change is recorded in the audit log.

---

## 5. Display Filters

The **Show Levels** buttons filter what is displayed in the browser — they do **not** change the server-side emission level.

Clicking a level badge toggles its visibility. At least one level must remain visible.

---

## 6. Connection Status

The green/gray dot in the top-right of the log panel indicates Socket.IO connection status:

- **Green** — connected; real-time updates active
- **Gray** — disconnected; attempting to reconnect

On reconnect, the client requests the buffered entries (up to 2000) via `admin:subscribe-logs`.

---

## 7. Max Lines Setting

The **Max Lines** dropdown in the toolbar controls how many log entries the browser keeps in memory.

| Option | When to use |
|---|---|
| 100 | Low-memory devices or when only the most recent entries matter |
| 200 | Light monitoring |
| **500** | **Default** — suitable for most workstations |
| 1000 | Deep debugging — keeps a longer history visible |
| 2000 | High-traffic troubleshooting — use with Pause to read without scroll |

- The selected value is **saved in your browser** (`localStorage`) and restored on your next visit
- Changing to a smaller value **immediately trims** the display to the newest N lines
- Changing to a larger value **immediately re-fetches** from the server to backfill older entries — you don't have to wait for new log activity to "grow into" the new setting
- The server's own ring buffer holds up to 2000 entries, matching the largest Max Lines option, so every option in the dropdown is fully satisfiable

> **Fixed 2026-07-02:** previously the displayed line count could silently fall short of the configured Max Lines — the initial/poll fetch always requested a fixed 200 entries regardless of this setting, the real-time stream kept using whatever Max Lines was set when the page first loaded (changes via the dropdown had no effect on already-open live streams), and the server buffer topped out at 500 even though the dropdown offered 1000/2000. All three are fixed; see `docs/design/Design_Admin_Log_Viewer.md` §4.2 for details.

---

## 8. Pause / Resume

Click **⏸ Pause** to freeze the display without disconnecting. New logs accumulate server-side. Click **▶ Resume** to resume — you will not receive the logs that arrived while paused (they will appear in `GET /admin/logs/recent` on next source switch).

---

## 9. Log File Configuration

Server-side log file settings in `server/.env`:

```env
LOG_TO_FILE=true          # Enable file writing (default: true)
LOG_DIR=/var/log/lts      # Primary log directory
LOG_LEVEL=INFO            # Minimum file log level (restart required to change)
LOG_FILTER_PATTERNS=      # Comma-separated regex patterns to suppress
```

Log file path: `/var/log/lts/lts-YYYY-MM-DD.log`  
Fallback path: `server/logs/lts-YYYY-MM-DD.log`

---

## 10. Searching Logs

A search bar is displayed between the toolbar and the stats row at all times.

### How to search

1. Click inside the search bar (or just start typing after clicking on the log panel)
2. Type a keyword — the log list filters in real-time as you type
3. Matching text is highlighted in yellow in each visible row
4. The match count shown in the search bar updates as you type
5. Click **✕** inside the search bar, or clear the field, to remove the filter

### Search behaviour

| Behaviour | Detail |
|---|---|
| Case sensitivity | Case-insensitive |
| Search scope | `msg` field and timestamp string |
| Scope | Current in-browser buffer only (up to configured Max Lines) — does not search log files on disk |
| Download | Respects active search — exports only matched lines |
| Stats row | Shows `🔍 filtered` tag while a query is active |

> **Tip:** To find a specific camera disconnect event, type part of the camera ID or `disconnected`. To find all errors within a time window, first set Show Levels to ERROR only, then search for the time prefix (e.g., `14:30`).

---

## 11. Troubleshooting

### Log viewer shows no entries

1. Check connection indicator — if gray, Socket.IO is not connected
2. Check server is running: `GET /health`
3. Confirm you are logged in as admin
4. Try switching source to Ingest/MediaMTX — if those show entries, the server logs may be below the current level

### Ingest Daemon logs are empty

1. Verify ingest-daemon is running: `curl http://localhost:7070/health`
2. Confirm `LOG_TO_FILE=true` in `server/.env`
3. Check log file exists: `ls /var/log/lts/lts-$(date +%Y-%m-%d).log`
4. If log file exists but no `[Ingest]` lines, ingest-daemon may not be generating output

### Log level change not persisting after server restart

Expected — the runtime level change via `PATCH /admin/logs/level` is in-memory only. To make it permanent, set `LOG_LEVEL=DEBUG` in `server/.env`.

---

## 12. API Reference

| Endpoint | Description |
|---|---|
| `GET /admin/logs/recent?source=server&limit=200` | Recent server logs from in-memory buffer (`limit` accepts 1–2000) |
| `GET /admin/logs/recent?source=ingest&limit=200` | Recent ingest-daemon logs from log file (`limit` accepts 1–2000) |
| `GET /admin/logs/recent?source=mediamtx&limit=200` | Recent MediaMTX logs from log file (`limit` accepts 1–2000) |
| `PATCH /admin/logs/level { level: 'INFO' }` | Change runtime relay log level |

All endpoints require JWT + `admin` role.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-29 | 초기 작성 |
| 1.1 | 2026-06-30 | §9 로그 검색 사용 가이드 추가, §10 번호 조정 |
| 1.2 | 2026-06-30 | §7 Max Lines 설정 가이드 추가, 섹션 번호 재조정 (§8~§12) |
| 1.3 | 2026-07-02 | §6/§7/§12 버그 수정 반영 — ring buffer 500→2000, Max Lines 증가 시 즉시 backfill 동작 설명 추가 |
