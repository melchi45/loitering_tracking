# TC — User Authentication & Authorization

**Document ID:** TC-LTS2026-AUTH-001  
**Issue Date:** 2026-05-28  
**Module:** User Authentication & Authorization  
**SRS Reference:** SRS-LTS2026-AUTH-001  
**Design Reference:** Design-LTS2026-AUTH-001  
**Test Scripts:** test/api/auth.test.js, test/api/admin_users.test.js  
**Status:** Released  
**Rev:** 1.1 — Updated for local email/password auth (OAuth tests deferred)

---

## Group A — Local Registration

### TC-AUTH-A-001: New user registration — creates pending record

| Field | Value |
|---|---|
| **Precondition** | No user with test email exists in `storage/users.json` |
| **Input** | `POST /auth/register` `{ email: "newuser@test.com", password: "TestPass1!", name: "New User" }` |
| **Expected** | `201`; user created with `status: "pending"`, `role: "viewer"` |
| **Validation** | `users.json` contains new entry (no password in response); audit log contains `signup` event |
| **SRS** | FR-AUTH-001 |

### TC-AUTH-A-002: First user auto-promoted to admin

| Field | Value |
|---|---|
| **Precondition** | `storage/users.json` is empty (or does not exist) |
| **Input** | `POST /auth/register` `{ email: "first@test.com", password: "TestPass1!" }` |
| **Expected** | `201`; user has `status: "active"`, `role: "admin"` |
| **Validation** | User can immediately log in without admin approval |
| **SRS** | FR-AUTH-001 |

### TC-AUTH-A-003: ADMIN_SEED_EMAIL auto-approved regardless of order

| Field | Value |
|---|---|
| **Precondition** | `ADMIN_SEED_EMAIL=admin@lts.local`; one other user already exists |
| **Input** | `POST /auth/register` `{ email: "admin@lts.local", password: "TestPass1!" }` |
| **Expected** | `201`; user has `status: "active"`, `role: "admin"` |
| **SRS** | FR-AUTH-001 |

### TC-AUTH-A-004: Duplicate email registration rejected

| Field | Value |
|---|---|
| **Precondition** | User with `email@test.com` already exists |
| **Input** | `POST /auth/register` with same email |
| **Expected** | `409 Conflict`; error message "Email already registered" |
| **SRS** | FR-AUTH-001 |

### TC-AUTH-A-005: Password too short rejected

| Field | Value |
|---|---|
| **Input** | `POST /auth/register` `{ email: "x@test.com", password: "short" }` |
| **Expected** | `400 Bad Request`; error about password length |
| **SRS** | FR-AUTH-001 |

### TC-AUTH-A-006: Missing email rejected

| Field | Value |
|---|---|
| **Input** | `POST /auth/register` `{ password: "TestPass1!" }` (no email) |
| **Expected** | `400 Bad Request`; validation error |
| **SRS** | FR-AUTH-001 |

---

## Group B — Local Sign-In

### TC-AUTH-B-001: Active user signs in — JWT pair issued

| Field | Value |
|---|---|
| **Precondition** | User exists with `status: "active"` and known password |
| **Input** | `POST /auth/login` `{ email, password }` |
| **Expected** | `200`; body `{ accessToken, user: { id, email, role } }`; `Set-Cookie: refreshToken` (HttpOnly, Secure, SameSite=Strict) |
| **Validation** | `lastLoginAt` updated in `users.json`; `loginCount` incremented; audit log `signin` |
| **SRS** | FR-AUTH-002 |

### TC-AUTH-B-002: Wrong password rejected

| Field | Value |
|---|---|
| **Precondition** | Active user exists |
| **Input** | `POST /auth/login` with correct email but wrong password |
| **Expected** | `401 { error: "Invalid credentials" }` |
| **SRS** | FR-AUTH-002 |

### TC-AUTH-B-003: Pending user sign-in rejected

| Field | Value |
|---|---|
| **Precondition** | User with `status: "pending"` |
| **Input** | `POST /auth/login` with correct credentials |
| **Expected** | `403 { error: "pending_approval" }` |
| **SRS** | FR-AUTH-002 |

