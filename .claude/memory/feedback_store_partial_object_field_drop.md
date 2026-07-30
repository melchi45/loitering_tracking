---
name: feedback-store-partial-object-field-drop
description: When reflecting a server response into a Zustand store after create/poll, pass the server object through (or spread it) — never hand-enumerate fields
metadata:
  node_type: memory
  type: feedback
---

When a client flow receives a server response (create, status poll, etc.) and needs to add/merge it into a Zustand store, do not construct a new object by listing fields one-by-one — pass the server response through as-is, or spread it (`{ ...data, someOverride }`). Hand-enumeration silently drops any field that exists on the server response but wasn't included in the literal, and this class of bug reproduces every time a new field is added to the server payload without someone remembering to also add it to every hand-built call site.

- ❌ `addCamera({ id: data.id, name: data.name, webrtcEnabled: data.webrtcEnabled })` — drops `repeatPlayback`/`channelSlot` even though `data` has them
- ✅ `addCamera({ ...data, status: 'live' })` or, if the store's `Camera` type is narrower than the raw response, an explicit but *complete* mapping kept in one place

Also check whether the store's own setter merges or replaces: `cameraStore.ts`'s `addCamera` pushes the given object verbatim (no merge with any existing/fetched record), so a partial object here isn't "filled in later" — it stays incomplete in the store until an unrelated full refresh (e.g. `setCameras()` from `GET /api/cameras`) happens to overwrite it.

**Why:** Found in `CameraList.tsx`'s `startYtPoll()` (2026-07-30) — the YouTube Add modal's Repeat Playback/Channel Slot looked "not applied" after creation even though the server (`youtubeStreamService.js`) had persisted and returned them correctly from the start; only the client's local store update was missing the fields. The Edit flow (`CameraEditModal.tsx` `handleYtSave()`) never had this bug because it already forwarded the full response into `updateCamera()`, which merges (`{...c, ...updates}`) rather than replaces.

**How to apply:** When reviewing or writing any code that takes a fetch/poll response and calls a Zustand `add*`/`set*` action, check whether the object passed in is the response itself (or a spread of it) versus a hand-listed subset. Flag hand-listed subsets as a likely field-drop bug, especially in any flow that runs alongside a sibling Edit/Update flow that already does it correctly — the asymmetry is a strong signal. Reference: `docs/design/Design_Channel_Slot.md` §5.3c, `docs/tc/TC_Channel_Slot.md` TC-CH-C-002a.
