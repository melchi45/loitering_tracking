import { create } from 'zustand';
import type { ClothingReIdEvent } from '../types';

const MAX_EVENTS = 20;
const EXPIRY_MS  = 60_000; // prune events older than 60 s

interface ClothingReIdStore {
  events: ClothingReIdEvent[];
  addEvent: (event: ClothingReIdEvent) => void;
  pruneExpired: () => void;
  clearEvents: () => void;
  /** Combined confidence: 0.7 × faceScore + 0.3 × clothingScore.
   *  Returns null when there is no recent face:reidentified companion event. */
  getCombinedScore: (event: ClothingReIdEvent, faceSimilarity: number | null) => number | null;
}

export const useClothingReIdStore = create<ClothingReIdStore>((set) => ({
  events: [],

  addEvent: (event) =>
    set((state) => {
      const now  = Date.now();
      const fresh = state.events.filter((e) => now - e.timestamp < EXPIRY_MS);
      return { events: [event, ...fresh].slice(0, MAX_EVENTS) };
    }),

  pruneExpired: () =>
    set((state) => {
      const now = Date.now();
      return { events: state.events.filter((e) => now - e.timestamp < EXPIRY_MS) };
    }),

  clearEvents: () => set({ events: [] }),

  getCombinedScore: (_event, faceSimilarity) => {
    if (faceSimilarity === null) return null;
    return 0.70 * faceSimilarity + 0.30 * _event.similarity;
  },
}));
