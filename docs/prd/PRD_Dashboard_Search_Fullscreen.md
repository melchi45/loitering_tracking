# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# Dashboard — Full-Screen Unified Search Panel

| | |
|---|---|
| **Document ID** | PRD-LTS2026-SEARCH-FS-001 |
| **Version** | 1.0 |
| **Status** | Approved |
| **Date** | 2026-05-27 |
| **Author** | LTS2026 Team |
| **Parent** | PRD_LTS2026_Loitering_Tracking_System.md |

---

## 1. Executive Summary

The current **SearchBar** provides a compact dropdown that lists up to 30 results. Users who need to perform investigative searches — correlating alerts, detections, face matches, and loitering events across multiple cameras and time windows — find the dropdown insufficient.

This document specifies a **Full-Screen Unified Search Panel** that opens from the existing SearchBar, presents a two-column master/detail interface, and allows deep investigation of any security event without leaving the dashboard.

---

## 2. Problem Statement

| Pain Point | Current State | Desired State |
|---|---|---|
| Result count limit | Max 30 results in a tiny dropdown | Paginated list, up to 200 per page |
| Context switching | Clicking a result jumps to a different tab | Detail shown in the same screen |
| Type filtering | All types mixed in one list | Toggle chips per entity type |
| Date range query | Not supported in dropdown | Date-from/Date-to pickers |
| Result detail | One-line summary only | Full detail panel with images, attributes, and actions |
| Keyboard navigation | Not supported | Arrow keys to browse results, Esc to close |

---

## 3. Goals & Non-Goals

### Goals
- G-1: Single overlay screen for complete security event investigation
- G-2: Filter by entity type (Detection / Alert / Face / Match / Event) with multi-select chips
- G-3: Date range filtering with calendar pickers
- G-4: Master list (left) + detail panel (right) layout
- G-5: Detail panel shows all relevant fields, images, and actions per entity type
- G-6: Keyboard-navigable result list (↑↓ arrows, Enter, Esc)
- G-7: Acknowledge alert action directly from detail panel
- G-8: Export visible results as CSV

### Non-Goals
- Real-time streaming into the search panel (search is on-demand)
- Video clip playback inside the panel (out of scope for v1.0)
- Multi-select bulk actions beyond export

---

## 4. User Personas & Use Cases

| Persona | Use Case |
|---|---|
| Security Operator | "Show me all loitering alerts from Camera 3 in the last hour, with images" |
| Supervisor | "Find all face matches for person 'John Doe' over the last 24h" |
| Analyst | "Export all detections between 08:00 and 09:00 today for the incident report" |
| Administrator | "Verify that the system detected smoke/fire events in Zone B last week" |

---

## 5. Acceptance Criteria

| ID | Criterion |
|---|---|
| AC-01 | A fullscreen icon button appears in the SearchBar component |
| AC-02 | Clicking the button opens a full-viewport overlay panel |
| AC-03 | Pressing Escape closes the panel |
| AC-04 | The panel contains a search input pre-filled with the current query |
| AC-05 | Type filter chips (All / Detection / Alert / Face / Match / Event) are displayed |
| AC-06 | Selecting a chip re-runs the search with `types=<selected>` |
| AC-07 | Date-from and date-to pickers filter the time range |
| AC-08 | Results are displayed in a scrollable left panel |
| AC-09 | Clicking a result row shows its full detail in the right panel |
| AC-10 | Arrow-key navigation changes the selected result |
| AC-11 | Detail panel shows large image (crop/photo) when available |
| AC-12 | Detection detail shows all attributes (face, mask, hat, color, accessories) |
| AC-13 | Alert detail shows Acknowledge button; clicking acknowledges via API |
| AC-14 | Face/Match detail shows both live crop and gallery photo side-by-side |
| AC-15 | "Load More" loads the next page of results |
| AC-16 | "Export CSV" downloads current results as a CSV file |
| AC-17 | Result count badge updates on each search |

---

## 6. Feature Priority

| Priority | Feature | Rationale |
|---|---|---|
| P0 | Full-screen overlay open/close | Core navigation |
| P0 | Left result list + right detail panel | Core layout |
| P0 | Type filter chips | Most-requested filter |
| P1 | Date range pickers | Needed for investigations |
| P1 | Keyboard navigation | Operator efficiency |
| P1 | Alert acknowledge action | Avoid tab-switching |
| P2 | Export CSV | Analyst workflow |
| P2 | Live crop + gallery dual-image for matches | Face ID v1.1 feature parity |

---

## 7. Metrics of Success

| Metric | Target |
|---|---|
| Time to find a specific event | Reduced by 50% vs. tab-switching workflow |
| Support for result set size | 200 results per query |
| Keyboard-only navigation coverage | 100% of result list actions |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — PRD for Dashboard Search Fullscreen |
