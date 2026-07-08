import { z } from 'zod';

export function registerSearchTools(server, client) {
  server.tool(
    'search_all',
    'Unified full-text search across alerts, detection snapshots, face gallery entries, events, and ' +
    'cross-camera face-match history in a single call. Use this instead of chaining query_analysis_events ' +
    '+ get_active_alerts + get_object_snapshots when the user gives a free-text description ' +
    '(e.g. "find anything about the red jacket near the entrance").',
    {
      q:             z.string().min(1).describe('Free-text search query (required)'),
      types:         z.string().optional().describe('Comma-separated result types to include: alerts,detections,faces,events,matches (default: alerts,detections,faces,events)'),
      from:          z.string().optional().describe('ISO 8601 start time filter'),
      to:            z.string().optional().describe('ISO 8601 end time filter'),
      minConfidence: z.number().min(0).max(1).optional().describe('Minimum detection confidence (0.0–1.0)'),
      maxConfidence: z.number().min(0).max(1).optional().describe('Maximum detection confidence (0.0–1.0)'),
      limit:         z.number().int().min(1).max(200).optional().describe('Max results (default 30)'),
    },
    async ({ q, types, from, to, minConfidence, maxConfidence, limit = 30 }) => {
      try {
        const params = { q, limit };
        if (types)                        params.types = types;
        if (from)                         params.from = from;
        if (to)                           params.to = to;
        if (minConfidence !== undefined)  params.minConfidence = minConfidence;
        if (maxConfidence !== undefined)  params.maxConfidence = maxConfidence;

        const { total, results = [] } = await client.get('/api/search', params);

        if (results.length === 0) {
          return { content: [{ type: 'text', text: `No results found for "${q}".` }] };
        }

        const lines = results.map(r => {
          switch (r._type) {
            case 'detection':
              return `[detection] ${r.className} @ ${r.cameraName || r.cameraId} — ${r.timestamp}${r.isLoitering ? ' (loitering)' : ''}${r.zoneName ? ` — zone: ${r.zoneName}` : ''}`;
            case 'alert':
              return `[alert] ${r.type} @ ${r.cameraName || r.cameraId} — ${r.timestamp}${r.acknowledged ? ' (acknowledged)' : ' (OPEN)'}`;
            case 'face':
              return `[face] ${r.name} — gallery: ${r.galleryName || r.galleryId} (${r.galleryType})`;
            case 'event':
              return `[event] ${r.type} @ ${r.cameraName || r.cameraId} — ${r.timestamp}${r.zoneName ? ` — zone: ${r.zoneName}` : ''}`;
            case 'match':
              return `[match] ${r.identity || r.faceId} @ ${r.cameraId} — score ${r.matchScore} — ${r.timestamp}`;
            default:
              return `[${r._type}] ${r.id}`;
          }
        });

        return {
          content: [{
            type: 'text',
            text: `${total} result(s) for "${q}" (showing ${results.length}):\n\n${lines.join('\n')}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}
