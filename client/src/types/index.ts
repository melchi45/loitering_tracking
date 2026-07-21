/** Per-channel RTSP URL entry — see Camera.nvrProfiles and POST /api/cameras/probe-channels */
export interface NvrProfile {
  channelIndex: number;
  rtspUrl:      string;
}

/** Response shape of POST /api/cameras/probe-channels (on-demand SUNAPI/ONVIF re-detection) */
export interface ProbeChannelsResult {
  success:       boolean;
  maxChannel:    number;
  supportSunapi: boolean;
  protocol:      'sunapi' | 'onvif' | 'none';
  profiles:      NvrProfile[];
  error?:        string;
  /** SUNAPI's own reported channel count, independent of which protocol "won" as maxChannel/protocol above (FR-CH-066). Always a number — 1 when not attempted/not detected. */
  sunapiMaxChannel?: number;
  /** ONVIF's own reported channel count (FR-CH-066). null (not 1) when ONVIF never responded, vs. a number when it did. */
  onvifMaxChannel?: number | null;
  /** SUNAPI's own per-channel RTSP URLs, independent of which protocol "won" as `profiles` above — lets the UI show both side by side. */
  sunapiProfiles?: NvrProfile[];
  /** ONVIF's own per-channel RTSP URLs (GetStreamUri-verified), independent of which protocol "won" as `profiles` above. */
  onvifProfiles?: NvrProfile[];
  /** CGI-confirmed RTSP port (network.cgi?msubmenu=portconf&action=view). null when credentials unavailable or the query failed — treat as "unconfirmed, SUNAPI default 554 applies". */
  sunapiRtspPort?: number | null;
}

