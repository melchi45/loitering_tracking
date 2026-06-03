# SRS — HTTPS / TLS Server Encryption

**Document ID:** SRS-LTS2026-HTTPS-001  
**Issue Date:** 2026-05-27  
**Module:** HTTPS / TLS Server Encryption  
**PRD Reference:** PRD-LTS2026-HTTPS-001  
**Status:** Released

---

## 1. Overview

This document specifies the functional and non-functional requirements for HTTPS/TLS support in the LTS-2026 Node.js backend server.

---

## 2. Functional Requirements

### FR-HTTPS-001 — HTTPS Mode Activation

- **Trigger**: `HTTPS_ENABLED=true` in `server/.env`
- **Input**: `SSL_CERT_PATH`, `SSL_KEY_PATH` (relative to `server/`)
- **Output**: `https.Server` created with the loaded TLS options
- **Error path**: If cert or key file does not exist or is unreadable, log `[Server] TLS ERROR: <filename> not found or unreadable` and `process.exit(1)`

### FR-HTTPS-002 — Default HTTP Mode (unchanged)

- **Trigger**: `HTTPS_ENABLED=false` or variable absent
- **Behaviour**: `http.createServer(app)` identical to pre-HTTPS code
- **Constraint**: No behavioural change for existing deployments

### FR-HTTPS-003 — Listen Port

- HTTPS mode listens on `HTTPS_PORT` (default `3443`)
- HTTP mode listens on `PORT` (default `3001`)
- Both values are read at startup; changing them requires a server restart

### FR-HTTPS-004 — CA Bundle

- `SSL_CA_PATH` (optional): path to intermediate/root CA bundle
- If set, passed as `ca` in TLS options to support private/internal CAs
- If unset, no `ca` option passed (browser-trusted public CAs work without it)

### FR-HTTPS-005 — HTTP → HTTPS Redirect

- **Trigger**: `HTTPS_ENABLED=true` AND `HTTP_REDIRECT=true`
- Spawns a secondary `http.createServer(redirectApp)` listening on `PORT`
- All requests receive `HTTP 301` to `https://<hostname>:<HTTPS_PORT><path>`
- Redirect server is independent of Socket.IO (no WebSocket upgrade handling)

### FR-HTTPS-006 — Socket.IO WebSocket Upgrade

- Socket.IO MUST attach to the active server (HTTPS or HTTP)
- `wss://` used automatically by the browser when the page origin is `https://`
- CORS options remain unchanged (`origin: '*'`)

### FR-HTTPS-007 — HSTS Header

- When `HTTPS_ENABLED=true`, Express middleware MUST add:
  ```
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  ```
- Header MUST NOT be sent in HTTP mode

### FR-HTTPS-008 — Health Endpoint

- `GET /health` MUST remain reachable over the active protocol
- Startup log MUST print the correct URL:
  - HTTPS: `[Server] Health: https://localhost:3443/health`
  - HTTP:  `[Server] Health: http://localhost:3080/health`

### FR-HTTPS-009 — Graceful Shutdown

- Shutdown handler MUST close the HTTPS server (same `httpServer.close()` call)
- Log message MUST indicate protocol: `[Server] HTTPS server closed` or `[Server] HTTP server closed`

---

## 3. Non-Functional Requirements

| ID | Category | Requirement |
|---|---|---|
| NFR-HTTPS-01 | Security | TLS 1.2 minimum; TLS 1.3 negotiated when available |
| NFR-HTTPS-02 | Security | No deprecated ciphers (RC4, 3DES, NULL) |
| NFR-HTTPS-03 | Security | Private key MUST NOT appear in application logs |
| NFR-HTTPS-04 | Performance | Cert files read once at startup (sync `fs.readFileSync`); no per-request I/O |
| NFR-HTTPS-05 | Performance | TLS handshake overhead: ≤ 50 ms on LAN (TLS 1.3 0-RTT resumption) |
| NFR-HTTPS-06 | Maintainability | No new npm dependencies — `node:https`, `node:fs` only |
| NFR-HTTPS-07 | Operability | `.env` variables fully document expected values with inline comments |
| NFR-HTTPS-08 | Compatibility | Must support Docker volume-mounted cert paths |

---

## 4. Interface Contracts

### 4.1 Environment Variables

| Variable | Type | Default | Valid Values |
|---|---|---|---|
| `HTTPS_ENABLED` | boolean string | `false` | `true` \| `false` |
| `HTTPS_PORT` | integer | `3443` | 1–65535 |
| `SSL_CERT_PATH` | file path | `./certs/server.crt` | Relative to `server/` or absolute |
| `SSL_KEY_PATH` | file path | `./certs/server.key` | Relative to `server/` or absolute |
| `SSL_CA_PATH` | file path | _(empty)_ | Relative to `server/` or absolute |
| `HTTP_REDIRECT` | boolean string | `false` | `true` \| `false` |

### 4.2 Server Startup Log

```
# HTTPS mode
[Server] Database initialised (mode: json )
[Server] Loitering Tracking System backend listening on port 3443
[Server] Health: https://localhost:3443/health

# HTTPS mode + HTTP redirect
[Server] HTTP→HTTPS redirect listening on port 3080
[Server] Loitering Tracking System backend listening on port 3443

# HTTP mode (default)
[Server] Loitering Tracking System backend listening on port 3080
[Server] Health: http://localhost:3080/health
```

### 4.3 Error Output (cert file missing)

```
Error: ENOENT: no such file or directory, open '.../server/certs/server.crt'
    at Object.readFileSync (node:fs:...)
[Server] Fatal startup error: ENOENT: no such file or directory
```

---

## 5. Constraints

- `HTTP_REDIRECT=true` requires `HTTPS_ENABLED=true`; if set with `HTTPS_ENABLED=false` the flag is silently ignored
- Certificate files must be PEM-encoded; DER format is not supported
- Port 443 requires root privileges or `CAP_NET_BIND_SERVICE` on Linux; use HTTPS_PORT=3443 and a reverse proxy for production port 443

---

## 6. Security Considerations

| Concern | Mitigation |
|---|---|
| Private key exposure | Key file permissions `600` (owner read-only); never log key content |
| Self-signed cert warnings | Document expected browser warning for dev; require CA-signed cert in production |
| Expired certificate | Monitor cert expiry with `openssl x509 -in server.crt -noout -dates`; certbot auto-renew for Let's Encrypt |
| HSTS lock-in | Only enable HSTS in production deployments where HTTPS is permanent |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — SRS for HTTPS TLS |
