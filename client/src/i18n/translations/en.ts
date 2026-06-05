export const en = {
  // App / header
  appTitle: 'Loitering Detection Dashboard',
  connected: 'Connected',
  disconnected: 'Disconnected',
  live: 'live',
  layoutLabel: 'Layout',
  settings: 'Settings',

  // Sidebar tabs
  tabCameras: 'Cameras',
  tabAlerts: 'Alerts',
  tabZones: 'Zones',
  tabVideoAnalytics: 'Analytics',
  tabDetections: 'Detections',
  tabFaceGallery: 'Face ID',

  // Face Gallery tab
  faceGallerySubtitle: 'Enroll & recognize persons',
  faceNewGalleryPlaceholder: 'New gallery name…',
  faceCreateGallery: '+ Gallery',
  faceDeleteGallery: 'Delete gallery',
  faceDeleteGalleryConfirm: 'Delete this gallery and all enrolled faces?',
  faceNoGalleries: 'No galleries yet — create one above.',
  faceSelectGallery: 'Select a gallery to manage faces.',
  faceEnrollTitle: 'Enroll Face',
  faceUploadHint: 'Click or drag a photo here',
  faceNamePlaceholder: 'Person name…',
  faceEnroll: 'Enroll',
  faceEnrolling: 'Enrolling…',
  faceEnrolled: 'Enrolled Faces',
  faceNoFaces: 'No faces enrolled yet.',
  faceLiveMatches: 'Live Matches',
  faceNoMatches: 'No matches yet',
  faceSelectType: 'Select gallery type',
  galleryTypeGeneral: 'General',
  galleryTypeVip: 'VIP',
  galleryTypeBlocklist: 'Blocklist',
  galleryTypeMissing: 'Missing Persons',
  missingPersonAlert: 'MISSING PERSON DETECTED',

  // Video Analytics tab
  videoAnalyticsHint: 'Enable or disable each AI module globally for all cameras.',
  videoAnalyticsFooter: 'Disabled modules stop processing immediately. Changes take effect on the next video frame.',

  // Camera list
  noCameras: 'No cameras added yet.',
  addCamera: 'Add Camera',
  editCamera: 'Edit',
  deleteCamera: 'Delete',
  startCamera: 'Start',
  stopCamera: 'Stop',
  cameraStatus: 'Status',

  // Camera status labels
  statusLive: 'LIVE',
  statusConn: 'CONN',
  statusRetry: 'RETRY',
  statusErr: 'ERR',
  statusOff: 'OFF',
  statusIdle: 'IDLE',
  noSignal: 'No signal',

  // Zone editor
  zoneHint: 'Click the + Zone button at the top-right of each camera view to edit zones.',
  addCameraFirst: 'Add a camera first.',
  zoneEdit: 'Edit Zone',
  zoneAdd: '+ Zone',
  zoneSave: 'Save',
  zoneCancel: 'Cancel',
  zoneDelete: 'Delete',
  zoneName: 'Zone Name',
  zoneType: 'Type',
  zoneTypeMonitor: 'MONITOR',
  zoneTypeExclude: 'EXCLUDE',
  zoneDwellThreshold: 'Dwell Threshold (s)',
  zoneTargetClasses: 'Target Classes',

  // Detections panel
  detections: 'Detections',
  noDetections: 'No detections',
  objCount: (n: number) => `${n} obj`,
  loiterCount: (n: number) => `${n} loiter`,

  // Detection row / legend headers
  legendPeopleVehicles: 'People / Vehicles',
  legendIndoor: 'Indoor / Office Objects',
  legendAiBadges: 'AI Attribute Badges',
  legendBaggage: 'baggage',
  legendAnimals: 'Animals',
  legendOutdoor: 'Outdoor / Infrastructure',
  legendFood: 'Food / Kitchen',
  legendHomeAppliances: 'Home Appliances',

  // Alerts
  alertTitle: 'Alerts',
  noAlerts: 'No alerts',
  alertAck: 'Ack',
  alertAckAll: 'Ack All',
  loiteringAlert: 'Loitering Alert',
  dwellTime: (s: number) => `${s.toFixed(1)}s`,

  // Discovery
  discoveryTitle: 'Camera Discovery',
  discoveryStart: 'Scan',
  discoveryRescan: 'Rescan',
  discoveryStop: 'Stop',
  discoveryAdd: 'Add',
  discoveryScanning: 'Scanning…',
  discoveryNone: 'No cameras found.',

  // Settings modal
  settingsTitle: 'Settings',
  settingsLanguage: 'Language',
  settingsClose: 'Close',

  // Settings — WebRTC
  settingsWebRTC: 'WebRTC',
  settingsWebRTCEnabled: 'Enable WebRTC',
  settingsStunServers: 'STUN Servers',
  settingsStunAdd: '+ Add',
  settingsStunPlaceholder: 'stun:stun.l.google.com:19302',
  settingsTurnServer: 'TURN Server',
  settingsTurnUrlPlaceholder: 'turn:your-server:3478',
  settingsTurnUsername: 'Username',
  settingsTurnAdd: '+ Add',
  settingsTurnCredential: 'Credential',
  settingsWebRTCApply: 'Apply',
  settingsWebRTCSaved: 'Saved ✓',

  // Settings — ICE Test
  settingsIceTest: 'ICE Connectivity Test',
  settingsIceTestRun: 'Run ICE Test',
  settingsIceTestRunning: 'Testing… (click to abort)',
  settingsIceTestDownload: 'Download Report',
  settingsIceTestClear: 'Clear',

  // Zone editor groups
  zoneGroupPeopleVehicles: 'People / Vehicles',
  zoneGroupAccessories: 'Accessories / Sports',
  zoneGroupAiAttributes: 'AI Attributes',
  zoneGroupHazards: 'Hazards',
  zoneGroupIndoor: 'Indoor / Office Objects',
  zoneGroupAnimals: 'Animals',
  zoneGroupOutdoor: 'Outdoor / Infrastructure',
  zoneGroupFood: 'Food / Kitchen',
  zoneGroupHomeAppliances: 'Home Appliances',
  zoneLoiteringTarget: 'Loitering Detection Targets',
  zoneLoiteringTargetHint: 'When selected, only these objects are tracked for dwell time and alerts.',
  zoneVertexHint: 'Drag vertex to move  /  Right-click vertex → delete  /  Right-click empty → save/delete zone',
  zoneClickToSelect: 'Click a zone to select it',
  zoneDrawHint: 'Click → add vertex  /  Double-click → finish',
  zoneDrawVertexHint: 'Drag or click target position',
  zoneDwellLabel: 'Dwell Threshold',
  zoneSeconds: 's',
  zoneSaveVertex: 'Save Vertex',
  zoneSaveVertexing: 'Saving…',
  zoneDeleteZone: 'Delete Zone',
  zoneReset: 'Reset',
  zoneCanSave: '✓ Ready to save',
  zoneVertexDeleteMin: 'Minimum 3 vertices required.',
  zoneEnterName: 'Enter zone name.',

  // Camera edit modal
  cameraName: 'Camera Name',
  cameraRtspUrl: 'RTSP URL',
  cameraSave: 'Save',
  cameraCancel: 'Cancel',
  cameraAdd: 'Add Camera',
  cameraEdit: 'Edit Camera',

  // Search Fullscreen — UI strings
  searchPlaceholder: 'Search alerts, detections, faces, events…',
  searchClose: 'Close (Esc)',
  searchSort: 'Sort:',
  searchSortNewest: 'Newest',
  searchSortOldest: 'Oldest',
  searchSortCamera: 'Camera A→Z',
  searchFrom: 'From',
  searchTo: 'To',
  searchClear: 'Clear',
  searchNoResults: (q: string) => `No results found for "${q}"`,
  searchTypeQuery: 'Type a query to search across all events',
  searchResults: (n: number) => `${n.toLocaleString()} result${n !== 1 ? 's' : ''}`,
  searchLoadMore: (shown: number, total: number) => `Load More (${shown} / ${total})`,
  searchAllLoaded: (total: number) => `All ${total} loaded`,

  // Search filter chip labels
  searchChipAll: 'All',
  searchChipDetection: 'Detection',
  searchChipAlert: 'Alert',
  searchChipFace: 'Face',
  searchChipMatch: 'Match',
  searchChipEvent: 'Event',

  // Search filter chip tooltips
  searchChipAllTooltip: 'Shows all result types — searches Detections, Alerts, Faces, Matches, and Events all at once.',
  searchChipDetectionTooltip: 'AI-detected object snapshots (people, vehicles, etc.). Includes dwell time, risk score, clothing, and color analysis.',
  searchChipAlertTooltip: 'Alerts triggered when the loitering threshold is exceeded. Unacknowledged alerts appear first; includes camera, zone, and dwell time.',
  searchChipFaceTooltip: 'Search persons enrolled in the face gallery. Filter by gallery type: Missing Persons, Suspects, Authorized Personnel, etc.',
  searchChipMatchTooltip: 'Real-time face recognition match events. Includes similarity score (%) and a live face crop at the time of detection.',
  searchChipEventTooltip: 'Loitering event records. Includes zone entry/exit times, total dwell time, and camera movement path.',
};

export type Translations = typeof en;
