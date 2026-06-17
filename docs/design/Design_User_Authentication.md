# Design — User Authentication & Authorization

**Document ID:** Design-LTS2026-AUTH-001  
**Issue Date:** 2026-05-28  
**Module:** User Authentication & Authorization  
**SRS Reference:** SRS-LTS2026-AUTH-001  
**Status:** Released  
**Rev:** 1.2 — Implemented as local email/password auth (OAuth deferred); auth services migrated to db.js unified storage

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                       CLIENT (React + Vite)                      │
│                                                                   │
│  page='signin'   SignInPage   (login + register tabs)           │
│  page='pending'  PendingPage  (awaiting admin approval)         │
│  page='admin'    AdminUsersPage  ← admin only                   │
│  page='dashboard' Dashboard   ← admin role only                 │
│               AccessDeniedPage ← operator / viewer role         │
│                                                                   │
│  authStore (Zustand)  accessToken (memory)                      │
│  HttpOnly cookie      refreshToken (cookie, 7 days)             │
│  userMenu             logout + admin nav + dashboard toggle      │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTPS REST
┌──────────────────────────▼──────────────────────────────────────┐
│                  SERVER  (Node.js / Express)                      │
│                                                                   │
│  routes/auth.js      POST /auth/register                         │
│                       POST /auth/login                            │
│                       POST /auth/refresh                          │
│                       POST /auth/logout                           │
│                       GET  /auth/me                               │
│                                                                   │
│  routes/admin.js      GET    /admin/users                        │
│                       GET    /admin/users/:id                     │
│                       PATCH  /admin/users/:id                     │
│                       DELETE /admin/users/:id                     │
│                       GET    /admin/audit                         │
│                                                                   │
│  middleware/auth.js   verifyAccessToken (RS256 JWT)              │
│                       optionalToken                               │
│  middleware/role.js   requireRole(roles[])                       │
│                                                                   │
│  services/UserService.js  db.js CRUD  →  users table (lts.json / MongoDB)     │
│  services/TokenService.js  JWT RS256 sign/verify/rotate                        │
│                             → refresh_tokens table (lts.json / MongoDB)        │
│  services/AuditService.js  append-only log → audit_logs table (lts.json / MongoDB) │
└─────────────────────────────────────────────────────────────────┘
```

> **Note on OAuth:** Google OAuth 2.0 and Microsoft Entra ID were deferred.
> Local email + bcrypt password auth is the implemented primary method.
> OAuth can be layered on later by adding passport strategies without
> changing the JWT / RBAC / audit infrastructure.

---

## 2. File Structure

```
server/
├── src/
│   ├── routes/
│   │   ├── auth.js            ← POST /register /login /refresh /logout; GET /me
│   │   └── admin.js           ← Admin user management endpoints
│   ├── middleware/
│   │   ├── auth.js            ← verifyAccessToken + optionalToken (RS256 JWT)
│   │   └── role.js            ← requireRole(...roles) RBAC guard
│   └── services/
│       ├── UserService.js     ← User CRUD (db.js → lts.json / MongoDB), bcrypt password hashing
│       ├── TokenService.js    ← JWT RS256 sign/verify, refresh token rotation (db.js → lts.json / MongoDB)
│       └── AuditService.js    ← Append-only auth audit log (db.js → lts.json / MongoDB, max 10 000 events)
├── certs/
│   ├── jwt.key                ← RS256 private key (generated, git-ignored)
│   └── jwt.pub                ← RS256 public key
└── .env                       ← JWT key paths + COOKIE_SECRET + CLIENT_ORIGIN

