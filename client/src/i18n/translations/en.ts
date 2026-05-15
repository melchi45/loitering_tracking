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

  // Zone editor groups
  zoneGroupPeopleVehicles: 'People / Vehicles',
  zoneGroupAiAttributes: 'AI Attributes',
  zoneGroupHazards: 'Hazards',
  zoneGroupIndoor: 'Indoor / Office Objects',
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
  zoneVertexDeleteMin: 'Minimum 3 vertices required. Use "Delete Zone" to remove the zone.',
  zoneEnterName: 'Enter zone name.',

  // Camera edit modal
  cameraName: 'Camera Name',
  cameraRtspUrl: 'RTSP URL',
  cameraSave: 'Save',
  cameraCancel: 'Cancel',
  cameraAdd: 'Add Camera',
  cameraEdit: 'Edit Camera',
} as const;

export type Translations = typeof en;
