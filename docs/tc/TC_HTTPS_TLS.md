# TC — HTTPS / TLS Server Encryption

**Document ID:** TC-LTS2026-HTTPS-001  
**Issue Date:** 2026-05-27  
**Module:** HTTPS / TLS Server Encryption  
**SRS Reference:** SRS-LTS2026-HTTPS-001  
**Design Reference:** Design-LTS2026-HTTPS-001  
**Test Scripts:** test/api/https_tls.test.js (Groups A, B, D, G)  
**Status:** Released

---

## Group A — HTTPS Mode Activation

### TC-HTTPS-A-001: Default HTTP mode unchanged

| Field | Value |
|---|---|
| **Precondition** | `HTTPS_ENABLED=false` (or absent) in `.env` |
| **Input** | Start server normally |
| **Expected** | Server listens on `PORT` (3001) over HTTP |
| **Validation** | `curl http://localhost:3080/health` → `200 OK` |
| **SRS** | FR-HTTPS-002 |

### TC-HTTPS-A-002: HTTPS mode activation

| Field | Value |
|---|---|
| **Precondition** | `HTTPS_ENABLED=true`, valid cert+key at configured paths |
| **Input** | Start server |
| **Expected** | Server listens on `HTTPS_PORT` (3443) over TLS |
| **Validation** | `curl -k https://localhost:3443/health` → `200 OK` |
| **SRS** | FR-HTTPS-001 |

### TC-HTTPS-A-003: Missing certificate file — startup failure

| Field | Value |
|---|---|
| **Precondition** | `HTTPS_ENABLED=true`, `SSL_CERT_PATH` points to non-existent file |
| **Input** | Start server |
| **Expected** | Process exits with code 1; logs ENOENT error |
| **Validation** | `echo $?` → `1`; stderr contains `ENOENT` and cert path |
| **SRS** | FR-HTTPS-001 |

### TC-HTTPS-A-004: Missing key file — startup failure

| Field | Value |
|---|---|
| **Precondition** | `HTTPS_ENABLED=true`, cert exists, `SSL_KEY_PATH` points to non-existent file |
| **Input** | Start server |
| **Expected** | Process exits with code 1; logs ENOENT for key file |
| **SRS** | FR-HTTPS-001 |

### TC-HTTPS-A-005: HTTPS_PORT customisation

| Field | Value |
|---|---|
| **Precondition** | `HTTPS_ENABLED=true`, `HTTPS_PORT=4443` |
| **Input** | Start server |
| **Expected** | Server listens on port 4443 |
| **Validation** | `curl -k https://localhost:4443/health` → `200 OK` |
| **SRS** | FR-HTTPS-003 |

---

## Group B — HTTP → HTTPS Redirect

### TC-HTTPS-B-001: 301 redirect issued

| Field | Value |
|---|---|
| **Precondition** | `HTTPS_ENABLED=true`, `HTTP_REDIRECT=true` |
| **Input** | `GET http://localhost:3080/api/cameras` |
| **Expected** | `301 Moved Permanently`, `Location: https://localhost:3443/api/cameras` |
| **Validation** | `curl -v http://localhost:3080/api/cameras 2>&1 \| grep "< HTTP"` → `301` |
| **SRS** | FR-HTTPS-005 |

### TC-HTTPS-B-002: Redirect preserves path and query

| Field | Value |
|---|---|
| **Input** | `GET http://localhost:3080/api/events?limit=10` |
| **Expected** | `Location: https://localhost:3443/api/events?limit=10` |
| **SRS** | FR-HTTPS-005 |

### TC-HTTPS-B-003: HTTP_REDIRECT=false — no redirect server

| Field | Value |
|---|---|
| **Precondition** | `HTTPS_ENABLED=true`, `HTTP_REDIRECT=false` |
| **Input** | `curl http://localhost:3080/health` |
| **Expected** | Connection refused (no HTTP server on PORT) |
| **SRS** | FR-HTTPS-002, FR-HTTPS-005 |

---

## Group C — TLS Protocol Validation

### TC-HTTPS-C-001: TLS 1.2 accepted

| Field | Value |
|---|---|
| **Input** | `openssl s_client -connect localhost:3443 -tls1_2 < /dev/null` |
| **Expected** | Handshake completes; `Protocol: TLSv1.2` in output |
| **SRS** | NFR-HTTPS-01 |

### TC-HTTPS-C-002: TLS 1.3 accepted

| Field | Value |
|---|---|
| **Input** | `openssl s_client -connect localhost:3443 -tls1_3 < /dev/null` |
| **Expected** | Handshake completes; `Protocol: TLSv1.3` in output |
| **SRS** | NFR-HTTPS-01 |

