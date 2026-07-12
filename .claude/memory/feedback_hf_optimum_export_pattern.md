---
name: feedback-hf-optimum-export-pattern
description: Reuse the hfOptimumExport catalog strategy for any future non-YOLO HuggingFace PyTorch model integration instead of re-deriving a PT→ONNX conversion path
metadata:
  type: feedback
---

When adding the Age Estimation feature (2026-07-12), the ViT Age Classifier (`nateraw/vit-age-classifier`) needed a PT→ONNX conversion path, but the codebase's only existing HuggingFace conversion strategy — `hfExport: { repo, file }` — is hard-wired to `ultralytics.YOLO(pt).export(format="onnx")` (see `server/src/routes/analysisApi.js` `/models/download` handler, PPE/Fire-Smoke entries). That only works for Ultralytics YOLO architectures; a ViT image classifier isn't one.

A fourth catalog source strategy, `hfOptimumExport: { repo }`, was added instead of forcing the ViT model through the YOLO-shaped path: it resolves a Python interpreter via a new `_findPythonWithOptimum()` (checks `import optimum, transformers`) and runs `optimum.exporters.onnx.main_export(model_name_or_path=repo, output=tmpDir, task="image-classification")`. The catalog now has four mutually-exclusive source strategies: `url` (direct ONNX), `hfExport` (HuggingFace `.pt` → `ultralytics export`), `hfOptimumExport` (HuggingFace checkpoint → `optimum.exporters.onnx`), `manualOnly` (no automatable source). A fifth, `pyExport` (standalone bespoke script, e.g. PromptPAR's `exportPromptPAR.py`), covers architectures too bespoke even for `optimum`.

**Why:** Reaching for `hfExport`/`ultralytics` for a non-YOLO HuggingFace model would either silently fail or require awkward workarounds. `optimum` is HuggingFace's own official ONNX export tool and handles the broad range of `transformers` model classes (ViT, BERT-style, etc.) correctly.

**How to apply:** When integrating a future non-YOLO HuggingFace PyTorch model into the AI model catalog, default to the `hfOptimumExport` strategy (mirror `analysisApi.js`'s `entry.hfOptimumExport` branch and `_findPythonWithOptimum()`) rather than designing a new one-off conversion path. Only fall back to a bespoke `pyExport` script (see PromptPAR's `exportPromptPAR.py`) when the model's architecture is so bespoke that even `optimum` can't export it directly (e.g. needs custom weight reconstruction, non-standard fusion layers). See `docs/design/Design_AI_Model_Catalog.md` §4.2d and `docs/design/Design_AI_Age_Estimation.md` §5 for the reference implementation.
