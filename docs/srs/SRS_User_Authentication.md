# SRS — User Authentication & Authorization

**Document ID:** SRS-LTS2026-AUTH-001  
**Issue Date:** 2026-05-28  
**Module:** User Authentication & Authorization  
**PRD Reference:** PRD-LTS2026-AUTH-001  
**Status:** Released  
**Rev:** 1.1 — Implemented as local email/password auth (OAuth deferred)

---

## 1. Overview

This document specifies the functional and non-functional requirements for the User Authentication & Authorization subsystem of the LTS-2026 Loitering Tracking System. The subsystem provides local email+password sign-up/sign-in (bcrypt), an admin-controlled approval workflow, JWT RS256-based session management, and role-based access control (RBAC).

> Google OAuth 2.0 and Microsoft Entra ID (MSAL) are deferred to a future release. The JWT / RBAC / audit infrastructure is designed to accommodate OAuth strategies without breaking changes.

---

## 2. Functional Requirements

### FR-AUTH-001 — Local Registration

- **Endpoint**: `POST /auth/register`
- **Input**: `{ email, password, name? }`
- **Processing**:
  1. Validate email format; validate password ≥ 8 characters
  2. Check email not already registered → 409 if duplicate
  3. Hash password with `bcrypt.hash(password, 12)`
  4. If first user in storage OR email matches `ADMIN_SEED_EMAIL`:
     set `status: "active"`, `role: "admin"`
  5. Otherwise: set `status: "pending"`, `role: "viewer"`
  6. Persist to `storage/users.json` with UUID, `createdAt`
  7. Log audit event `signup`
- **Success response**: `201 { user: { id, email, name, role, status } }`
- **Error paths**: 400 (validation), 409 (email taken)

### FR-AUTH-002 — Local Sign-In

- **Endpoint**: `POST /auth/login`
- **Input**: `{ email, password }`
- **Processing**:
  1. Look up user by email (including password hash)
  2. `bcrypt.compare(password, hash)` → 401 if mismatch
  3. Check `status`:
     - `"pending"` → `403 { error: "pending_approval" }`
     - `"rejected"` → `403 { error: "access_denied" }`
     - `"revoked"` → `403 { error: "access_denied" }`
     - `"active"` → proceed
  4. Issue access token and refresh token
  5. Update `lastLoginAt`, `loginCount`
  6. Log audit event `signin`
- **Success**: Set `refreshToken` as `HttpOnly Secure SameSite=Strict` cookie (7 days); return `{ accessToken, user }` in body

### FR-AUTH-003 — JWT Access Token

- Algorithm: RS256
- Payload claims: `sub` (userId), `email`, `role`, `name`, `iat`, `exp`
- Expiry: `JWT_ACCESS_EXPIRES` env var (default `15m`)
- Key: private key from `JWT_PRIVATE_KEY_PATH`

### FR-AUTH-004 — JWT Refresh Token

- Random 40-byte hex token; stored as SHA-256 hash in `storage/tokens.json`
- Expiry: `JWT_REFRESH_EXPIRES` env var (default `7d`)
- **Endpoint**: `POST /auth/refresh`
  - Read `refreshToken` cookie
  - Validate: hash exists in storage, not revoked, not expired
  - Rotate: issue new refresh token, revoke old hash
  - Issue new `accessToken`
  - Return `{ accessToken }` + new `Set-Cookie: refreshToken`
- On validation failure: `401 { error: "invalid_refresh_token" }`; clear cookie

### FR-AUTH-005 — Logout

- **Endpoint**: `POST /auth/logout`
- **Processing**:
  1. Hash the `refreshToken` cookie value
  2. Delete hash entry from `storage/tokens.json`
  3. Log audit event `logout`
  4. Clear `refreshToken` cookie (`maxAge: 0`)
- **Response**: `200 { ok: true }`

### FR-AUTH-006 — Current User Endpoint

- **Endpoint**: `GET /auth/me`
- **Authentication**: Bearer access token required
- **Response**: User object `{ id, email, name, role, status, createdAt, lastLoginAt }`

### FR-AUTH-007 — Admin: List Users

