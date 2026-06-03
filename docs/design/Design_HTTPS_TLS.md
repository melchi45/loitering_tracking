# Design — HTTPS / TLS Server Encryption

**Document ID:** Design-LTS2026-HTTPS-001  
**Issue Date:** 2026-05-27  
**Module:** HTTPS / TLS Server Encryption  
**SRS Reference:** SRS-LTS2026-HTTPS-001  
**Status:** Released

---

## 1. Architecture Overview

```
server/.env
  HTTPS_ENABLED=true / false
  HTTPS_PORT=3443
  SSL_CERT_PATH / SSL_KEY_PATH / SSL_CA_PATH
  HTTP_REDIRECT=true / false
        │
        ▼
server/src/index.js  main()
        │
        ├─ HTTPS_ENABLED=true ──────────────────────────────────────────┐
        │   fs.readFileSync(certFile)                                   │
        │   fs.readFileSync(keyFile)                                    │
        │   [+optional] fs.readFileSync(caFile)                        │
        │   https.createServer(tlsOpts, expressApp)  ──────── httpServer│
        │                                                               │
        │   HTTP_REDIRECT=true?                                         │
        │     └─ http.createServer(redirectApp).listen(PORT)  ←── 301  │
        │                                                               │
        └─ HTTPS_ENABLED=false ─────────────────────────────────────────┤
            http.createServer(expressApp)  ───────────────── httpServer │
                                                                        │
                                                                        ▼
                                                  Socket.IO attaches to httpServer
                                                  httpServer.listen(ACTIVE_PORT)
```

---

## 2. File Structure

```
server/
├── src/
│   └── index.js          ← HTTPS/HTTP server creation logic
├── certs/                ← Certificate directory (git-ignored)
│   ├── server.crt        ← PEM certificate (self-signed or CA-signed)
│   ├── server.key        ← PEM private key  (chmod 600)
│   └── ca.crt            ← (optional) CA/intermediate bundle
└── .env                  ← HTTPS configuration variables
```

> `server/certs/` MUST be added to `.gitignore` — never commit private keys.

---

## 3. Code Design — `server/src/index.js`

### 3.1 Imports Added

```js
const http    = require('http');
const https   = require('https');   // ← added
const fs      = require('fs');      // ← added
const path    = require('path');
```

### 3.2 Server Creation (inside `main()`)

```js
const httpsEnabled = process.env.HTTPS_ENABLED === 'true';
let httpServer;

if (httpsEnabled) {
  const certFile = path.resolve(__dirname, '..', process.env.SSL_CERT_PATH || './certs/server.crt');
  const keyFile  = path.resolve(__dirname, '..', process.env.SSL_KEY_PATH  || './certs/server.key');
  const caFile   = process.env.SSL_CA_PATH
    ? path.resolve(__dirname, '..', process.env.SSL_CA_PATH) : null;

  const tlsOpts = {
    cert: fs.readFileSync(certFile),   // throws ENOENT → startup failure
    key:  fs.readFileSync(keyFile),
  };
  if (caFile) tlsOpts.ca = fs.readFileSync(caFile);

  httpServer = https.createServer(tlsOpts, app);
} else {
  httpServer = http.createServer(app);   // unchanged default
}

// Socket.IO always attaches to the active server
const io = new SocketIOServer(httpServer, { ... });
```

### 3.3 HSTS Middleware

```js
// Placed after cors() middleware, before route registration
if (httpsEnabled) {
  app.use((_req, res, next) => {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });
}
```

### 3.4 Listen + Optional HTTP Redirect

```js
const ACTIVE_PORT  = httpsEnabled ? parseInt(process.env.HTTPS_PORT || '3443', 10) : PORT;
const ACTIVE_PROTO = httpsEnabled ? 'https' : 'http';

if (httpsEnabled && process.env.HTTP_REDIRECT === 'true') {
  const redirectApp = express();
  redirectApp.use((req, res) => {
    res.redirect(301, `https://${req.hostname}:${ACTIVE_PORT}${req.url}`);
  });
  http.createServer(redirectApp).listen(PORT, () => {
    console.log(`[Server] HTTP→HTTPS redirect listening on port ${PORT}`);
  });
}

await new Promise((resolve, reject) => {
  httpServer.listen(ACTIVE_PORT, (err) => {
    if (err) return reject(err);
    resolve();
  });
});

