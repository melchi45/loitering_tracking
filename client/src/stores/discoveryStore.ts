import { create } from 'zustand';
import type { DiscoveredCamera } from '../types';

interface DiscoveryState {
  cameras: DiscoveredCamera[];
  selected: DiscoveredCamera | null;
  scanning: boolean;
  addOrUpdate: (cam: DiscoveredCamera) => void;
  clear: () => void;
  select: (cam: DiscoveredCamera | null) => void;
  setScanning: (v: boolean) => void;
}

export const useDiscoveryStore = create<DiscoveryState>((set) => ({
  cameras:  [],
  selected: null,
  scanning: false,

  addOrUpdate: (cam) =>
    set((s) => {
      const idx = s.cameras.findIndex((c) => c.id === cam.id);
      if (idx === -1) return { cameras: [...s.cameras, cam] };
      const updated = [...s.cameras];
      updated[idx] = cam;
      // If this was the selected camera, update it too
      const selected = s.selected?.id === cam.id ? cam : s.selected;
      return { cameras: updated, selected };
    }),

  clear: () => set({ cameras: [], selected: null }),

  select: (cam) => set({ selected: cam }),

  setScanning: (v) => set({ scanning: v }),
}));
