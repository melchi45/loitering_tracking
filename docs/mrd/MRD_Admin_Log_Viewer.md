# MRD — Admin Log Viewer

**Product:** LTS-2026 Loitering Detection & Tracking System  
**Feature:** Real-Time Server Log Viewer in Administrator Dashboard  
**Version:** 1.3  
**Date:** 2026-06-29  
**Author:** LTS Engineering Team

---

## 1. Executive Summary

Operations and development teams currently have no in-browser way to inspect live server logs while the LTS-2026 system is running. Diagnosing issues requires SSH access and manual log tailing. A real-time Log Viewer built into the Administrator Dashboard removes this barrier, accelerating incident response and reducing mean-time-to-repair (MTTR).

---

## 2. Market / Operational Need

| Pain Point | Impact |
|---|---|
| SSH required to read live logs | Delays non-technical admins; needs extra credentials |
| No log filtering in terminal | Finding relevant entries in high-traffic logs is slow |
| Ingest Daemon and MediaMTX logs are separate | Hard to correlate multi-process issues |
| Cannot change log verbosity without restart | Debugging requires service disruption |

---

## 3. Target Users

| User | Context |
|---|---|
| System Administrator | Monitors server health in production without CLI access |
| DevOps / SRE | Correlates multi-service events during incident investigation |
| Field Engineer | Verifies camera capture and AI pipeline status on-site |
| Developer (QA) | Watches log output while testing new features |

---

## 4. Business Requirements

| ID | Requirement |
|---|---|
| BR-01 | Admins must be able to view live server logs from a web browser without SSH access |
| BR-02 | Logs must be filterable by severity level (ERROR / WARNING / INFO / DEBUG) |
| BR-03 | The log level must be adjustable at runtime without restarting the server |
| BR-04 | Ingest Daemon logs must be viewable separately from main server logs |
| BR-05 | Log content must be downloadable as a text file for offline analysis |
| BR-06 | The viewer must update in real time (< 1 s latency for server logs) |
| BR-07 | Log access must be restricted to users with `admin` role |
| BR-08 | The toolbar and controls must remain visible at all times — only the log area scrolls |
| BR-09 | Admins must be able to search log messages by keyword within the current view |
| BR-10 | Admins must be able to configure the maximum number of log lines kept in the display buffer, and the number of lines actually shown must reliably reach that configured maximum (see 2026-07-02 defect note below) |

---

## 5. Success Metrics

- MTTR for log-related incidents reduced by ≥ 30%
- Admin log page load time < 2 s
- Socket.IO log relay latency < 500 ms (p95)
- Zero non-admin users able to access log endpoints (security audit)

---

## 6. Known Issues — Resolved

| Date | Issue | Resolution |
|---|---|---|
| 2026-07-02 | Displayed log line count did not match the admin-configured Max Lines value (BR-10) — three compounding causes: fetch calls used a hardcoded 200-line request regardless of the setting, the real-time stream kept using a stale copy of the setting captured at page load, and the server's in-memory buffer topped out at 500 even though the UI offered up to 2000. | All three fixed together — fetch requests now use the current setting, live-stream/poll handlers re-read the current setting on every change, and the server buffer was raised to 2000 to match the largest UI option. See `docs/design/Design_Admin_Log_Viewer.md` §4.2 for the technical write-up. |

---

## 7. Out of Scope

- Historical log file browser (multi-day search)
- Log aggregation from remote analysis servers
- Alerting / notification rules based on log patterns
- Log retention policy management

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-29 | 초기 작성 |
| 1.1 | 2026-06-30 | BR-08 툴바 고정, BR-09 텍스트 검색 요구사항 추가 |
| 1.2 | 2026-06-30 | BR-10 Max Lines 설정 추가 |
| 1.3 | 2026-07-02 | BR-10 문구 보강, §6 Known Issues — Resolved 섹션 신설 (표시 lines ≠ Max Lines 결함 및 해결 기록), §7로 Out of Scope 재번호 |