### TC-AUTH-B-004: Rejected user sign-in rejected

| Field | Value |
|---|---|
| **Precondition** | User with `status: "rejected"` |
| **Input** | `POST /auth/login` with correct credentials |
| **Expected** | `403 { error: "access_denied" }` |
| **SRS** | FR-AUTH-002 |

### TC-AUTH-B-005: Non-existent user rejected

| Field | Value |
|---|---|
| **Input** | `POST /auth/login` `{ email: "nobody@test.com", password: "anything" }` |
| **Expected** | `401 { error: "Invalid credentials" }` (same as wrong password; no user enumeration) |
| **SRS** | FR-AUTH-002 |

---

## Group C — JWT Token Management

### TC-AUTH-C-001: Access token contains correct claims

| Field | Value |
|---|---|
| **Input** | Decode access token from successful sign-in |
| **Expected** | Payload contains: `sub` (userId), `email`, `role`, `name`, `iat`, `exp` (exp = iat + 900s) |
| **Validation** | `jwt.verify(token, pubKey, { algorithms: ['RS256'] })` succeeds |
| **SRS** | FR-AUTH-003 |

### TC-AUTH-C-002: Expired access token rejected

| Field | Value |
|---|---|
| **Precondition** | Access token issued with `exp = now - 1s` (mock or wait) |
| **Input** | `GET /auth/me` with expired token |
| **Expected** | `401 { error: "Invalid or expired token" }` |
| **SRS** | FR-AUTH-003 |

### TC-AUTH-C-003: Token refresh — valid refresh token returns new access token

| Field | Value |
|---|---|
| **Precondition** | Active session; valid `refreshToken` cookie |
| **Input** | `POST /auth/refresh` |
| **Expected** | `200 { accessToken }`; new token has fresh `exp`; `Set-Cookie` with new rotated refreshToken |
| **SRS** | FR-AUTH-004 |

### TC-AUTH-C-004: Token refresh — revoked refresh token rejected

| Field | Value |
|---|---|
| **Precondition** | Refresh token entry in storage with `revoked: true` |
| **Input** | `POST /auth/refresh` with that token in cookie |
| **Expected** | `401 { error: "invalid_refresh_token" }`; `Set-Cookie` clears cookie |
| **SRS** | FR-AUTH-004 |

### TC-AUTH-C-005: Token refresh — expired refresh token rejected

| Field | Value |
|---|---|
| **Precondition** | Refresh token in storage with `expiresAt` in the past |
| **Input** | `POST /auth/refresh` |
| **Expected** | `401 { error: "invalid_refresh_token" }` |
| **SRS** | FR-AUTH-004 |

### TC-AUTH-C-006: Refresh token missing (no cookie)

| Field | Value |
|---|---|
| **Input** | `POST /auth/refresh` with no cookies |
| **Expected** | `401 { error: "invalid_refresh_token" }` |
| **SRS** | FR-AUTH-004 |

---

## Group D — Logout

### TC-AUTH-D-001: Logout revokes refresh token

| Field | Value |
|---|---|
| **Precondition** | Active session with valid access + refresh tokens |
| **Input** | `POST /auth/logout` with `refreshToken` cookie |
| **Expected** | `200 { ok: true }`; refresh token removed from `tokens.json`; `Set-Cookie` clears cookie |
| **Validation** | Audit log contains `logout` event |
| **SRS** | FR-AUTH-005 |

### TC-AUTH-D-002: Subsequent refresh after logout fails

| Field | Value |
|---|---|
| **Precondition** | Logout performed in TC-AUTH-D-001 |
| **Input** | `POST /auth/refresh` with old refresh token cookie |
| **Expected** | `401 { error: "invalid_refresh_token" }` |
| **SRS** | FR-AUTH-005 |

### TC-AUTH-D-003: Logout with no cookie succeeds silently

