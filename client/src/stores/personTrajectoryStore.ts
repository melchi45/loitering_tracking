import { create } from 'zustand';
import type { PersonTrajectory } from '../types';

interface PersonTrajectoryStore {
  persons: Map<string, PersonTrajectory>;
  updatePerson: (p: PersonTrajectory) => void;
  hydrate:      (list: PersonTrajectory[]) => void;
}

export const usePersonTrajectoryStore = create<PersonTrajectoryStore>((set) => ({
  persons: new Map(),

  updatePerson: (p) => set((state) => {
    const next = new Map(state.persons);
    next.set(p.faceId, p);
    return { persons: next };
  }),

  hydrate: (list) => set(() => {
    const next = new Map<string, PersonTrajectory>();
    for (const p of list) next.set(p.faceId, p);
    return { persons: next };
  }),
}));
