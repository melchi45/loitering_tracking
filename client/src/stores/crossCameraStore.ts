import { create } from 'zustand';
import type { CrossCameraReIdEvent } from '../types';

const MAX_EVENTS  = 20;
const EXPIRY_MS   = 60_000; // prune events older than 60 s

interface CrossCameraStore {
  events: CrossCameraReIdEvent[];
  addEvent: (event: CrossCameraReIdEvent) => void;
  pruneExpired: () => void;
  clearEvents: () => void;
}

export const useCrossCameraStore = create<CrossCameraStore>((set) => ({
  events: [],

  addEvent: (event) =>
    set((state) => {
      const now    = Date.now();
      // Prune expired entries and keep newest first, capped at MAX_EVENTS
      const fresh  = state.events.filter((e) => now - e.timestamp < EXPIRY_MS);
      const next   = [event, ...fresh].slice(0, MAX_EVENTS);
      return { events: next };
    }),

  pruneExpired: () =>
    set((state) => {
      const now = Date.now();
      return { events: state.events.filter((e) => now - e.timestamp < EXPIRY_MS) };
    }),

  clearEvents: () => set({ events: [] }),
}));