- **Endpoint**: `GET /admin/users?status=&search=`
- **Authentication**: Bearer token with `role: "admin"`
- **Query params**: `status` (pending|active|rejected|revoked|all), `search` (email/name substring)
- **Response**: Array of user objects (password hash excluded)

### FR-AUTH-008 — Admin: Approve User

- **Endpoint**: `PATCH /admin/users/:id` with body `{ action: "approve", role: "operator" | "viewer" | "admin" }`
- **Authentication**: Bearer token with `role: "admin"`
- **Processing**:
  1. Set `status: "active"`, `role: <provided>`, `approvedAt: now`, `approvedBy: req.user.sub`
  2. Log audit event `approved`
- **Response**: Updated user object
- **Error**: 404 if user not found

### FR-AUTH-009 — Admin: Reject User

- **Endpoint**: `PATCH /admin/users/:id` with body `{ action: "reject" }`
- **Processing**:
  1. Set `status: "rejected"`
  2. Revoke all refresh tokens for this user
  3. Log audit event `rejected`
- **Response**: Updated user object

### FR-AUTH-010 — Admin: Change Role

- **Endpoint**: `PATCH /admin/users/:id` with body `{ action: "set_role", role: "admin" | "operator" | "viewer" }` *(via role dropdown in UI; PATCH body: `{ role }`)*
- **Processing**:
  1. Validate user is `active`
  2. Update `role`
  3. Log audit event `role_changed`

### FR-AUTH-011 — Admin: Revoke User

- **Endpoint**: `PATCH /admin/users/:id` with body `{ action: "revoke" }`
- **Processing**:
  1. Set `status: "revoked"`
  2. Revoke all active refresh tokens for this user (`TokenService.revokeAllForUser`)
  3. Log audit event `revoked`

### FR-AUTH-012 — Admin: Reactivate User

- **Endpoint**: `PATCH /admin/users/:id` with body `{ action: "reactivate" }`
- **Processing**:
  1. Set `status: "active"`
  2. Log audit event `approved`

### FR-AUTH-013 — Admin: Delete User

- **Endpoint**: `DELETE /admin/users/:id`
- **Authentication**: Bearer token with `role: "admin"`
- **Processing**: Remove user record and all associated refresh tokens; log `deleted`
- **Constraint**: Cannot delete own account

### FR-AUTH-014 — Auth Page Routing (Frontend)

- All pages except `page='signin'` require a valid `authStore.user`
- `page='admin'` additionally requires `role === "admin"`
- Implemented via conditional rendering in `App.tsx` (no React Router)

### FR-AUTH-015 — Silent Token Refresh on App Load

- On application mount, `App.tsx` calls `auth.refresh()` (→ `POST /auth/refresh`)
- If successful: populate `authStore` with returned user + access token; navigate to `'dashboard'`
- If `401`: clear state, show `page='signin'`

### FR-AUTH-016 — Audit Logging

- Every auth event MUST be written to `storage/audit.json` with:
  `{ id, ts, event, userId, email, ip, userAgent, actorId, detail }`
- Log is append-only; max 10 000 entries (oldest pruned)
- Accessible via `GET /admin/audit?userId=&event=&limit=` (admin only)

### FR-AUTH-017 — RBAC Enforcement on Existing API Routes

- All existing API routes (cameras, alerts, zones, analytics) SHOULD include `verifyAccessToken` middleware
- Read endpoints (GET) accessible to `viewer`, `operator`, `admin`
- Write endpoints (POST, PUT, PATCH, DELETE) require `operator` or `admin`
- Zone configuration and camera management require `admin`

---

## 3. Non-Functional Requirements

### NFR-AUTH-001 — Performance

- `/auth/me` response time: ≤ 50 ms p95 (file I/O only)
- `/auth/login` server-side processing: ≤ 300 ms p95 (bcrypt hash cost 12)
- Token verification (middleware): ≤ 5 ms p95

### NFR-AUTH-002 — Security

- Passwords stored as bcrypt hashes (cost 12); never logged or returned in responses
- Refresh tokens stored as SHA-256 hashes; single-use rotation on refresh
- JWT signed with RS256; private key never exposed in responses or logs
- Access token not stored in `localStorage` or `sessionStorage`
- All auth endpoints over HTTPS in production (`HTTPS_ENABLED=true`)
- CORS restricted to `CLIENT_ORIGIN` with `credentials: true`

