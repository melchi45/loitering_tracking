---
name: feedback-memory-location-project-local
description: This project's Claude memory lives in-repo at .claude/memory/, not in the external per-user harness memory path
metadata:
  type: feedback
---

For this project, do not write persistent memory to the external harness-default path (`~/.claude/projects/<project-hash>/memory/`). Instead, read and write memory files under `.claude/memory/` inside this repository. `CLAUDE.md` carries a pointer to `.claude/memory/MEMORY.md` so any Claude session opening this repo — regardless of machine or user account — picks up the same notes automatically, since `.claude/memory/` is checked into git alongside the code.

**Why:** The user explicitly asked (2026-07-12) for memory to work only from inside the project rather than depend on a machine-local external folder outside the repo, so the notes travel with the repository itself.

**How to apply:** When saving a new feedback/project/reference memory for this repo, write it as a new `.md` file under `.claude/memory/` with the standard frontmatter, and add a one-line pointer to `.claude/memory/MEMORY.md`. Do not also duplicate it to the external per-user memory path.
