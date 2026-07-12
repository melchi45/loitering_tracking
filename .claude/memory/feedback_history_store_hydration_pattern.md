---
name: feedback-history-store-hydration-pattern
description: "New \"history-type\" Zustand stores must hydrate from the server on mount, not start empty"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 541ebcfa-cbc6-4d9e-bef6-62a40ae1a27d
---

Any new "history-type" Zustand store (feeds/logs of past events) must implement a `hydrate()` action that is called from `App.tsx` in a `useEffect` fetching from the server on mount, so the panel doesn't start empty on every page refresh.

**Why:** `useCrossCameraStore` originally did not fetch history from the server on mount (unlike `usePersonTrajectoryStore`), so it started as an empty list on every refresh. Fixed by calling `GET /api/analysis/face-trajectories?limit=100` in `App.tsx`, reconstructing transitions (`segments[i-1] → segments[i]`) into `CrossCameraReIdEvent[]`, and passing them to `hydrate()`.

**How to apply:** When adding a new history/feed-style Zustand store, implement both the `hydrate()` action and the `App.tsx` mount-time fetch together — don't ship one without the other. Pairs with [[feedback-history-feed-no-time-prune]] (count-based capping, not time-based expiry) for the same class of store. Reference: `.claude/skills/cross-camera-face-reid/SKILL.md`, `docs/design/Design_CrossCamera_Face_Tracking.md` §4.6.
