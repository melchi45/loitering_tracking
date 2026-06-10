import { useEffect, useRef, useState } from 'react';
import { useSocket } from './useSocket';
import { subscriptionCounts } from './useCamera';
import type { Detection } from '../types';

interface DetectionsEvent {
  cameraId:   string;
  detections: Detection[];
}

// Stable key from a sorted id list — avoids object identity churn in deps
function idsKey(ids: string[]): string {
  return [...ids].sort().join('|');
}

/**
 * Subscribe to multiple cameras and return a Map of their latest detections.
 * Shares the module-level subscriptionCounts ref-counter with useCamera so that
 * duplicate socket rooms are never opened when a camera is already subscribed
 * by the grid or a fullscreen view.
 */
export function useAllDetections(enabledCameraIds: string[]): Map<string, Detection[]> {
  const { socket }       = useSocket();
  const subscribedRef    = useRef<Set<string>>(new Set());
  const [detMap, setDetMap] = useState<Map<string, Detection[]>>(new Map());

  // Reconcile subscriptions whenever the enabled set changes
  useEffect(() => {
    const next = new Set(enabledCameraIds);
    const cur  = subscribedRef.current;

    // Subscribe to newly added cameras
    for (const id of next) {
      if (!cur.has(id)) {
        const cnt = subscriptionCounts.get(id) ?? 0;
        if (cnt === 0) socket.emit('camera:subscribe', { cameraId: id });
        subscriptionCounts.set(id, cnt + 1);
        cur.add(id);
      }
    }

    // Unsubscribe from removed cameras
    for (const id of [...cur]) {
      if (!next.has(id)) {
        const cnt = subscriptionCounts.get(id) ?? 0;
        if (cnt <= 1) {
          socket.emit('camera:unsubscribe', { cameraId: id });
          subscriptionCounts.delete(id);
        } else {
          subscriptionCounts.set(id, cnt - 1);
        }
        cur.delete(id);
        setDetMap(prev => {
          const m = new Map(prev);
          m.delete(id);
          return m;
        });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey(enabledCameraIds), socket]);

  // Socket event listeners — stable across renders
  useEffect(() => {
    const handleDetections = (ev: DetectionsEvent) => {
      // In analysis server mode no cameras are registered, so subscribedRef is empty.
      // Accept all incoming events in that case (global io.emit from analysisApi).
      if (subscribedRef.current.size > 0 && !subscribedRef.current.has(ev.cameraId)) return;
      setDetMap(prev => {
        const m = new Map(prev);
        m.set(ev.cameraId, ev.detections);
        return m;
      });
    };

    const handleReconnect = () => {
      for (const id of subscribedRef.current) {
        socket.emit('camera:subscribe', { cameraId: id });
      }
    };

    socket.on('detections', handleDetections);
    socket.on('connect',    handleReconnect);

    return () => {
      socket.off('detections', handleDetections);
      socket.off('connect',    handleReconnect);
    };
  }, [socket]);

  // Unsubscribe everything on component unmount
  useEffect(() => {
    return () => {
      for (const id of subscribedRef.current) {
        const cnt = subscriptionCounts.get(id) ?? 0;
        if (cnt <= 1) {
          socket.emit('camera:unsubscribe', { cameraId: id });
          subscriptionCounts.delete(id);
        } else {
          subscriptionCounts.set(id, cnt - 1);
        }
      }
      subscribedRef.current.clear();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return detMap;
}
