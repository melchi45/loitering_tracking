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
  /** uncertain = PPE model running but could not classify this person (head occluded, too small, etc.) */
  status:     'mask_correct' | 'mask_incorrect' | 'no_mask' | 'uncertain';
  confidence: number;
}

export interface HatAttribute {
  className:        string;
  confidence:       number;
  /** null = PPE model running but could not classify this person */
  isHelmet:         boolean | null;
  /** true = hardhat detected (compliant), false = no_hardhat (non-compliant), null = uncertain */
  safetyCompliant?: boolean | null;
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

export interface CrossCameraReIdEvent {
  faceId:       string;
  prevCameraId: string;
  newCameraId:  string;
  similarity:   number;
  timestamp:    number;
}

export interface Detection {
  objectId:      number;
  confidence:    number;
  bbox:          BBox;
  class:         string;
  className:     string;
  isLoitering:   boolean;
  dwellTime:     number;
  // Face recognition (for className='face' detection objects)
  faceId?:       string;   // stable ID assigned by cosine-similarity gallery
  matchScore?:   number;   // cosine similarity vs. previous gallery entry (0–1)
  crossCamera?:  { prevCameraId: string };  // present when face matched across cameras
  // Adaptive Multi-Feature Tracking metrics (present only for zone-matched objects)
  revisitCount?: number;
  velocity?:     number;
  pacingScore?:  number;
  circularScore?: number;
  riskScore?:    number;
  // Attribute enrichment (optional — only present when relevant model is loaded)
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

export interface OnvifProfile {
  token:    string;
  name:     string;
  encoding: string;
  width:    number;
  height:   number;
  fps:      number;
  rtspUrl:  string;
}

export interface DiscoveredCamera {
  id: string;          // MACAddress_IPAddress or onvif_IP
  source?: 'udp' | 'onvif' | 'both';
  Model: string;
  Manufacturer?: string;
  FirmwareVersion?: string;
  SerialNumber?: string;
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
  SupportOnvif?: boolean;
  URL?: string;        // DDNS URL
  rtspUrl?: string;
  profiles?: OnvifProfile[];
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
  minRiskScore?: number;
  active?: boolean;
  targetClasses?: string[];
}
