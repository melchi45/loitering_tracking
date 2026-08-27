---
name: feedback-dual-frame-entry-points
description: "New per-person AI attribute modules (age, gender, etc.) must be wired into BOTH pipelineManager.js's local-camera loop AND analysisApi.js's POST /frame handler from the first implementation — they are separate code paths."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9e6e2577-6957-415b-a0dd-c1bc4886af4c
---

This codebase has **two independent frame-processing entry points** for per-person AI attributes (color, cloth, face, age, gender, etc.):

1. `server/src/services/pipelineManager.js` — the local-camera loop, used when a camera is captured directly by this process (`SERVER_MODE=combined`, or an `analysis`-mode server with its own directly-attached ingest-daemon cameras).
2. `server/src/routes/analysisApi.js`'s `POST /frame` handler — the entry point that processes JPEG frames delegated over HTTP by a `SERVER_MODE=streaming` server. This is a **separately implemented** code path, not a call-through to (1).

**Why this matters:** Age Estimation (`estimatedAge`, [[project_age_estimation_streaming_gap]]) shipped 2026-07-12 with the inference call wired only into path (1). Path (2) never called `AgeEstimationService` at all — `_ageEstimation` was only referenced by the model-catalog switch/download/deactivate endpoints. This meant `estimatedAge` could never appear on any `SERVER_MODE=streaming` deployment, regardless of toggle state, model-load state, or connection health. It went undetected for two days until a user reported the display gap, and root-causing it required adding a temporary diagnostic log to `pipelineManager.js`'s `_processRemoteResult()` and inspecting live production traffic to see that the remote server's `tracked` objects were missing the field entirely (while `color`/`cloth`, which ARE wired into path (2) via `_attrPipeline.enrich()`, were present).

**How to apply:** When adding any new per-person AI attribute service (following the `AgeEstimationService`/`GenderClassificationService` template — `load()/reload()/unload()/ready/status` + a throttled per-track cache), grep both files for the existing attribute's wiring pattern and add the estimation call to **both** in the same change:
- `pipelineManager.js`: instance-level cache (`this._xCache`), called inside the local per-camera detection loop, right after the Age Estimation block.
- `analysisApi.js`: module-level cache (`_xCache` — this file has no class instance), called inside `POST /frame` right after `_attrPipeline.enrich()` and the Age Estimation block.

Also update the diagnostic field in **both** `pipelineManager.js`'s `getServiceStatus()`/`getAnalysisMetrics()` AND `analysisApi.js`'s standalone `/metrics` fallback response (used when no `pipelineManager` is registered) — these are two separate `services` objects that both silently omitted `ageEstimation` until fixed 2026-07-14.

Gender Classification (`estimatedGender`, added 2026-07-14) was built with both entry points from the initial commit specifically to avoid repeating this gap — see `docs/design/Design_AI_Gender_Classification.md` §7/§12 and `TC_AI_Gender_Classification.md` TC-GEN-015 for the regression guard test.

**Related, distinct gap found 2026-07-15:** even after a field is computed on both entry points, `pipelineManager.js` has a **third** internal fork that must independently forward it: the streaming-mode `_trackMeta` accumulator inside `_processRemoteResult()` (populates `ctx._trackMeta` from `result.tracked` returned by the remote analysis server) is a *different* code site than the local-inference `_trackMeta` accumulator used by combined/analysis-local mode — both feed the same 30s `ctx._activeFlushTimer` persistence loop that writes `detectionTracks`, but each has its own field list that must be kept in sync by hand. `estimatedAge`/`estimatedGender` were present in the local-mode accumulator (fixed 2026-07-14 per above) but missing from the streaming-mode one, so on `SERVER_MODE=streaming` servers the values arrived correctly from the analysis server (`obj.estimatedAge` was there) but were silently dropped before ever reaching the DB — invisible in `DetectionsTimelineInline.tsx`'s Person Detail panel. Fixed in `pipelineManager.js`'s `_processRemoteResult()` `_trackMeta` update/create branches (~line 2085-2121). **How to apply:** when adding a new per-person field anywhere in this pipeline, grep `_trackMeta.set(` and `_trackMeta.get(` in `pipelineManager.js` — there are two independent accumulator sites (local-mode ~line 1113, streaming-mode ~line 2091) plus the flush/finalize persistence blocks (~line 1403, ~line 1440) — and confirm the field is threaded through all of them, not just the computation call sites.
