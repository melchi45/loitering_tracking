'use strict';

const ALL_TABLES = [
  'cameras', 'zones', 'events', 'alerts',
  'faceGalleries', 'faceGalleryFaces',
  'settings', 'detectionSnapshots', 'faceMatchHistory',
  'missing_persons', 'missing_person_detections',
  'analysisEvents', 'client_logs', 'client_webrtc_stats',
  'onvif_events', 'onvif_event_types', 'onvif_snapshots',
  'detectionTracks', 'users', 'refresh_tokens', 'audit_logs',
];

// Maximum rows kept in-memory per table. Oldest records evicted when cap is exceeded.
const TABLE_ROW_CAPS = {
  events:                    20000,
  alerts:                    10000,
  detectionSnapshots:         2000,
  faceMatchHistory:           5000,
  missing_person_detections:  5000,
  client_logs:               10000,
  client_webrtc_stats:        5000,
  onvif_events:              50000,
  onvif_snapshots:            2000,
  detectionTracks:           10000,
  refresh_tokens:            10000,
  audit_logs:                10000,
};

// One-time migration from legacy separate JSON files (JSON mode only, first startup).
const LEGACY_MIGRATIONS = [
  { table: 'users',          file: 'users.json',  key: 'users' },
  { table: 'refresh_tokens', file: 'tokens.json', key: 'refreshTokens' },
  { table: 'audit_logs',     file: 'audit.json',  key: 'events' },
];

module.exports = { ALL_TABLES, TABLE_ROW_CAPS, LEGACY_MIGRATIONS };
