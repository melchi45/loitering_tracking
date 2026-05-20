export interface Camera {
  id: string;
  name: string;
  rtspUrl: string;
  ip?: string;
  mac?: string;
  webrtcEnabled?: boolean;
  status: 'live' | 'streaming' | 'connecting' | 'reconnecting' | 'offline' | 'error' | 'idle';
  /** 'youtube' for virtual YouTube stream channels; absent for physical IP cameras */
  type?: 'youtube' | string;
  /** Original YouTube page URL — only present when type === 'youtube' */
  youtubeUrl?: string;
  /** YouTube stream resolution e.g. '1080p' — only present when type === 'youtube' */
  resolution?: string;
  /** YouTube stream bitrate in kbps — only present when type === 'youtube' */
  bitrate?: number;
  /** When true, automatically restart playback when the YouTube video ends */
  repeatPlayback?: boolean;
  /** When false, AI inference (detection/tracking/behavior) is skipped for this camera. Default true. */
  aiEnabled?: boolean;
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
  /** e.g. 'tshirt' | 'shirt' | 'jacket' | 'hoodie' | 'vest' | 'dress' | 'unknown' */
  upper?: string;
  /** e.g. 'pants' | 'jeans' | 'shorts' | 'skirt' | 'unknown' */
  lower?: string;
  /** e.g. 'short' | 'long' — sleeve length from PAR model */
  sleeve?: string;
}

export interface CrossCameraReIdEvent {
  faceId:       string;
  alias?:       string | null;  // canonical person alias e.g. "P3"
  prevCameraId: string;
  newCameraId:  string;
  newObjectId?: string | number | null;  // tracker objectId of the person in newCameraId
  similarity:   number;
  timestamp:    number;
}

export interface PersonSegment {
  cameraId:  string;
  objectId:  string | number | null;
  entryTime: number;
  exitTime:  number;
}

export interface PersonTrajectory {
  faceId:          string;
  alias:           string;   // "P1", "P2", …
  firstSeenAt:     number;
  lastSeenAt:      number;
  currentCameraId: string;
  segments:        PersonSegment[];
}

export interface Detection {
  objectId:      string | number;  // string UUID from ByteTracker, or numeric for synthetic detections
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
  objectId: string | number;
  zone?: string;       // zone display name (zoneName from server)
  zoneId?: string;
  type?: string;       // 'LOITERING' | 'FIRE' | 'SMOKE' | ...
  dwellTime: number;
  timestamp: number | string;  // Unix ms or ISO string (normalize on receive)
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
