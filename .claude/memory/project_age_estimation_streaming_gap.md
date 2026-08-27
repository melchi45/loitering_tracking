---
name: project-age-estimation-streaming-gap
description: "Timeline and current state of the Age Estimation (estimatedAge) and Gender Classification (estimatedGender) AI modules, including the 2026-07-12→07-14 streaming-mode display gap and its fix."
metadata: 
  node_type: memory
  type: project
  originSessionId: 9e6e2577-6957-415b-a0dd-c1bc4886af4c
---

**Age Estimation** (`server/src/services/ageEstimationService.js`) shipped 2026-07-12 as an opt-in per-person attribute module (InsightFace GenderAge / ViT Age Classifier, admin-selectable in the AI Models catalog). It computed `estimatedAge` and emitted it over the live `detections` Socket.IO event, but:
- 2026-07-14: discovered it was never persisted to `detectionTracks`/`detectionSnapshots` nor rendered in any client component — fixed by adding it to `pipelineManager.js`'s `ctx._trackMeta` persistence sites, `snapshotService.js`, and 4 client display locations (`CameraView.tsx`, `FullscreenCameraView.tsx`, `DetectionsTimelineInline.tsx`, `SearchFullscreen.tsx`).
- Same day, follow-up: a user reported the fix still didn't show data on a `SERVER_MODE=streaming` deployment. Root cause (found via a temporary diagnostic log in `_processRemoteResult()` inspecting live traffic): `analysisApi.js`'s `POST /frame` handler — the entry point for streaming-delegated frames — never called `AgeEstimationService` at all; it was only wired into `pipelineManager.js`'s local-camera loop. Fixed by adding the same face/body-fallback + throttle-cache logic to `analysisApi.js`. See [[feedback_dual_frame_entry_points]] for the durable lesson extracted from this incident.
- Also fixed same day: `getAnalysisMetrics()`'s `services` object silently omitted an `ageEstimation` diagnostic key entirely (not even `null`) — added so operators can tell "toggle off" vs. "model not loaded remotely" vs. "stale code" from `/api/analysis/metrics` alone.

**Gender Classification** (`server/src/services/genderClassificationService.js`, added 2026-07-14) is the direct sequel: same catalog/service/persistence/display pattern as Age Estimation, but built with **both** frame-processing entry points from the initial implementation (per the lesson above), reusing Age Estimation's already-downloaded `genderage.onnx` file for its lightweight model option (reads the gender channels at `output[0:2]` that `AgeEstimationService` ignores) plus a dedicated ViT classifier (`rizvandwiki/gender-classification-2`, verified to exist on HuggingFace, 99.1% eval accuracy) via the existing `hfOptimumExport` conversion path.

Full SDLC doc set for both features: `docs/{mrd,rfp,prd,srs,design,tc}/*_AI_Age_Estimation.md` and the `*_AI_Gender_Classification.md` equivalents, plus `docs/ops/{Age,Gender}_Estimation_Guide.md`/`Gender_Classification_Guide.md`.

**2026-07-15 follow-up gap (fixed):** even with computation wired into both frame-entry-points (above), `pipelineManager.js`'s streaming-mode `_trackMeta` accumulator (`_processRemoteResult()`) had its own separate field list that omitted `estimatedAge`/`estimatedGender` — so on `SERVER_MODE=streaming` servers the values computed remotely never reached the local `detectionTracks` table, and never showed in the Fullscreen bottom DETECTION timeline's Person Detail panel (`DetectionsTimelineInline.tsx`), even though the same fields worked fine in combined/analysis-local mode. See [[feedback_dual_frame_entry_points]] for the generalized lesson (a third internal fork, not just the two entry points).