| Field | Value |
|---|---|
| **Input** | `POST /auth/logout` without `refreshToken` cookie |
| **Expected** | `200 { ok: true }` (graceful no-op) |
| **SRS** | FR-AUTH-005 |

---

## Group E — Current User Endpoint

### TC-AUTH-E-001: GET /auth/me returns user profile

| Field | Value |
|---|---|
| **Precondition** | Active user with valid access token |
| **Input** | `GET /auth/me` with `Authorization: Bearer <token>` |
| **Expected** | `200 { id, email, name, role, status, createdAt, lastLoginAt }` |
| **SRS** | FR-AUTH-006 |

### TC-AUTH-E-002: GET /auth/me without token rejected

| Field | Value |
|---|---|
| **Input** | `GET /auth/me` without Authorization header |
| **Expected** | `401 { error: "No token" }` |
| **SRS** | FR-AUTH-006 |

---

## Group F — Admin: User Management

### TC-AUTH-F-001: Admin retrieves list of pending users

| Field | Value |
|---|---|
| **Precondition** | 3 pending users in storage; admin token |
| **Input** | `GET /admin/users?status=pending` with admin JWT |
| **Expected** | `200`; array of 3 user objects with `status: "pending"` |
| **SRS** | FR-AUTH-007 |

### TC-AUTH-F-002: Non-admin access to /admin/users rejected

| Field | Value |
|---|---|
| **Precondition** | Valid `operator` role token |
| **Input** | `GET /admin/users` with operator JWT |
| **Expected** | `403 { error: "Insufficient role" }` |
| **SRS** | FR-AUTH-007 |

### TC-AUTH-F-003: Admin approves pending user

| Field | Value |
|---|---|
| **Precondition** | User with `status: "pending"` |
| **Input** | `PATCH /admin/users/:id` `{ action: "approve", role: "operator" }` |
| **Expected** | `200`; user has `status: "active"`, `role: "operator"`, `approvedAt` set, `approvedBy` = admin ID |
| **Validation** | Audit log contains `approved` event |
| **SRS** | FR-AUTH-008 |

### TC-AUTH-F-004: Admin rejects pending user

| Field | Value |
|---|---|
| **Precondition** | User with `status: "pending"` |
| **Input** | `PATCH /admin/users/:id` `{ action: "reject" }` |
| **Expected** | `200`; user has `status: "rejected"` |
| **Validation** | Audit log contains `rejected` event; all tokens for that user revoked |
| **SRS** | FR-AUTH-009 |

### TC-AUTH-F-005: Admin changes role of active user

| Field | Value |
|---|---|
| **Precondition** | Active user with `role: "viewer"` |
| **Input** | `PATCH /admin/users/:id` `{ role: "operator" }` |
| **Expected** | `200`; user has `role: "operator"` |
| **Validation** | Audit log contains `role_changed` event |
| **SRS** | FR-AUTH-010 |

### TC-AUTH-F-006: Admin revokes active user — tokens invalidated

| Field | Value |
|---|---|
| **Precondition** | Active user with refresh token in storage |
| **Input** | `PATCH /admin/users/:id` `{ action: "revoke" }` |
| **Expected** | `200`; user `status: "revoked"`; all refresh tokens for that user removed |
| **Validation** | Audit log contains `revoked` event |
| **SRS** | FR-AUTH-011 |

### TC-AUTH-F-007: Admin reactivates rejected user

| Field | Value |
|---|---|
| **Precondition** | User with `status: "rejected"` |
| **Input** | `PATCH /admin/users/:id` `{ action: "reactivate" }` |
| **Expected** | `200`; user has `status: "active"` |
| **SRS** | FR-AUTH-012 |

### TC-AUTH-F-008: Admin deletes user

| Field | Value |
|---|---|
| **Precondition** | Non-admin user in storage |
| **Input** | `DELETE /admin/users/:id` with admin JWT |
| **Expected** | `200 { ok: true }`; user removed from `users.json`; all tokens removed |
| **Validation** | Audit log contains `deleted` event |
| **SRS** | FR-AUTH-013 |

