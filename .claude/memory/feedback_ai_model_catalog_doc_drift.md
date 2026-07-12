---
name: feedback-ai-model-catalog-doc-drift
description: AI model/PAR-related SRS/RFP/PRD/Design docs can silently drift from shipped model files — verify server/models/ + analysisApi.js catalog before trusting doc content, and check for hard-coded catalog invariants in tests when a model swap changes catalog composition.
metadata:
  type: feedback
---

When an AI model integration ships (e.g. the PromptPAR/PA100k cloth-PAR model, 2026-07-12), the code→docs sync commit is easy to skip because there's no compile-time link between an ONNX model file and its SRS/RFP/PRD/Design description. Found `docs/design/Design_AI_Cloth_Analysis.md`, `docs/srs/SRS_AI_Cloth_Analysis.md`, and `docs/design/Design_AI_Model_Catalog.md` all still describing a 12-attribute `openpar.onnx` / `openpar-market1501` placeholder that was fully replaced months earlier by the real 26-attribute PA100k model (`openpar_pa100k.onnx`, catalog id `openpar-pa100k`) — the integration commit never touched these docs.

**Why:** Docs referencing a specific `.onnx` filename, catalog `id`, attribute count, or input tensor shape are a claim about what shipped *at the time the doc was written* — they rot silently the moment the model is swapped, because nothing breaks at build time. The drift is invisible until someone (human or agent) reads the doc and acts on stale details (wrong filename, wrong attribute schema, wrong `manualOnly` status).

**How to apply:**
- Before trusting any doc's description of an ONNX model (filename, catalog id, attribute/output schema, `manualOnly` flag), grep the actual service file (e.g. `colorClothService.js`) and the catalog entry in `analysisApi.js`'s `EXTENDED_CATALOG` — don't assume the doc is current just because it has a recent-looking version number.
- When a catalog entry's `manualOnly` flag or count changes (adding/removing a model), check `test/api/model_catalog.test.js` for hard `assert()`s on catalog composition (e.g. `manualEntries.length >= 1`) — these can silently start failing (or silently stop testing anything meaningful) if a model swap changes which entries are `manualOnly` without the test being re-verified against the new catalog shape.
- When shipping a new selectable model into an existing family (e.g. adding OpenPAR alongside PromptPAR under `cloth-par`), the Admin Dashboard's generic per-family table (`AdminUsersPage.tsx` `AiModelsSection()`) already renders multiple entries with independent Activate buttons with zero UI code changes — no bespoke selector component is needed.
