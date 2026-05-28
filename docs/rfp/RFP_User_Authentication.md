# REQUEST FOR PROPOSAL (RFP)
# User Authentication & Authorization

| | |
|---|---|
| **RFP Reference** | RFP-LTS2026-AUTH-001 |
| **Issue Date** | 2026-05-28 |
| **Module** | User Authentication & Authorization |
| **Proposal Deadline** | 2026-06-30 |
| **Repository** | [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking) |

---

## 1. Overview

### 1.1 Purpose

This RFP defines the requirements for the **User Authentication & Authorization** module of the LTS-2026 Loitering Tracking System. The module shall control access to the dashboard, REST API, and administrative functions through a secure, role-based identity system.

### 1.2 Background

LTS-2026 is a multi-user web application accessed by security operators, administrators, and read-only viewers. Without a proper authentication layer, all API endpoints and live video feeds are publicly accessible. A gated login system with admin-controlled onboarding is required before the system can be deployed in any production environment.

### 1.3 Scope of Work

The selected vendor shall deliver:

- Secure user registration and login (email/password and/or OAuth 2.0)
- JWT-based session management (access token + refresh token)
- Role-based access control (admin / operator / viewer)
- Admin approval workflow for new user accounts
- Admin user management panel (approve, reject, revoke, promote)
- Audit logging of all authentication events
- React SPA integration (sign-in page, pending page, protected routes)

---

## 2. Functional Requirements

### 2.1 User Registration

| ID | Requirement |
|---|---|
| FR-AUTH-001 | System SHALL provide `POST /auth/register` accepting `email`, `password`, and optional `name` |
| FR-AUTH-002 | Passwords SHALL be hashed using bcrypt (cost factor ≥ 10) before storage |
| FR-AUTH-003 | The first registered user OR a user whose email matches `ADMIN_SEED_EMAIL` SHALL be automatically activated as `admin` |
| FR-AUTH-004 | All other new users SHALL be created with `status: "pending"` and `role: "viewer"` |
| FR-AUTH-005 | Duplicate email registrations SHALL be rejected with `409 Conflict` |
| FR-AUTH-006 | Passwords shorter than 8 characters SHALL be rejected with `400 Bad Request` |

### 2.2 Sign-In

| ID | Requirement |
|---|---|
| FR-AUTH-007 | System SHALL provide `POST /auth/login` accepting `email` and `password` |
| FR-AUTH-008 | Successful login SHALL return a short-lived JWT access token (15 min) in the response body |
| FR-AUTH-009 | Successful login SHALL set a long-lived refresh token (7 days) as an `HttpOnly` `Secure` cookie |
| FR-AUTH-010 | Login attempts for `pending`, `rejected`, or `revoked` accounts SHALL return `403 Forbidden` |
| FR-AUTH-011 | Invalid credentials SHALL return `401 Unauthorized` without revealing which field is incorrect |

### 2.3 OAuth 2.0 (Google & Microsoft)

| ID | Requirement |
|---|---|
| FR-AUTH-012 | System SHALL provide `GET /auth/google` to initiate Google OAuth 2.0 flow |
| FR-AUTH-013 | System SHALL provide `GET /auth/google/callback` to complete Google OAuth exchange |
| FR-AUTH-014 | System SHALL provide `GET /auth/microsoft` to initiate Microsoft Entra ID OAuth flow |
| FR-AUTH-015 | System SHALL provide `GET /auth/microsoft/callback` to complete Microsoft OAuth exchange |
| FR-AUTH-016 | OAuth providers SHALL be enabled only when corresponding credentials are set in environment |
| FR-AUTH-017 | After successful OAuth, server SHALL redirect browser to SPA with `?auth=success`, `?auth=pending`, or `?auth=denied` query parameter |
| FR-AUTH-018 | OAuth users SHALL be linked by email if an existing local account shares the same address |

### 2.4 Session Management

| ID | Requirement |
|---|---|
| FR-AUTH-019 | System SHALL provide `POST /auth/refresh` to exchange a valid refresh cookie for a new access token |
| FR-AUTH-020 | Refresh tokens SHALL be single-use (rotation on every `/auth/refresh` call) |
| FR-AUTH-021 | System SHALL provide `POST /auth/logout` to clear the refresh cookie and invalidate the token |
| FR-AUTH-022 | System SHALL provide `GET /auth/me` returning the current user's profile (requires valid access token) |

### 2.5 Admin User Management

| ID | Requirement |
|---|---|
| FR-AUTH-023 | System SHALL provide `GET /admin/users` listing all users (admin only) |
| FR-AUTH-024 | System SHALL provide `PATCH /admin/users/:id` supporting actions: `approve`, `reject`, `revoke`, `reactivate` |
| FR-AUTH-025 | Admin SHALL be able to change a user's role during approval (`admin`, `operator`, `viewer`) |
| FR-AUTH-026 | An admin SHALL NOT be able to revoke their own account |

### 2.6 Role-Based Access Control

| ID | Requirement |
|---|---|
| FR-AUTH-027 | All API endpoints except `/auth/*` and `/health` SHALL require a valid JWT access token |
| FR-AUTH-028 | Admin-only endpoints (`/admin/*`) SHALL reject requests from non-admin roles with `403 Forbidden` |
| FR-AUTH-029 | Operator and viewer roles SHALL have read access to cameras, alerts, and analytics |
| FR-AUTH-030 | Only admin and operator roles SHALL be permitted to modify zones, acknowledge alerts, and manage pipelines |