### TC-AUTH-F-009: Admin cannot delete own account

| Field | Value |
|---|---|
| **Precondition** | Admin authenticated |
| **Input** | `DELETE /admin/users/:ownId` |
| **Expected** | `403 { error: "Cannot delete own account" }` |
| **SRS** | FR-AUTH-013 |

### TC-AUTH-F-010: Search users by email substring

| Field | Value |
|---|---|
| **Precondition** | Multiple users in storage |
| **Input** | `GET /admin/users?search=test` with admin JWT |
| **Expected** | `200`; only users whose email or name contains "test" |
| **SRS** | FR-AUTH-007 |

---

## Group G — RBAC Enforcement on Existing Routes

### TC-AUTH-G-001: Unauthenticated request to camera API rejected

| Field | Value |
|---|---|
| **Input** | `GET /api/cameras` without Authorization header |
| **Expected** | `401 { error: "No token" }` |
| **SRS** | FR-AUTH-017 |

### TC-AUTH-G-002: Viewer can read cameras

| Field | Value |
|---|---|
| **Precondition** | User with `role: "viewer"` |
| **Input** | `GET /api/cameras` with viewer JWT |
| **Expected** | `200` with camera list |
| **SRS** | FR-AUTH-017 |

### TC-AUTH-G-003: Viewer cannot create camera

| Field | Value |
|---|---|
| **Precondition** | User with `role: "viewer"` |
| **Input** | `POST /api/cameras` with viewer JWT |
| **Expected** | `403 { error: "Insufficient role" }` |
| **SRS** | FR-AUTH-017 |

---

## Group H — Frontend: Page Routing & Silent Refresh

### TC-AUTH-H-001: Unauthenticated user sees SignInPage

| Field | Value |
|---|---|
| **Precondition** | No auth state in `authStore`; no valid refresh cookie |
| **Input** | App loads |
| **Expected** | `page='signin'` rendered; `<SignInPage>` shown |
| **SRS** | FR-AUTH-014 |

### TC-AUTH-H-002: Non-admin cannot navigate to AdminUsersPage

| Field | Value |
|---|---|
| **Precondition** | Authenticated user with `role: "viewer"` |
| **Input** | `auth.navigateTo('admin')` called |
| **Expected** | Navigation ignored; user stays on dashboard (userMenu does not show "User Management" link) |
| **SRS** | FR-AUTH-014 |

### TC-AUTH-H-003: Silent refresh restores session on page reload

| Field | Value |
|---|---|
| **Precondition** | User has valid `refreshToken` cookie; page refreshed (Zustand memory cleared) |
| **Input** | App mounts; `auth.refresh()` called automatically |
| **Expected** | `authStore` populated with user + access token; `page='dashboard'` rendered without showing SignInPage |
| **SRS** | FR-AUTH-015 |

### TC-AUTH-H-004: Pending user sees PendingPage after registration

| Field | Value |
|---|---|
| **Precondition** | Second (non-first) user registers |
| **Input** | `auth.register(email, password)` succeeds |
| **Expected** | `page='pending'` rendered; `<PendingPage>` shows waiting message |
| **SRS** | FR-AUTH-001, FR-AUTH-014 |

---

## Group A — Google OAuth Sign-Up

### TC-AUTH-A-001: New user sign-up via Google — creates pending record

| Field | Value |
|---|---|
| **Precondition** | No user with test email exists in `storage/users.json` |
| **Input** | Simulate `GET /auth/google/callback` with valid Google `id_token` |
| **Expected** | User created with `status: "pending"`, `role: "viewer"`, `provider: "google"` |
| **Validation** | `users.json` contains new entry; response redirects to `/auth/pending` |
| **SRS** | FR-AUTH-001 |

### TC-AUTH-A-002: Existing pending user re-attempts Google OAuth

| Field | Value |
|---|---|
| **Precondition** | User with `status: "pending"` exists for test email |
| **Input** | Same Google OAuth callback |
| **Expected** | No duplicate user created; redirect to `/auth/pending` |
| **Validation** | `users.json` still has exactly one record for that email |
| **SRS** | FR-AUTH-001 |

