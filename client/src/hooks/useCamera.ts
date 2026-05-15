import { useEffect, useState } from 'react';
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

  useEffect(() => {
    if (!cameraId) return;

    const count = subscriptionCounts.get(cameraId) ?? 0;
    if (count === 0) socket.emit('camera:subscribe', { cameraId });
    subscriptionCounts.set(cameraId, count + 1);
    setSubscribed(true);

    // Re-subscribe after server restart / socket reconnect (rooms are cleared on server restart)
    const handleReconnect = () => {
      socket.emit('camera:subscribe', { cameraId });
    };

    const handleFrame = (event: FrameEvent) => {
      if (event.cameraId !== cameraId) return;
      setFrame(event.data);
      if (event.frameWidth)  setFrameWidth(event.frameWidth);
      if (event.frameHeight) setFrameHeight(event.frameHeight);
    };

    const handleDetections = (event: DetectionsEvent) => {
      if (event.cameraId !== cameraId) return;
      setDetections(event.detections);
      if (event.frameWidth)  setFrameWidth(event.frameWidth);
      if (event.frameHeight) setFrameHeight(event.frameHeight);
    };

    socket.on('connect', handleReconnect);
    socket.on('frame', handleFrame);
    socket.on('detections', handleDetections);

    return () => {
      socket.off('connect', handleReconnect);
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
