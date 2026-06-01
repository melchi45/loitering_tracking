# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# User Profile Management

| | |
|---|---|
| **Document Reference** | SRS-LTS2026-PROFILE-001 |
| **Parent RFP** | RFP-LTS2026-PROFILE-001 |
| **Issue Date** | 2026-05-29 |
| **Status** | **✅ Active** |
| **Repository** | [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking) |

---

## 1. Data Model

### 1.1 User Record — Additional Profile Fields

Appended to the existing user record in `users.json` / MongoDB `users` collection:

```json
{
  "id": "uuid",
  "email": "user@example.com",
  "name": "Jane Doe",
  "organization": "Hanwha Vision",
  "phone": "+82-10-1234-5678",
  "bio": "Security operator, Seoul HQ.",
  "avatarDataUrl": "data:image/jpeg;base64,/9j/4AAQ..."
}
```

| Field | Type | Required | Max Length | Notes |
|---|---|:---:|---|---|
| `name` | string | ✅ | 64 | Display name; already exists |
| `organization` | string | ❌ | 128 | Company / department |
| `phone` | string | ❌ | 32 | Free-form; server does not validate format |
| `bio` | string | ❌ | 256 | Short self-description |
| `avatarDataUrl` | string | ❌ | ~50 KB | `data:image/jpeg;base64,...`; server resizes to 200×200 |

## 2. API Specification

### 2.1 `GET /auth/me` (existing — extended)

Returns the full user record including new profile fields. No changes to signature.

### 2.2 `PATCH /auth/me`

Update the authenticated user's own profile.

**Auth**: Bearer access token required.

**Request body** (all fields optional except `name`):
```json
{
  "name":         "Jane Doe",
  "organization": "Hanwha Vision",
  "phone":        "+82-10-1234-5678",
  "bio":          "Security operator.",
  "avatarDataUrl":"data:image/jpeg;base64,..."
}
```

**Validation**:
- `name`: required if present in body; 1–64 chars
- `organization`: ≤ 128 chars
- `phone`: ≤ 32 chars
- `bio`: ≤ 256 chars
- `avatarDataUrl`: must start with `data:image/`; raw base64 body ≤ 65536 chars (~48 KB)

**Response `200 OK`**:
```json
{
  "id": "...", "email": "...", "name": "Jane Doe",
  "organization": "Hanwha Vision", "phone": "...", "bio": "...",
  "avatarDataUrl": "data:image/jpeg;base64,...",
  "role": "operator", "status": "active", ...
}
```

**Errors**:
| Status | Condition |
|---|---|
| 400 | `name` is empty or exceeds limits |
| 400 | `avatarDataUrl` does not start with `data:image/` |
| 400 | `avatarDataUrl` exceeds 65536 chars |
| 401 | Missing / invalid access token |

### 2.3 `GET /admin/users` — Extended Search

`?search=<text>` now matches against: `email`, `name`, `organization`, `phone`, `bio`.

### 2.4 `GET /admin/users/:id` — Extended Response

Returns all profile fields including `organization`, `phone`, `bio`, `avatarDataUrl`.

## 3. UserService Changes

### 3.1 `updateProfile(id, { name, organization, phone, bio, avatarDataUrl })`

```js
function updateProfile(id, { name, organization, phone, bio, avatarDataUrl } = {}) {
  const users = _load();
  const idx   = users.findIndex(u => u.id === id);
  if (idx === -1) return null;
  const user = users[idx];
  if (name         !== undefined) user.name         = name;
  if (organization !== undefined) user.organization = organization;
  if (phone        !== undefined) user.phone        = phone;
  if (bio          !== undefined) user.bio          = bio;
  if (avatarDataUrl!== undefined) user.avatarDataUrl= avatarDataUrl;
  _save(users);
  const { passwordHash: _, ...safe } = user;
  return safe;
}
```

### 3.2 `list()` — Extended Search

```js
if (search) {
  const q = search.toLowerCase();
  users = users.filter(u =>
    u.email.toLowerCase().includes(q) ||
    (u.name         || '').toLowerCase().includes(q) ||
    (u.organization || '').toLowerCase().includes(q) ||
    (u.phone        || '').toLowerCase().includes(q) ||
    (u.bio          || '').toLowerCase().includes(q)
  );
}
```

## 4. Client Components

### 4.1 `ProfileModal.tsx`

- Opens as an overlay modal
- Avatar section: circular preview (64×64), "Choose file" button, paste-from-clipboard support (`paste` event listener on the document)
- Form fields: Name (required), Organization, Phone, Bio (textarea)
- Footer: Cancel + Save buttons; dirty state tracking
- On save: `PATCH /auth/me` → updates authStore user

### 4.2 `App.tsx` — User Menu

Add "Profile" item before "Sign Out":
```tsx
<button onClick={() => setShowProfile(true)}>
  <UserCircleIcon /> Profile
</button>
```
Render `<ProfileModal>` when `showProfile === true`.

### 4.3 `authStore.ts` — `updateProfile` Action

```ts
updateProfile: async (fields) => {
  const { accessToken } = get();
  const data = await apiFetch('/auth/me', {
    method:  'PATCH',
    headers: { Authorization: `Bearer ${accessToken}` },
    body:    JSON.stringify(fields),
  });
  set({ user: data });
}
```

### 4.4 `AdminUsersPage.tsx` — Extended Columns

- Add `organization`, `phone`, `avatarDataUrl` to `User` interface
- Render avatar thumbnail (24×24) in the Name column
- Add `Organization` and `Phone` table columns
- Update search placeholder: "Search by email, name, org, phone, bio…"
- Show profile detail in expandable row or hover tooltip

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-29 | LTS Engineering Team | Initial release |
