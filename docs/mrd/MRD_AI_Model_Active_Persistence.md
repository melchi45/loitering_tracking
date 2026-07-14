# MRD — AI Model Active Persistence

**Product:** LTS-2026 Loitering Detection & Tracking System  
**Feature:** Restart-Survival for Admin Dashboard AI Model "Active" Selections  
**Version:** 1.0  
**Date:** 2026-07-14  
**Author:** LTS Engineering Team

---

## 1. Executive Summary

The Administrator Dashboard's AI Models tab lets operators Activate/Deactivate a specific model per AI family (YOLO Detection Model, Cloth Attribute, Human Parsing, Age Estimation, Gender Classification, etc. — see `RFP_AI_Model_Catalog.md`). Every one of these choices lived only in server process memory: restarting the `SERVER_MODE=analysis` (or `combined`) process silently reverted every family to its hardcoded/`.env`-default model, discarding the operator's selection with no warning. This MRD covers making every Active/Deactivate selection survive a server restart, using the same storage the system already uses for other admin-configurable settings.

---

## 2. Operational Need

| Pain Point | Impact |
|---|---|
| Selecting a non-default model (e.g. OpenPAR instead of PromptPAR, YOLO12n instead of the default YOLO detector, ViT Age/Gender Classifier instead of InsightFace) does not survive a restart | Operator must re-select every non-default model by hand after every deploy, crash recovery, or planned maintenance restart |
| No indication in the UI or logs that a restart wiped the selection | Silent regression — a switched model that was "Active" yesterday quietly reverts, and nothing tells the operator why inference behavior changed |
| Deactivated (explicitly unloaded) families also silently re-load their on-disk default after a restart | An operator who freed memory/VRAM by deactivating a family loses that memory saving on every restart |

---

## 3. Target Users

| User | Context |
|---|---|
| System Administrator | Selects non-default models for accuracy/speed/memory trade-offs via the AI Models tab and expects the choice to stick |
| DevOps / SRE | Restarts or redeploys the analysis server as part of routine operations and must not have to manually re-apply model selections afterward |
| Field Engineer | Configures a GPU-constrained edge deployment (e.g. deactivating PromptPAR, activating OpenPAR) and expects that configuration to persist across power cycles |

---

## 4. Business Requirements

| ID | Requirement |
|---|---|
| BR-01 | Every model Activate/Deactivate action taken from the Admin Dashboard AI Models tab must be saved to persistent storage, not just process memory. |
| BR-02 | The saved selection must be restored automatically the next time the server starts, before it begins serving inference traffic — no operator action required. |
| BR-03 | Persistence must work identically regardless of the configured storage backend (`DB_TYPE=json` or `DB_TYPE=mongodb`). |
| BR-04 | If a persisted model is no longer available (file deleted, entry removed from the catalog), the server must start successfully anyway, fall back to the family's default, and log a warning — a missing file must never block startup. |
| BR-05 | The persistence mechanism must extend to any AI model family added in the future without requiring new storage schema or new persistence code — only the same switch/deactivate wiring every family already needs. |

---

## 5. Success Metrics

- 0 operator-reported "my model selection reset after a restart" incidents post-release
- 100% of successful `/models/switch` and `/models/deactivate` calls result in a row write to the `settings` table, verifiable via `GET /api/settings/activeModels`
- Server startup time increase attributable to restore ≤ a few hundred ms (bounded by the number of persisted families, typically single digits)

---

## 6. Out of Scope

- Persisting selections for `pipelineManager.js`'s locally-captured-camera AI services in `SERVER_MODE=combined` (a separate, pre-existing gap where `/models/switch` never affected that code path at all — see `Design_AI_Model_Catalog.md` §11.4). This MRD covers `SERVER_MODE=analysis`/`combined`'s shared `analysisApi.js` inference path only, matching the reported scenario.
- A UI affordance showing "this selection differs from the shipped default" or an audit trail of who changed which model when (`AuditService.js` integration is a candidate for a future iteration, not this one).
- Versioning/rollback of past model selections — only the single current selection per family is stored.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-14 | 초기 작성 — Admin Dashboard AI Model Active 선택이 서버 재시작 후 초기화되는 문제에 대한 비즈니스 요구사항 정의 |
