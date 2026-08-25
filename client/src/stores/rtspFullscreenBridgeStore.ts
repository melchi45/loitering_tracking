import { create } from 'zustand';

// Bridges a grid tile's live <rtsp-over-websocket> player into
// FullscreenCameraView's video slot WITHOUT ever reparenting the underlying
// DOM node — the vendor custom element's disconnectedCallback() explicitly
// calls stop() (tears down its WebSocket/MediaSource/RTP state) whenever it
// leaves the DOM, which a React Portal (or any other DOM move) would trigger
// just as much as an unmount/remount, defeating the whole point. Instead,
// the grid tile's own CameraView instance stays mounted exactly where it
// already is and, while its camera is shown in FullscreenCameraView, switches
// to `position: fixed` at this store's tracked target rect so it visually
// covers the fullscreen modal's video slot — same DOM node, same connection,
// the entire time. See docs/design/Design_RTSP_Over_WebSocket.md.
interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface RtspFullscreenBridgeState {
  // cameraId -> FullscreenCameraView's live video-slot rect, present only
  // while that camera is open in fullscreen AND in rtsp-over-websocket mode.
  targetRects: Record<string, Rect | undefined>;
  // cameraId -> whether a grid CameraView instance for that camera is
  // currently mounted (rtsp-over-websocket mode only). FullscreenCameraView
  // reads this to decide, per camera, whether a grid instance exists to
  // visually "borrow" (no reconnect) or whether it must mount its own local
  // instance instead (e.g. opened via search/face-match/zones while that
  // camera's channel-group page isn't the one currently visible in the grid
  // — a real reconnect in that case, same as before this bridge existed).
  gridInstances: Record<string, boolean>;
  setTargetRect: (cameraId: string, rect: Rect | undefined) => void;
  registerGridInstance: (cameraId: string) => void;
  unregisterGridInstance: (cameraId: string) => void;
}

export const useRtspFullscreenBridgeStore = create<RtspFullscreenBridgeState>((set) => ({
  targetRects: {},
  gridInstances: {},

  setTargetRect: (cameraId, rect) =>
    set((s) => ({ targetRects: { ...s.targetRects, [cameraId]: rect } })),

  registerGridInstance: (cameraId) =>
    set((s) => ({ gridInstances: { ...s.gridInstances, [cameraId]: true } })),

  unregisterGridInstance: (cameraId) =>
    set((s) => {
      const next = { ...s.gridInstances };
      delete next[cameraId];
      return { gridInstances: next };
    }),
}));