client/src/
├── pages/
│   ├── SignInPage.tsx          ← page='signin'  (login + register tabs)
│   ├── PendingPage.tsx         ← page='pending' (awaiting approval)
│   └── admin/
│       └── AdminUsersPage.tsx  ← page='admin'   (user management table)
├── stores/
│   └── authStore.ts            ← Zustand: user, accessToken, page, login/logout/refresh
└── App.tsx                     ← Auth page routing + userMenu in header
```

> **Note:** No React Router needed. Auth state drives page rendering via `authStore.page`.

### 역할별 대시보드 접근 제어

`App.tsx`는 인증 후 role을 검사하여 Streaming/Analysis Dashboard 진입을 Admin 전용으로 제한한다:

```tsx
if (auth.user?.role !== 'admin') return <AccessDeniedPage />;
return <Dashboard />;
```

| role | 접근 가능 페이지 |
|---|---|
| `admin` | Dashboard (Streaming + Analysis), AdminUsersPage |
| `operator` | AccessDeniedPage |
| `viewer` | AccessDeniedPage |

`AccessDeniedPage` (`client/src/pages/AccessDeniedPage.tsx`):
- 현재 계정 email / role 표시
- "다른 계정으로 로그인" 버튼 → `auth.logout()`

---

## 3. Data Models

> **Storage Note:** `users`, `refresh_tokens`, `audit_logs` are unified tables in `db.js`. When `DB_TYPE=mongodb`, data is persisted to MongoDB; when `DB_TYPE=json`, it is written to `storage/lts.json`. Legacy separate JSON files (`users.json`, `tokens.json`, `audit.json`) are automatically migrated into `lts.json` on first startup.

### 3.1 User Record (`db.js` — `users` table)

```json
{
  "id": "uuid-v4",
  "email": "user@example.com",
  "name": "Jane Doe",
  "avatar": "https://lh3.googleusercontent.com/...",
  "provider": "google",
  "providerAccountId": "google-sub-claim",
  "role": "viewer",
  "status": "pending",
  "createdAt": "2026-05-28T09:00:00Z",
  "approvedAt": null,
  "approvedBy": null,
  "lastLoginAt": null,
  "loginCount": 0
}
```

Status values: `"pending"` → `"active"` | `"rejected"`

### 3.2 Refresh Token Record (`db.js` — `refresh_tokens` table)

```json
{
  "tokenHash": "sha256-hex-of-refresh-token",
  "userId": "uuid-v4",
  "issuedAt": "2026-05-28T09:00:00Z",
  "expiresAt": "2026-06-04T09:00:00Z",
  "revoked": false
}
```

### 3.3 Audit Log Entry (`db.js` — `audit_logs` table)

```json
{
  "id": "uuid-v4",
  "ts": "2026-05-28T09:00:00Z",
  "event": "signup",
  "userId": "uuid-v4",
  "email": "user@example.com",
  "provider": "google",
  "ip": "203.0.113.1",
  "userAgent": "Mozilla/5.0 ...",
  "actorId": null,
  "detail": {}
}
```

Event types: `signup`, `signin`, `signin_blocked`, `logout`, `token_refresh`, `approved`, `rejected`, `role_changed`, `revoked`

---

## 4. Backend Code Design

### 4.1 Environment Variables (`server/.env`)

```dotenv
# JWT RS256 key pair
# Generate: cd server/certs
#   openssl genrsa -out jwt.key 2048
#   openssl rsa -in jwt.key -pubout -out jwt.pub
JWT_PRIVATE_KEY_PATH=./certs/jwt.key
JWT_PUBLIC_KEY_PATH=./certs/jwt.pub
JWT_ACCESS_EXPIRES=15m
JWT_REFRESH_EXPIRES=7d

# Cookie signing secret (generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
COOKIE_SECRET=<random 32+ byte hex>

# CORS allowed origins for credentials (comma-separated)
CLIENT_ORIGIN=https://localhost:3443,http://localhost:3080

# First registered user email auto-promoted to admin (optional)
ADMIN_SEED_EMAIL=admin@lts.local

# Set false to bypass all auth checks in development
AUTH_ENABLED=true
```

### 4.2 `middleware/auth.js`

```js
const jwt = require('jsonwebtoken');
const fs  = require('fs');
const path = require('path');

const pubKey = fs.readFileSync(
  path.resolve(__dirname, '../../', process.env.JWT_PUBLIC_KEY_PATH)
);

function verifyAccessToken(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, pubKey, { algorithms: ['RS256'] });
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { verifyAccessToken };
```

### 4.3 `middleware/role.js`

```js
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthenticated' });
    if (!roles.includes(req.user.role))
      return res.status(403).json({ error: 'Insufficient role' });
    next();
  };
}

module.exports = { requireRole };
```

### 4.4 `services/TokenService.js`

```js
const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const privKey = fs.readFileSync(
  path.resolve(__dirname, '../../', process.env.JWT_PRIVATE_KEY_PATH)
);
const pubKey = fs.readFileSync(
  path.resolve(__dirname, '../../', process.env.JWT_PUBLIC_KEY_PATH)
);

function issueAccessToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    privKey,
    { algorithm: 'RS256', expiresIn: process.env.JWT_ACCESS_EXPIRES || '15m' }
  );
}