### TC-AUTH-A-003: Admin seed email auto-approved on first sign-up

| Field | Value |
|---|---|
| **Precondition** | `ADMIN_SEED_EMAIL=admin@test.com`; no users in storage |
| **Input** | Google OAuth callback for `admin@test.com` |
| **Expected** | User created with `status: "active"`, `role: "admin"`; JWT pair issued |
| **Validation** | Response body contains `accessToken`; `Set-Cookie` header with `refreshToken` |
| **SRS** | FR-AUTH-001 |

### TC-AUTH-A-004: OAuth state parameter mismatch

| Field | Value |
|---|---|
| **Precondition** | Valid OAuth flow initiated |
| **Input** | Callback with tampered `state` parameter |
| **Expected** | `400 Bad Request`; error page shown; no user created |
| **SRS** | FR-AUTH-001, NFR-AUTH-002 |

### TC-AUTH-A-005: Invalid id_token signature rejected

| Field | Value |
|---|---|
| **Precondition** | N/A |
| **Input** | `GET /auth/google/callback` with malformed or unsigned `id_token` |
| **Expected** | `400 Bad Request`; no user created; audit log event `signup_failed` |
| **SRS** | FR-AUTH-001 |

---

## Group B — Microsoft OAuth Sign-Up

### TC-AUTH-B-001: New user sign-up via Microsoft — creates pending record

| Field | Value |
|---|---|
| **Precondition** | No user with test email in storage |
| **Input** | Simulate MSAL callback with valid token |
| **Expected** | User created with `status: "pending"`, `provider: "microsoft"` |
| **SRS** | FR-AUTH-002 |

### TC-AUTH-B-002: Microsoft user with same email as existing Google user

| Field | Value |
|---|---|
| **Precondition** | Active Google user with `email@test.com` exists |
| **Input** | Microsoft OAuth callback for same `email@test.com` |
| **Expected** | Second user created with `provider: "microsoft"` (separate account) OR linked — per design decision; no existing record overwritten |
| **SRS** | FR-AUTH-002 |

---

## Group C — Sign-In (Returning User)

### TC-AUTH-C-001: Active user signs in — JWT pair issued

| Field | Value |
|---|---|
| **Precondition** | User exists with `status: "active"` |
| **Input** | Google OAuth callback for that user |
| **Expected** | `200 OK`; response body `{ accessToken, user: { id, email, role } }`; `Set-Cookie: refreshToken` (HttpOnly, Secure, SameSite=Strict) |
| **Validation** | `lastLoginAt` updated in `users.json`; `loginCount` incremented |
| **SRS** | FR-AUTH-003 |

### TC-AUTH-C-002: Pending user attempts sign-in

| Field | Value |
|---|---|
| **Precondition** | User exists with `status: "pending"` |
| **Input** | OAuth callback |
| **Expected** | `403 { error: "pending_approval" }` |
| **SRS** | FR-AUTH-003 |

### TC-AUTH-C-003: Rejected user attempts sign-in

| Field | Value |
|---|---|
| **Precondition** | User exists with `status: "rejected"` |
| **Input** | OAuth callback |
| **Expected** | `403 { error: "access_denied" }` |
| **SRS** | FR-AUTH-003 |

---

## Group D — JWT Token Management

### TC-AUTH-D-001: Access token contains correct claims

| Field | Value |
|---|---|
| **Input** | Decode access token from successful sign-in |
| **Expected** | Payload contains: `sub` (userId), `email`, `role`, `iat`, `exp` (exp = iat + 900s) |
| **Validation** | `jwt.verify(token, pubKey, { algorithms: ['RS256'] })` succeeds |
| **SRS** | FR-AUTH-004 |

### TC-AUTH-D-002: Expired access token rejected

| Field | Value |
|---|---|
| **Precondition** | Access token issued with `exp = now - 1s` (mock) |
| **Input** | `GET /auth/me` with expired token |
| **Expected** | `401 { error: "Invalid or expired token" }` |
| **SRS** | FR-AUTH-004 |

