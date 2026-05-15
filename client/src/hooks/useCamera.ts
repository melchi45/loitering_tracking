import { useEffect, useRef, useState } from 'react';
import { useSocket } from './useSocket';
import type { Detection } from '../types';

interface FrameEvent {
  cameraId: string;
  frameId: number;
  timestamp: number;
  data: string; // base64 jpeg
  frameWidth?: number;
  frameHeight?: number;
}

interface DetectionsEvent {
  cameraId: string;
  frameId: number;
  timestamp: number;
  detections: Detection[];
  frameWidth?: number;
  frameHeight?: number;
}

// Module-level ref counter so two components subscribing to the same cameraId
// (e.g. grid cell + fullscreen modal) don't unsubscribe until both unmount.
const subscriptionCounts = new Map<string, number>();

export function useCamera(cameraId: string) {
  const { socket } = useSocket();
  const [frame,       setFrame]       = useState<string | null>(null);
  const [detections,  setDetections]  = useState<Detection[]>([]);
  const [frameWidth,  setFrameWidth]  = useState<number>(640);
  const [frameHeight, setFrameHeight] = useState<number>(640);
  const [subscribed,  setSubscribed]  = useState(false);

  const lastDetFrameId = useRef<number>(0);

  useEffect(() => {
    if (!cameraId) return;

    const count = subscriptionCounts.get(cameraId) ?? 0;
    if (count === 0) socket.emit('camera:subscribe', { cameraId });
    subscriptionCounts.set(cameraId, count + 1);
    setSubscribed(true);
    lastDetFrameId.current = 0;

    const handleFrame = (event: FrameEvent) => {
      if (event.cameraId !== cameraId) return;
      setFrame(event.data);
      if (event.frameWidth)  setFrameWidth(event.frameWidth);
      if (event.frameHeight) setFrameHeight(event.frameHeight);
    };

    const handleDetections = (event: DetectionsEvent) => {
      if (event.cameraId !== cameraId) return;
      if (event.frameId < lastDetFrameId.current) return;
      lastDetFrameId.current = event.frameId;
      setDetections(event.detections);
      if (event.frameWidth)  setFrameWidth(event.frameWidth);
      if (event.frameHeight) setFrameHeight(event.frameHeight);
    };

    socket.on('frame', handleFrame);
    socket.on('detections', handleDetections);

    return () => {
      socket.off('frame', handleFrame);
      socket.off('detections', handleDetections);
      const current = subscriptionCounts.get(cameraId) ?? 0;
      if (current <= 1) {
        socket.emit('camera:unsubscribe', { cameraId });
        subscriptionCounts.delete(cameraId);
      } else {
        subscriptionCounts.set(cameraId, current - 1);
      }
      setSubscribed(false);
      setFrame(null);
      setDetections([]);
    };
  }, [cameraId, socket]);

  return { frame, detections, frameWidth, frameHeight, subscribed };
}
