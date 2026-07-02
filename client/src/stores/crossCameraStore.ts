import { create } from 'zustand';
import type { CrossCameraReIdEvent } from '../types';

// History list, not a live-only toast feed — entries must persist until capped
// by count, never by age. A previous time-based expiry (60s) silently wiped
// the whole list whenever the AI pipeline went quiet for a minute, which is
// what caused the Cross-Camera Re-ID feed to "disappear". Do not reintroduce
// time-based pruning here; see docs/design/Design_CrossCamera_Face_Tracking.md §4.6.
const MAX_EVENTS = 50;

interface CrossCameraStore {
  events: CrossCameraReIdEvent[];
  addEvent: (event: CrossCameraReIdEvent) => void;
  hydrate: (events: CrossCameraReIdEvent[]) => void;
  clearEvents: () => void;
}

export const useCrossCameraStore = create<CrossCameraStore>((set) => ({
  events: [],

  addEvent: (event) =>
    set((state) => ({ events: [event, ...state.events].slice(0, MAX_EVENTS) })),

  // Bulk-load persisted history (e.g. from GET /api/analysis/face-trajectories on
  // mount/reconnect). Merges with any events already received live this session,
  // de-duplicated by faceId+timestamp, newest first.
  hydrate: (events) =>
    set((state) => {
      const seen = new Set<string>();
      const merged: CrossCameraReIdEvent[] = [];
      for (const e of [...state.events, ...events].sort((a, b) => b.timestamp - a.timestamp)) {
        const key = `${e.faceId}:${e.timestamp}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(e);
      }
      return { events: merged.slice(0, MAX_EVENTS) };
    }),

  clearEvents: () => set({ events: [] }),
}));