### TC-AUTH-D-003: Token refresh — valid refresh token returns new access token

| Field | Value |
|---|---|
| **Precondition** | Active session; valid `refreshToken` cookie |
| **Input** | `POST /auth/refresh` |
| **Expected** | `200 { accessToken }`; new token has fresh `exp` |
| **SRS** | FR-AUTH-005 |

### TC-AUTH-D-004: Token refresh — revoked refresh token rejected

| Field | Value |
|---|---|
| **Precondition** | Refresh token exists in storage with `revoked: true` |
| **Input** | `POST /auth/refresh` with that token in cookie |
| **Expected** | `401 { error: "invalid_refresh_token" }`; `Set-Cookie` clears cookie |
| **SRS** | FR-AUTH-005 |

### TC-AUTH-D-005: Token refresh — expired refresh token rejected

| Field | Value |
|---|---|
| **Precondition** | Refresh token in storage with `expiresAt` in the past |
| **Input** | `POST /auth/refresh` |
| **Expected** | `401 { error: "invalid_refresh_token" }` |
| **SRS** | FR-AUTH-005 |

### TC-AUTH-D-006: Refresh token missing (no cookie)

| Field | Value |
|---|---|
| **Input** | `POST /auth/refresh` with no cookies |
| **Expected** | `401 { error: "invalid_refresh_token" }` |
| **SRS** | FR-AUTH-005 |

---

## Group E — Logout

### TC-AUTH-E-001: Logout revokes refresh token

| Field | Value |
|---|---|
| **Precondition** | Active session with valid access + refresh tokens |
| **Input** | `POST /auth/logout` with `Authorization: Bearer <accessToken>` and `refreshToken` cookie |
| **Expected** | `200 { ok: true }`; `refreshToken` entry in storage has `revoked: true`; `Set-Cookie` clears cookie |
| **SRS** | FR-AUTH-006 |

### TC-AUTH-E-002: Subsequent refresh after logout fails

| Field | Value |
|---|---|
| **Precondition** | Logout performed in TC-AUTH-E-001 |
| **Input** | `POST /auth/refresh` with old refresh token cookie |
| **Expected** | `401 { error: "invalid_refresh_token" }` |
| **SRS** | FR-AUTH-006 |

### TC-AUTH-E-003: Logout without access token rejected

| Field | Value |
|---|---|
| **Input** | `POST /auth/logout` without `Authorization` header |
| **Expected** | `401 { error: "No token" }` |
| **SRS** | FR-AUTH-006 |

---

## Group F — Admin: User Management

### TC-AUTH-F-001: Admin retrieves list of pending users

| Field | Value |
|---|---|
| **Precondition** | 3 pending users in storage; admin token |
| **Input** | `GET /admin/users?status=pending` with admin JWT |
| **Expected** | `200`; array of 3 user objects with `status: "pending"` |
| **SRS** | FR-AUTH-008 |

### TC-AUTH-F-002: Non-admin access to /admin/users rejected

| Field | Value |
|---|---|
| **Precondition** | Valid `operator` role token |
| **Input** | `GET /admin/users` with operator JWT |
| **Expected** | `403 { error: "Insufficient role" }` |
| **SRS** | FR-AUTH-008 |

### TC-AUTH-F-003: Admin approves pending user

| Field | Value |
|---|---|
| **Precondition** | User with `status: "pending"` |
| **Input** | `PATCH /admin/users/:id` `{ action: "approve", role: "operator" }` |
| **Expected** | `200`; user has `status: "active"`, `role: "operator"`, `approvedAt` set, `approvedBy` set to admin ID |
| **Validation** | Audit log contains `approved` event |
| **SRS** | FR-AUTH-009 |

### TC-AUTH-F-004: Approve already-active user returns 409

| Field | Value |
|---|---|
| **Precondition** | User with `status: "active"` |
| **Input** | `PATCH /admin/users/:id` `{ action: "approve", role: "viewer" }` |
| **Expected** | `409 Conflict` |
| **SRS** | FR-AUTH-009 |

