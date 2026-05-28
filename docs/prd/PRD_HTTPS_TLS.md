# PRD — HTTPS / TLS Server Encryption

**Document ID:** PRD-LTS2026-HTTPS-001  
**Issue Date:** 2026-05-27  
**Module:** HTTPS / TLS Server Encryption  
**RFP Reference:** RFP-LTS2026-HTTPS-001  
**Status:** Released

---

## 1. Technology Selection

| Component | Choice | Rationale |
|---|---|---|
| TLS module | Node.js built-in `node:https` | No extra dependencies; identical API surface to `node:http` |
| Certificate format | PEM (X.509) | Industry standard; compatible with OpenSSL, Let's Encrypt, certbot |
| Minimum TLS version | TLS 1.2 | Node.js v12+ default; TLS 1.3 negotiated automatically when both sides support it |
| HTTP redirect | Express micro-app on plain `PORT` | Keeps existing integrations functional during migration |
| Certificate storage | File system (PEM files) | Simple; Docker volume-mountable; compatible with certbot auto-renewal |
| CI development certs | `openssl req` self-signed | Zero external dependencies; works offline |
| Production certs | Let's Encrypt via `certbot` | Free, auto-renewable, widely trusted |

---

## 2. Implementation Approach

### 2.1 Server Startup Sequence

```
HTTPS_ENABLED=true?
  ├─ YES → read SSL_CERT_PATH + SSL_KEY_PATH (+ optional SSL_CA_PATH)
  │         create https.Server(tlsOpts, expressApp)
  │         HTTP_REDIRECT=true? → create redirect http.Server on PORT
  │         listen on HTTPS_PORT (default 3443)
  └─ NO  → create http.Server(expressApp)   [unchanged default behaviour]
              listen on PORT (default 3001)

Socket.IO always attaches to the active server (http or https).
```

### 2.2 Environment Variables

| Variable | Default | Description |
|---|---|---|
| `HTTPS_ENABLED` | `false` | Set `true` to enable TLS |
| `HTTPS_PORT` | `3443` | TLS listen port |
| `SSL_CERT_PATH` | `./certs/server.crt` | PEM certificate path (relative to `server/`) |
| `SSL_KEY_PATH` | `./certs/server.key` | PEM private key path (relative to `server/`) |
| `SSL_CA_PATH` | _(empty)_ | Optional CA/intermediate bundle |
| `HTTP_REDIRECT` | `false` | Set `true` for HTTP 301 → HTTPS redirect |

### 2.3 Certificate Rotation Strategy

Certificates are read once at process startup with `fs.readFileSync`. To rotate:

1. Replace PEM files on disk
2. `npm run restart` (zero-downtime: stop old → start new process, ~1 s gap)

> For zero-gap rotation use a process manager (PM2 cluster mode) or put a TLS-terminating reverse proxy (nginx/Caddy) in front — see §5 for recommendations.

### 2.4 Security Hardening Defaults

Node.js `https.createServer` inherits secure defaults:
- **TLS 1.2 minimum** (`minVersion: 'TLSv1.2'`)
- **Cipher suite**: Node.js `tls.DEFAULT_CIPHERS` (AES-GCM, ChaCha20, no RC4/3DES)
- **HSTS header**: Set manually in Express middleware when HTTPS active
  ```js
  app.use((req, res, next) => {
    if (httpsEnabled) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });
  ```

---

## 3. Priority

| Priority | Feature |
|:---:|---|
| P0 | HTTPS mode with self-signed cert (development) |
| P0 | `.env`-based configuration — no code change to enable |
| P1 | HTTP → HTTPS redirect |
| P1 | CA bundle support (intermediate certs) |
| P2 | HSTS header when HTTPS active |
| P3 | Zero-downtime PM2 cluster certificate rotation |

---

## 4. Dependencies

| Dependency | Type | Status |
|---|---|---|
| `node:https` | Node.js built-in | ✅ Available (Node 18+) |
| `node:fs` | Node.js built-in | ✅ Available |
| `openssl` CLI | Dev tooling | ✅ Available on Linux/macOS |
| `certbot` | Production tooling | Optional — not bundled |

---

## 5. Deployment Recommendations

### 5.1 Development (self-signed)

```bash
mkdir -p server/certs
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -subj "/CN=localhost" \
  -keyout server/certs/server.key \
  -out    server/certs/server.crt
```

### 5.2 Production — Let's Encrypt (public server)

```bash
certbot certonly --standalone -d lts.example.com
# Certs at: /etc/letsencrypt/live/lts.example.com/
# Map in .env:
#   SSL_CERT_PATH=/etc/letsencrypt/live/lts.example.com/fullchain.pem
#   SSL_KEY_PATH=/etc/letsencrypt/live/lts.example.com/privkey.pem
```

### 5.3 Production — Reverse Proxy (recommended for port 443)

```
[Browser] ──HTTPS:443──▶ [nginx/Caddy] ──HTTP:3001──▶ [LTS Node.js]
```

nginx handles TLS termination; Node.js stays on HTTP (simpler cert rotation, PM2 clustering).

### 5.4 Docker / Docker Compose

```yaml
volumes:
  - ./server/certs:/app/server/certs:ro   # mount cert directory read-only
environment:
  - HTTPS_ENABLED=true
  - SSL_CERT_PATH=./certs/server.crt
  - SSL_KEY_PATH=./certs/server.key
```

---

## 6. Test Strategy

| Phase | Scope |
|---|---|
| Phase-1 (API) | REST endpoint reachability over HTTPS; 301 redirect; cert-missing startup fail |
| Phase-2 (Integration) | Socket.IO `wss://` connect; WebRTC signalling over HTTPS |
| Phase-3 (E2E) | Browser dashboard loads over HTTPS; no Mixed-Content warnings |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — PRD for HTTPS TLS |
