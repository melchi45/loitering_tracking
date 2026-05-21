import { z } from 'zod';

export function registerAlertTools(server, client) {
  server.tool(
    'get_active_alerts',
    'Get current unacknowledged loitering alerts sorted by recency. Use this to see what requires immediate operator attention.',
    {
      cameraId: z.string().optional().describe('Filter by camera ID'),
      limit:    z.number().int().min(1).max(50).optional().describe('Max results (default 10)'),
    },
    async ({ cameraId, limit = 10 }) => {
      try {
        const params = { acknowledged: 'false', limit: 100 };
        if (cameraId) params.cameraId = cameraId;

        const { data: alerts = [] } = await client.get('/api/alerts', params);
        const results = alerts.slice(0, limit);

        if (results.length === 0) {
          return { content: [{ type: 'text', text: 'No active alerts at this time. All clear.' }] };
        }

        const lines = results.map(a =>
          [
            `Alert ID: ${a.id}`,
            `  Type:       ${a.type || 'LOITERING'}`,
            `  Camera:     ${a.cameraId}`,
            `  Zone:       ${a.zoneName || a.zoneId || 'Global'}`,
            `  Dwell Time: ${a.dwellTime}s`,
            `  Time:       ${new Date(typeof a.timestamp === 'number' ? a.timestamp : Date.parse(a.timestamp)).toISOString()}`,
          ].join('\n')
        );

        return {
          content: [{ type: 'text', text: `${results.length} active alert(s):\n\n${lines.join('\n\n')}` }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'explain_alert',
    'Get a comprehensive contextual explanation of a specific alert: incident details, zone configuration, object recurrence history, and risk assessment (LOW/MEDIUM/HIGH).',
    {
      alertId: z.string().describe('Alert UUID to explain'),
    },
    async ({ alertId }) => {
      try {
        // Fetch alert from list (no single-item GET endpoint in current API)
        const { data: allAlerts = [] } = await client.get('/api/alerts', { limit: 1000 });
        const alert = allAlerts.find(a => a.id === alertId);
        if (!alert) {
          return { content: [{ type: 'text', text: `Alert not found: ${alertId}` }], isError: true };
        }

        // Parallel: event details + camera list + zone config + object history
        const [eventResult, camerasResult, eventsResult] = await Promise.allSettled([
          alert.eventId ? client.get(`/api/events/${alert.eventId}`) : Promise.resolve(null),
          client.get('/api/cameras'),
          client.get('/api/events', { limit: 200 }),
        ]);

        const event   = eventResult.status   === 'fulfilled' && eventResult.value   ? eventResult.value.data   : null;
        const cameras = camerasResult.status === 'fulfilled' ? camerasResult.value.data || [] : [];
        const allEvents = eventsResult.status === 'fulfilled' ? eventsResult.value.data || [] : [];

        const camera = cameras.find(c => c.id === alert.cameraId);

        // Zone config (may fail if cameraId unavailable)
        let zone = null;
        try {
          const { data: zones = [] } = await client.get(`/api/cameras/${alert.cameraId}/zones`);
          zone = zones.find(z => z.id === alert.zoneId);
        } catch (_) { /* zone info optional */ }

        // Object recurrence
        const objectHistory = allEvents.filter(e => e.objectId === alert.objectId);

        // Time context
        const alertMs  = typeof alert.timestamp === 'number' ? alert.timestamp : Date.parse(alert.timestamp);
        const alertDate = new Date(alertMs);
        const hour      = alertDate.getHours();
        const timeLabel = hour < 6 ? 'early morning' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 21 ? 'evening' : 'night';

        // Risk assessment
        const dwellRatio = zone?.dwellThreshold ? alert.dwellTime / zone.dwellThreshold : 1;
        const isNight    = hour >= 22 || hour < 6;
        const isRepeat   = objectHistory.length > 3;

        const riskFactors = [];
        if (dwellRatio > 2)  riskFactors.push(`Dwell is ${dwellRatio.toFixed(1)}× the zone threshold`);
        if (isNight)         riskFactors.push('Night-time occurrence (22:00–06:00)');
        if (isRepeat)        riskFactors.push(`Repeat actor — ${objectHistory.length} total appearances`);

        const riskLevel = (isNight && isRepeat) ? 'HIGH' : (isNight || isRepeat || dwellRatio > 2) ? 'MEDIUM' : 'LOW';

        const report = [
          `## Alert Explanation`,
          `**Alert ID:** ${alertId}`,
          `**Status:** ${alert.acknowledged ? 'Acknowledged' : 'Active — requires attention'}`,
          `**Triggered At:** ${alertDate.toISOString()} (${timeLabel})`,
          ``,
          `### Incident Details`,
          `- **Type:** ${alert.type || 'LOITERING'}`,
          `- **Camera:** ${camera?.name || alert.cameraId}`,
          `- **Zone:** ${alert.zoneName || zone?.name || alert.zoneId || 'Global monitor'}`,
          `- **Dwell Time:** ${alert.dwellTime}s${zone?.dwellThreshold ? ` (threshold: ${zone.dwellThreshold}s)` : ''}`,
          `- **Object ID:** ${alert.objectId}`,
          ``,
          `### Zone Configuration`,
          zone ? [
            `- **Type:** ${zone.type || 'MONITOR'}`,
            `- **Dwell Threshold:** ${zone.dwellThreshold || 30}s`,
            `- **Polygon:** ${zone.polygon?.length || 0} vertices`,
            `- **Target Classes:** ${(zone.targetClasses || ['human']).join(', ')}`,
            zone.schedule ? `- **Schedule:** ${JSON.stringify(zone.schedule)}` : null,
          ].filter(Boolean).join('\n')
            : '- Zone details unavailable',
          ``,
          `### Object History`,
          objectHistory.length > 1 ? [
            `- **Total appearances:** ${objectHistory.length}`,
            `- **First seen:** ${objectHistory[objectHistory.length - 1]?.startTime}`,
            `- **Cameras visited:** ${[...new Set(objectHistory.map(e => e.cameraId))].join(', ')}`,
            isRepeat ? `- ⚠️ Repeat behavior detected` : null,
          ].filter(Boolean).join('\n')
            : '- First recorded occurrence for this object',
          ``,
          `### Risk Assessment`,
          `- **Risk Level:** ${riskLevel}`,
          riskFactors.length > 0
            ? riskFactors.map(f => `- ${f}`).join('\n')
            : '- Standard loitering alert — no elevated risk factors',
        ].join('\n');

        return { content: [{ type: 'text', text: report }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'acknowledge_alert',
    'Mark an alert as acknowledged (reviewed and handled by an operator). This removes it from the active alerts list.',
    {
      alertId: z.string().describe('Alert UUID to acknowledge'),
    },
    async ({ alertId }) => {
      try {
        await client.post(`/api/alerts/${alertId}/acknowledge`);
        return { content: [{ type: 'text', text: `Alert ${alertId} has been acknowledged.` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}
