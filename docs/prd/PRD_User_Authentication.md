# PRD — User Authentication & Authorization

**Document ID:** PRD-LTS2026-AUTH-001  
**Issue Date:** 2026-05-28  
**Module:** User Authentication & Authorization  
**RFP Reference:** RFP-LTS2026-AUTH-001  
**Status:** Released  
**Rev:** 1.1 — Implemented as local email/password auth (OAuth deferred)

---

## 1. Technology Selection

| Component | Choice | Rationale |
|---|---|---|
| Identity method | Local email + password (bcrypt) | No external IdP credentials required; OAuth can be layered later |
| Password hashing | bcryptjs (cost 12) | Industry standard; protects against credential leaks |
| Session tokens | JWT RS256 (Access 15 min + Refresh 7 days) | Stateless; works across microservices; asymmetric signing |
| Token storage (client) | `HttpOnly` Secure cookie (refresh) + memory (access) | Prevents XSS token theft |
| Backend auth middleware | Custom Express middleware (`verifyAccessToken`) | Lightweight; composable with route guards |
| Admin approval workflow | Server-side `pending` state in user record | Prevents immediate access after registration |
| RBAC roles | `admin`, `operator`, `viewer` | Maps to least-privilege access per feature |
| Token signing | RS256 (asymmetric key pair in `server/certs/`) | Allows public-key verification without sharing secret |
| Audit logging | Append-only JSON file (`storage/audit.json`) | Tamper-evident record of auth events (max 10 000) |
| OAuth (future) | Google OAuth 2.0 / Microsoft Entra ID | Deferred — can be added without changing RBAC/JWT infrastructure |

---

## 2. User Roles

| Role | Description | Permissions |
|---|---|---|
| `admin` | System administrator | Full access; approve/reject signups; manage users & roles |
| `operator` | Security operator | View all cameras; manage zones; acknowledge alerts; view analytics |
| `viewer` | Read-only observer | View live feeds and alerts; no configuration changes |

---

## 3. Authentication Flows

### 3.1 Sign-Up Flow (Local Registration + Admin Approval)

```
Browser                    Server
  │                          │
  │── POST /auth/register ─► │
  │   {email, password,      │
  │    name?}                │
  │                          │── bcrypt.hash(password, 12)
  │                          │── if first user or ADMIN_SEED_EMAIL:
  │                          │     status='active', role='admin'
  │                          │   else:
  │                          │     status='pending', role='viewer'
  │                          │── audit.log('signup')
  │◄── 201                    │
  │    {user: {id,email,status,role}}
  │                          │
  │  (if pending → show PendingPage)
```

### 3.2 Admin Approval Flow

```
Admin Browser              Server
  │                          │
  │── GET /admin/users ───►  │  (requires role=admin JWT)
  │◄── list of pending users  │
  │                          │
  │── PATCH /admin/users/:id  │
  │   {action:"approve",      │
  │    role:"operator"}   ──► │
  │                          │── update user: status="active", role=...
  │                          │── audit.log('approved')
  │◄── 200 {status:"active"}  │
```

### 3.3 Sign-In Flow

```
Browser                    Server
  │                          │
  │── POST /auth/login ────► │
  │   {email, password}      │
  │                          │── bcrypt.compare(password, hash)
  │                          │── status check:
  │                          │   "pending"  → 403 "Awaiting approval"
  │                          │   "rejected" → 403 "Access denied"
  │                          │   "active"   → issue JWT pair
  │◄── 200                    │
  │    Set-Cookie: refreshToken (HttpOnly, Secure, SameSite=Strict)
  │    body: { accessToken, user: {id, name, email, role} }
```

### 3.4 Token Refresh Flow

```
Browser                    Server
  │── POST /auth/refresh ──► │
  │   Cookie: refreshToken   │
  │                          │── validate token hash (not revoked, not expired)
  │                          │── rotate: issue new refresh token, revoke old
  │                          │── issue new accessToken
  │◄── 200 { accessToken }   │
  │    Set-Cookie: refreshToken (rotated)
```

### 3.5 Logout Flow

```
Browser                    Server
  │── POST /auth/logout ──►  │
  │   Cookie: refreshToken   │
  │                          │── TokenService.revokeRefreshToken
  │                          │── audit.log('logout')
  │◄── 200                    │
  │    Set-Cookie: refreshToken="" (maxAge=0)
```

---