### TC-HTTPS-C-003: TLS 1.1 rejected (deprecated)

| Field | Value |
|---|---|
| **Input** | `openssl s_client -connect localhost:3443 -tls1_1 < /dev/null` |
| **Expected** | Handshake fails; connection rejected |
| **SRS** | NFR-HTTPS-01 |

### TC-HTTPS-C-004: Certificate CN verification

| Field | Value |
|---|---|
| **Input** | `openssl s_client -connect localhost:3443 < /dev/null 2>&1 \| grep "subject="` |
| **Expected** | CN matches configured certificate (e.g., `CN=localhost`) |
| **SRS** | FR-HTTPS-001 |

---

## Group D — REST API over HTTPS

### TC-HTTPS-D-001: Health endpoint over HTTPS

| Field | Value |
|---|---|
| **Input** | `curl -k https://localhost:3443/health` |
| **Expected** | `200 OK`, `{ "status": "ok" }` |
| **SRS** | FR-HTTPS-008 |

### TC-HTTPS-D-002: Cameras API over HTTPS

| Field | Value |
|---|---|
| **Input** | `curl -k https://localhost:3443/api/cameras` |
| **Expected** | `200 OK`, cameras array |
| **SRS** | FR-HTTPS-006 |

### TC-HTTPS-D-003: HSTS header present

| Field | Value |
|---|---|
| **Input** | `curl -kI https://localhost:3443/health` |
| **Expected** | Response header: `Strict-Transport-Security: max-age=31536000; includeSubDomains` |
| **SRS** | FR-HTTPS-007 (SRS §2, NFR-HTTPS-02) |

### TC-HTTPS-D-004: HSTS header absent in HTTP mode

| Field | Value |
|---|---|
| **Precondition** | `HTTPS_ENABLED=false` |
| **Input** | `curl -I http://localhost:3080/health` |
| **Expected** | No `Strict-Transport-Security` header |
| **SRS** | FR-HTTPS-007 |

---

## Group E — CA Bundle (optional)

### TC-HTTPS-E-001: Custom CA bundle accepted

| Field | Value |
|---|---|
| **Precondition** | `SSL_CA_PATH` set to a valid CA PEM file |
| **Input** | Start server; `curl --cacert server/certs/ca.crt https://localhost:3443/health` |
| **Expected** | `200 OK` without `-k` flag (cert validated via custom CA) |
| **SRS** | FR-HTTPS-004 |

### TC-HTTPS-E-002: SSL_CA_PATH unset — no ca option passed

| Field | Value |
|---|---|
| **Precondition** | `SSL_CA_PATH` not set (default) |
| **Input** | Start server; verify TLS handshake completes with public CA |
| **Expected** | Server starts; no error about CA |
| **SRS** | FR-HTTPS-004 |

---

## Group F — Graceful Shutdown

### TC-HTTPS-F-001: SIGTERM closes HTTPS server

| Field | Value |
|---|---|
| **Precondition** | Server running in HTTPS mode |
| **Input** | `kill -SIGTERM <pid>` |
| **Expected** | Log: `[Server] HTTPS server closed`; process exits cleanly with code 0 |
| **SRS** | FR-HTTPS-009 |

### TC-HTTPS-F-002: SIGTERM closes HTTP server

| Field | Value |
|---|---|
| **Precondition** | Server running in HTTP mode (default) |
| **Input** | `kill -SIGTERM <pid>` |
| **Expected** | Log: `[Server] HTTP server closed`; process exits cleanly |
| **SRS** | FR-HTTPS-009 |

---

## Group G — Regression

### TC-HTTPS-G-001: All existing HTTP API tests pass with HTTPS_ENABLED=false

| Field | Value |
|---|---|
| **Precondition** | `HTTPS_ENABLED=false` (default) |
| **Input** | `node test/run_all.js --skip e2e` |
| **Expected** | All Phase-1 API tests pass (≥ 265 cases) |
| **SRS** | FR-HTTPS-002 |

---

## Test Summary

| Group | Cases | Phase |
|---|---|---|
| A — Activation | 5 | Phase-1 |
| B — Redirect | 3 | Phase-1 |
| C — TLS Protocol | 4 | Phase-1 |
| D — REST + HSTS | 4 | Phase-1 |
| E — CA Bundle | 2 | Phase-1 |
| F — Shutdown | 2 | Phase-1 |
| G — Regression | 1 | Phase-1 |
| **Total** | **21** | |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Test cases for HTTPS TLS |
