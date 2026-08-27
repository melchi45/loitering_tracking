---
name: feedback-docs-first-new-features
description: "For substantial new features (not bug fixes), write the design doc and capture open questions BEFORE writing any implementation code"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 23271567-dba0-4ffb-98f5-ab031d3bf1f0
---

When asked to build a substantial new feature (not a bug fix or small enhancement) in this project, write the design doc first — investigate the actual current state of the relevant code, map requirements to real data sources/components, and surface open questions — before writing any implementation code. Update skills and MEMORY.md as part of that same docs-first pass, not deferred to the end.

**Why:** User explicitly interrupted an in-progress feature (Ingest Daemon Admin Dashboard monitoring, 2026-07-21) that had already moved to investigating the codebase, saying "기능 추가전 docs 를 먼저 추가하고, skills 및 MEMORY.md 파일에 기록부터 해주세요" (write docs first, before adding the feature, and record in skills/MEMORY.md first). This is distinct from [[feedback_sdlc_sync]] (which is about keeping docs in sync *with* code changes in the same response) — this is specifically about sequencing for *new* features: docs and open questions surface first, implementation follows only after decisions are confirmed.

**How to apply:**
- When a request describes a new capability spanning multiple files/services (not "fix X" or "add a field to Y"), pause before implementing.
- Research the actual current state (read the real code, don't assume) and write a design doc capturing: requirements, current-state findings, a data-source/ownership mapping if the feature spans multiple processes or services, a proposed architecture, and explicit open questions for anything genuinely ambiguous.
- Use AskUserQuestion for the open questions once the doc exists — don't implement around unstated assumptions for anything that meaningfully changes the architecture (scope, real-time mechanism, security model, etc.).
- Update the relevant skill files (`.claude/skills/` + `.github/skills/` mirror) and MEMORY.md with the plan/findings at this same stage, not only after implementation finishes.
- Once decisions are confirmed, implement, then return to the same docs/skills/memory files and update them to reflect what was actually built (mark Proposed → Implemented, add a results/verification section) rather than leaving them as a stale plan.