## 4. Page Layouts Required

### 4.1 Sign-In / Register Page (`page='signin'`)

- Unified entry page with two tabs: **Sign In** and **Register**
- Sign In: email + password fields, login button
- Register: name (optional), email, password (≥ 8 chars), confirm password
- Note shown on register: "First user automatically becomes admin"
- Error states: `pending`, `rejected`, `invalid credentials`, `generic-error`

### 4.2 Pending Approval Page (`page='pending'`)

- Shown after successful registration (non-first user)
- Message: "Your account is awaiting administrator approval"
- 3-step instructions (register → admin approves → login)
- Sign out link

### 4.3 Admin User Management Page (`page='admin'`)

- Access: `admin` role only (via user menu in dashboard header)
- Filter tabs: **All** | **Pending** | **Active** | **Rejected** | **Revoked**
- Search by email/name
- Table columns: Name, Email, Role, Status, Created, Last login, Actions
- Actions: **Approve** (pending) | **Reject** (pending) | **Role dropdown** (active) | **Revoke** (active) | **Reactivate** (rejected/revoked) | **Delete**

### 4.4 Account / Profile Menu (top-right of Dashboard)

- User avatar (initials) + name + role badge
- **User Management** link (admin only)
- **Sign Out** button (calls `POST /auth/logout`)

---

## 5. Priority

| Priority | Feature |
|:---:|---|
| P0 | Local email+password registration + admin approval workflow |
| P0 | JWT RS256 issuance (access + refresh) on approved sign-in |
| P0 | Route guard — all API routes require valid JWT |
| P0 | Admin User Management page (approve / reject / role) |
| P1 | Role-based UI visibility (admin vs operator vs viewer) |
| P1 | Token refresh endpoint with rotation |
| P1 | Logout with refresh token revocation |
| P1 | Pending Approval page |
| P2 | Audit log viewer in admin panel |
| P2 | Force logout / revoke all sessions per user |
| P3 | Google OAuth 2.0 (future) |
| P3 | Microsoft Entra ID / MSAL (future) |
| P3 | Email notifications (approved / rejected) |

---

## 6. Non-Functional Requirements

| Attribute | Requirement |
|---|---|
| Security | Tokens signed with RS256; refresh tokens stored hashed; bcrypt cost 12 |
| Performance | Auth endpoints ≤ 200 ms p95 |
| Availability | Auth service: 99.9 % uptime (same SLA as API server) |
| Password policy | Minimum 8 characters; validated on both client and server |

---

## 2. User Roles

| Role | Description | Permissions |
|---|---|---|
| `admin` | System administrator | Full access; approve/reject signups; manage users & roles |
| `operator` | Security operator | View all cameras; manage zones; acknowledge alerts; view analytics |
| `viewer` | Read-only observer | View live feeds and alerts; no configuration changes |

---

## 3. Authentication Flows

### 3.1 Sign-Up Flow (OAuth + Admin Approval)

```
Browser                    Server                      IdP (Google/Microsoft)
  │                          │                                 │
  │── POST /auth/signup ──►  │                                 │
  │   {provider: "google"}   │                                 │
  │                          │── redirect to OAuth ──────────► │
  │◄── 302 redirect ────────  │                                 │
  │                          │                                 │
  │ (user authenticates at IdP)                                │
  │◄─────────── OAuth callback (code) ─────────────────────────│
  │── GET /auth/callback ──► │                                 │
  │                          │── exchange code for tokens ──► │
  │                          │◄── id_token, profile ─────────  │
  │                          │                                 │
  │                          │ create user record              │
  │                          │   status: "pending"             │
  │                          │   provider: "google"            │
  │                          │   email, name, avatar           │
  │                          │                                 │
  │                          │── notify admin (email/socket) ─ │
  │                          │                                 │
  │◄── 200 {status:"pending"} │                                │
  │    "Awaiting admin approval"                               │
```

### 3.2 Admin Approval Flow

```
Admin Browser              Server
  │                          │
  │── GET /admin/users ───►  │  (requires role=admin JWT)
  │◄── list of pending users  │
  │                          │
  │── PATCH /admin/users/:id  │
  │   {action:"approve",      │
  │    role:"operator"}   ──► │
  │                          │── update user: status="active", role=...
  │                          │── send notification email to user
  │◄── 200 {status:"active"}  │
```

### 3.3 Sign-In Flow

