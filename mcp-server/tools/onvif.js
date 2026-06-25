import { z } from 'zod';

export function registerOnvifTools(server, client) {
  // ── query_onvif_events ─────────────────────────────────────────────────────
  server.tool(
    'query_onvif_events',
    'Query ONVIF metadata events (motion, line-crossing, fire detection, audio alarm, tamper, etc.) from the LTS database. Supports filtering by camera, event type, severity, and time range.',
    {
      cameraId:  z.string().optional().describe('Filter by camera ID'),
      type:      z.string().optional().describe('Filter by topicType (e.g. motionAlarm, lineCrossing, earlyFireDetection, audioAlarm)'),
      severity:  z.enum(['critical', 'high', 'medium', 'low', 'info']).optional().describe('Filter by severity level'),
      from:      z.string().optional().describe('ISO8601 start time (e.g. 2026-06-25T00:00:00Z)'),
      to:        z.string().optional().describe('ISO8601 end time'),
      limit:     z.number().int().min(1).max(200).optional().describe('Max results (default 50)'),
      ruleName:  z.string().optional().describe('Filter by RuleName (analytics rule, e.g. Name1, Zone1_Loitering)'),
    },
    async ({ cameraId, type, severity, from, to, limit = 50, ruleName }) => {
      try {
        const params = { limit };
        if (cameraId) params.cameraId = cameraId;
        if (type)     params.type     = type;
        if (severity) params.severity = severity;
        if (from)     params.from     = from;
        if (to)       params.to       = to;

        const { events = [], total } = await client.get('/api/onvif-events', params);

        const filtered = ruleName
          ? events.filter(e => e.ruleName === ruleName)
          : events;

        if (filtered.length === 0) {
          return { content: [{ type: 'text', text: 'No ONVIF events found for the given filters.' }] };
        }

        const lines = filtered.map(e => {
          const ts = e.utcTime || e.serverTs || '';
          const time = ts ? new Date(ts).toISOString() : 'N/A';
          return [
            `[${time}] ${e.topicLabel || e.topicType} — ${e.state ?? ''}`,
            `  Camera   : ${e.cameraId || 'N/A'}`,
            `  Topic    : ${e.topicType || e.topic}`,
            `  Severity : ${e.severity || 'info'}`,
            e.sourceToken ? `  Source   : ${e.sourceToken}` : null,
            e.ruleName    ? `  RuleName : ${e.ruleName}` : null,
            e.operation   ? `  Operation: ${e.operation}` : null,
          ].filter(Boolean).join('\n');
        });

        const header = `ONVIF Events: ${filtered.length}${total != null ? ` of ${total}` : ''} results\n`;
        return { content: [{ type: 'text', text: header + lines.join('\n\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ── get_onvif_event_types ──────────────────────────────────────────────────
  server.tool(
    'get_onvif_event_types',
    'Get all ONVIF event topic types ever seen by the system (ever-seen registry). Use to discover what types of ONVIF events this camera network generates before querying specific events.',
    {},
    async () => {
      try {
        const { types = [] } = await client.get('/api/onvif-event-types');

        if (types.length === 0) {
          return { content: [{ type: 'text', text: 'No ONVIF event types registered yet. Events may not have arrived.' }] };
        }

        const lines = types.map(t =>
          `  ${t.topicType || t.type} (${t.label || t.topicLabel || '—'}) — count: ${t.count ?? '?'}, severity: ${t.severity || 'info'}`
        );

        return {
          content: [{ type: 'text', text: `Registered ONVIF event types (${types.length}):\n${lines.join('\n')}` }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}
