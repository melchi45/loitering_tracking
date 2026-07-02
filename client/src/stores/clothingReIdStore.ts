import { create } from 'zustand';
import type { ClothingReIdEvent } from '../types';

// History list, not a live-only toast feed — capped by count, never by age.
// See crossCameraStore.ts for why time-based expiry was removed (it silently
// wiped the whole history whenever no new events arrived for 60s).
const MAX_EVENTS = 50;

interface ClothingReIdStore {
  events: ClothingReIdEvent[];
  addEvent: (event: ClothingReIdEvent) => void;
  clearEvents: () => void;
  /** Combined confidence: 0.7 × faceScore + 0.3 × clothingScore.
   *  Returns null when there is no recent face:reidentified companion event. */
  getCombinedScore: (event: ClothingReIdEvent, faceSimilarity: number | null) => number | null;
}

export const useClothingReIdStore = create<ClothingReIdStore>((set) => ({
  events: [],

  addEvent: (event) =>
    set((state) => ({ events: [event, ...state.events].slice(0, MAX_EVENTS) })),

  clearEvents: () => set({ events: [] }),

  getCombinedScore: (_event, faceSimilarity) => {
    if (faceSimilarity === null) return null;
    return 0.70 * faceSimilarity + 0.30 * _event.similarity;
  },
}));