### NFR-AUTH-003 — Reliability

- `UserService` reads/writes are synchronous file operations with try/catch
- Startup failure if JWT key files are missing or unreadable (`process.exit(1)` with error)
- Token storage corruption: server logs warning and rejects all refresh tokens (forces re-login)

### NFR-AUTH-004 — Scalability

- JSON file storage sufficient for ≤ 500 users; upgrade path documented in Design doc
- Token blocklist pruned of expired entries on each server startup

### NFR-AUTH-005 — Privacy

- Only email, name, role, status, timestamps stored; no sensitive identity data
- User can be deleted via admin panel; all records removed from `users.json` and tokens cleared

### NFR-AUTH-006 — Observability

- Every auth event logged to `storage/audit.json` and `console.log` with `[AUTH]` prefix
- Failed token verifications logged at WARN level with masked token prefix (first 8 chars)

---

## 4. Constraints

- `ADMIN_SEED_EMAIL` or first-user-auto-promotion ensures at least one admin exists at bootstrap
- Server requires Node.js ≥ 18
- Single-node deployment only (refresh token storage in JSON file; not suitable for horizontal scaling)
- OAuth (Google/Microsoft) deferred; to be added as separate passport strategies when credentials are available

---

## 5. Acceptance Criteria

| ID | Criterion |
|---|---|
| AC-AUTH-001 | A new user registering (non-first) is created with `status: "pending"` and sees the pending page |
| AC-AUTH-002 | The first registered user (or ADMIN_SEED_EMAIL) gets `role: "admin"` and `status: "active"` automatically |
| AC-AUTH-003 | An admin can approve a pending user; the user can then sign in and receive a JWT |
| AC-AUTH-004 | A rejected/revoked user receives `403` on sign-in attempt |
| AC-AUTH-005 | Access token expires after 15 minutes; refresh token extends the session |
| AC-AUTH-006 | Logout revokes the refresh token; subsequent refresh calls return `401` |
| AC-AUTH-007 | A `viewer` role user cannot access write endpoints; receives `403` |
| AC-AUTH-008 | A non-admin user cannot access `/admin/users`; receives `403` |
| AC-AUTH-009 | All auth events appear in `storage/audit.json` with correct fields |
| AC-AUTH-010 | Silent refresh on page reload restores session without requiring re-login |

---

## 2. Functional Requirements

### FR-AUTH-001 — Google OAuth Sign-Up

- **Trigger**: User clicks "Continue with Google" on `/auth`
- **Input**: OAuth 2.0 authorization code (PKCE flow), Google `id_token`
- **Processing**:
  1. Exchange code for `id_token` at Google token endpoint
  2. Verify `id_token` signature and `aud` claim against `GOOGLE_CLIENT_ID`
  3. Extract `sub`, `email`, `name`, `picture` from claims
  4. Look up user by `{ provider: "google", providerAccountId: sub }`
  5. If not found: create user with `status: "pending"`, `role: "viewer"`
  6. If email matches `ADMIN_SEED_EMAIL` and first user: set `status: "active"`, `role: "admin"`
- **Success path (new user)**: Redirect to `/auth/pending`
- **Success path (returning active user)**: Issue JWT pair; redirect to `/dashboard`
- **Error path**: OAuth state mismatch or invalid token → 400 with error page

### FR-AUTH-002 — Microsoft OAuth Sign-Up

- Identical flow to FR-AUTH-001 using MSAL Node confidential client
- Claims source: Microsoft Graph `me` endpoint (`id`, `mail`, `displayName`)
- `provider: "microsoft"`, `providerAccountId: user.id`

### FR-AUTH-003 — Sign-In (Existing User)

- **Trigger**: Returning user completes OAuth flow (Google or Microsoft)
- **Processing**:
  1. Look up user by provider + providerAccountId
  2. Check `status`:
     - `"pending"` → return `403 { error: "pending_approval" }`
     - `"rejected"` → return `403 { error: "access_denied" }`
     - `"active"` → issue JWT pair; update `lastLoginAt`, `loginCount`
- **Success**: Set `refreshToken` as `HttpOnly Secure SameSite=Strict` cookie (7 days); return `{ accessToken, user }` in response body

