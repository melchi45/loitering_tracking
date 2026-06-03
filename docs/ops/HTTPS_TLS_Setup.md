# Operations Guide
# HTTPS / TLS Configuration

| | |
|---|---|
| **Document Reference** | OPS-LTS2026-TLS-001 |
| **Document Type** | Operations Guide |
| **Parent System** | LTS-2026-001 Loitering Detection & Tracking System |
| **Issue Date** | 2026-05-28 |
| **Status** | **✅ Active — HTTPS enabled on port 3443 (self-signed cert, dev environment)** |
| **Repository** | [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking) |

---

By default the server runs over plain HTTP (port 3080). Enable HTTPS by setting `HTTPS_ENABLED=true` in `server/.env`.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `HTTPS_ENABLED` | `false` | Set `true` to start server over TLS |
| `HTTPS_PORT` | `3443` | TLS listen port (use 443 with root or CAP_NET_BIND_SERVICE) |
| `SSL_CERT_PATH` | `./certs/server.crt` | PEM certificate path, relative to `server/` |
| `SSL_KEY_PATH` | `./certs/server.key` | PEM private key path, relative to `server/` |
| `SSL_CA_PATH` | _(empty)_ | Optional CA/intermediate bundle (for private CAs) |
| `HTTP_REDIRECT` | `false` | Set `true` to issue HTTP 301 → HTTPS on plain `PORT` |

## Option A — Self-Signed Certificate (Development)

Suitable for local development and LAN deployments where a browser security warning is acceptable.

```bash
# 1. Create certs directory (git-ignored)
mkdir -p server/certs

# 2. Generate self-signed cert valid 365 days
#    -addext adds SAN so Chrome/Firefox don't reject it
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=IP:127.0.0.1,IP:192.168.214.3,DNS:localhost" \
  -keyout server/certs/server.key \
  -out    server/certs/server.crt

# 3. Restrict key permissions
chmod 600 server/certs/server.key

# 4. Enable HTTPS in server/.env
#    HTTPS_ENABLED=true
#    HTTPS_PORT=3443
#    SSL_CERT_PATH=./certs/server.crt
#    SSL_KEY_PATH=./certs/server.key

# 5. Start server
cd server && npm start

# 6. Verify
curl -k https://localhost:3443/health
# → {"status":"ok"}
```

> **Browser trust (optional):** Add `server/certs/server.crt` to your OS/browser trust store to eliminate the "Not secure" warning.  
> On Ubuntu: `sudo cp server/certs/server.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates`

## Option B — mkcert (Locally Trusted Dev Cert, Recommended)

[mkcert](https://github.com/FiloSottile/mkcert) creates locally trusted certificates with no browser warning — ideal for development.

```bash
# Install mkcert
sudo apt install mkcert         # Debian/Ubuntu
# or: brew install mkcert       # macOS

# Install the local CA into your system trust store
mkcert -install

# Generate cert for localhost + LAN IP
mkdir -p server/certs
cd server/certs
mkcert localhost 127.0.0.1 192.168.214.3

# mkcert creates: localhost+2.pem  localhost+2-key.pem
# Update server/.env:
#   SSL_CERT_PATH=./certs/localhost+2.pem
#   SSL_KEY_PATH=./certs/localhost+2-key.pem
#   HTTPS_ENABLED=true
```

## Option C — Let's Encrypt / certbot (Production)

For public-facing servers with a registered domain name.

```bash
# Install certbot
sudo apt install certbot

# Obtain certificate (standalone mode — briefly binds port 80)
sudo certbot certonly --standalone -d lts.example.com

# Certs stored at:
#   /etc/letsencrypt/live/lts.example.com/fullchain.pem  ← SSL_CERT_PATH
#   /etc/letsencrypt/live/lts.example.com/privkey.pem    ← SSL_KEY_PATH

# server/.env
HTTPS_ENABLED=true
HTTPS_PORT=443
SSL_CERT_PATH=/etc/letsencrypt/live/lts.example.com/fullchain.pem
SSL_KEY_PATH=/etc/letsencrypt/live/lts.example.com/privkey.pem
HTTP_REDIRECT=true

# Auto-renewal (certbot renew hook — restart server after renewal)
sudo crontab -e
# Add: 0 3 * * * certbot renew --quiet && cd /opt/lts/server && npm run restart
```

## Option D — Reverse Proxy (Recommended for Port 443)

Keep Node.js on plain HTTP and let nginx/Caddy handle TLS. This is the most operationally robust approach for production.

```
[Browser] ──HTTPS:443──▶ [nginx / Caddy] ──HTTP:3001──▶ [LTS Node.js]
```

**nginx example** (`/etc/nginx/sites-available/lts`):

```nginx
server {
    listen 443 ssl http2;
    server_name lts.example.com;

    ssl_certificate     /etc/letsencrypt/live/lts.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/lts.example.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    # REST API + Socket.IO (WebSocket upgrade required)
    location / {
        proxy_pass         http://localhost:3080;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
    }
}

server {
    listen 80;
    server_name lts.example.com;
    return 301 https://$host$request_uri;
}
```

**Caddy example** (`/etc/caddy/Caddyfile`):

```
lts.example.com {
    reverse_proxy localhost:3080
}
```

Caddy obtains and renews Let's Encrypt certificates automatically.

## HTTP → HTTPS Redirect

When `HTTPS_ENABLED=true` and `HTTP_REDIRECT=true`, the server spawns a secondary HTTP listener on `PORT` (3001) that redirects all requests to `https://<hostname>:<HTTPS_PORT><path>`.

```bash
# server/.env
HTTPS_ENABLED=true
HTTPS_PORT=3443
HTTP_REDIRECT=true

# Result:
# http://server:3001/api/cameras  →  301 → https://server:3443/api/cameras
```

## Docker / Docker Compose

```yaml
# docker-compose.yml
services:
  server:
    build: ./server
    ports:
      - "3443:3443"   # HTTPS
      - "3080:3080"   # HTTP redirect (optional)
    volumes:
      - ./server/certs:/app/server/certs:ro   # mount certs read-only
    environment:
      - HTTPS_ENABLED=true
      - HTTPS_PORT=3443
      - SSL_CERT_PATH=./certs/server.crt
      - SSL_KEY_PATH=./certs/server.key
      - HTTP_REDIRECT=true
```

## Vite Dev Server Proxy (Client)

When the server runs in HTTPS mode, update the Vite proxy target in `client/vite.config.ts`:

```ts
proxy: {
  '/api': {
    target: 'https://localhost:3443',  // ← change from http://localhost:3080
    changeOrigin: true,
    secure: false,  // allow self-signed certs in development
  },
  '/socket.io': {
    target: 'https://localhost:3443',
    changeOrigin: true,
    ws: true,
    secure: false,
  },
},
```

## Verification

```bash
# Health check (self-signed: use -k to skip cert verification)
curl -k https://localhost:3443/health

# Verify TLS details
openssl s_client -connect localhost:3443 < /dev/null 2>&1 | grep -E "Protocol|Cipher|subject"

# Test HSTS header
curl -kI https://localhost:3443/health | grep -i strict

# Run HTTPS test suite
node test/api/https_tls.test.js
# With HTTPS mode:
LTS_HTTPS_URL=https://localhost:3443 node test/api/https_tls.test.js
```

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — extracted from README.md §16 |
