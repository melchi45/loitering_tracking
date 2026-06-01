# REQUEST FOR PROPOSAL (RFP)
# User Profile Management

| | |
|---|---|
| **RFP Reference** | RFP-LTS2026-PROFILE-001 |
| **Parent System** | LTS-2026-001 Loitering Detection & Tracking System |
| **Issue Date** | 2026-05-29 |
| **Proposal Deadline** | 2026-06-30 |
| **Status** | **✅ Phase-1 In Progress** |
| **Repository** | [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking) |

---

## 1. Overview

### 1.1 Purpose

This RFP defines requirements for the **User Profile Management** module of LTS-2026. Every authenticated user shall be able to view and edit their own profile — including a display photo, name, organization, contact number, and bio. Administrators shall view all profile fields in the User Management page and search users by any profile attribute.

### 1.2 Background

The existing authentication system (Phase 11) provides login/logout, JWT sessions, and admin approval workflows. However, user identity is limited to email, name, and role. Operators managing multi-site deployments need richer identity context — organization affiliation, contact details, and a recognizable profile photo — to coordinate incident response and user accountability.

### 1.3 Scope of Work

- Profile editing page / modal accessible from the top-right user menu
- Profile photo upload (file picker) and paste from clipboard
- Profile fields: display name, organization, phone, bio
- `PATCH /auth/me` REST endpoint for profile updates
- `GET /auth/me/avatar` endpoint serving the profile photo
- Admin User Management — show profile columns; extend search to all profile fields

---

## 2. Functional Requirements

| ID | Requirement |
|---|---|
| FR-PROF-001 | System SHALL provide a Profile menu item in the top-right user dropdown |
| FR-PROF-002 | Profile modal SHALL display current photo, name, organization, phone, and bio |
| FR-PROF-003 | User SHALL be able to upload a profile photo via file picker (JPEG/PNG/GIF/WebP, ≤ 2 MB) |
| FR-PROF-004 | User SHALL be able to paste an image from the clipboard into the photo area |
| FR-PROF-005 | Server SHALL resize and store the photo as a base64 JPEG data URL (max 200×200 px) |
| FR-PROF-006 | User SHALL be able to edit display name (required, 1–64 chars) |
| FR-PROF-007 | User SHALL be able to edit organization (optional, ≤ 128 chars) |
| FR-PROF-008 | User SHALL be able to edit phone (optional, ≤ 32 chars, basic format validation) |
| FR-PROF-009 | User SHALL be able to edit bio (optional, ≤ 256 chars) |
| FR-PROF-010 | `PATCH /auth/me` SHALL accept all profile fields and return the updated user object |
| FR-PROF-011 | Admin User Management table SHALL display organization and phone columns |
| FR-PROF-012 | Admin User Management SHALL show profile photo thumbnail in the user row |
| FR-PROF-013 | Admin search SHALL match against email, name, organization, phone, and bio |
| FR-PROF-014 | Profile changes SHALL be reflected in the top-right user menu immediately after save |
| FR-PROF-015 | Unsaved changes SHALL trigger a "you have unsaved changes" warning on modal close |

## 3. Non-Functional Requirements

| ID | Requirement |
|---|---|
| NFR-PROF-001 | Avatar storage SHALL NOT exceed 50 KB per user (enforced on server via canvas resize to 200×200 max) |
| NFR-PROF-002 | `PATCH /auth/me` SHALL respond within 200 ms (p95) |
| NFR-PROF-003 | Profile data SHALL be stored in `users.json` (JSON mode) or `users` MongoDB collection; no separate file store required |
| NFR-PROF-004 | Only the authenticated user may update their own profile; admin cannot overwrite another user's profile fields |
| NFR-PROF-005 | Admin read access to other users' profile data is permitted via `GET /admin/users/:id` |

## 4. Acceptance Criteria

| AC | Criterion |
|---|---|
| AC-001 | Profile menu item appears in top-right dropdown for all authenticated users |
| AC-002 | Clicking "Profile" opens the profile modal pre-filled with current data |
| AC-003 | File upload, save, and reload shows the new avatar |
| AC-004 | Clipboard paste of an image populates the avatar preview |
| AC-005 | All 5 fields (photo, name, org, phone, bio) are saved by `PATCH /auth/me` |
| AC-006 | Admin User Management shows org, phone, and avatar for each user |
| AC-007 | Admin search "org name" returns users whose organization matches |
| AC-008 | Missing required name field is rejected with 400 |
| AC-009 | Avatar > 2 MB is rejected with 400 |
| AC-010 | Non-admin user cannot update another user's profile |

## 5. Milestones

| Milestone | Deliverable |
|---|---|
| M1 | `PATCH /auth/me` endpoint; `UserService.updateProfile()` |
| M2 | `ProfileModal.tsx` component — file upload + paste + form |
| M3 | App.tsx profile menu item; authStore profile update action |
| M4 | AdminUsersPage — profile columns + extended search |
| M5 | TC + test script `test/api/user_profile.test.js` |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-29 | LTS Engineering Team | Initial release |