### FR-AUTH-004 — JWT Access Token

- Algorithm: RS256
- Payload claims: `sub` (userId), `email`, `role`, `iat`, `exp`
- Expiry: `JWT_ACCESS_EXPIRES` env var (default `15m`)
- Key: private key from `JWT_PRIVATE_KEY_PATH`

### FR-AUTH-005 — JWT Refresh Token

- Random 40-byte hex token; stored as SHA-256 hash in `storage/tokens.json`
- Expiry: `JWT_REFRESH_EXPIRES` env var (default `7d`)
- **Endpoint**: `POST /auth/refresh`
  - Read `refreshToken` cookie
  - Validate: hash exists in storage, `revoked: false`, not expired
  - Issue new `accessToken` (does not rotate refresh token)
  - Return `{ accessToken }`
- On validation failure: `401 { error: "invalid_refresh_token" }`; clear cookie

### FR-AUTH-006 — Logout

- **Endpoint**: `POST /auth/logout`
- **Authentication**: Bearer access token required (verifyAccessToken middleware)
- **Processing**:
  1. Hash the `refreshToken` cookie value
  2. Set `revoked: true` in `storage/tokens.json` for that hash
  3. Log audit event `logout`
  4. Clear `refreshToken` cookie (`maxAge: 0`)
- **Response**: `200 { ok: true }`

### FR-AUTH-007 — Current User Endpoint

- **Endpoint**: `GET /auth/me`
- **Authentication**: Bearer access token required
- **Response**: User object `{ id, email, name, avatar, role, status }`

### FR-AUTH-008 — Admin: List Users

- **Endpoint**: `GET /admin/users?status=&search=`
- **Authentication**: Bearer token with `role: "admin"`
- **Query params**: `status` (pending|active|rejected|all), `search` (email/name substring)
- **Response**: Array of user objects with pagination metadata

### FR-AUTH-009 — Admin: Approve User

- **Endpoint**: `PATCH /admin/users/:id` with body `{ action: "approve", role: "operator" | "viewer" | "admin" }`
- **Authentication**: Bearer token with `role: "admin"`
- **Processing**:
  1. Validate user exists and `status === "pending"`
  2. Set `status: "active"`, `role: <provided>`, `approvedAt: now`, `approvedBy: req.user.sub`
  3. Log audit event `approved`
- **Response**: Updated user object
- **Error**: 404 if user not found; 409 if already active/rejected

### FR-AUTH-010 — Admin: Reject User

- **Endpoint**: `PATCH /admin/users/:id` with body `{ action: "reject" }`
- **Processing**:
  1. Set `status: "rejected"`
  2. Log audit event `rejected`
- **Response**: Updated user object

### FR-AUTH-011 — Admin: Change Role

- **Endpoint**: `PATCH /admin/users/:id` with body `{ action: "set_role", role: "admin" | "operator" | "viewer" }`
- **Processing**:
  1. Validate user is `active`
  2. Update `role`
  3. Log audit event `role_changed`
- **Constraint**: An admin cannot downgrade their own role if they are the only admin

### FR-AUTH-012 — Admin: Revoke User

- **Endpoint**: `PATCH /admin/users/:id` with body `{ action: "revoke" }`
- **Processing**:
  1. Set `status: "pending"` (suspends login)
  2. Revoke all active refresh tokens for this user
  3. Log audit event `revoked`

### FR-AUTH-013 — Admin: Delete User

- **Endpoint**: `DELETE /admin/users/:id`
- **Authentication**: Bearer token with `role: "admin"`
- **Processing**: Remove user record and all associated refresh tokens; log `deleted`
- **Constraint**: Cannot delete own account

### FR-AUTH-014 — Route Guard (Frontend)

- All routes except `/auth` and `/auth/pending` require a valid `authStore.user`
- Routes under `/admin/*` additionally require `role === "admin"`
- On missing auth: redirect to `/auth`
- On insufficient role: redirect to `/dashboard`

### FR-AUTH-015 — Silent Token Refresh on App Load

- On application mount, `App.tsx` calls `POST /auth/refresh`
- If successful: populate `authStore` with returned user + access token
- If `401`: clear cookie, show `/auth`

