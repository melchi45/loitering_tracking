export interface Camera {
  id: string;
  name: string;
  rtspUrl: string;
  ip?: string;
  mac?: string;
  status: 'live' | 'streaming' | 'connecting' | 'reconnecting' | 'offline' | 'error' | 'idle';
}

export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FaceAttribute {
  bbox:       BBox;
  score:      number;
  faceId?:    string;
  identity?:  string;
  matchScore?: number;
}

export interface MaskAttribute {
  status:     'mask_correct' | 'mask_incorrect' | 'no_mask';
  confidence: number;
}

export interface HatAttribute {
  className:  string;
  confidence: number;
  isHelmet:   boolean;
}

export interface ColorAttribute {
  upper:    string;
  lower:    string;
  upperRgb?: [number, number, number];
  lowerRgb?: [number, number, number];
}

export interface ClothAttribute {
  upper?: string;
  lower?: string;
}

export interface Detection {
  objectId:    number;
  confidence:  number;
  bbox:        BBox;
  class:       string;
  className:   string;
  isLoitering: boolean;
  dwellTime:   number;
  // Attribute enrichment (optional — only present when relevant model is loaded
  // and the camera zone has matching targetClasses)
  face?:  FaceAttribute;
  mask?:  MaskAttribute;
  hat?:   HatAttribute;
  color?: ColorAttribute;
  cloth?: ClothAttribute;
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
  id: string;          // MACAddress_IPAddress
  Model: string;
  Type?: number;
  IPAddress: string;
  MACAddress?: string;
  Port?: number;
  Channel?: number;
  MaxChannel?: number;
  HttpType?: boolean;  // false=http, true=https
  HttpPort?: number;
  HttpsPort?: number;
  Gateway?: string;
  SubnetMask?: string;
  SupportSunapi?: boolean;
  URL?: string;        // DDNS URL
  rtspUrl?: string;
  Username?: string;
  Password?: string;
}

export interface Zone {
  id: string;
  cameraId: string;
  name: string;
  type: 'MONITOR' | 'EXCLUDE';
  polygon: Array<{ x: number; y: number }>;
  dwellThreshold?: number;
  minDisplacement?: number;
  reentryWindow?: number;
  active?: boolean;
  targetClasses?: string[];
}
