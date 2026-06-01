# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# User Profile Management

| | |
|---|---|
| **Document Reference** | PRD-LTS2026-PROFILE-001 |
| **Parent RFP** | RFP-LTS2026-PROFILE-001 |
| **Issue Date** | 2026-05-29 |
| **Status** | **✅ Active** |
| **Repository** | [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking) |

---

## 1. Overview

The **User Profile** module enables every authenticated LTS user to personalize their identity within the system. A profile consists of a photo (avatar), display name, organization, phone number, and bio. Administrators gain enriched visibility into user identities in the User Management panel, and can search across all profile attributes to quickly locate users across large deployments.

## 2. User Stories

| ID | As a… | I want to… | So that… |
|---|---|---|---|
| US-PROF-001 | Logged-in user | Access a Profile page from the top-right user menu | I can view and update my profile without navigating away |
| US-PROF-002 | Logged-in user | Upload a profile photo from my file system | My identity is visually recognizable to colleagues |
| US-PROF-003 | Logged-in user | Paste a screenshot or photo from clipboard | I can quickly set a photo without saving a file first |
| US-PROF-004 | Logged-in user | Edit my display name, organization, phone, and bio | Other users and admins can contact me easily |
| US-PROF-005 | Administrator | See each user's organization and phone in User Management | I can quickly identify which site/org each user belongs to |
| US-PROF-006 | Administrator | Search users by organization or phone | I can locate all users from a specific site |
| US-PROF-007 | Administrator | See profile photo in the user list | I can visually identify users at a glance |

## 3. Feature Scope

### In Scope (Phase 1)
- Profile menu item in top-right user dropdown (all authenticated users)
- Profile modal: avatar, name, organization, phone, bio
- File upload + clipboard paste for avatar
- `PATCH /auth/me` REST endpoint
- Admin User Management: profile column (avatar + org + phone)
- Admin search extended to all profile fields
- Audit log entries for profile updates

### Out of Scope
- Public profile pages
- Profile visibility settings
- Social media links
- Two-factor authentication binding to profile

## 4. UX Requirements

### 4.1 Profile Modal
- Triggered by "Profile" menu item in top-right dropdown
- Avatar display area (circular, 96×96): shows current photo or placeholder
- Clicking avatar or "Choose file" button opens native file picker
- `Ctrl+V` / `⌘V` paste support for images
- Input fields: Name (required), Organization, Phone, Bio (textarea)
- Character counters on Bio field
- Footer: Cancel, Save buttons
- Dirty-state guard: confirm dialog if closing with unsaved changes
- Immediate success indicator after save

### 4.2 User Menu Avatar
- Top-right user icon shows avatar image if set, otherwise initial letter
- Organization shown as subtitle in dropdown header

### 4.3 Admin User Management
- Avatar thumbnail (28×28) shown next to user name
- New "Organization" column in user table
- Phone shown under user name in the Name column
- Bio shown as truncated line below name

## 5. Constraints

- Avatar stored as base64 data URL in `users.json` / MongoDB (≤ 48 KB after encoding)
- No external storage (S3, filesystem) required for Phase 1
- Server validates avatar size before storing

## 6. Success Metrics

| Metric | Target |
|---|---|
| Profile completion rate | ≥ 40% of active users within 30 days |
| Admin search by org | Returns correct users in ≤ 200 ms |
| PATCH /auth/me error rate | < 0.1% |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-29 | LTS Engineering Team | Initial release |
