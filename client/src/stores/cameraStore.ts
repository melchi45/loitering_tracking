import { create } from 'zustand';
import type { Camera } from '../types';

interface CameraStore {
  cameras: Camera[];
  setCameras: (cameras: Camera[]) => void;
  addCamera: (camera: Camera) => void;
  updateCameraStatus: (id: string, status: Camera['status']) => void;
  removeCamera: (id: string) => void;
}

export const useCameraStore = create<CameraStore>((set) => ({
  cameras: [],

  setCameras: (cameras) => set({ cameras }),

  addCamera: (camera) =>
    set((state) => {
      // Prevent duplicates
      if (state.cameras.find((c) => c.id === camera.id)) {
        return state;
      }
      return { cameras: [...state.cameras, camera] };
    }),

  updateCameraStatus: (id, status) =>
    set((state) => ({
      cameras: state.cameras.map((c) =>
        c.id === id ? { ...c, status } : c
      ),
    })),

  removeCamera: (id) =>
    set((state) => ({
      cameras: state.cameras.filter((c) => c.id !== id),
    })),
}));