### FR-AUTH-016 — Axios Interceptor for 401 Retry

- On any API response `401 { error: "token_expired" }`:
  1. Attempt one `POST /auth/refresh`
  2. Retry original request with new access token
  3. On second `401`: dispatch `clearAuth()` and navigate to `/auth`

### FR-AUTH-017 — Audit Logging

- Every auth event MUST be written to `storage/audit.json` with:
  `{ id, ts, event, userId, email, provider, ip, userAgent, actorId, detail }`
- Log is append-only; no deletion
- Accessible via `GET /admin/audit` (admin only, P2)

### FR-AUTH-018 — RBAC Enforcement on Existing API Routes

- All existing API routes (cameras, alerts, zones, analytics) MUST include `verifyAccessToken` middleware
- Read endpoints (GET) accessible to `viewer`, `operator`, `admin`
- Write endpoints (POST, PUT, PATCH, DELETE) require `operator` or `admin`
- Zone configuration and camera management require `admin`

---

## 3. Non-Functional Requirements

### NFR-AUTH-001 — Performance

- `/auth/me` response time: ≤ 50 ms p95 (file I/O only)
- OAuth callback total server-side processing: ≤ 300 ms p95 (excluding IdP latency)
- Token verification (middleware): ≤ 5 ms p95

### NFR-AUTH-002 — Security

- Refresh tokens stored as SHA-256 hashes; never stored in plaintext
- JWT signed with RS256; private key never exposed in responses or logs
- PKCE (`code_verifier` / `code_challenge`) used for both OAuth providers
- `state` parameter validated on every OAuth callback to prevent CSRF
- Access token not stored in `localStorage` or `sessionStorage`
- All auth endpoints over HTTPS in production (`HTTPS_ENABLED=true`)

### NFR-AUTH-003 — Reliability

- `UserService` reads/writes are synchronous file operations with try/catch
- Startup failure if JWT key files are missing or unreadable (`process.exit(1)` with error)
- Token storage corruption: server logs warning and rejects all refresh tokens (forces re-login)

### NFR-AUTH-004 — Scalability

- JSON file storage sufficient for ≤ 500 users; upgrade path documented in Design doc
- Token blocklist pruned of expired entries on each server startup

### NFR-AUTH-005 — Privacy / GDPR

- Only `openid email profile` OAuth scopes requested
- No sensitive IdP data (phone numbers, addresses) stored
- User can request deletion via admin panel; all records removed from `users.json` and `audit.json`

### NFR-AUTH-006 — Observability

- Every auth event logged to `storage/audit.json` and `console.log` with `[AUTH]` prefix
- Failed token verifications logged at WARN level with masked token prefix (first 8 chars)

---

## 4. Constraints

- OAuth redirect URIs must be registered in Google Cloud Console and Microsoft Entra app registration
- `ADMIN_SEED_EMAIL` must be set before first deployment; the first user matching this email is auto-approved as admin
- Server requires Node.js ≥ 18 for `crypto.randomBytes` and `jose` / `jsonwebtoken` compatibility
- Single-node deployment only (refresh token storage in JSON file; not suitable for horizontal scaling)

---

## 5. Acceptance Criteria

| ID | Criterion |
|---|---|
| AC-AUTH-001 | A new Google user completing OAuth is created with `status: "pending"` and sees the pending page |
| AC-AUTH-002 | An admin can approve a pending user; the user can then sign in and receive a JWT |
| AC-AUTH-003 | A rejected user receives `403 access_denied` on sign-in attempt |
| AC-AUTH-004 | Access token expires after 15 minutes; refresh token extends the session |
| AC-AUTH-005 | Logout revokes the refresh token; subsequent refresh calls return `401` |
| AC-AUTH-006 | A `viewer` role user cannot access write endpoints; receives `403` |
| AC-AUTH-007 | A non-admin user cannot access `/admin/users`; receives `403` |
| AC-AUTH-008 | All auth events appear in `storage/audit.json` with correct fields |
| AC-AUTH-009 | Existing dashboard and camera routes return `401` when no valid JWT is present |
| AC-AUTH-010 | Silent refresh on page reload restores session without requiring re-login |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — SRS for User Authentication |