console.log(`[Server] Loitering Tracking System backend listening on port ${ACTIVE_PORT}`);
console.log(`[Server] Health: ${ACTIVE_PROTO}://localhost:${ACTIVE_PORT}/health`);
```

### 3.5 Graceful Shutdown

```js
httpServer.close(() => {
  console.log(`[Server] ${httpsEnabled ? 'HTTPS' : 'HTTP'} server closed`);
  ...
});
```

---

## 4. Sequence Diagrams

### 4.1 HTTPS Startup (HTTPS_ENABLED=true)

```
main()
  │
  ├─ webrtcGateway.init()
  ├─ initDB()
  ├─ express() → app
  ├─ fs.readFileSync(cert)  ──fail──▶ ENOENT → process.exit(1)
  ├─ fs.readFileSync(key)   ──fail──▶ ENOENT → process.exit(1)
  ├─ https.createServer(tlsOpts, app)  → httpServer
  ├─ new SocketIOServer(httpServer)    → io
  ├─ [routes, services, handlers]
  ├─ HTTP_REDIRECT? → http.createServer(redirectApp).listen(PORT)
  └─ httpServer.listen(HTTPS_PORT)
       └─ log: "listening on port 3443"
```

### 4.2 Browser Request Flow (HTTPS + HTTP_REDIRECT)

```
Browser
  │── GET http://server:3001/api/...
  │                │
  │         [redirect http.Server]
  │                └── 301 → https://server:3443/api/...
  │── GET https://server:3443/api/...
  │                │
  │         [https.Server / Express]
  │                └── 200 OK
```

---

## 5. Certificate Management

### 5.1 Development (self-signed)

```bash
mkdir -p server/certs
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=IP:127.0.0.1,IP:192.168.214.3,DNS:localhost" \
  -keyout server/certs/server.key \
  -out    server/certs/server.crt
chmod 600 server/certs/server.key
```

### 5.2 Production — Let's Encrypt

```bash
# Install certbot
apt install certbot

# Standalone challenge (stops any service on port 80 briefly)
certbot certonly --standalone -d lts.example.com

# Certs stored at:
#   /etc/letsencrypt/live/lts.example.com/fullchain.pem
#   /etc/letsencrypt/live/lts.example.com/privkey.pem

# server/.env
SSL_CERT_PATH=/etc/letsencrypt/live/lts.example.com/fullchain.pem
SSL_KEY_PATH=/etc/letsencrypt/live/lts.example.com/privkey.pem
HTTPS_PORT=443   # requires root or CAP_NET_BIND_SERVICE
```

### 5.3 Docker Volume Mount

```yaml
# docker-compose.yml
services:
  server:
    volumes:
      - ./server/certs:/app/server/certs:ro
    environment:
      - HTTPS_ENABLED=true
      - SSL_CERT_PATH=./certs/server.crt
      - SSL_KEY_PATH=./certs/server.key
      - HTTPS_PORT=3443
```

### 5.4 `.gitignore` Entry

```
# TLS certificates — never commit private keys
server/certs/
```

---

## 6. Client-Side Impact

| Change | Required Action |
|---|---|
| Vite dev server proxy (`vite.config.ts`) | Update `target` to `https://localhost:3443` when `HTTPS_ENABLED=true`; add `secure: false` for self-signed |
| API base URL (`client/src/`) | No change — relative `/api/` paths work regardless of protocol |
| Socket.IO connection URL | No change — uses `window.location.origin` by default; switches to `wss://` automatically |
| WebRTC STUN/TURN | No change — ICE servers configured separately in `.env` |

### Vite Proxy for HTTPS Development

```ts
// vite.config.ts
proxy: {
  '/api': {
    target: process.env.VITE_API_URL || 'http://localhost:3080',
    changeOrigin: true,
    secure: false,  // allow self-signed cert
  },
}
```

---

## 7. Security Checklist

| Item | Status |
|---|---|
| `server/certs/` in `.gitignore` | ✅ Required |
| `server.key` file permissions `600` | ✅ Required |
| Private key never logged | ✅ Code does not log tlsOpts |
| HSTS header in HTTPS mode | ✅ Added via middleware |
| Minimum TLS 1.2 | ✅ Node.js default |
| Cipher suite audit | ✅ Node.js secure defaults |
| Cert expiry monitoring | ⚠ Operator responsibility |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Technical design for HTTPS TLS |