---

## 3. Non-Functional Requirements

| ID | Category | Requirement |
|---|---|---|
| NFR-AUTH-001 | Security | Passwords SHALL never be returned in any API response |
| NFR-AUTH-002 | Security | JWT signing SHALL use RS256 asymmetric keys (private key server-only) |
| NFR-AUTH-003 | Security | Refresh token cookies SHALL have `HttpOnly`, `Secure`, `SameSite=Lax` attributes |
| NFR-AUTH-004 | Security | OAuth CSRF state SHALL be verified using a server-side session (not client storage) |
| NFR-AUTH-005 | Audit | All auth events (`signup`, `signin`, `signin_blocked`, `signout`, `approved`, `rejected`, `revoked`) SHALL be appended to `storage/audit.json` |
| NFR-AUTH-006 | Audit | Audit log SHALL record `userId`, `email`, `ip`, `timestamp`, and `event` for each entry |
| NFR-AUTH-007 | Performance | Login and token refresh SHALL complete in < 500 ms under normal load |
| NFR-AUTH-008 | Availability | Auth system SHALL degrade gracefully when `AUTH_ENABLED=false` (all API access permitted) |
| NFR-AUTH-009 | Scalability | User storage SHALL support both JSON file mode and MongoDB mode via the shared db.js adapter |

---

## 4. Technical Constraints

| Constraint | Value |
|---|---|
| Runtime | Node.js 22+ / Express 4 |
| Password hashing | bcryptjs (cost 12) |
| JWT algorithm | RS256 — key pair in `server/certs/jwt.key` + `jwt.pub` |
| Token lifetimes | Access: 15 min · Refresh: 7 days |
| OAuth providers | Google OAuth 2.0 (passport-google-oauth20) · Microsoft Entra ID (@azure/msal-node) |
| Session store | express-session (in-memory, OAuth CSRF state only, 10 min TTL) |
| User persistence | `storage/users.json` (JSON mode) · `users` collection (MongoDB mode) |
| Audit persistence | `storage/audit.json` (append-only, max 10 000 entries) |
| Frontend | React 18 + Zustand (`authStore`) · No React Router (custom `page` state) |

---

## 5. Acceptance Criteria

| # | Criterion |
|---|---|
| AC-001 | Unauthenticated requests to protected endpoints return `401` |
| AC-002 | A fresh registration creates a `pending` user; cannot sign in until approved |
| AC-003 | Admin can approve a pending user; user can then sign in |
| AC-004 | Access token expires after 15 min; `/auth/refresh` issues a new pair |
| AC-005 | Google OAuth flow completes end-to-end: sign-in → Google → callback → dashboard |
| AC-006 | Microsoft OAuth flow completes end-to-end: sign-in → Microsoft → callback → dashboard |
| AC-007 | Admin cannot revoke themselves |
| AC-008 | Audit log records every sign-in, sign-out, approval, and rejection |
| AC-009 | `AUTH_ENABLED=false` disables all auth checks without breaking other features |
| AC-010 | All Phase-1 API test cases in `test/api/auth.test.js` pass |

---

## 6. Deliverables

| Deliverable | Description |
|---|---|
| `server/src/routes/auth.js` | Auth route handlers (register, login, refresh, logout, me, OAuth) |
| `server/src/routes/admin.js` | Admin user management routes |
| `server/src/services/UserService.js` | User CRUD, OAuth upsert, role management |
| `server/src/services/TokenService.js` | JWT issue, verify, rotate |
| `server/src/services/AuditService.js` | Append-only audit log |
| `server/src/middleware/auth.js` | `verifyAccessToken` Express middleware |
| `server/src/middleware/role.js` | `requireRole(...roles)` Express middleware |
| `server/src/config/passport.js` | Google OAuth passport strategy |
| `server/src/services/MsalService.js` | Microsoft Entra ID OAuth service |
| `client/src/pages/SignInPage.tsx` | OAuth sign-in page (Google + Microsoft buttons) |
| `client/src/pages/PendingPage.tsx` | Awaiting approval page |
| `client/src/pages/admin/AdminUsersPage.tsx` | Admin user management panel |
| `client/src/stores/authStore.ts` | Zustand auth state (user, accessToken, page, refresh, logout) |
| `test/api/auth.test.js` | Phase-1 REST API test suite |
| `test/api/admin_users.test.js` | Phase-1 Admin user management test suite |

---

## 7. Milestones

| Milestone | Target | Deliverable |
|---|---|---|
| M1 — Local Auth Backend | Week 1 | Registration, login, JWT, refresh, logout, RBAC middleware |
| M2 — Admin Workflow | Week 1 | Admin routes, user approval/rejection, audit log |
| M3 — Frontend Integration | Week 2 | SignInPage, PendingPage, AdminUsersPage, authStore |
| M4 — OAuth Integration | Week 2 | Google + Microsoft OAuth flow, passport, MSAL |
| M5 — Testing & Hardening | Week 3 | auth.test.js, admin_users.test.js, security review |

---

## 8. Evaluation Criteria

| Criterion | Weight |
|---|---|
| Security (JWT, bcrypt, cookie attributes, CSRF) | 35% |
| Completeness of auth flows (local + OAuth) | 25% |
| Admin workflow usability | 20% |
| Test coverage | 15% |
| Code quality and documentation | 5% |

---

*Document prepared by: LTS Engineering Team*  
*Rev 1.0 — Initial release covering local auth + Google/Microsoft OAuth*

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — RFP for User Authentication |
