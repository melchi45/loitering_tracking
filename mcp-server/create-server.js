import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { LTSClient }              from './lts-client.js';
import { registerLoiteringTools } from './tools/loitering.js';
import { registerAlertTools }     from './tools/alerts.js';
import { registerCameraTools }    from './tools/cameras.js';
import { registerAnalyticsTools } from './tools/analytics.js';
import { registerSnapshotTools }  from './tools/snapshots.js';
import { registerStatsTools }     from './tools/stats.js';
import { registerResources }      from './resources.js';

/**
 * Creates a fully configured McpServer instance.
 * Call this once per transport connection (each SSE session gets its own instance).
 */
export function createServer(baseUrl) {
  const server = new McpServer({
    name:        'lts-mcp-server',
    version:     '1.0.0',
    description: 'LTS-2026 Loitering Tracking System — LLM integration via MCP',
  });

  const client = new LTSClient(baseUrl);

  registerLoiteringTools(server, client);
  registerAlertTools(server, client);
  registerCameraTools(server, client);
  registerAnalyticsTools(server, client);
  registerSnapshotTools(server, client);
  registerStatsTools(server, client);
  registerResources(server, client);

  return server;
}

/** Static catalog used by GET /schema (HTTP transport). */
export const TOOL_CATALOG = [
  { name: 'query_loitering_events',  access: 'read',  description: 'Query loitering detection events with optional time/camera/dwell filters.' },
  { name: 'get_tracking_history',    access: 'read',  description: 'Full appearance history for a specific tracked object.' },
  { name: 'get_active_alerts',       access: 'read',  description: 'Current unacknowledged loitering alerts sorted by recency.' },
  { name: 'explain_alert',           access: 'read',  description: 'Contextual explanation of an alert: risk assessment, zone config, object history.' },
  { name: 'acknowledge_alert',       access: 'write', description: 'Mark an alert as acknowledged (reviewed by operator).' },
  { name: 'get_camera_status',       access: 'read',  description: 'Camera pipeline status, AI-enabled flag, and error messages.' },
  { name: 'get_zone_config',         access: 'read',  description: 'Zone polygon, dwell threshold, target classes, and schedule for a camera.' },
  { name: 'update_zone_threshold',   access: 'write', description: 'Update the dwell time threshold for a monitoring zone (5–3600 s).' },
  { name: 'get_analytics_summary',   access: 'read',  description: 'Statistical summary: event counts, dwell stats, peak hour, alerts by zone.' },
  { name: 'generate_security_report',access: 'read',  description: 'Full markdown security report with incident log, metrics, and recommendations.' },
  { name: 'get_object_snapshots',    access: 'read',  description: 'Detection snapshots with cropped images for a specific tracked object.' },
  { name: 'search_person',           access: 'read',  description: 'Missing person search: loitering events + tracking history + snapshot images.' },
  { name: 'get_stats_dashboard',     access: 'read',  description: 'System-wide stats snapshot: cameras, events, alerts, zones, Face ID, and storage mode.' },
];

export const RESOURCE_CATALOG = [
  { uri: 'lts://cameras',            description: 'All configured cameras with current pipeline status.' },
  { uri: 'lts://alerts/active',      description: 'Unacknowledged loitering alerts (up to 50).' },
  { uri: 'lts://zones/{cameraId}',   description: 'Zone configuration for a specific camera.' },
  { uri: 'lts://system/summary',     description: 'Overall system health: camera counts, active alerts, recent event stats.' },
  { uri: 'lts://stats/dashboard',    description: 'Full aggregated stats dashboard: cameras, events (7-day trend), alerts by severity, zones, Face ID.' },
];
