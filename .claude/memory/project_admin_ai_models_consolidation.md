---
name: project-admin-ai-models-consolidation
description: "Analysis-mode sidebar Analytics tab (VideoAnalyticsTab.tsx) fully removed 2026-07-30 — content merged into Admin Dashboard → AI Models, split into 3 clearly separated sections"
metadata: 
  node_type: memory
  type: project
  originSessionId: b3c8c8ff-973b-46d2-b12c-190f0dae72df
  modified: 2026-07-30T07:08:48.351Z
---

**2026-07-30**: `client/src/components/VideoAnalyticsTab.tsx` — the sidebar "Analytics" tab that used to appear in analysis mode (and, in earlier historical iterations, combined/streaming modes too) — was **deleted entirely**. Its full content is now inside `AiModelsSection` (`client/src/pages/admin/AdminUsersPage.tsx`, Admin Dashboard → AI Models), restructured into three explicitly separated sections:

1. **Model Selection (Active/Deactivate)** — unchanged, pre-existing YOLO + Additional Model Families tables (`/api/analysis/models/switch|deactivate`).
2. **Analytics Categories (On/Off)** — `ADMIN_MODULE_GROUPS` expanded from 3 groups (Core/Attributes/Hazards) to 9, absorbing the former sidebar tab's full COCO 80-class catalog (Accessories/Indoor/Animals/Outdoor/Food/Appliances) plus `glasses`/`sunglasses` Phase-2 pending items. Backed by `/api/analytics/config` — unchanged API.
3. **Tracking & Sensitivity Tuning** (new) — Appearance Weights, Fire/Smoke Sensitivity, Tracker/Kalman Settings sliders, ported verbatim from the old tab. Backed by `/api/tracker/config`(+`/reset`) and `/api/analysis/config/fire-smoke` — unchanged APIs.

**Why 3 sections, not 2**: the user explicitly asked to keep "which model is active" separate from "is the category on/off" — these were already adjacent-but-distinguishable in `AiModelsSection` before this change; the work made the separation explicit (section headers, comments) while also expanding category coverage to full parity with what the old tab had.

**Analysis-mode sidebar now has only one tab** (`detections` → `AnalysisEventsTab`). `App.tsx`'s `SidebarTab` union, `TAB_ITEMS`, and `ANALYSIS_TABS` were all updated; this also fixes mobile bottom-nav automatically since both derive from the same `TAB_ITEMS` array — no separate mobile-specific code path existed despite what `docs/design/Design_Mobile_Layout.md` describes (that doc is from an earlier architecture iteration with a distinct `mobileTab` state; kept as historical background, not deleted).

**Known gap surfaced by this change**: Admin Dashboard is not mobile-optimized, so a "Remote Administrator" persona (per `PRD_Mobile_Layout.md`) who used to reach Analytics config from a phone via the sidebar tab has no equivalent mobile-friendly path now. Not fixed — just flagged in the PRD.

**Detections history** — user asked to verify this wasn't already duplicated elsewhere before touching it. Confirmed: `AnalysisEventsTab.tsx` (sidebar Detections tab) and `AnalysisDetectionPanel.tsx` (full-screen overlay from `AnalysisServerDashboard.tsx`'s stat card) are near-duplicate implementations of the same `/api/analysis/events` DB history — this was already true before this session, not something introduced by it. No changes made here.

**i18n cleanup**: 9 now-unused translation keys (`tabVideoAnalytics`, `videoAnalyticsHint`, `videoAnalyticsFooter`, `vaDisableAllModules`, `vaEnableAllAvailable`, `vaDisableGroup`, `vaEnableGroup`, `vaFireSensitivityHint`, `vaNmsHint`) removed from all 15 locale files. The `zoneGroup*` keys (group labels) were **not** removed — they're still shared with `FullscreenCameraView.tsx`'s detection-list grouping display.

**Docs**: this was a large fan-out — `Design_Admin_Dashboard.md` §4.2 (full rewrite, v1.9), `SRS_Admin_Dashboard.md` (new §4.3, v1.4), `TC_Admin_Dashboard.md` (new TC-AD-011b~d, v1.4), `Design_Dashboard_Layout.md`/`SRS_Dashboard_Layout.md`/`TC_Dashboard_Layout.md`/`PRD_Dashboard_Layout.md`/`RFP_Dashboard_Layout.md` (sidebar tab count corrected), `Design_Dashboard_Analysis_Mode.md` (v2.0, §10.2 changelog), `Design_Dashboard_Detection_Display.md`+SRS+RFP+PRD+TC (banner notes — this feature's docs had an entire historical §7/§10.3 devoted to the old tab), Mobile Layout doc set (RFP/PRD/SRS/Design/TC), plus ~15 more feature-specific docs (Animal/Hat/Face/Accessories/Mask Detection, LTS2026 system overview, WebRTC Media Gateway, Distributed AI Pipeline) that incidentally referenced `VideoAnalyticsTab.tsx` as an implementation file — all corrected with pointer notes rather than full rewrites. If a future session finds a stale `VideoAnalyticsTab` reference somewhere, grep `docs/` for it — there may be a few very deep/incidental mentions left unedited by design (kept as historical narrative inside sections already banner-annotated at the top).