export interface Camera {
  id: string;
  name: string;
  rtspUrl: string;
  ip?: string;
  mac?: string;
  webrtcEnabled?: boolean;
  status: 'live' | 'streaming' | 'connecting' | 'reconnecting' | 'offline' | 'error' | 'idle' | 'paused';
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
  /** Device HTTP/CGI port (SUNAPI), used to re-probe channels without a fresh discovery scan */
  httpPort?: number | null;
  /** NVR physical sub-channel (1-based), set via SUNAPI/ONVIF discovery — distinct from channelSlot below */
  channelIndex?: number | null;
  /** Global Dashboard Channel Slot (1..MAX_CHANNEL_NUM), unique across all cameras/streams — determines grid position */
  channelSlot?: number | null;
  /** Total physical channels on the source NVR (from SUNAPI/ONVIF discovery); >1 enables the NVR Channel switcher */
  maxChannel?: number | null;
  /** True if this camera was added from a SUNAPI (Wisenet) discovery */
  supportSunapi?: boolean;
  /** Per-channel RTSP URLs resolved at discovery/add-time, used to switch NVR channel later without a live re-query */
  nvrProfiles?: NvrProfile[] | null;
  /** Thermal sensor native resolution width (e.g. 160) — used to scale onvif:temperature raw coordinates to actual video resolution. Absent/null means no calibration (raw coordinates assumed to already match video resolution). */
  thermalSensorWidth?: number | null;
  /** Thermal sensor native resolution height (e.g. 120) — paired with thermalSensorWidth for coordinate calibration. */
  thermalSensorHeight?: number | null;
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

// PromptPAR (PA100k, 26 attributes) — see server/src/services/colorClothService.js
// _runPAR(). No `upper` categorical field: PA100k has no direct equivalent of the
// old 12-attribute placeholder's upper-garment TYPE (tshirt/shirt/jacket/...), only
// sleeve length + style flags.
export interface ClothAttribute {
  /** 'trousers' | 'shorts' | 'skirtAndDress' */
  lower?: string;
  /** 'short' | 'long' — sleeve length */
  sleeve?: string;
  gender?: 'female' | 'male';
  ageGroup?: 'over60' | '18to60' | 'less18';
  viewAngle?: 'front' | 'side' | 'back';
  hat?: boolean;
  glasses?: boolean;
  handBag?: boolean;
  shoulderBag?: boolean;
  backpack?: boolean;
  holdObjectsInFront?: boolean;
  upperStride?: boolean;
  upperLogo?: boolean;
  upperPlaid?: boolean;
  upperSplice?: boolean;
  lowerStripe?: boolean;
  lowerPattern?: boolean;
  longCoat?: boolean;
  boots?: boolean;
}

export type GalleryType = 'general' | 'vip' | 'blocklist' | 'missing';

export interface FaceGallery {
  id:          string;
  name:        string;
  description: string;
  type:        GalleryType;
  faceCount:   number;
  createdAt:   string;
}

export interface EnrolledFace {
  id:        string;
  galleryId: string;
  name:      string;
  thumbnail: string;  // data:image/jpeg;base64,...
  score:     number;
  createdAt: string;
}

export interface FaceMatchEvent {
  faceId:        string;
  cameraId:      string;
  cameraName?:   string;   // absent on rows persisted before this field existed
  identity:      string;
  galleryId:     string;
  galleryType:   GalleryType;
  matchScore:    number;
  thumbnail:     string;
  liveCropData?: string;   // v1.1 — base64 JPEG crop of detected face from live frame
  timestamp:     number;
}

export interface CrossCameraReIdEvent {
  faceId:              string;
  alias?:              string | null;  // canonical person alias e.g. "P3"
  prevCameraId:        string;
  newCameraId:         string;
  newObjectId?:        string | number | null;
  similarity:          number;
  timestamp:           number;
}

/** Clothing colour/type feature vector used in appearance Re-ID */
export interface ClothingFeature {
  upper?:    string | null;  // PAR cloth type (e.g. 'jacket') — null when model not loaded
  lower?:    string | null;
  upperRgb?: [number, number, number] | null;
  lowerRgb?: [number, number, number] | null;
}

/** Emitted by server when the same outfit is detected on a different camera */
export interface ClothingReIdEvent {
  clothingId:   string;        // 'C1', 'C2', … gallery-assigned appearance ID
  faceId?:      string | null; // linked face ID when face was also detected
  prevCameraId: string;
  newCameraId:  string;
  similarity:   number;        // _clothingAppearSim score [0, 1]
  objectId?:    string | number | null;
  feature:      ClothingFeature;
  timestamp:    number;
}

export interface PersonSegment {
  cameraId:    string;
  objectId:    string | number | null;
  entryTime:   number;
  exitTime:    number;
  /** Face-match cosine similarity that produced this segment (absent on legacy data predating this field). */
  similarity?: number | null;
}

export interface PersonTrajectory {
  faceId:          string;
  alias:           string;   // "P1", "P2", …
  firstSeenAt:     number;
  lastSeenAt:      number;
  currentCameraId: string;
  segments:        PersonSegment[];
}

// Dedicated Age Estimation feature (InsightFace GenderAge / ViT Age Classifier —
// server/src/services/ageEstimationService.js), distinct from ClothAttribute.ageGroup
// (a coarse 3-bucket PromptPAR/PA100k attribute). This is the finer-grained,
// admin-selectable model's own numeric/bucketed prediction.
export interface EstimatedAge {
  value:    number;           // predicted age (regression value, or bucket midpoint)
  bucket?:  string;           // present for bucket-classifier models (e.g. ViT Age Classifier)
  source:   'face' | 'body';  // which crop the estimate was made from
  modelId:  string;           // 'insightface-genderage' | 'vit-age-classifier'
}

// Dedicated Gender Classification feature (InsightFace GenderAge / ViT Gender
// Classifier — server/src/services/genderClassificationService.js), distinct
// from ClothAttribute.gender (a PromptPAR/PA100k byproduct attribute). This is
// the finer-grained, admin-selectable model's own prediction.
export interface EstimatedGender {
  value:      'male' | 'female';
  confidence: number;         // softmax probability of the winning class (0-1)
  source:     'face' | 'body';
  modelId:    string;         // 'insightface-genderage-gender' | 'vit-gender-classifier'
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
  // Clothing appearance Re-ID
  clothingId?:   string;   // 'C1', 'C2', … — cross-camera appearance tracking ID
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
  estimatedAge?: EstimatedAge | null;
  estimatedGender?: EstimatedGender | null;
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
  token:         string;
  name:          string;
  encoding:      string;
  width:         number;
  height:        number;
  fps:           number;
  rtspUrl:       string;
  sourceToken?:  string; // VideoSourceConfiguration/SourceToken — identifies physical video input
  channelIndex?: number; // 1-based channel this profile belongs to (NVR: per-channel; single cam: always 1)
}

export interface DiscoveredCamera {
  id: string;          // MACAddress_IPAddress or onvif_IP
  source?: 'udp' | 'onvif' | 'both';
  Model: string;
  Manufacturer?: string;
  FirmwareVersion?: string;
  SerialNumber?: string;
  Type?: number;
  /** Human-readable label for `Type` (WiseNet UDP discovery's Device Type byte — SUNAPI IP Installer spec §3.4.2), e.g. "Camera"/"Encoder"/"Recorder". Undefined when the discovery response didn't carry this field at all (short/legacy packet), not merely when Type is 0x00. */
  DeviceType?: string;
  IPAddress: string;
  MACAddress?: string;
  Port?: number;
  Channel?: number;
  MaxChannel?: number;
  /** SUNAPI's own reported channel count (FR-CH-066) — only meaningful when SupportSunapi is true; undefined when never determined via SUNAPI. Distinct from the merged MaxChannel above. */
  SunapiMaxChannel?: number;
  /** ONVIF's own reported channel count (FR-CH-066) — undefined when never determined via ONVIF. Distinct from the merged MaxChannel above. */
  OnvifMaxChannel?: number;
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
