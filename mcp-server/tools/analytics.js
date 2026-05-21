import { z } from 'zod';

export function registerAnalyticsTools(server, client) {
  server.tool(
    'get_analytics_summary',
    'Statistical summary of loitering detections and alerts for a time window: event counts, dwell time stats, peak hour, busiest camera, alerts by zone, and acknowledgment rate.',
    {
      from:     z.string().optional().describe('Start time (ISO 8601). Defaults to 24 hours ago'),
      to:       z.string().optional().describe('End time (ISO 8601). Defaults to now'),
      cameraId: z.string().optional().describe('Restrict to a specific camera'),
    },
    async ({ from, to, cameraId }) => {
      try {
        const now     = Date.now();
        const fromStr = from || new Date(now - 24 * 60 * 60 * 1000).toISOString();
        const toStr   = to   || new Date(now).toISOString();

        const params = { limit: 1000, from: fromStr, to: toStr };
        if (cameraId) params.cameraId = cameraId;

        const [eventsRes, alertsRes] = await Promise.all([
          client.get('/api/events', params),
          client.get('/api/alerts', { limit: 1000 }),
        ]);

        const events = eventsRes.data || [];
        let   alerts = alertsRes.data || [];

        // Filter alerts by time range (alerts have numeric or ISO timestamp)
        const fromMs = Date.parse(fromStr);
        const toMs   = Date.parse(toStr);
        alerts = alerts.filter(a => {
          const t = typeof a.timestamp === 'number' ? a.timestamp : Date.parse(a.timestamp);
          return t >= fromMs && t <= toMs;
        });
        if (cameraId) alerts = alerts.filter(a => a.cameraId === cameraId);

        if (events.length === 0 && alerts.length === 0) {
          return { content: [{ type: 'text', text: `No data found for the period ${fromStr} → ${toStr}.` }] };
        }

        const avgDwell = events.length > 0
          ? Math.round(events.reduce((s, e) => s + (e.dwellTime || 0), 0) / events.length)
          : 0;
        const maxDwell = events.reduce((m, e) => Math.max(m, e.dwellTime || 0), 0);

        // Busiest camera
        const camCounts = {};
        events.forEach(e => { camCounts[e.cameraId] = (camCounts[e.cameraId] || 0) + 1; });
        const topCam = Object.entries(camCounts).sort((a, b) => b[1] - a[1])[0];

        // Peak hour
        const hourBins = new Array(24).fill(0);
        events.forEach(e => { if (e.startTime) hourBins[new Date(e.startTime).getHours()]++; });
        const peakHour = hourBins.indexOf(Math.max(...hourBins));

        // Alerts by zone
        const zoneCounts = {};
        alerts.forEach(a => {
          const key = a.zoneName || a.zoneId || 'Global';
          zoneCounts[key] = (zoneCounts[key] || 0) + 1;
        });

        const acknowledged = alerts.filter(a => a.acknowledged).length;
        const ackRate = alerts.length > 0 ? Math.round((acknowledged / alerts.length) * 100) : 0;

        const zoneLines = Object.entries(zoneCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([z, n]) => `- ${z}: ${n}`);

        const summary = [
          `## Analytics Summary`,
          `**Period:** ${fromStr} → ${toStr}`,
          ``,
          `### Events`,
          `- Total loitering events:  **${events.length}**`,
          `- Average dwell time:      **${avgDwell}s**`,
          `- Maximum dwell time:      **${maxDwell}s**`,
          `- Peak activity hour:      **${peakHour}:00–${peakHour + 1}:00**`,
          topCam ? `- Busiest camera:          **${topCam[0]}** (${topCam[1]} events)` : null,
          ``,
          `### Alerts`,
          `- Total alerts:            **${alerts.length}**`,
          `- Acknowledged:            **${acknowledged}** (${ackRate}%)`,
          `- Active (unacknowledged): **${alerts.length - acknowledged}**`,
          zoneLines.length > 0 ? [``, `### Alerts by Zone`, ...zoneLines].join('\n') : null,
        ].filter(x => x !== null).join('\n');

        return { content: [{ type: 'text', text: summary }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'generate_security_report',
    'Generate a full markdown security report for a time period. Suitable for shift handovers or management review. Includes executive summary, incident log, key metrics, and automated recommendations.',
    {
      from:     z.string().describe('Report start time (ISO 8601)'),
      to:       z.string().describe('Report end time (ISO 8601)'),
      cameraId: z.string().optional().describe('Restrict report to a specific camera'),
    },
    async ({ from, to, cameraId }) => {
      try {
        const params = { limit: 500, from, to };
        if (cameraId) params.cameraId = cameraId;

        const [eventsRes, alertsRes, camerasRes] = await Promise.all([
          client.get('/api/events', params),
          client.get('/api/alerts', { limit: 500 }),
          client.get('/api/cameras'),
        ]);

        const events  = eventsRes.data  || [];
        const cameras = camerasRes.data || [];
        let   alerts  = (alertsRes.data || []).filter(a => {
          const t = typeof a.timestamp === 'number' ? a.timestamp : Date.parse(a.timestamp);
          return t >= Date.parse(from) && t <= Date.parse(to);
        });
        if (cameraId) alerts = alerts.filter(a => a.cameraId === cameraId);

        const camMap = {};
        cameras.forEach(c => { camMap[c.id] = c.name || c.id; });

        const openAlerts   = alerts.filter(a => !a.acknowledged);
        const maxDwellEvt  = events.reduce((m, e) => (!m || (e.dwellTime || 0) > (m.dwellTime || 0)) ? e : m, null);
        const avgDwell     = events.length > 0
          ? Math.round(events.reduce((s, e) => s + (e.dwellTime || 0), 0) / events.length)
          : 0;
        const runningCams  = cameras.filter(c => c.pipelineStatus?.running).length;

        const incidentLog = alerts.length === 0
          ? '_No alerts during this period._'
          : alerts.slice(0, 20).map((a, i) => {
              const ts = new Date(typeof a.timestamp === 'number' ? a.timestamp : Date.parse(a.timestamp)).toISOString();
              return [
                `### Incident ${i + 1}`,
                `- **Alert ID:** ${a.id}`,
                `- **Time:** ${ts}`,
                `- **Camera:** ${camMap[a.cameraId] || a.cameraId}`,
                `- **Zone:** ${a.zoneName || a.zoneId || 'Global'}`,
                `- **Dwell:** ${a.dwellTime}s`,
                `- **Status:** ${a.acknowledged ? 'Acknowledged' : '**OPEN**'}`,
              ].join('\n');
            }).join('\n\n')
              + (alerts.length > 20 ? `\n\n_...and ${alerts.length - 20} more alerts._` : '');

        const recommendations = [
          openAlerts.length > 5   ? `⚠️ ${openAlerts.length} unacknowledged alerts — review and acknowledge to maintain situational awareness.` : null,
          maxDwellEvt && maxDwellEvt.dwellTime > 600
            ? `⚠️ Extreme dwell time detected (${maxDwellEvt.dwellTime}s) on camera ${camMap[maxDwellEvt.cameraId] || maxDwellEvt.cameraId} — consider zone threshold review.`
            : null,
          runningCams < cameras.length
            ? `⚠️ ${cameras.length - runningCams} camera(s) offline — verify connectivity.`
            : null,
          events.length === 0    ? '✅ No loitering events detected during this period.' : null,
          openAlerts.length === 0 ? '✅ All alerts acknowledged.' : null,
        ].filter(Boolean);

        const report = [
          `# Security Report`,
          `**Generated:** ${new Date().toISOString()}`,
          `**Period:** ${from} → ${to}`,
          cameraId ? `**Camera:** ${camMap[cameraId] || cameraId}` : `**Scope:** All cameras (${cameras.length} total)`,
          ``,
          `---`,
          ``,
          `## Executive Summary`,
          `${events.length} loitering event(s) detected, generating **${alerts.length}** alert(s). ` +
            `**${openAlerts.length}** alert(s) remain unacknowledged.`,
          ``,
          `---`,
          ``,
          `## Incident Log`,
          incidentLog,
          ``,
          `---`,
          ``,
          `## Key Metrics`,
          `| Metric | Value |`,
          `|---|---|`,
          `| Total Events | ${events.length} |`,
          `| Total Alerts | ${alerts.length} |`,
          `| Open Alerts | ${openAlerts.length} |`,
          `| Avg Dwell Time | ${avgDwell}s |`,
          maxDwellEvt ? `| Longest Dwell | ${maxDwellEvt.dwellTime}s (${camMap[maxDwellEvt.cameraId] || maxDwellEvt.cameraId}) |` : null,
          `| Cameras Active | ${runningCams}/${cameras.length} |`,
          ``,
          `---`,
          ``,
          `## Recommendations`,
          recommendations.length > 0 ? recommendations.join('\n') : '✅ No issues detected.',
          ``,
          `---`,
          `_Report generated by LTS MCP Server_`,
        ].filter(x => x !== null).join('\n');

        return { content: [{ type: 'text', text: report }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}
