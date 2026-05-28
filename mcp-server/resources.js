import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerResources(server, client) {
  // ── All cameras ─────────────────────────────────────────────────────────────
  server.resource(
    'cameras',
    'lts://cameras',
    { mimeType: 'application/json', description: 'All configured cameras with current pipeline status' },
    async () => {
      const { data } = await client.get('/api/cameras');
      return {
        contents: [{ uri: 'lts://cameras', text: JSON.stringify(data, null, 2), mimeType: 'application/json' }],
      };
    }
  );

  // ── Active (unacknowledged) alerts ───────────────────────────────────────────
  server.resource(
    'alerts-active',
    'lts://alerts/active',
    { mimeType: 'application/json', description: 'Current unacknowledged loitering alerts (up to 50)' },
    async () => {
      const { data } = await client.get('/api/alerts', { acknowledged: 'false', limit: 50 });
      return {
        contents: [{ uri: 'lts://alerts/active', text: JSON.stringify(data, null, 2), mimeType: 'application/json' }],
      };
    }
  );

  // ── Zone config per camera (resource template) ───────────────────────────────
  server.resource(
    'zones',
    new ResourceTemplate('lts://zones/{cameraId}', { list: undefined }),
    { mimeType: 'application/json', description: 'Zone configuration for a specific camera' },
    async (uri, { cameraId }) => {
      const { data } = await client.get(`/api/cameras/${cameraId}/zones`);
      return {
        contents: [{ uri: uri.href, text: JSON.stringify(data, null, 2), mimeType: 'application/json' }],
      };
    }
  );

  // ── System summary ────────────────────────────────────────────────────────────
  server.resource(
    'system-summary',
    'lts://system/summary',
    { mimeType: 'application/json', description: 'Overall system health: camera counts, active alerts, and recent event stats' },
    async () => {
      const [camerasRes, alertsRes, eventsRes] = await Promise.allSettled([
        client.get('/api/cameras'),
        client.get('/api/alerts', { acknowledged: 'false', limit: 100 }),
        client.get('/api/events', { limit: 100 }),
      ]);

      const cameras     = camerasRes.status === 'fulfilled' ? camerasRes.value.data || [] : [];
      const activeAlerts = alertsRes.status === 'fulfilled' ? alertsRes.value.data || [] : [];
      const recentEvents = eventsRes.status === 'fulfilled' ? eventsRes.value.data || [] : [];

      const avgDwell = recentEvents.length > 0
        ? Math.round(recentEvents.reduce((s, e) => s + (e.dwellTime || 0), 0) / recentEvents.length)
        : 0;

      const summary = {
        timestamp: new Date().toISOString(),
        cameras: {
          total:      cameras.length,
          running:    cameras.filter(c => c.pipelineStatus?.running).length,
          aiEnabled:  cameras.filter(c => c.aiEnabled).length,
        },
        alerts: {
          active:  activeAlerts.length,
          oldest:  activeAlerts[activeAlerts.length - 1]?.timestamp ?? null,
        },
        events: {
          recent100Count: recentEvents.length,
          avgDwellSec:    avgDwell,
        },
      };

      return {
        contents: [{ uri: 'lts://system/summary', text: JSON.stringify(summary, null, 2), mimeType: 'application/json' }],
      };
    }
  );

  // ── Stats dashboard (full aggregated stats) ───────────────────────────────
  server.resource(
    'stats-dashboard',
    'lts://stats/dashboard',
    { mimeType: 'application/json', description: 'Full aggregated stats dashboard: cameras, events (7-day trend), alerts by severity, zones, Face ID, and storage mode' },
    async () => {
      const { data } = await client.get('/api/stats');
      return {
        contents: [{ uri: 'lts://stats/dashboard', text: JSON.stringify(data, null, 2), mimeType: 'application/json' }],
      };
    }
  );
}
