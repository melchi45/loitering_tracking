# RFP — HTTPS / TLS Server Encryption

**Document ID:** RFP-LTS2026-HTTPS-001  
**Issue Date:** 2026-05-27  
**Module:** HTTPS / TLS Server Encryption  
**Status:** Released

---

## 1. Background

LTS-2026 currently serves all REST API, Socket.IO, and WebRTC signalling traffic over plain HTTP (port 3001). In production and enterprise deployments this poses several risks:

- REST API credentials (JWT tokens) and camera credentials transmitted in cleartext
- Browser Mixed-Content policy blocks WebRTC signalling when the web UI is served over HTTPS
- Modern browsers flag non-HTTPS origins and restrict access to camera/microphone APIs
- Compliance requirements (ISO 27001, NIST SP 800-52) mandate encryption in transit

---

## 2. Objectives

| ID | Objective |
|---|---|
| OBJ-HTTPS-01 | Serve all server traffic (REST, Socket.IO, WebRTC signalling) over TLS 1.2+ |
| OBJ-HTTPS-02 | Support self-signed certificates (development) and CA-signed certificates (production) |
| OBJ-HTTPS-03 | Optional HTTP → HTTPS redirect so existing integrations and health-checks migrate cleanly |
| OBJ-HTTPS-04 | Zero-downtime certificate rotation support |
| OBJ-HTTPS-05 | All configuration via `.env` — no code changes required to enable/disable TLS |

---

## 3. Scope

| In Scope | Out of Scope |
|---|---|
| Node.js HTTPS server (`node:https` module) | Reverse proxy (nginx / Caddy / Traefik) — recommended but not required |
| TLS for REST API + Socket.IO | Client-side mutual TLS (mTLS) — Phase-2 |
| HTTP → HTTPS 301 redirect | ACME automatic certificate renewal (delegate to certbot / acme.sh) |
| Environment-variable-based cert configuration | Hardware Security Module (HSM) key storage |
| Docker volume mount for certs | Certificate transparency logging |

---

## 4. Functional Requirements

| ID | Requirement |
|---|---|
| FR-HTTPS-01 | Server MUST start in HTTPS mode when `HTTPS_ENABLED=true` |
| FR-HTTPS-02 | Certificate and key paths MUST be configurable via `SSL_CERT_PATH` / `SSL_KEY_PATH` |
| FR-HTTPS-03 | Optional CA bundle path via `SSL_CA_PATH` for intermediate certificate chains |
| FR-HTTPS-04 | HTTPS listen port MUST be configurable via `HTTPS_PORT` (default: 3443) |
| FR-HTTPS-05 | When `HTTP_REDIRECT=true`, plain HTTP server on `PORT` MUST issue HTTP 301 to HTTPS |
| FR-HTTPS-06 | Missing cert/key file MUST cause startup failure with a clear error message |
| FR-HTTPS-07 | When `HTTPS_ENABLED=false` (default), server MUST behave identically to current HTTP-only mode |

---

## 5. Non-Functional Requirements

| ID | Requirement |
|---|---|
| NFR-HTTPS-01 | Minimum TLS version: TLS 1.2 (Node.js default since v12+) |
| NFR-HTTPS-02 | Cipher suite: Node.js default secure set (no RC4, no export ciphers) |
| NFR-HTTPS-03 | Certificate file reads MUST occur once at startup; no per-request I/O |
| NFR-HTTPS-04 | Startup time increase for TLS initialisation MUST be < 500 ms |
| NFR-HTTPS-05 | No additional npm dependencies — use built-in `node:https` and `node:fs` |

---

## 6. Acceptance Criteria

1. `curl -k https://localhost:3443/health` returns `200 OK` when `HTTPS_ENABLED=true`
2. `curl http://localhost:3001/health` returns `301 → https://localhost:3443/health` when `HTTP_REDIRECT=true`
3. Server startup fails with `[Server] TLS ERROR: cert/key file not found` when cert files are missing
4. `HTTPS_ENABLED=false` (default): existing HTTP tests pass without modification
5. Browser WebRTC signalling succeeds over `wss://` when served via HTTPS

---

## 7. Schedule

| Milestone | Target |
|---|---|
| Implementation | Sprint 6 (2026-05-27) |
| Integration Test | Sprint 6 |
| Production Cert Deployment | Post-MVP |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — RFP for HTTPS TLS |
