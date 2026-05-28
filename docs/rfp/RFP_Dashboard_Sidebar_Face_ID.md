# RFP: Dashboard Sidebar — Face ID Panel

**Document No.**: LTS-2026-013  
**Version**: 1.1  
**Date**: 2026-05-27  
**Classification**: Technical Requirements Specification (RFP)  
**Status**: Active — v1.1 amended (Live Match Crop + Search)  
**Related RFPs**: LTS-2026-010 (Dashboard Layout), LTS-2026-001 (Loitering Tracking System), LTS-2026-009 (Face Recognition AI), LTS-2026-SNAP-001 (Detection Snapshot & Search)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Panel Diagram](#2-panel-diagram)
3. [Panel Header](#3-panel-header)
4. [Gallery Section](#4-gallery-section)
5. [Face Card](#5-face-card)
6. [Gallery Creation Flow](#6-gallery-creation-flow)
7. [Face Enrollment Flow](#7-face-enrollment-flow)
8. [Match Log](#8-match-log)
9. [Missing Person Alert Banner](#9-missing-person-alert-banner)
10. [Gallery Type Specification](#10-gallery-type-specification)
11. [REST API Integration](#11-rest-api-integration)
12. [Socket.IO Events](#12-socketio-events)
13. [Data Persistence](#13-data-persistence)
14. [i18n Keys](#14-i18n-keys)
15. [Implementation Status](#15-implementation-status)

---

## 1. Overview

### 1.1 Purpose

This document defines the technical requirements for the **Face ID tab** (`faces`) panel of the LTS Dashboard right sidebar. The Face ID panel enables security operators to:

- Create and manage **named face galleries** categorized as Missing Person, VIP, Blocklist, or General.
- **Enroll persons** by uploading face photos; the server extracts ArcFace embeddings automatically.
- View a real-time **face-match log** of persons identified in live camera feeds.
- Receive a flashing **missing person alert banner** when a missing-person match occurs.

### 1.2 Scope

- Gallery CRUD: create / expand / delete named galleries
- Face enrollment: drag-drop or click-to-upload JPEG/PNG/WebP → server SCRFD + ArcFace inference
- Face card list with thumbnail, name, delete button
- Real-time match log via Socket.IO `face_match` event
- Missing-person alert banner (flashing, dismissible)
- Full gallery type system (missing / vip / blocklist / general)

### 1.3 Out of Scope

- Face-to-face search query across galleries (Phase-2)
- Bulk face import via ZIP file (Phase-2)
- Manual embedding vector override (Phase-3)
- Gallery export / import (Phase-3)

---

## 2. Panel Diagram

### 2.1 Normal State (Gallery Selected)

```
┌──────────────────────────────────────────────────┐
│  🪪 Face ID   Enroll & recognize persons          │  ← Header
├──────────────────────────────────────────────────┤
│  [Gallery name…]  [▾ Type ▾]  [+ Create]        │  ← Gallery creation row
├──────────────────────────────────────────────────┤
│  🔍 MISSING  ●                                   │  ← Section (type: missing)
│    ▶ 🔍 Missing Persons (2)         [2] [✕]     │  ← Gallery row (collapsed)
│  ⭐ VIP                                          │
│    ▶ ⭐ VIP Gallery (1)             [1] [✕]     │
│  🚫 BLOCKLIST                                    │
│    ▶ 🚫 Suspects (3)               [3] [✕]     │
│  🗃 GENERAL                                      │
│    ▼ 🗃 Staff (5)                  [5] [✕]     │  ← Selected gallery (expanded)
├──────────────────────────────────────────────────┤
│  [📷 Upload Photo] (drag-drop or click)          │  ← UploadArea
│  [Person Name…]                    [Enroll]      │
├──────────────────────────────────────────────────┤
│  [👤 Alice] [👤 Bob] [👤 Carol]  …              │  ← FaceCard grid
├──────────────────────────────────────────────────┤
│  Recent Matches                                  │  ← MatchLog
│  [🚨 Missing · Alice · 94.2% · CAM-1 · 12:34:01]│
│  [⭐ VIP    · Bob   · 87.3% · CAM-2 · 12:33:55] │
│  [⚡ General· Carol · 76.1% · CAM-1 · 12:33:40] │
└──────────────────────────────────────────────────┘
```

### 2.2 Missing Person Alert State

```
┌──────────────────────────────────────────────────┐
│  🚨 MISSING PERSON: Alice   94.2%   CAM-1       │  ← Banner (animate-pulse)
├──────────────────────────────────────────────────┤
│  ... (normal panel content below) ...            │
└──────────────────────────────────────────────────┘
```

### 2.3 Empty State (No Galleries)

```
┌──────────────────────────────────────────────────┐
│  🪪 Face ID   Enroll & recognize persons          │
├──────────────────────────────────────────────────┤
│  [Gallery name…]  [▾ Type ▾]  [+ Create]        │
├──────────────────────────────────────────────────┤
│             👤                                   │
│         No galleries                             │
└──────────────────────────────────────────────────┘
```

---

## 3. Panel Header

| Element | CSS / Value | Description |
|---|---|---|
| Icon | `🪪` | Tab icon |
| Title | `text-sm font-bold text-white` | i18n key `tabFaceGallery` |
| Subtitle | `text-[9px] text-gray-500` | i18n key `faceGallerySubtitle` |
| Missing badge | `bg-red-700 animate-pulse` round badge | Count of faces in `missing`-type galleries; hidden when 0 |

---

## 4. Gallery Section

### 4.1 Section Structure

Galleries are grouped by type and displayed in the following priority order:

1. 🔍 **Missing** — displayed with red tint header and pulsing dot
2. ⭐ **VIP**
3. 🚫 **Blocklist**
4. 🗃 **General**

Each type section is rendered by `GallerySection`. If a type has no galleries, the section header is omitted entirely.

### 4.2 Gallery Row

| Element | Behavior |
|---|---|
| Gallery name | Truncated to available width, `text-[10px] font-medium` |
| Face count badge | `GalleryBadge` — type-colored pill with face count |
| Delete button | `✕`, revealed on hover (stopPropagation to parent row); `hover:text-red-400` |
| Selected state | Left border colored by type + `bg-gray-800` background |
| Click behavior | Toggles expanded/collapsed state; fetches faces for selected gallery |

### 4.3 Gallery Row Left Border Color

| Type | Border color | Background accent |
|---|---|---|
| `missing` | `border-l-red-500` | `hover:bg-red-950/30` |
| `vip` | `border-l-yellow-500` | `hover:bg-gray-800` |
| `blocklist` | `border-l-orange-500` | `hover:bg-gray-800` |
| `general` | `border-l-blue-500` | `hover:bg-gray-800` |

---

## 5. Face Card

A face card represents a single enrolled person within a gallery.

### 5.1 Layout

```
┌─────────────────┐
│   [thumbnail]   │  ← 48×48 JPEG, rounded, object-cover
│     Alice       │  ← name, 9px, truncate, max-w-[56px]
│  [✕ on hover]  │  ← delete button, absolute top-right
└─────────────────┘
```

### 5.2 Specification

| Property | Value |
|---|---|
| Thumbnail size | 48×48 px (`w-12 h-12`) |
| Thumbnail fallback | Gray box with `👤` icon |
| Name | `text-[9px] text-gray-300 font-medium truncate max-w-[56px]` |
| Delete button | `w-4 h-4`, `bg-red-700 hover:bg-red-600`, visible on `.group:hover` only |
| Card background | `bg-gray-800 rounded-lg p-1.5 border border-gray-700 hover:border-gray-500` |

### 5.3 Face Card Grid

Face cards within an expanded gallery are laid out as a `flex flex-wrap gap-1.5` grid, max height not constrained (scrolls with parent container).

---

## 6. Gallery Creation Flow

1. Operator types a gallery name in the text input (placeholder: i18n `faceNewGalleryName`).
2. Operator selects a gallery type via the `[▾ Type ▾]` dropdown menu.
3. Clicks `[+ Create]` button → `POST /api/galleries` with `{ name, type }`.
4. On success: gallery list refreshes; newly created gallery is auto-selected.
5. On error: error text shown inline.

**Type selector dropdown** (`showTypeMenu`):
- Shows 4 type options with icon + label
- Clicking outside closes the menu
- Default type: `general`

---

## 7. Face Enrollment Flow

### 7.1 Upload Area (UploadArea Component)

1. Operator opens a gallery (clicks to expand/select).
2. **Drag-drop** a JPEG/PNG/WebP onto the dashed upload area, **or** click the area to open a file picker.
3. A **preview** of the photo appears.
4. Operator enters the person's name in the text field.
5. Clicks **[Enroll]** → `POST /api/galleries/:id/faces` (multipart/form-data).
6. Server pipeline:
   - SCRFD-2.5GF detects faces in the photo.
   - ArcFace ResNet-50 extracts a 512-dim embedding.
   - JPEG thumbnail (96×96) is generated and stored in DB.
7. On success: upload area resets; gallery face count increments.
8. On error: error message displayed (`text-[10px] text-red-400`).

### 7.2 Error Conditions

| Error | HTTP | UI |
|---|---|---|
| No face detected in photo | 400 | "No face detected" error text |
| Face service not available (model not loaded) | 503 | "Face service not available" error text |
| Gallery not found | 404 | "Gallery not found" error text |
| File too large (> 10 MB) | 400 | Error text |

### 7.3 Upload Area Drag State

| State | CSS |
|---|---|
| Idle | `border-gray-600 hover:border-gray-500` |
| Dragging over | `border-blue-500 bg-blue-950/30` |
| Preview loaded | Photo preview replaces hint text |

---

## 8. Match Log

The match log displays real-time face identification events received from the server.

### 8.1 Event Source

Socket.IO event: `face_match`  
Emitted by: `server/src/services/pipelineManager.js` when live camera frame matches an enrolled face above the similarity threshold.

### 8.2 Log Entry Layout (v1.1)

```
┌──────────────────────────────────────────────────────────────────────┐
│ [enrolled photo]  [LIVE CROP]  [type badge] [person name] [score%]  │
│                               [cameraId]  ·  [HH:MM:SS]            │
└──────────────────────────────────────────────────────────────────────┘
```

| Field | Description |
|---|---|
| Enrolled photo | 28×28 (`w-7 h-7`) gallery thumbnail from enrollment |
| **Live crop** | **28×28 crop of the detected face from the live frame (`liveCropData`)** |
| Type badge | Gallery type emoji icon |
| Person name | `font-bold text-[10px]` |
| Score | Cosine similarity as `(score × 100).toFixed(1)%` |
| Camera ID | Camera UUID (truncated or human-readable name) |
| Timestamp | `HH:MM:SS` local time via `toLocaleTimeString` |

### 8.3 Log Row Background

| Gallery Type | Background | Border |
|---|---|---|
| `missing` | `bg-red-950/60` | `border-red-700/60` |
| `vip` | `bg-yellow-950/50` | `border-yellow-700/50` |
| `blocklist` | `bg-orange-950/50` | `border-orange-700/50` |
| `general` | `bg-gray-800/60` | `border-gray-700/40` |

### 8.4 Log Constraints

- Maximum **50 entries** retained in state; oldest pruned on new event.
- Displayed in reverse-chronological order (newest at top).
- Container: `max-h-48 overflow-y-auto`

---

## 9. Missing Person Alert Banner

Displayed at the top of the panel (above gallery list) when the match log contains at least one `galleryType === 'missing'` event.

| Property | Value |
|---|---|
| Background | `bg-red-800/80` |
| Border | `border-b border-red-700` |
| Animation | `animate-pulse` |
| Icon | `🚨` |
| Content | i18n `missingPersonAlert` label + person name + similarity% + camera ID |
| Visibility | Appears as soon as a missing-person match event is received; persists for the lifetime of the `matchLog` state (not auto-dismissed) |

---

## 10. Gallery Type Specification

| Type ID | Icon | Label i18n key | Badge color | Use Case |
|---|---|---|---|---|
| `missing` | 🔍 | `galleryTypeMissing` | `bg-red-700 text-red-100` | Missing persons; highest-priority alerting; triggers `missing_person_match` event |
| `vip` | ⭐ | `galleryTypeVip` | `bg-yellow-700 text-yellow-100` | VIP recognition; access control; notification |
| `blocklist` | 🚫 | `galleryTypeBlocklist` | `bg-orange-700 text-orange-100` | Blocklisted individuals; triggers alert on detection |
| `general` | 🗃 | `galleryTypeGeneral` | `bg-gray-700 text-gray-300` | General-purpose enrollment |

Display priority (top → bottom): `missing` → `vip` → `blocklist` → `general`

---

## 11. REST API Integration

| Action | Method | Endpoint | Request Body | Success Response |
|---|---|---|---|---|
| List galleries | `GET` | `/api/galleries` | — | `{ success: true, data: FaceGallery[] }` |
| Create gallery | `POST` | `/api/galleries` | `{ name, type }` | `{ success: true, data: FaceGallery }` |
| Delete gallery | `DELETE` | `/api/galleries/:id` | — | `{ success: true }` |
| List faces | `GET` | `/api/galleries/:id/faces` | — | `{ success: true, data: EnrolledFace[] }` |
| Enroll face | `POST` | `/api/galleries/:id/faces` | `multipart/form-data` (`photo` file + `name` string) | `{ success: true, data: EnrolledFace }` |
| Delete face | `DELETE` | `/api/galleries/:id/faces/:faceId` | — | `{ success: true }` |

### 11.1 FaceGallery Object

```typescript
interface FaceGallery {
  id:        string;       // UUID
  name:      string;       // User-provided label
  type:      GalleryType;  // 'missing' | 'vip' | 'blocklist' | 'general'
  faceCount: number;       // Derived count from faceGalleryFaces table
  createdAt: number;       // Unix ms
}
```

### 11.2 EnrolledFace Object

```typescript
interface EnrolledFace {
  id:         string;       // UUID
  galleryId:  string;       // Parent gallery UUID
  name:       string;       // Person name
  thumbnail:  string;       // base64 JPEG data URI (96×96)
  createdAt:  number;       // Unix ms
}
```

---

## 12. Socket.IO Events

### 12.1 Subscribed Events

| Event | Payload | Handler |
|---|---|---|
| `face_match` | `FaceMatchEvent` | Prepend to `matchLog` state; trigger missing-person banner if `galleryType === 'missing'` |

### 12.2 FaceMatchEvent Object (v1.1)

```typescript
interface FaceMatchEvent {
  faceId:        string;      // Live gallery face ID (e.g. "F7")
  identity:      string;      // Enrolled person name
  galleryId:     string;      // Matched gallery ID
  galleryType:   GalleryType; // Gallery type
  matchScore:    number;      // Cosine similarity (0–1)
  cameraId:      string;      // Camera UUID
  timestamp:     number;      // Unix ms
  thumbnail?:    string;      // base64 JPEG — enrolled gallery photo
  liveCropData?: string;      // [NEW v1.1] base64 JPEG — live detected face crop
}
```

---

## 13. Data Persistence

| Data | Storage Location | Persists Across Restart |
|---|---|---|
| Named galleries (`faceGalleries` table) | `storage/lts.json` | ✅ Yes |
| Enrolled faces + thumbnails (`faceGalleryFaces` table) | `storage/lts.json` | ✅ Yes |
| ArcFace embedding vectors | Inline in `faceGalleryFaces` row | ✅ Yes |
| Person trajectories + alias counter | `storage/face_tracking.json` | ✅ Yes |
| **Face match history** (`faceMatchHistory` table) | **`storage/lts.json`** | **✅ Yes (v1.1)** |
| Runtime session gallery (transient F1, F2… IDs) | In-memory (30 s expiry) | ❌ Cleared — by design |

---

## 14. i18n Keys

| Key | English | Korean |
|---|---|---|
| `tabFaceGallery` | `Face ID` | `Face Recognition` |
| `faceGallerySubtitle` | `Enroll & recognize persons` | `Enroll & recognize persons` |
| `faceEnroll` | `Enroll` | `Enroll` |
| `faceEnrolling` | `Enrolling…` | `Enrolling…` |
| `faceUploadHint` | `Drop photo or click` | `Drop photo or click` |
| `faceNamePlaceholder` | `Person name` | `Person name` |
| `faceNoMatches` | `No matches yet` | `No matches` |
| `faceNoGalleries` | `No galleries` | `No galleries` |
| `faceNewGalleryName` | `Gallery name…` | `Gallery name…` |
| `faceDeleteGallery` | `Delete gallery` | `Delete gallery` |
| `faceDeleteGalleryConfirm` | `Delete this gallery and all enrolled faces?` | `Delete this gallery and all enrolled faces?` |
| `galleryTypeMissing` | `Missing` | `Missing` |
| `galleryTypeVip` | `VIP` | `VIP` |
| `galleryTypeBlocklist` | `Blocklist` | `Blocklist` |
| `galleryTypeGeneral` | `General` | `General` |
| `missingPersonAlert` | `MISSING PERSON` | `MISSING PERSON FOUND` |

---

## 15. Implementation Status

| Component | File | Status |
|---|---|---|
| `FaceGalleryTab` | `client/src/components/FaceGalleryTab.tsx` | ✅ Implemented |
| Tab registration | `client/src/App.tsx` (line 460) | ✅ Implemented |
| `faceGallery` REST API | `server/src/api/faceGallery.js` | ✅ Implemented |
| `FaceService` (SCRFD + ArcFace) | `server/src/services/faceService.js` | ✅ Implemented (model load optional) |
| Gallery persistence | `server/src/db.js` (`faceGalleries`, `faceGalleryFaces` tables) | ✅ Implemented |
| Person trajectory persistence | `server/src/services/pipelineManager.js` + `storage/face_tracking.json` | ✅ Implemented |
| i18n keys | `client/src/i18n/index.ts` | ✅ Implemented |
| **Live face crop in match log** | `pipelineManager.js` + `FaceGalleryTab.tsx` | ⏳ v1.1 (this sprint) |
| **Face match history DB** | `server/src/db.js` + `faceMatchHistory` table | ⏳ v1.1 (this sprint) |
| **Search integration** | `server/src/api/search.js` + `SearchBar.tsx` | ⏳ v1.1 (this sprint) |

---

## 16. Live Match Crop Display (v1.1 New)

### 16.1 Background

In v1.0, the Match Log shows only the **enrolled gallery photo**. Operators cannot visually confirm whether the live detection actually matches the enrolled person because no live-frame crop is shown.

### 16.2 Requirements

When a `face_match` event is emitted, the server SHALL:
1. Crop the detected face bounding box from the live JPEG frame buffer using `sharp`.
2. Include the resulting JPEG as `liveCropData` (base64 data URL) in the event payload.

The client SHALL:
1. Display both the **enrolled photo** (gallery thumbnail) AND the **live crop** side-by-side in each MatchLog entry.
2. Show a placeholder icon when `liveCropData` is absent.

### 16.3 Constraints

- Crop MUST NOT block the frame pipeline; MUST run in `setImmediate`.
- `face_match` is emitted only after the crop is ready (no two-step event pair).
- Fallback: if cropping fails, emit `face_match` without `liveCropData`.
- Crop bounds: `SNAPSHOT_MAX_DIMENSION` px, quality `SNAPSHOT_JPEG_QUALITY`.

---

## 17. Face Match History & SearchBar Integration (v1.1 New)

### 17.1 Background

v1.0 match events are kept only in client React state and are lost on page refresh. There is no server-side record of who was recognized, when, and on which camera.

### 17.2 Requirements

**Server**
- Each `face_match` event SHALL be persisted in the `faceMatchHistory` DB table.
- `GET /api/search?q=&types=matches` SHALL search `faceMatchHistory.identity` and return results with `liveCropData`.

**Client**
- When the SearchBar query matches a face name (e.g., "John"), results of type `_type: 'match'` SHALL appear.
- Each result shows: `liveCropData` thumbnail, name, gallery type badge, camera name, score, timestamp.

### 17.3 `faceMatchHistory` Record Schema

```json
{
  "id":           "uuid",
  "faceId":       "F7",
  "cameraId":     "uuid",
  "cameraName":   "Camera 1",
  "identity":     "John Doe",
  "galleryId":    "uuid",
  "galleryType":  "vip",
  "matchScore":   0.91,
  "thumbnail":    "data:image/jpeg;base64,...",
  "liveCropData": "data:image/jpeg;base64,...",
  "timestamp":    1748343600000,
  "createdAt":    "2026-05-27T11:33:47.000Z"
}
```

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — RFP for Dashboard Sidebar Face ID |
