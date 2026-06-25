import { z } from 'zod';

export function registerLoiteringTools(server, client) {
  server.tool(
    'query_face_trajectories',
    'Query cross-camera face trajectory history stored in the DB. Each trajectory record shows which cameras a person (identified by face embedding) visited, with timestamps and segment-level camera transitions.',
    {
      faceId:   z.string().optional().describe('Filter by face ID (e.g. "F3")'),
      alias:    z.string().optional().describe('Filter by person alias (e.g. "P3")'),
      cameraId: z.string().optional().describe('Filter trajectories that include this camera ID in any segment'),
      from:     z.string().optional().describe('Include persons last seen after this time (ISO 8601)'),
      to:       z.string().optional().describe('Include persons first seen before this time (ISO 8601)'),
      limit:    z.number().int().min(1).max(500).optional().describe('Max results (default 20)'),
    },
    async ({ faceId, alias, cameraId, from, to, limit = 20 }) => {
      try {
        const params = { limit };
        if (faceId)   params.faceId   = faceId;
        if (alias)    params.alias    = alias;
        if (cameraId) params.cameraId = cameraId;
        if (from)     params.from     = from;
        if (to)       params.to       = to;

        const { data } = await client.get('/api/analysis/face-trajectories', params);
        const rows = data?.trajectories ?? [];

        if (rows.length === 0) {
          return { content: [{ type: 'text', text: 'No face trajectory records found for the specified filters.' }] };
        }

        const lines = rows.map(t => {
          const segs = (t.segments || []).map(s =>
            `    · cam=${s.cameraId?.slice(0, 8)} obj=${s.objectId?.slice(0, 8) ?? 'n/a'} ${new Date(s.entryTime).toISOString()}→${s.exitTime ? new Date(s.exitTime).toISOString() : 'ongoing'}`
          ).join('\n');
          return [
            `Face ${t.faceId} (${t.alias})`,
            `  First seen:  ${new Date(t.firstSeenAt).toISOString()}`,
            `  Last seen:   ${new Date(t.lastSeenAt).toISOString()}`,
            `  Current cam: ${t.currentCameraId ?? 'none'}`,
            `  Segments (${(t.segments || []).length}):`,
            segs || '    (none)',
          ].join('\n');
        });

        return {
          content: [{
            type: 'text',
            text: `Found ${rows.length} face trajectory record(s):\n\n${lines.join('\n\n')}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'query_loitering_events',
    'Query loitering detection events. Returns events where tracked objects exceeded the dwell time threshold in monitored zones.',
    {
      cameraId:    z.string().optional().describe('Filter by camera ID'),
      from:        z.string().optional().describe('Start time filter (ISO 8601, e.g. 2026-05-21T00:00:00Z)'),
      to:          z.string().optional().describe('End time filter (ISO 8601)'),
      minDwellSec: z.number().optional().describe('Minimum dwell time in seconds'),
      limit:       z.number().int().min(1).max(100).optional().describe('Max results (default 20)'),
    },
    async ({ cameraId, from, to, minDwellSec, limit = 20 }) => {
      try {
        const params = { limit: 200 };
        if (cameraId) params.cameraId = cameraId;
        if (from)     params.from = from;
        if (to)       params.to = to;

        const { data: events = [] } = await client.get('/api/events', params);

        let results = minDwellSec
          ? events.filter(e => (e.dwellTime || 0) >= minDwellSec)
          : events;
        results = results.slice(0, limit);

        if (results.length === 0) {
          return { content: [{ type: 'text', text: 'No loitering events found for the specified filters.' }] };
        }

        const lines = results.map(e =>
          [
            `Event ID: ${e.id}`,
            `  Camera:     ${e.cameraId}`,
            `  Zone:       ${e.zoneName || e.zoneId || 'Global'}`,
            `  Object ID:  ${e.objectId}`,
            `  Dwell Time: ${e.dwellTime}s`,
            `  Start Time: ${e.startTime}`,
          ].join('\n')
        );

        return {
          content: [{ type: 'text', text: `Found ${results.length} loitering event(s):\n\n${lines.join('\n\n')}` }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_tracking_history',
    'Get the full appearance history for a specific tracked object — cameras visited, zones entered, total dwell time, and first/last seen timestamps.',
    {
      objectId: z.string().describe('Tracked object / person ID'),
      cameraId: z.string().optional().describe('Restrict lookup to a specific camera'),
    },
    async ({ objectId, cameraId }) => {
      try {
        const params = { limit: 200 };
        if (cameraId) params.cameraId = cameraId;

        const { data: events = [] } = await client.get('/api/events', params);
        const history = events.filter(e => e.objectId === objectId);

        if (history.length === 0) {
          return { content: [{ type: 'text', text: `No tracking history found for object ID: ${objectId}` }] };
        }

        const totalDwell = history.reduce((s, e) => s + (e.dwellTime || 0), 0);
        const cameras    = [...new Set(history.map(e => e.cameraId))];
        const zones      = [...new Set(history.map(e => e.zoneName || e.zoneId).filter(Boolean))];

        return {
          content: [{
            type: 'text',
            text: [
              `Tracking History for Object: ${objectId}`,
              `  Appearances:       ${history.length}`,
              `  Total Dwell Time:  ${totalDwell}s`,
              `  Cameras seen:      ${cameras.join(', ')}`,
              `  Zones visited:     ${zones.join(', ') || 'None'}`,
              `  First seen:        ${history[history.length - 1]?.startTime}`,
              `  Last seen:         ${history[0]?.startTime}`,
            ].join('\n'),
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}
