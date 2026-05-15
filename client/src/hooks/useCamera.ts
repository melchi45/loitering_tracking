import { useEffect, useState } from 'react';
import { useSocket } from './useSocket';
import type { Detection } from '../types';

interface FrameEvent {
  cameraId: string;
  frameId: number;
  timestamp: number;
  data: string; // base64 jpeg
}

interface DetectionsEvent {
  cameraId: string;
  frameId: number;
  timestamp: number;
  detections: Detection[];
  frameWidth?: number;
  frameHeight?: number;
}

export function useCamera(cameraId: string) {
  const { socket } = useSocket();
  const [frame,       setFrame]       = useState<string | null>(null);
  const [detections,  setDetections]  = useState<Detection[]>([]);
  const [frameWidth,  setFrameWidth]  = useState<number>(640);
  const [frameHeight, setFrameHeight] = useState<number>(640);
  const [subscribed,  setSubscribed]  = useState(false);

  useEffect(() => {
    if (!cameraId) return;

    socket.emit('camera:subscribe', { cameraId });
    setSubscribed(true);

    const handleFrame = (event: FrameEvent) => {
      if (event.cameraId === cameraId) {
        setFrame(event.data);
      }
    };

    const handleDetections = (event: DetectionsEvent) => {
      if (event.cameraId === cameraId) {
        setDetections(event.detections);
        if (event.frameWidth)  setFrameWidth(event.frameWidth);
        if (event.frameHeight) setFrameHeight(event.frameHeight);
      }
    };

    socket.on('frame', handleFrame);
    socket.on('detections', handleDetections);

    return () => {
      socket.emit('camera:unsubscribe', { cameraId });
      socket.off('frame', handleFrame);
      socket.off('detections', handleDetections);
      setSubscribed(false);
      setFrame(null);
      setDetections([]);
    };
  }, [cameraId, socket]);

  return { frame, detections, frameWidth, frameHeight, subscribed };
}
