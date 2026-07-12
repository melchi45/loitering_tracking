---
name: feedback-async-button-tristate
description: "Async action buttons whose result can legitimately be empty need 3-way state, not a boolean/data!=null gate"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 541ebcfa-cbc6-4d9e-bef6-62a40ae1a27d
---

Any async action button (detect/search/lookup, etc.) whose successful result can legitimately be an empty value must not render based on a 2-way gate like `boolean`/`data != null`. "Not yet attempted" and "attempted but empty result" render identically, making the button look broken to the user.

- ❌ `{!hasResult && <p>Click to try…</p>} {hasResult && <ResultView/>}`
- ✅ `{!hasResult && !attempted && <p>Click to try…</p>} {!hasResult && attempted && <p>Tried — nothing found.</p>} {hasResult && <ResultView/>}`

Keep `attempted` (or a similarly named state like `redetected`) as separate state from the result data itself — that's the only way to distinguish the three states.

**Why:** Discovered from the `CameraEditModal.tsx` "Re-detect" button bug (2026-07-02) — a real empty-result case was indistinguishable from "never clicked," making the button appear non-functional.

**How to apply:** When implementing or reviewing any async action button in the React client, check for this 3-way state pattern. Reference: `docs/design/Design_Channel_Slot.md` §5.4a, `.claude/skills/react-dashboard-dev/SKILL.md`.
