---
name: project-guide-distribution-pattern
description: "Established workflow for absorbing docs/rfp/*_가이드.md reference guides into the MRD/RFP/PRD/SRS/Design/ops/TC SDLC chain, then deleting the source guide"
metadata: 
  node_type: memory
  type: project
  originSessionId: cb8e8d69-d9db-4a37-bd9f-27b74879f6fd
---

This project has a recurring pattern: the user drops abstract external reference guides into `docs/rfp/*_가이드.md` (e.g. `CCTV_IPTV_상의하의_색상분류_가이드.md`, `Multi_Camera_Tracking_ReID_가이드.md`, `Loitering_Detection_가이드.md`, `ReID_및_색상분석_활용가이드.md`) and asks to "concretize" them by distributing their content into the existing MRD/RFP/PRD/SRS/Design/ops/TC docs (and test scripts where applicable), creating a new standalone doc only if content doesn't fit an existing chain.

**Why**: The guides themselves are too abstract/high-level to act on directly (per the user, 2026-07-09). The project's convention is to treat them as one-time source material: gap-analyze against current implementation, write concrete FR-IDs/design sections/milestones into the permanent SDLC docs, then **delete the source guide file once its content is fully absorbed** — it should not remain as a permanent parallel copy. `Multi_Camera_Tracking_ReID_가이드.md` was already fully absorbed + deleted this way; `CCTV_IPTV_상의하의_색상분류_가이드.md` was absorbed + deleted 2026-07-09 (user confirmed via prompt, since it was an untracked file with no git history to recover).

**How to apply**: When asked to concretize one of these guide files again (e.g. `Loitering_Detection_가이드.md` or `ReID_및_색상분석_활용가이드.md` are still present in `docs/rfp/`):
1. Read the guide fully, then read the existing RFP/PRD/SRS/Design/TC chain for the corresponding module to see what's already covered (a lot may already be done from a prior turn — check `git diff HEAD --stat` for uncommitted work before assuming nothing exists).
2. For each concrete tier/recommendation in the guide, either (a) find it's already mapped to a design section, or (b) write a new "Proposed, not yet implemented" section with FR-IDs (SRS), milestone+TODO (PRD), Appendix note (RFP), architecture (Design), and a "Planned" test group (TC) — never silently implement code changes beyond what's asked.
3. Bump each touched doc's version header + append a Document History / 개정 이력 row (never edit history rows in place).
4. Once every tier is covered, **ask the user before deleting the source guide** (AskUserQuestion) — these files are untracked in git, so `rm` is unrecoverable. If confirmed, delete it and rewrite any *live* prose citations (status blockquotes, explanatory paragraphs) in the dependent docs to an archival phrasing like "(now-consolidated, original deleted YYYY-MM-DD)" — but leave historical Document History table rows untouched (they're an append-only log of what was true at that version).

**Non-obvious finding (2026-07-09)**: At the time of the CCTV_IPTV guide's absorption, the working tree already had substantial *code* implementing AI-05 Phase-3 Human Parsing (`colorClothService.js` `_runHumanParsing`/`reloadHumanParsing`/`_parseCache`, `pipelineManager.js`, `attributePipeline.js`, `analyticsConfig.js`'s `humanParsing` toggle, `analysisApi.js`'s `EXTENDED_CATALOG`, `downloadModels.js`) and CrossCamera Face Tracking Phase-2 Appearance Re-ID (`appearanceReidService.js`, `qdrantService.js`, Qdrant in `docker-compose.yml`) — all uncommitted, all feature-flagged off by default (`humanParsing: false`, `QDRANT_ENABLED=false`, model download entries `enabled: false`), with code comments explicitly noting model source URLs are unverified. The docs (Design/SRS/PRD/RFP/TC) still say "Proposed, not yet implemented" for these, which is technically stale (the scaffolding exists) but not necessarily wrong to leave as-is since the feature is inert until someone downloads/verifies the models and flips the flags. Flag this to the user rather than silently rewriting "Proposed" → "Implemented" — verifying real model behavior first is the user's call, not something to assume in docs.

Related: [feedback_sdlc_sync.md](feedback_sdlc_sync.md)
