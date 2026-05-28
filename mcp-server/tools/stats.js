import { z } from 'zod';

export function registerStatsTools(server, client) {
  server.tool(
    'get_stats_dashboard',
    'Get a comprehensive real-time snapshot of the entire LTS-2026 system: camera counts by status, detection event totals and 7-day trend, alert counts by severity, zone statistics, Face ID enrollment, and storage mode. Equivalent to reading the Stats Dashboard Panel in the web UI.',
    {
      // No required inputs — returns system-wide aggregated stats
    },
    async () => {
      try {
        const { data } = await client.get('/api/stats');

        if (!data) {
          return { content: [{ type: 'text', text: 'Stats API returned no data.' }], isError: true };
        }

        const {
          generatedAt,
          storage,
          cameras,
          zones,
          events,
          alerts,
          faces,
        } = data;

        // ── Cameras ────────────────────────────────────────────────────────────
        const camLines = [
          `- Total:          **${cameras?.total ?? 0}**`,
          `- Streaming:      **${cameras?.byStatus?.streaming ?? 0}**`,
          `- Stopped:        **${cameras?.byStatus?.stopped ?? 0}**`,
          cameras?.aiEnabled !== undefined
            ? `- AI Enabled:     **${cameras.aiEnabled}**`
            : null,
        ].filter(Boolean);

        // ── Zones ──────────────────────────────────────────────────────────────
        const zoneLines = [
          `- Total:          **${zones?.total ?? 0}**`,
        ];
        if (zones?.byType && Object.keys(zones.byType).length > 0) {
          Object.entries(zones.byType).forEach(([t, n]) => {
            zoneLines.push(`- ${t}:${' '.repeat(Math.max(1, 12 - t.length))}**${n}**`);
          });
        }

        // ── Events ─────────────────────────────────────────────────────────────
        const eventLines = [
          `- Total:          **${events?.total ?? 0}**`,
          `- Today:          **${events?.today ?? 0}**`,
          `- Loitering:      **${events?.loitering ?? 0}**`,
        ];
        if (events?.last7days && events.last7days.length > 0) {
          const trendParts = events.last7days.map(d => `${d.date}: ${d.count}`);
          eventLines.push(`- 7-day trend:    ${trendParts.join(' | ')}`);
        }

        // ── Alerts ─────────────────────────────────────────────────────────────
        const alertLines = [
          `- Total:          **${alerts?.total ?? 0}**`,
          `- Unacknowledged: **${alerts?.unacknowledged ?? 0}**`,
          `- Today:          **${alerts?.today ?? 0}**`,
        ];
        if (alerts?.bySeverity) {
          const { critical = 0, high = 0, medium = 0, low = 0 } = alerts.bySeverity;
          alertLines.push(
            `- Critical:       **${critical}**`,
            `- High:           **${high}**`,
            `- Medium:         **${medium}**`,
            `- Low:            **${low}**`,
          );
        }

        // ── Face ID ────────────────────────────────────────────────────────────
        const faceLines = [
          `- Galleries:      **${faces?.galleries ?? 0}**`,
          `- Enrolled Faces: **${faces?.enrolled ?? 0}**`,
        ];

        const report = [
          `## LTS-2026 Stats Dashboard`,
          `**Generated:** ${generatedAt ?? new Date().toISOString()}`,
          `**Storage Mode:** ${storage?.mode ?? 'unknown'}`,
          ``,
          `### Cameras`,
          ...camLines,
          ``,
          `### Detection Events`,
          ...eventLines,
          ``,
          `### Alerts`,
          ...alertLines,
          ``,
          `### Zones`,
          ...zoneLines,
          ``,
          `### Face ID`,
          ...faceLines,
        ].join('\n');

        return { content: [{ type: 'text', text: report }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}
