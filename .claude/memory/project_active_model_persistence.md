---
name: project-active-model-persistence
description: Active Model Persistence feature (2026-07-14) — Admin Dashboard AI Models Active selections now survive server restart via activeModelConfig.js / settings table.
metadata: 
  node_type: memory
  type: project
  originSessionId: ee6c53f0-9a78-49ad-ab9c-458fb4bb5e45
---

Shipped 2026-07-14: Admin Dashboard → AI Models tab Active/Deactivate selections (per family — YOLO Detection Model, Cloth Attribute, Human Parsing, Appearance Re-ID, Age Estimation, Gender Classification, etc.) previously lived only in `analysisApi.js`'s in-memory service instances and silently reverted to the hardcoded/`.env` default on every server restart.

**Fix:** new `server/src/services/activeModelConfig.js` persists `family -> modelId|null` in the existing generic `settings` table (row id `activeModels`), same `DB_TYPE` (json/mongodb) backend already used by `trackerConfig.js`/`analyticsConfig.js` — no schema change. `POST /models/switch`/`POST /models/deactivate` in `analysisApi.js` were refactored so their per-family dispatch logic lives in shared `_applyModelSwitch()`/`_applyModelDeactivate()` functions, called both by the live routes (which persist only on success) and by a new `_restoreActiveModels()` step that runs at the end of `_loadServices()` on every boot.

**Design is generic by construction:** the restore loop drives off `entry.family` + `ALL_MODELS`, so adding a new AI model family in the future needs zero additional persistence code — only the same `EXTENDED_CATALOG` entry + switch/deactivate case every family already requires. See [[feedback_dual_frame_entry_points]] for a related but distinct lesson (this feature only had one entry point to fix, `analysisApi.js`, since Active-model switching was never wired into `pipelineManager.js`'s separate local-camera service instances in the first place — that gap is pre-existing and explicitly out of scope, documented in `Design_AI_Model_Catalog.md` §11.4).

Full SDLC doc set: `docs/mrd/MRD_AI_Model_Active_Persistence.md` (new dedicated MRD, since `AI_Model_Catalog` itself never had one), `docs/{rfp,prd,srs,design,tc}/*_AI_Model_Catalog.md` (each bumped with a persistence section — RFP FR-RFP-MC-015, PRD §4.6/AC-12, SRS §3.7 FR-MC-031~035, Design §11, TC TC-MC-026~030), `docs/ops/Distributed_AI_Pipeline_Setup.md` §1.4, `test/api/model_catalog.test.js` Group F (TC-MC-026/027, unit-tested against a scratch JSON DB).
