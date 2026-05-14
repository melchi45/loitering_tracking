export interface Camera {
  id: string;
  name: string;
  rtspUrl: string;
  ip?: string;
  mac?: string;
  status: 'live' | 'offline' | 'error' | 'idle';
}

export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Detection {
  objectId: number;
  confidence: number;
  bbox: BBox;
  class: string;
  isLoitering: boolean;
  dwellTime: number;
}

export interface DetectionFrame {
  cameraId: string;
  frameId: number;
  timestamp: number;
  detections: Detection[];
}

export interface Alert {
  id: string;
  cameraId: string;
  objectId: number;
  zone?: string;
  dwellTime: number;
  timestamp: number;
  acknowledged: boolean;
}

export interface DiscoveredCamera {
  id: string;
  name: string;
  ip: string;
  mac?: string;
  rtspUrl: string;
}

export interface Zone {
  id: string;
  cameraId: string;
  name: string;
  type: 'MONITOR' | 'EXCLUDE';
  polygon: Array<{ x: number; y: number }>;
}
