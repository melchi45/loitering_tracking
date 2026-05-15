import { create } from 'zustand';
import type { Camera } from '../types';

interface CameraStore {
  cameras:    Camera[];
  selectedId: string | null;
  setCameras:         (cameras: Camera[]) => void;
  addCamera:          (camera: Camera) => void;
  updateCamera:       (id: string, updates: Partial<Camera>) => void;
  updateCameraStatus: (id: string, status: Camera['status']) => void;
  removeCamera:       (id: string) => void;
  selectCamera:       (id: string | null) => void;
}

export const useCameraStore = create<CameraStore>((set) => ({
  cameras:    [],
  selectedId: null,

  setCameras: (cameras) => set({ cameras }),

  addCamera: (camera) =>
    set((s) => {
      if (s.cameras.find((c) => c.id === camera.id)) return s;
      return { cameras: [...s.cameras, camera] };
    }),

  updateCamera: (id, updates) =>
    set((s) => ({
      cameras: s.cameras.map((c) => (c.id === id ? { ...c, ...updates } : c)),
    })),

  updateCameraStatus: (id, status) =>
    set((s) => ({
      cameras: s.cameras.map((c) => (c.id === id ? { ...c, status } : c)),
    })),

  removeCamera: (id) =>
    set((s) => ({
      cameras:    s.cameras.filter((c) => c.id !== id),
      selectedId: s.selectedId === id ? null : s.selectedId,
    })),

  selectCamera: (id) => set({ selectedId: id }),
}));
