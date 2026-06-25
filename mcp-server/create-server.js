import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { LTSClient }              from './lts-client.js';
import { registerLoiteringTools } from './tools/loitering.js';
import { registerAlertTools }     from './tools/alerts.js';
import { registerCameraTools }    from './tools/cameras.js';
import { registerAnalyticsTools } from './tools/analytics.js';
import { registerSnapshotTools }  from './tools/snapshots.js';
import { registerStatsTools }     from './tools/stats.js';
import { registerSystemTools }    from './tools/system.js';
import { registerOnvifTools }     from './tools/onvif.js';
import { registerDetectionTools } from './tools/detections.js';
import { registerMissingPersonTools, registerMissingPersonResources } from './tools/missing-person.js';
import { registerResources }      from './resources.js';

/**
 * Creates a fully configured McpServer instance.
 * Call this once per transport connection (each SSE session gets its own instance).
 */
export function createServer(baseUrl) {
  const server = new McpServer({
    name:        'lts-mcp-server',
    version:     '1.1.0',
    description: 'LTS-2026 Loitering Tracking System — LLM integration via MCP',
  });

  const client = new LTSClient(baseUrl);

  registerSystemTools(server, client);
  registerLoiteringTools(server, client);
  registerAlertTools(server, client);
  registerCameraTools(server, client);
  registerAnalyticsTools(server, client);
  registerSnapshotTools(server, client);
  registerStatsTools(server, client);
  registerOnvifTools(server, client);
  registerDetectionTools(server, client);
  registerMissingPersonTools(server, client);
  registerResources(server, client);
  registerMissingPersonResources(server, client);

  return server;
}

/** Static catalog used by GET /schema (HTTP transport). */
export const TOOL_CATALOG = [
  // ── System ────────────────────────────────────────────────────────────────
  { name: 'get_server_status',        access: 'read',  description: 'LTS server health, mode (combined/streaming/analysis), uptime, DB type, active cameras.' },
  // ── Loitering / Tracking ─────────────────────────────────────────────────
  { name: 'query_loitering_events',   access: 'read',  description: 'Query loitering detection events with optional time/camera/dwell filters.' },
  { name: 'get_tracking_history',     access: 'read',  description: 'Full appearance history for a specific tracked object.' },
  // ── Alerts ───────────────────────────────────────────────────────────────
  { name: 'get_active_alerts',        access: 'read',  description: 'Current unacknowledged loitering alerts sorted by recency.' },
  { name: 'explain_alert',            access: 'read',  description: 'Contextual explanation of an alert: risk assessment, zone config, object history.' },
  { name: 'acknowledge_alert',        access: 'write', description: 'Mark an alert as acknowledged (reviewed by operator).' },
  // ── Cameras (read) ───────────────────────────────────────────────────────
  { name: 'get_camera_status',        access: 'read',  description: 'Camera pipeline status, AI-enabled flag, and error messages.' },
  { name: 'get_zone_config',          access: 'read',  description: 'Zone polygon, dwell threshold, target classes, and schedule for a camera.' },
  // ── Cameras (write) ──────────────────────────────────────────────────────
  { name: 'add_camera',              access: 'write', description: 'Add a new RTSP/YouTube camera channel and start its AI pipeline.' },
  { name: 'update_camera',           access: 'write', description: 'Update camera name, URL, AI-enabled flag, or location.' },
  { name: 'delete_camera',           access: 'write', description: 'Remove a camera channel, stop its pipeline, and delete its record.' },
  { name: 'toggle_camera_ai',        access: 'write', description: 'Enable or disable AI inference for a camera without stopping the stream.' },
  { name: 'update_zone_threshold',   access: 'write', description: 'Update the dwell time threshold for a monitoring zone (5–3600 s).' },
  // ── Analytics ────────────────────────────────────────────────────────────
  { name: 'get_analytics_summary',   access: 'read',  description: 'Statistical summary: event counts, dwell stats, peak hour, alerts by zone.' },
  { name: 'generate_security_report',access: 'read',  description: 'Full markdown security report with incident log, metrics, and recommendations.' },
  { name: 'get_stats_dashboard',     access: 'read',  description: 'System-wide stats snapshot: cameras, events, alerts, zones, Face ID, and storage mode.' },
  // ── ONVIF Events ─────────────────────────────────────────────────────────
  { name: 'query_onvif_events',       access: 'read',  description: 'Query ONVIF metadata events (motion, fire, line-crossing, audio alarm) with filters.' },
  { name: 'get_onvif_event_types',    access: 'read',  description: 'Get all ONVIF topicTypes ever seen by the system (event type registry).' },
  // ── AI Detections ────────────────────────────────────────────────────────
  { name: 'query_analysis_events',    access: 'read',  description: 'Query AI analysis events (loitering, fire, smoke) with time/camera/type filters.' },
  { name: 'get_detection_tracks',     access: 'read',  description: 'Object detection track history: dwell time, class, first/last seen per object.' },
  { name: 'get_analysis_metrics',     access: 'read',  description: 'AI pipeline metrics: FPS, model, queue depth, GPU util, detections by class.' },
  // ── Snapshots / Search ───────────────────────────────────────────────────
  { name: 'get_object_snapshots',     access: 'read',  description: 'Detection snapshots with cropped images for a specific tracked object.' },
  { name: 'search_person',            access: 'read',  description: 'Missing person search: loitering events + tracking history + snapshot images.' },
  // ── Missing Persons ──────────────────────────────────────────────────────
  { name: 'register_missing_person',  access: 'write', description: 'Register a missing person profile with contact info and embedding.' },
  { name: 'search_missing_person',    access: 'read',  description: 'Search missing person registry by filters and free text.' },
  { name: 'get_missing_person_detections',  access: 'read',  description: 'Retrieve missing-person detections by date and status.' },
  { name: 'update_missing_person_status',   access: 'write', description: 'Update a missing person status: FOUND/MISSING/UNCONFIRMED.' },
  { name: 'get_missing_person_statistics',  access: 'read',  description: 'Get missing-person registry and detection statistics.' },
];

export const RESOURCE_CATALOG = [
  { uri: 'lts://cameras',            description: 'All configured cameras with current pipeline status.' },
  { uri: 'lts://alerts/active',      description: 'Unacknowledged loitering alerts (up to 50).' },
  { uri: 'lts://zones/{cameraId}',   description: 'Zone configuration for a specific camera.' },
  { uri: 'lts://system/summary',     description: 'Overall system health: camera counts, active alerts, recent event stats.' },
  { uri: 'lts://stats/dashboard',    description: 'Full aggregated stats dashboard: cameras, events (7-day trend), alerts by severity, zones, Face ID.' },
  { uri: 'missing-persons://registry', description: 'Missing person registry snapshot.' },
  { uri: 'missing-persons://detections/{date}', description: 'Missing-person detections for a specific date.' },
];