### TC-AUTH-F-005: Admin rejects pending user

| Field | Value |
|---|---|
| **Precondition** | User with `status: "pending"` |
| **Input** | `PATCH /admin/users/:id` `{ action: "reject" }` |
| **Expected** | `200`; user has `status: "rejected"` |
| **Validation** | Audit log contains `rejected` event |
| **SRS** | FR-AUTH-010 |

### TC-AUTH-F-006: Admin changes role of active user

| Field | Value |
|---|---|
| **Precondition** | Active user with `role: "viewer"` |
| **Input** | `PATCH /admin/users/:id` `{ action: "set_role", role: "operator" }` |
| **Expected** | `200`; user has `role: "operator"` |
| **Validation** | Audit log contains `role_changed` event |
| **SRS** | FR-AUTH-011 |

### TC-AUTH-F-007: Admin cannot self-downgrade if only admin

| Field | Value |
|---|---|
| **Precondition** | Only one admin in storage; admin attempts to change own role |
| **Input** | `PATCH /admin/users/:adminId` `{ action: "set_role", role: "viewer" }` |
| **Expected** | `409 Conflict`; error message "Cannot remove last admin" |
| **SRS** | FR-AUTH-011 |

### TC-AUTH-F-008: Admin revokes active user — tokens invalidated

| Field | Value |
|---|---|
| **Precondition** | Active user with refresh token in storage |
| **Input** | `PATCH /admin/users/:id` `{ action: "revoke" }` |
| **Expected** | `200`; user `status: "pending"`; all refresh tokens for that user have `revoked: true` |
| **SRS** | FR-AUTH-012 |

### TC-AUTH-F-009: Admin deletes user

| Field | Value |
|---|---|
| **Precondition** | Non-admin user in storage |
| **Input** | `DELETE /admin/users/:id` with admin JWT |
| **Expected** | `200 { ok: true }`; user removed from `users.json`; tokens removed |
| **SRS** | FR-AUTH-013 |

### TC-AUTH-F-010: Admin cannot delete own account

| Field | Value |
|---|---|
| **Precondition** | Admin authenticated |
| **Input** | `DELETE /admin/users/:ownId` |
| **Expected** | `403 { error: "Cannot delete own account" }` |
| **SRS** | FR-AUTH-013 |

---

## Group G — Current User Endpoint

### TC-AUTH-G-001: GET /auth/me returns user profile

| Field | Value |
|---|---|
| **Precondition** | Active user with valid access token |
| **Input** | `GET /auth/me` with `Authorization: Bearer <token>` |
| **Expected** | `200 { id, email, name, avatar, role, status }` |
| **SRS** | FR-AUTH-007 |

### TC-AUTH-G-002: GET /auth/me without token rejected

| Field | Value |
|---|---|
| **Input** | `GET /auth/me` without Authorization header |
| **Expected** | `401 { error: "No token" }` |
| **SRS** | FR-AUTH-007 |

---

## Group H — RBAC Enforcement on Existing Routes

### TC-AUTH-H-001: Unauthenticated request to camera API rejected

| Field | Value |
|---|---|
| **Input** | `GET /api/cameras` without Authorization header |
| **Expected** | `401 { error: "No token" }` |
| **SRS** | FR-AUTH-018 |

### TC-AUTH-H-002: Viewer can read cameras

| Field | Value |
|---|---|
| **Precondition** | User with `role: "viewer"` |
| **Input** | `GET /api/cameras` with viewer JWT |
| **Expected** | `200` with camera list |
| **SRS** | FR-AUTH-018 |

### TC-AUTH-H-003: Viewer cannot create camera

| Field | Value |
|---|---|
| **Precondition** | User with `role: "viewer"` |
| **Input** | `POST /api/cameras` with viewer JWT |
| **Expected** | `403 { error: "Insufficient role" }` |
| **SRS** | FR-AUTH-018 |

### TC-AUTH-H-004: Operator can create camera

