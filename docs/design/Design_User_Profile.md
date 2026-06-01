# TECHNICAL DESIGN — User Profile Management

| | |
|---|---|
| **Document Reference** | DESIGN-LTS2026-PROFILE-001 |
| **Parent SRS** | SRS-LTS2026-PROFILE-001 |
| **Issue Date** | 2026-05-29 |
| **Status** | **✅ Active** |
| **Repository** | [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking) |

---

## 1. Architecture

```
Browser                           Node.js / Express
  │                                      │
  │──PATCH /auth/me ──────────────────▶  auth.js router
  │  { name, org, phone, bio, avatar }   │
  │                                      │── verifyAccessToken (JWT RS256)
  │                                      │── validate fields
  │                                      │── UserService.updateProfile(id, fields)
  │                                      │── AuditService.log('profile_updated')
  │◀── 200 { full user object } ─────────│
```

## 2. Server-Side Changes

### 2.1 `server/src/services/UserService.js`

**New function `updateProfile(id, fields)`**
- Loads `users.json` (or MongoDB `users` collection)
- Patches only fields present in `fields` object (partial update)
- Strips `passwordHash` from returned object
- Saves atomically

**Modified `list({ search })`**
- Extends search filter to include `organization`, `phone`, `bio` in addition to `email` and `name`

### 2.2 `server/src/routes/auth.js`

**New route `PATCH /auth/me`**

```
POST body fields → Validation → UserService.updateProfile → AuditService.log → JSON response
```

**Validation rules:**
| Field | Rule |
|---|---|
| `name` | string, ≥ 1 char, ≤ 64 chars (if provided) |
| `organization` | string, ≤ 128 chars |
| `phone` | string, ≤ 32 chars |
| `bio` | string, ≤ 256 chars |
| `avatarDataUrl` | starts with `data:image/`, ≤ 65536 chars total |

Only `req.user.sub` is updated; users cannot modify other users via this endpoint.

## 3. Client-Side Changes

### 3.1 `client/src/stores/authStore.ts`

Extended `AuthUser` interface:
```ts
organization?: string;
phone?: string;
bio?: string;
avatarDataUrl?: string;
```

New `updateProfile(fields)` action:
- Calls `PATCH /auth/me` with `Authorization: Bearer <accessToken>`
- Updates `user` in Zustand store on success

### 3.2 `client/src/components/ProfileModal.tsx` (new file)

**Component state:**
```
name, organization, phone, bio, avatar (local), avatarError, saving, saveError, saved
```

**Avatar handling:**
- File picker: `<input type="file" accept="image/*">` → `FileReader.readAsDataURL()` → validate size → set local state
- Clipboard paste: `document.addEventListener('paste', handler)` — extracts `image/*` item from `ClipboardEvent`
- Validation: checks `data.length <= MAX_AVATAR_BYTES` (65536)

**Form submission:**
1. Validate `name` not empty
2. Call `authStore.updateProfile(fields)`
3. Show success indicator
4. Dirty-state guard on close

**Lifecycle:**
- `useEffect` registers/unregisters paste and keydown (Escape) listeners

### 3.3 `client/src/App.tsx`

- Import `ProfileModal`
- Add `const [showProfile, setShowProfile] = useState(false)`
- Add "Profile" button in `userMenu` dropdown (before "User Management")
- Show avatar image in top-right button when `user.avatarDataUrl` is set
- Render `<ProfileModal>` in overlays section

### 3.4 `client/src/pages/admin/AdminUsersPage.tsx`

**User interface extended with:**
```ts
organization?: string; phone?: string; bio?: string; avatarDataUrl?: string;
```

**Table changes:**
- Name column: avatar thumbnail (28×28) + name + email + phone
- New "Organization" column
- Bio shown as truncated subtitle
- Search placeholder updated

## 4. Security Considerations

| Risk | Mitigation |
|---|---|
| XSS via avatarDataUrl | Rendered with `<img src=...>` only — no `innerHTML`, no `dangerouslySetInnerHTML` |
| Oversized avatar DoS | Server rejects `avatarDataUrl.length > 65536` before save |
| Invalid image format | Server checks `startsWith('data:image/')` |
| Unauthorized profile update | `req.user.sub` from verified JWT; no user-supplied id accepted |
| Sensitive data leak | `passwordHash` stripped from all `updateProfile` responses |
| Audit trail | All profile changes logged with `AuditService.log('profile_updated')` |

## 5. Data Flow Diagram

```
[User opens Profile modal]
       │
       ▼
[ProfileModal renders with current user data from authStore]
       │
[User edits fields / uploads photo]
       │
[User clicks Save]
       │
       ├─▶ Client: PATCH /auth/me  ──▶  Server: validate + updateProfile()
       │                                       ─▶  _save(users) / MongoDB update
       │                                       ─▶  AuditService.log()
       │◀─ 200 { updated user } ─────────────────────────────────────────
       │
[authStore.set({ user: updated })]
       │
[ProfileModal shows "Profile saved!" indicator]
       │
[User menu avatar updates immediately]
```

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-29 | LTS Engineering Team | Initial release |