function issueRefreshToken(user) {
  const token = crypto.randomBytes(40).toString('hex');
  const hash  = crypto.createHash('sha256').update(token).digest('hex');
  // persist hash to storage/tokens.json
  return { token, hash };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = { issueAccessToken, issueRefreshToken, hashToken };
```

### 4.5 Auth Route Summary (`routes/auth.js`)

```js
const express  = require('express');
const router   = express.Router();
const UserService  = require('../services/UserService');
const TokenService = require('../services/TokenService');
const AuditService = require('../services/AuditService');
const { verifyAccessToken } = require('../middleware/auth');

// POST /auth/register — { email, password, name? }
// First user → auto-approved admin; subsequent → status=pending
router.post('/register', async (req, res) => { /* bcrypt.hash + UserService.create */ });

// POST /auth/login — { email, password }
// Validates password, checks status, issues JWT pair
router.post('/login', async (req, res) => { /* bcrypt.compare + issueAccessToken/Refresh */ });

// POST /auth/refresh — reads refreshToken cookie
// Validates hash, rotates refresh token, returns new accessToken
router.post('/refresh', async (req, res) => { /* TokenService.validateRefreshToken + rotate */ });

// POST /auth/logout — revokes refresh token, clears cookie
router.post('/logout', (req, res) => { /* TokenService.revokeRefreshToken + clearCookie */ });

// GET /auth/me — requires Bearer token, returns user record
router.get('/me', verifyAccessToken, (req, res) => { /* UserService.findById(req.user.sub) */ });

module.exports = router;
```

### 4.6 Admin Routes (`routes/admin.js`)

All routes apply `verifyAccessToken` + `requireRole('admin')` at router level.

```js
// GET  /admin/users?status=&search=   — list users
// GET  /admin/users/:id               — get single user
// PATCH /admin/users/:id              — { action: approve|reject|revoke|reactivate, role? }
// DELETE /admin/users/:id             — delete user (revokes all tokens)
// GET  /admin/audit?userId=&event=&limit=  — query audit log
```

---

## 5. Frontend Code Design

### 5.1 `stores/authStore.ts`

```ts
export type AppPage = 'signin' | 'pending' | 'dashboard' | 'admin';

interface AuthState {
  user: AuthUser | null;
  accessToken: string | null;
  page: AppPage;
  loading: boolean;
  error: string | null;

  register: (email, password, name?) => Promise<void>;
  login:    (email, password) => Promise<void>;
  logout:   () => Promise<void>;
  refresh:  () => Promise<boolean>;   // silent session restore on mount
  navigateTo: (page: AppPage) => void;
}
```

### 5.2 Auth Page Routing in `App.tsx`

No React Router needed — conditional rendering based on `authStore.page`:

```tsx
export default function App() {
  const auth = useAuthStore();

  // Silent refresh on mount (restore session from HttpOnly cookie)
  useEffect(() => {
    if (auth.user) return;
    auth.refresh();
  }, []);

  if (auth.page === 'signin')  return <SignInPage />;
  if (auth.page === 'pending') return <PendingPage />;
  if (auth.page === 'admin')   return <AdminUsersPage />;
  return <DashboardLayout />;   // page === 'dashboard'
}
```

### 5.3 Token Refresh Strategy

- Access token held in Zustand memory (lost on page reload → silent refresh on mount)
- On app startup: `POST /auth/refresh` via `HttpOnly` cookie → re-populates `authStore`
- Future: Axios interceptor on `401` can call `auth.refresh()` then retry once

---

## 6. Security Considerations

| Risk | Mitigation |
|---|---|
| XSS token theft | Access token in JS memory only; refresh token in `HttpOnly` cookie |
| CSRF on cookie | `SameSite=Strict` on refresh cookie; CORS origin whitelist with `credentials: true` |
| Token replay | Refresh tokens hashed (SHA-256) in storage; single-use rotation; blocklist on logout |
| Mass approval bypass | Status check on every login; no JWT issued for `pending`/`rejected` accounts |
| Privilege escalation | Role embedded in signed RS256 JWT; server re-validates role on every admin request |
| Weak passwords | bcrypt cost factor 12; minimum 8 characters enforced |
| Audit trail tampering | Audit log is append-only; entries never deleted (max 10 000 kept) |
| Account takeover | `revokeAllForUser` called on reject/revoke; all sessions invalidated immediately |

---

## 7. Dependencies Added

```
server/package.json:
  "bcryptjs":      "^2.x"   ← password hashing
  "cookie-parser": "^1.x"   ← HttpOnly cookie parsing
  (jsonwebtoken, uuid already present)

client/package.json:
  No new dependencies needed (uses native fetch + Zustand)
```

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Technical design for User Authentication |
| 1.2 | 2026-06-17 | LTS Engineering Team | 서비스 저장소 통합: users.json·tokens.json·audit.json → db.js 통합 (lts.json / MongoDB) |