| Field | Value |
|---|---|
| **Precondition** | User with `role: "operator"` |
| **Input** | `POST /api/cameras` with valid body and operator JWT |
| **Expected** | `200` or `201` with created camera |
| **SRS** | FR-AUTH-018 |

### TC-AUTH-H-005: Zone configuration requires admin

| Field | Value |
|---|---|
| **Precondition** | User with `role: "operator"` |
| **Input** | `PATCH /api/zones` with operator JWT |
| **Expected** | `403 { error: "Insufficient role" }` |
| **SRS** | FR-AUTH-018 |

---

## Group I — Frontend: Route Guard & Silent Refresh

### TC-AUTH-I-001: Unauthenticated user redirected from /dashboard to /auth

| Field | Value |
|---|---|
| **Precondition** | No auth state in `authStore`; no valid refresh cookie |
| **Input** | Navigate to `/dashboard` |
| **Expected** | Redirect to `/auth` |
| **SRS** | FR-AUTH-014 |

### TC-AUTH-I-002: Non-admin redirected from /admin/users to /dashboard

| Field | Value |
|---|---|
| **Precondition** | Authenticated user with `role: "viewer"` |
| **Input** | Navigate to `/admin/users` |
| **Expected** | Redirect to `/dashboard` |
| **SRS** | FR-AUTH-014 |

### TC-AUTH-I-003: Silent refresh restores session on page reload

| Field | Value |
|---|---|
| **Precondition** | User has valid `refreshToken` cookie; page refreshed (memory cleared) |
| **Input** | App mounts; `POST /auth/refresh` called automatically |
| **Expected** | `authStore` populated with user + access token; `/dashboard` rendered without redirect to `/auth` |
| **SRS** | FR-AUTH-015 |

### TC-AUTH-I-004: Silent refresh fails — user sent to /auth

| Field | Value |
|---|---|
| **Precondition** | `refreshToken` cookie is expired or revoked |
| **Input** | App mounts; `POST /auth/refresh` returns `401` |
| **Expected** | Redirect to `/auth`; `authStore` remains empty |
| **SRS** | FR-AUTH-015 |

### TC-AUTH-I-005: 401 interceptor retries once then redirects

| Field | Value |
|---|---|
| **Precondition** | Access token expires mid-session; valid refresh token |
| **Input** | API call returns `401`; interceptor refreshes; retries call |
| **Expected** | Original API call succeeds with new access token; user session uninterrupted |
| **SRS** | FR-AUTH-016 |

---

## Group J — Audit Log

### TC-AUTH-J-001: Signup event written to audit log

| Field | Value |
|---|---|
| **Input** | New user completes OAuth sign-up |
| **Expected** | `audit.json` contains entry `{ event: "signup", email, provider, ip, userAgent }` |
| **SRS** | FR-AUTH-017 |

### TC-AUTH-J-002: Login event written for successful sign-in

| Field | Value |
|---|---|
| **Input** | Active user completes OAuth sign-in |
| **Expected** | `audit.json` contains `{ event: "signin", userId, email }` |
| **SRS** | FR-AUTH-017 |

### TC-AUTH-J-003: Blocked sign-in event written

| Field | Value |
|---|---|
| **Input** | Pending user attempts sign-in |
| **Expected** | `audit.json` contains `{ event: "signin_blocked", userId, detail.reason: "pending" }` |
| **SRS** | FR-AUTH-017 |

### TC-AUTH-J-004: Logout event written

| Field | Value |
|---|---|
| **Input** | User calls `POST /auth/logout` |
| **Expected** | `audit.json` contains `{ event: "logout", userId }` |
| **SRS** | FR-AUTH-017 |

### TC-AUTH-J-005: Approval event written with actorId

| Field | Value |
|---|---|
| **Input** | Admin approves pending user |
| **Expected** | `audit.json` contains `{ event: "approved", userId: <targetUser>, actorId: <adminId> }` |
| **SRS** | FR-AUTH-017 |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Test cases for User Authentication |
