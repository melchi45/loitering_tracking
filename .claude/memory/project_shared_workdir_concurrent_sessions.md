---
name: project-shared-workdir-concurrent-sessions
description: "This repo's working directory is shared by multiple concurrent Claude Code sessions (at least /home/youngho/workspace/loitering_tracking and /data6/youngho/workspace/loitering_tracking) — commits from one session can sweep up another session's uncommitted edits"
metadata: 
  node_type: memory
  type: project
  originSessionId: d9c4d386-3828-4018-a23c-bc012984c43a
---

Confirmed on 2026-07-09 during the AI Model Catalog expansion task: while this session had uncommitted edits sitting on disk, another concurrent Claude Code session (or the user, in a separate window) ran `git commit` twice against the *same* working tree — commits `bb7cf48` ("feat(ai): implement AI-05 Phase-3 Human Parsing + CrossCamera Phase-2 Appearance Re-ID") and `2a51ca7` ("docs(ai-05): absorb CCTV_IPTV color-classification guide, propose Phase-1.5, reconcile model catalog docs"). Both commits included files this session had already edited (e.g. `docs/design/Design_AI_Model_Catalog.md`, `docs/srs/SRS_AI_Model_Catalog.md`, `docs/tc/TC_AI_Model_Catalog.md`, `README.md`, `test/api/model_catalog.test.js`, `docs/ops/Distributed_AI_Pipeline_Setup.md`) alongside the other session's own unrelated changes — because both sessions share one filesystem path and one `.git`, not isolated worktrees.

Evidence this is ongoing, not a one-time fluke: `git status --short` mid-task showed `.claude/skills/cross-camera-face-reid/SKILL.md` and `.claude/skills/docker-deploy/SKILL.md` as modified even though this session never touched them — another session was actively editing in real time. Multiple `mcp-server/index.js` node processes were running simultaneously for both the `/home/youngho/...` and `/data6/youngho/...` paths (`ps aux`), and an `<ide_opened_file>` notification referenced the `/home/youngho/...` copy of `README.md`.

**Why:** No worktree isolation between the user's concurrent sessions on this project — a structural fact about how this user runs Claude Code here, not a one-off mistake.

**How to apply:**
- Never assume `git status`/`git diff` reflects only this session's own edits — always read the actual diff content (not just the file list) before deciding a file is "mine" to fix or revert.
- Before any destructive git operation (`reset`, `checkout --`, `clean`), check `git log`/`reflog` for very recent commits that might not be visible in the conversation's cached gitStatus block — that block is a snapshot from session start and goes stale fast here.
- Do not `git commit` proactively in this repo without confirming with the user first, even more than usual — a concurrent session may be mid-edit, and committing prematurely could freeze a half-finished change or duplicate a commit the other session is about to make.
- If asked to investigate "who changed X," check `git log -p`/blame rather than assuming — commit authorship/messages here can span multiple unrelated features bundled by whichever session happened to run `git commit` first.
- See [[project_face_search_condition_sync]] and [[project_loitering_missing_person_troubleshooting]] for other project-specific state to cross-check.
