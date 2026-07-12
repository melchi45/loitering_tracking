---
name: feedback-history-feed-no-time-prune
description: "History/log/feed-style Zustand stores must cap by count (MAX_EVENTS), never by time-based expiry"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 541ebcfa-cbc6-4d9e-bef6-62a40ae1a27d
---

Any "history/log/feed" style panel or Zustand store (e.g. Cross-Camera Re-ID feed, clothing Re-ID feed) must cap its item list by count only (`MAX_EVENTS`-style). Never add time-based expiry/pruning (e.g. `EXPIRY_MS`, filtering out items older than N seconds).

**Why:** `crossCameraStore.ts`/`clothingReIdStore.ts` previously used `EXPIRY_MS = 60_000` to filter out items older than 60s on every `addEvent()` call. When the AI analysis server stalled 60+ seconds (e.g. circuit breaker open), the next event received would wipe out the entire existing history — this was the real root cause of a v1.2 bug (2026-07-02) where the Cross-Camera Re-ID history kept disappearing on the Streaming Dashboard DETECTIONS panel.

**How to apply:** When adding or reviewing any new "history-type" Zustand store, reject time-based expiry logic on sight and use count-based capping instead. Also see [[feedback-history-store-hydration-pattern]] for the companion pattern (mount-time DB hydration) required for these same stores. Reference: `docs/design/Design_CrossCamera_Face_Tracking.md` §4.6, `.claude/skills/cross-camera-face-reid/SKILL.md`.
