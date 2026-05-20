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
};

export type Translations = typeof en;
