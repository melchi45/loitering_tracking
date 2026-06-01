# TEST CASES — User Profile Management

| | |
|---|---|
| **Document Reference** | TC-LTS2026-PROFILE-001 |
| **Parent SRS** | SRS-LTS2026-PROFILE-001 |
| **Issue Date** | 2026-05-29 |
| **Status** | **✅ Active** |
| **Test Script** | `test/api/user_profile.test.js` |
| **Repository** | [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking) |

---

## 1. Test Scope

This document covers all test cases for the User Profile Management feature:

- A: Profile Read (GET /auth/me extended response)
- B: Profile Update (PATCH /auth/me field validation and persistence)
- C: Avatar Upload (base64 data URL acceptance and rejection)
- D: Admin View Profile (GET /admin/users/:id profile fields)
- E: Admin Search by Profile Fields
- F: Security (authentication enforcement, data sanitization)

## 2. Test Environment

| Item | Value |
|---|---|
| Target URL | `https://localhost:3443` (or `LTS_HTTPS_URL` env var) |
| Auth | `ADMIN_EMAIL` + `ADMIN_PASS` env vars |
| TLS | Self-signed cert allowed (`rejectUnauthorized: false`) |
| Runtime | Node.js ≥ 18 (native `fetch` + `https.Agent`) |

## 3. Test Cases

### Group A — Profile Read

| TC ID | Name | Precondition | Steps | Expected Result |
|---|---|---|---|---|
| TC-PROF-A-001 | GET /auth/me returns core user fields | Authenticated | `GET /auth/me` with Bearer token | 200, body has `id`, `email`, `name`, `role` |
| TC-PROF-A-002 | Profile fields present or undefined | Any profile state | `GET /auth/me` | `organization`, `phone`, `bio`, `avatarDataUrl` are string or absent |
| TC-PROF-A-003 | GET /auth/me without token returns 401 | No token | `GET /auth/me` without Authorization | 401 |

### Group B — Profile Update

| TC ID | Name | Precondition | Steps | Expected Result |
|---|---|---|---|---|
| TC-PROF-B-001 | Valid org/phone/bio saved | Authenticated | `PATCH /auth/me` with valid fields | 200, response includes updated fields |
| TC-PROF-B-002 | Changes persisted on re-read | B-001 passed | `GET /auth/me` | Returns same values as B-001 payload |
| TC-PROF-B-003 | Name update accepted | Authenticated | `PATCH /auth/me { name: "LTS Admin" }` | 200, `name = "LTS Admin"` |
| TC-PROF-B-004 | Empty name rejected | Authenticated | `PATCH /auth/me { name: "" }` | 400, error message |
| TC-PROF-B-005 | Name > 64 chars rejected | Authenticated | `PATCH /auth/me { name: "A"×65 }` | 400 |
| TC-PROF-B-006 | Organization > 128 chars rejected | Authenticated | `PATCH /auth/me { organization: "X"×129 }` | 400 |
| TC-PROF-B-007 | Bio > 256 chars rejected | Authenticated | `PATCH /auth/me { bio: "B"×257 }` | 400 |

### Group C — Avatar Upload

| TC ID | Name | Precondition | Steps | Expected Result |
|---|---|---|---|---|
| TC-PROF-C-001 | Valid PNG data URL accepted | Authenticated | `PATCH /auth/me` with valid `data:image/png;base64,...` | 200, avatarDataUrl starts with `data:image/` |
| TC-PROF-C-002 | Avatar persisted | C-001 passed | `GET /auth/me` | `avatarDataUrl` returned |
| TC-PROF-C-003 | Non-image data URL rejected | Authenticated | `PATCH /auth/me { avatarDataUrl: "data:text/plain;base64,..." }` | 400 |
| TC-PROF-C-004 | Avatar > 65536 chars rejected | Authenticated | `PATCH /auth/me { avatarDataUrl: "data:image/jpeg;base64," + "A"×65537 }` | 400 |

### Group D — Admin View Profile

| TC ID | Name | Precondition | Steps | Expected Result |
|---|---|---|---|---|
| TC-PROF-D-001 | Admin can fetch user detail | Admin authenticated | `GET /admin/users/:id` | 200, id matches |
| TC-PROF-D-002 | Response includes profile fields | User has profile data | `GET /admin/users/:id` | `organization`, `phone` present (string or undefined) |
| TC-PROF-D-003 | Response includes avatar when set | C-001 passed | `GET /admin/users/:id` | `avatarDataUrl` starts with `data:image/` |

### Group E — Admin Search by Profile Fields

| TC ID | Name | Precondition | Steps | Expected Result |
|---|---|---|---|---|
| TC-PROF-E-001 | Empty search returns all users | Admin authenticated | `GET /admin/users?search=` | 200, `users` array |
| TC-PROF-E-002 | Search by email domain | Admin user present | `GET /admin/users?search=<domain>` | Admin user found |
| TC-PROF-E-003 | Search by organization | Admin has org set | `GET /admin/users?search=TestOrg` | 200, array returned |
| TC-PROF-E-004 | Search by phone fragment | Admin has phone set | `GET /admin/users?search=0000-0001` | 200, array returned |
| TC-PROF-E-005 | Non-matching search returns empty | Any | `GET /admin/users?search=__no_match_xyz_9999__` | 200, `users: []` |

### Group F — Security

| TC ID | Name | Precondition | Steps | Expected Result |
|---|---|---|---|---|
| TC-PROF-F-001 | PATCH /auth/me requires token | No token | `PATCH /auth/me` without Authorization | 401 |
| TC-PROF-F-002 | Admin endpoints require auth | No token | `GET /admin/users` | 401 or 403 |
| TC-PROF-F-003 | passwordHash not in response | Authenticated | `PATCH /auth/me` | Response body does NOT contain `passwordHash` |

## 4. Running the Test Script

```bash
# Default (admin@localhost:3443 with default credentials)
node test/api/user_profile.test.js

# Custom credentials
LTS_HTTPS_URL=https://dev.hanwhavision.com:3443 \
  ADMIN_EMAIL=melchi45@gmail.com \
  ADMIN_PASS=yourpassword \
  node test/api/user_profile.test.js
```

## 5. Pass Criteria

All test cases in Groups A–F must show **PASS**. SKIP is allowed only for group D when `adminUserId` cannot be resolved (server not running or credentials wrong). No FAIL results are acceptable for release.

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-29 | LTS Engineering Team | Initial release |