```
Browser                    Server
  │                          │
  │── POST /auth/signin ──►  │
  │   {provider: "google"}   │
  │                          │── redirect to IdP (OAuth 2.0 PKCE)
  │◄── 302 to IdP ──────────  │
  │ (user authenticates)     │
  │── GET /auth/callback ──► │
  │                          │ lookup user by email
  │                          │ status check:
  │                          │   "pending"  → 403 "Awaiting approval"
  │                          │   "rejected" → 403 "Access denied"
  │                          │   "active"   → issue JWT pair
  │◄── 200                    │
  │    Set-Cookie: refreshToken (HttpOnly, Secure, SameSite=Strict)
  │    body: { accessToken, user: {id, name, email, role} }
```

### 3.4 Token Refresh Flow

```
Browser                    Server
  │── POST /auth/refresh ──► │
  │   Cookie: refreshToken   │
  │                          │── validate refresh token (not revoked, not expired)
  │                          │── issue new accessToken
  │◄── 200 { accessToken }   │
```

### 3.5 Logout Flow

```
Browser                    Server
  │── POST /auth/logout ──►  │
  │   Authorization: Bearer  │
  │   Cookie: refreshToken   │
  │                          │── revoke refresh token (add to blocklist / delete from DB)
  │                          │── log audit event
  │◄── 200                    │
  │    Set-Cookie: refreshToken="" (maxAge=0)
```

---

## 4. Page Layouts Required

### 4.1 Sign-In / Sign-Up Page (`/auth`)

- Unified entry page
- Two primary action buttons: **Continue with Google**, **Continue with Microsoft**
- "Request Access" copy explains admin-approval requirement
- Loading spinner during OAuth redirect
- Error states: `pending`, `rejected`, `generic-error`

### 4.2 Pending Approval Page (`/auth/pending`)

- Shown after successful signup OAuth flow
- Message: "Your account is pending administrator approval. You will receive an email once approved."
- Re-check button (polls `/auth/me` every 30 s)
- Sign out link

### 4.3 Admin User Management Page (`/admin/users`)

- Access: `admin` role only
- Tabs: **Pending Approval** | **Active Users** | **Rejected**
- Table columns: Avatar, Name, Email, Provider, Requested At, Role (dropdown), Actions
- Actions: **Approve** (with role selector) | **Reject** | **Revoke** (active users)
- Bulk approve/reject selection
- Search & filter by email/name

### 4.4 User Permission Settings Page (`/admin/users/:id`)

- Individual user detail
- Edit role: `admin` | `operator` | `viewer`
- Force logout (revoke all tokens)
- Deactivate / re-activate account
- View sign-in history (last 10 events)

### 4.5 Account / Profile Menu (top-right of Dashboard)

- User avatar + name
- Current role badge
- **Log out** button (calls `POST /auth/logout`)

---

## 5. Priority

| Priority | Feature |
|:---:|---|
| P0 | Google OAuth signup + admin approval workflow |
| P0 | JWT issuance (access + refresh) on approved sign-in |
| P0 | Route guard — all API routes require valid JWT |
| P0 | Admin User Management page (approve / reject) |
| P1 | Microsoft OAuth signup |
| P1 | Role-based UI visibility (operator vs viewer) |
| P1 | Token refresh endpoint |
| P1 | Logout with token revocation |
| P1 | Pending Approval page |
| P2 | User Permission Settings page |
| P2 | Audit log viewer in admin panel |
| P2 | Email notifications (approved / rejected) |
| P3 | Bulk approve/reject |
| P3 | Sign-in history per user |

---

## 6. Non-Functional Requirements

| Attribute | Requirement |
|---|---|
| Security | Tokens signed with RS256; refresh tokens stored hashed in DB |
| Performance | Auth endpoints ≤ 200 ms p95 (excluding IdP redirect latency) |
| Availability | Auth service: 99.9 % uptime (same SLA as API server) |
| Compliance | OAuth scopes limited to `openid email profile`; no sensitive Google/MS data stored |
| GDPR | User can request account deletion; all PII removed within 30 days |
| Audit | Every login, logout, approval, rejection logged with timestamp, IP, user-agent |

---

## 7. Out of Scope

- Local username/password authentication
- Two-factor authentication (planned Phase 12.1)
- SAML / enterprise SSO federation (planned Phase 12.2)
- Self-service password reset (N/A — OAuth only)

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — PRD for User Authentication |
