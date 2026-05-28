# DESIGN DOCUMENT
# Dashboard Sidebar — Alerts and Zones Panel

| | |
|---|---|
| **Document ID** | DESIGN-LTS-UI-AZ-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent SRS** | srs/SRS_Dashboard_Sidebar_Alerts_Zones.md |

---

## Table of Contents
1. [Architecture Overview](#1-architecture-overview)
2. [File Structure](#2-file-structure)
3. [Component Tree](#3-component-tree)
4. [State Management Design](#4-state-management-design)
5. [Socket.IO Subscription Design](#5-socketio-subscription-design)
6. [TypeScript Interface Definitions](#6-typescript-interface-definitions)
7. [REST API Integration](#7-rest-api-integration)
8. [Zone Editor Canvas Design](#8-zone-editor-canvas-design)
9. [Responsive & Mobile Considerations](#9-responsive--mobile-considerations)
10. [Error Handling](#10-error-handling)

---

## 1. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                        CLIENT (React)                            │
│                                                                  │
│  AlertPanel.tsx (sidebar Alerts tab)                             │
│   ├─ AlertStore (Zustand)                                        │
│   └─ POST /api/alerts/:id/acknowledge                            │
│                                                                  │
│  ZonesPanel.tsx (sidebar Zones tab)                              │
│   └─ Hint text only (no editor)                                  │
│                                                                  │
│  FullscreenCameraView.tsx                                        │
│   └─ ZoneEditor.tsx (fixed inset-0 z-[100])                     │
│        ├─ <canvas> — polygon draw/select/drag                    │
│        ├─ Right control panel (w-64)                             │
│        └─ REST: GET/POST/PUT/DELETE /api/cameras/:id/zones       │
└──────────────────────────────────────────────────────────────────┘
                         │ HTTP / WebSocket
┌────────────────────────▼─────────────────────────────────────────┐
│  Server: /api/alerts, /api/cameras/:cameraId/zones               │
│  Socket.IO: 'alert' → AlertStore.addAlert()                      │
└──────────────────────────────────────────────────────────────────┘
```

---

## 2. File Structure

```
loitering_tracking/
├── client/
│   └── src/
│       ├── components/
│       │   ├── AlertPanel.tsx         # Alerts sidebar tab
│       │   ├── ZonesPanel.tsx         # Zones tab (hint only)
│       │   └── ZoneEditor.tsx         # Fullscreen zone editor canvas
│       └── stores/
│           └── alertStore.ts          # Zustand: alerts[], addAlert, acknowledgeAlert, clearAlerts
└── server/
    └── src/
        └── api/
            ├── events.js              # /api/alerts endpoints
            └── zones.js               # /api/cameras/:cameraId/zones endpoints
```

---

## 3. Component Tree

```
AlertPanel
├─ Panel Header
│   ├─ Title (i18n: alertTitle)
│   ├─ Unacknowledged badge (conditional, count > 0)
│   └─ Clear All button (conditional, alerts.length > 0)
├─ Alert rows (max 20, newest first)
│   └─ AlertRow × N
│       ├─ ⚠ icon (red / gray)
│       ├─ Camera name
│       ├─ Relative time
│       ├─ Obj #{objectId}
│       ├─ Zone name (conditional)
│       ├─ Dwell time
│       └─ Ack button (conditional, !acknowledged)
└─ Empty state (alerts.length === 0)

ZonesPanel
└─ Hint text (i18n: zoneHint)
   └─ Sub-hint (i18n: addCameraFirst, conditional)

ZoneEditor (fixed inset-0 z-[100])
├─ Background JPEG frame
├─ Canvas (full area, absolute)
└─ Right Control Panel (w-64)
    ├─ Header: "Zone Edit" + × button
    ├─ Mode switcher (idle | draw)
    ├─ [Idle mode: zone selected]
    │   ├─ Name input
    │   ├─ Type badge (MONITOR | EXCLUDE)
    │   ├─ Vertex count
    │   ├─ Deselect button
    │   └─ Save Polygon button
    ├─ [Idle mode: nothing selected]
    │   └─ Hint text (i18n: zoneClickToSelect)
    ├─ [Draw mode]
    │   ├─ Zone name input
    │   ├─ Zone type selector
    │   ├─ Dwell Threshold slider (MONITOR only)
    │   ├─ Min Displacement slider (MONITOR only)
    │   ├─ Min Risk Score slider (MONITOR only)
    │   ├─ Save button (disabled < 3 vertices)
    │   └─ Reset button
    └─ Saved Zones List
        └─ ZoneListItem × N
            ├─ Color dot
            ├─ Name
            ├─ Threshold label
            └─ ✕ delete button
```

---

## 4. State Management Design

### 4.1 AlertStore (Zustand)

```typescript
interface AlertStore {
  alerts:           Alert[];
  addAlert:         (alert: Alert) => void;
  acknowledgeAlert: (id: string) => void;
  clearAlerts:      () => void;
}

// Implementation
const useAlertStore = create<AlertStore>((set) => ({
  alerts: [],
  addAlert: (alert) =>
    set((state) => ({ alerts: [alert, ...state.alerts] })),
  acknowledgeAlert: (id) =>
    set((state) => ({
      alerts: state.alerts.map((a) =>
        a.id === id ? { ...a, acknowledged: true } : a
      ),
    })),
  clearAlerts: () => set({ alerts: [] }),
}));
```

### 4.2 ZoneEditor Local State

| State | Type | Purpose |
|---|---|---|
| `mode` | `'idle' \| 'draw'` | Current editor mode |
| `zones` | `Zone[]` | Loaded zones from server |
| `selectedZoneId` | `string \| null` | Selected zone in idle mode |
| `selectedVertexIdx` | `number \| null` | Selected vertex index for move |
| `drawPoints` | `{x,y}[]` | In-progress polygon vertices |
| `drawName` | `string` | New zone name input |
| `drawType` | `'MONITOR' \| 'EXCLUDE'` | New zone type |
| `dwellThreshold` | `number` | New zone dwell threshold (30 default) |
| `minDisplacement` | `number` | New zone min displacement (50 default) |
| `minRiskScore` | `number` | New zone min risk score (0.0 default) |
| `contextMenu` | `{ x, y, target } \| null` | Right-click context menu |

### 4.3 relativeTime() Utility

```typescript
function relativeTime(timestamp: number): string {
  const delta = Math.floor((Date.now() - timestamp) / 1000);
  if (delta < 60)   return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  return `${Math.floor(delta / 3600)}h ago`;
}
```

---

## 5. Socket.IO Subscription Design

### 5.1 Alert Reception

```typescript
// In AlertPanel.tsx or App.tsx
useEffect(() => {
  const socket = (window as any).__ltsSocket;
  const handler = (alert: Alert) => {
    alertStore.addAlert(alert);
  };
  socket.on('alert', handler);
  return () => socket.off('alert', handler);
}, []);
```

### 5.2 Unread Count in App.tsx

```typescript
// Unread count drives the badge on the sidebar Alerts tab
useEffect(() => {
  const socket = (window as any).__ltsSocket;
  socket.on('alert', () => {
    if (sidebarTab !== 'alerts') {
      setUnreadAlerts(n => n + 1);
    }
  });
}, [sidebarTab]);
```

---

## 6. TypeScript Interface Definitions

```typescript
interface Alert {
  id:           string;       // UUID
  cameraId:     string;
  objectId:     number;
  zone?:        string;
  dwellTime:    number;       // seconds
  timestamp:    number;       // Unix ms
  acknowledged: boolean;
}

interface Zone {
  id:               string;
  cameraId:         string;
  name:             string;
  type:             'MONITOR' | 'EXCLUDE';
  polygon:          Array<{ x: number; y: number }>;
  dwellThreshold?:  number;   // default 30
  minDisplacement?: number;   // default 50
  minRiskScore?:    number;   // default 0.0
  active?:          boolean;
  targetClasses?:   string[];
}

interface ZoneCreateRequest {
  name:             string;
  polygon:          Array<{ x: number; y: number }>;
  type?:            'MONITOR' | 'EXCLUDE';
  dwellThreshold?:  number;
  minDisplacement?: number;
  minRiskScore?:    number;
}
```

---

## 7. REST API Integration

### 7.1 AlertPanel — On Mount

```typescript
useEffect(() => {
  fetch('/api/alerts?limit=20')
    .then(r => r.json())
    .then(d => {
      // Load server-persisted alerts on first mount
      alertStore.clearAlerts();
      d.data.forEach((a: Alert) => alertStore.addAlert(a));
    });
}, []);
```

### 7.2 Alert Acknowledgment

```typescript
async function handleAcknowledge(alertId: string) {
  alertStore.acknowledgeAlert(alertId);  // optimistic update
  try {
    await fetch(`/api/alerts/${alertId}/acknowledge`, { method: 'POST' });
  } catch (err) {
    console.error('Acknowledge API call failed; local state already updated:', err);
  }
}
```

### 7.3 ZoneEditor — Load Zones on Open

```typescript
useEffect(() => {
  fetch(`/api/cameras/${cameraId}/zones`)
    .then(r => r.json())
    .then(d => setZones(d.data));
}, [cameraId]);
```

### 7.4 Zone Create

```typescript
async function handleSaveZone() {
  const body: ZoneCreateRequest = {
    name: drawName,
    polygon: drawPoints,
    type: drawType,
    ...(drawType === 'MONITOR' && {
      dwellThreshold, minDisplacement, minRiskScore,
    }),
  };
  const res = await fetch(`/api/cameras/${cameraId}/zones`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  setZones(prev => [...prev, data.data]);
  setDrawPoints([]);
  setMode('idle');
}
```

### 7.5 Zone Update (Polygon Edit)

```typescript
async function handleSavePolygon(zoneId: string, updatedPolygon: {x:number;y:number}[]) {
  const res = await fetch(`/api/cameras/${cameraId}/zones/${zoneId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ polygon: updatedPolygon }),
  });
  const data = await res.json();
  setZones(prev => prev.map(z => z.id === zoneId ? data.data : z));
}
```

### 7.6 Zone Delete

```typescript
async function handleDeleteZone(zoneId: string) {
  await fetch(`/api/cameras/${cameraId}/zones/${zoneId}`, { method: 'DELETE' });
  setZones(prev => prev.filter(z => z.id !== zoneId));
  setSelectedZoneId(null);
}
```

---

## 8. Zone Editor Canvas Design

### 8.1 Hit Testing

```typescript
function hitTestZone(x: number, y: number, zones: Zone[]): Zone | null {
  // Point-in-polygon test (ray casting)
  for (const zone of zones) {
    if (pointInPolygon({ x, y }, zone.polygon)) return zone;
  }
  return null;
}

function hitTestVertex(x: number, y: number, zone: Zone): number {
  const RADIUS = 10;
  return zone.polygon.findIndex(v =>
    Math.hypot(v.x - x, v.y - y) < RADIUS
  );
}
```

### 8.2 Polygon Centroid Calculation

```typescript
function centroid(polygon: {x:number;y:number}[]): {x:number;y:number} {
  const n = polygon.length;
  const sum = polygon.reduce((acc, v) => ({ x: acc.x + v.x, y: acc.y + v.y }), { x: 0, y: 0 });
  return { x: sum.x / n, y: sum.y / n };
}
```

### 8.3 Canvas Draw Loop

```typescript
function drawCanvas(ctx: CanvasRenderingContext2D) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  // Draw saved zones
  for (const zone of zones) {
    const isSelected = zone.id === selectedZoneId;
    const color = zone.type === 'MONITOR' ? '#3b82f6' : '#f59e0b';
    const fillAlpha = isSelected ? 0.32 : 0.15;

    ctx.beginPath();
    zone.polygon.forEach((v, i) => i === 0 ? ctx.moveTo(v.x, v.y) : ctx.lineTo(v.x, v.y));
    ctx.closePath();
    ctx.fillStyle = color + Math.round(fillAlpha * 255).toString(16).padStart(2, '0');
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Vertices
    zone.polygon.forEach((v, i) => {
      ctx.beginPath();
      ctx.arc(v.x, v.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = i === selectedVertexIdx ? '#fbbf24' : color;
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.stroke();
    });

    // Centroid label
    const { x, y } = centroid(zone.polygon);
    ctx.fillStyle = zone.type === 'MONITOR' ? '#60a5fa' : '#fbbf24';
    ctx.font = 'bold 10px sans-serif';
    ctx.fillText(zone.name, x, y);
  }

  // Draw in-progress polygon (draw mode)
  if (mode === 'draw' && drawPoints.length > 0) {
    ctx.beginPath();
    drawPoints.forEach((v, i) => i === 0 ? ctx.moveTo(v.x, v.y) : ctx.lineTo(v.x, v.y));
    ctx.strokeStyle = '#60a5fa';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
```

---

## 9. Responsive & Mobile Considerations

- On mobile, `AlertPanel` occupies the full content area when the Alerts bottom nav tab is active
- `ZonesPanel` hint text is shown in the Zones mobile tab
- `ZoneEditor` is a `fixed inset-0` overlay; it works on mobile but touch-based polygon drawing is not explicitly specified (Phase-2)
- Alert rows shall be readable at 320 px width; the Ack button uses compact sizing (`text-[10px]`)

---

## 10. Error Handling

| Scenario | Handling |
|---|---|
| `GET /api/alerts` fails on mount | Log error; AlertPanel starts empty; Socket.IO events still populate it |
| `POST /api/alerts/:id/acknowledge` fails | Local `acknowledgeAlert()` already called; log error silently |
| `GET /api/cameras/:id/zones` fails | Log error; ZoneEditor shows empty canvas; user can still draw new zones |
| `POST /api/cameras/:id/zones` fails | Show error message in control panel; `drawPoints` not cleared |
| `PUT /api/cameras/:id/zones/:id` fails | Show error; polygon not updated in local state |
| `DELETE /api/cameras/:id/zones/:id` fails | Show error; zone remains in local `zones[]` list |
| Zone polygon < 3 vertices on save | Save button disabled; guard check in handler |
| Right-click delete vertex < 4 vertices | "Delete Vertex" option disabled in context menu |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Technical design for Dashboard Sidebar Alerts Zones |
