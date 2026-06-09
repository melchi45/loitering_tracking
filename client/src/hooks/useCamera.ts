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
export const subscriptionCounts = new Map<string, number>();

// Module-level caches so fullscreen / secondary consumers show last-known state
// immediately on mount rather than waiting for the next socket event.
const detectionCache    = new Map<string, Detection[]>();
const frameDimensions   = new Map<string, { w: number; h: number }>();
const latestFrameCache  = new Map<string, string>(); // base64 JPEG

export function useCamera(cameraId: string) {
  const { socket } = useSocket();
  const [frame,       setFrame]       = useState<string | null>(
    () => latestFrameCache.get(cameraId) ?? null,
  );
  const [detections,  setDetections]  = useState<Detection[]>(
    () => detectionCache.get(cameraId) ?? [],
  );
  const [frameWidth,  setFrameWidth]  = useState<number>(
    () => frameDimensions.get(cameraId)?.w ?? 640,
  );
  const [frameHeight, setFrameHeight] = useState<number>(
    () => frameDimensions.get(cameraId)?.h ?? 640,
  );
  const [subscribed,  setSubscribed]  = useState(false);

  useEffect(() => {
    if (!cameraId) return;

    // Restore cached state on every effect run, including StrictMode remount
    // (the cleanup resets state to [], so we need to restore here too)
    const cachedDets = detectionCache.get(cameraId);
    if (cachedDets) setDetections(cachedDets);
    const dims = frameDimensions.get(cameraId);
    if (dims) { setFrameWidth(dims.w); setFrameHeight(dims.h); }
    const cachedFrame = latestFrameCache.get(cameraId);
    if (cachedFrame !== undefined) setFrame(cachedFrame);

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
      latestFrameCache.set(cameraId, event.data);
      if (event.frameWidth && event.frameHeight) {
        frameDimensions.set(cameraId, { w: event.frameWidth, h: event.frameHeight });
        setFrameWidth(event.frameWidth);
        setFrameHeight(event.frameHeight);
      }
    };

    const handleDetections = (event: DetectionsEvent) => {
      if (event.cameraId !== cameraId) return;
      setDetections(event.detections);
      detectionCache.set(cameraId, event.detections);
      if (event.frameWidth && event.frameHeight) {
        frameDimensions.set(cameraId, { w: event.frameWidth, h: event.frameHeight });
        setFrameWidth(event.frameWidth);
        setFrameHeight(event.frameHeight);
      }
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
        // Clear caches when the last consumer leaves
        detectionCache.delete(cameraId);
        frameDimensions.delete(cameraId);
        latestFrameCache.delete(cameraId);
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
