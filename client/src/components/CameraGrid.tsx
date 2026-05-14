import React from 'react';
import { useCameraStore } from '../stores/cameraStore';
import CameraView from './CameraView';

interface Props {
  layout: 1 | 4 | 9 | 16;
}

const GRID_COLS: Record<number, string> = {
  1: 'grid-cols-1',
  4: 'grid-cols-2',
  9: 'grid-cols-3',
  16: 'grid-cols-4',
};

export default function CameraGrid({ layout }: Props) {
  const cameras = useCameraStore((s) => s.cameras);

  const cols = GRID_COLS[layout] ?? 'grid-cols-2';
  const cells = Array.from({ length: layout });

  return (
    <div className={`grid ${cols} gap-1 w-full h-full`}>
      {cells.map((_, idx) => {
        const camera = cameras[idx];
        if (camera) {
          return (
            <div key={camera.id} className="relative bg-gray-900 rounded overflow-hidden aspect-video">
              <CameraView cameraId={camera.id} cameraName={camera.name} />
            </div>
          );
        }
        return (
          <div
            key={`empty-${idx}`}
            className="relative bg-gray-800 rounded overflow-hidden aspect-video flex items-center justify-center"
          >
            <span className="text-xs text-gray-600 select-none">No Camera</span>
          </div>
        );
      })}
    </div>
  );
}
