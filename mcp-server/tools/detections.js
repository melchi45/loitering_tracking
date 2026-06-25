import { z } from 'zod';

export function registerDetectionTools(server, client) {
  // ── query_analysis_events ──────────────────────────────────────────────────
  server.tool(
    'query_analysis_events',
    'Query AI analysis events (loitering, fire detection, smoke detection) stored in the LTS database. Each event includes the detection type, camera, confidence, and timestamp. Ask this to understand what AI-detected incidents occurred.',
    {
      cameraId: z.string().optional().describe('Filter by camera ID'),
      type:     z.enum(['loitering', 'fire', 'smoke', 'all']).optional().describe('Event type filter (default all)'),
      from:     z.string().optional().describe('ISO8601 start time'),
      to:       z.string().optional().describe('ISO8601 end time'),
      limit:    z.number().int().min(1).max(500).optional().describe('Max results (default 50)'),
    },
    async ({ cameraId, type = 'all', from, to, limit = 50 }) => {
      try {
        const params = { limit };
        if (cameraId)           params.cameraId = cameraId;
        if (type !== 'all')     params.type     = type;
        if (from)               params.from     = from;
        if (to)                 params.to       = to;

        const { events = [], total } = await client.get('/api/analysis/events', params);

        if (events.length === 0) {
          return { content: [{ type: 'text', text: 'No analysis events found for the given filters.' }] };
        }

        // Group counts by type for summary
        const counts = {};
        for (const e of events) { counts[e.type || 'unknown'] = (counts[e.type || 'unknown'] || 0) + 1; }
        const summary = Object.entries(counts).map(([t, n]) => `${t}:${n}`).join(', ');

        const lines = events.map(e => {
          const ts   = e.timestamp || e.serverTs || '';
          const time = ts ? new Date(ts).toISOString() : 'N/A';
          return [
            `[${time}] ${(e.type || 'unknown').toUpperCase()} — camera: ${e.cameraId || 'N/A'}`,
            `  Confidence: ${e.confidence != null ? `${(e.confidence * 100).toFixed(1)}%` : 'N/A'}`,
            e.objectId ? `  Object ID : ${e.objectId}` : null,
            e.zoneId   ? `  Zone      : ${e.zoneName || e.zoneId}` : null,
            e.dwellTime != null ? `  Dwell Time: ${e.dwellTime}s` : null,
          ].filter(Boolean).join('\n');
        });

        const header = `Analysis Events: ${events.length}${total != null ? ` of ${total}` : ''} (${summary})\n`;
        return { content: [{ type: 'text', text: header + lines.join('\n\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ── get_detection_tracks ───────────────────────────────────────────────────
  server.tool(
    'get_detection_tracks',
    'Get object detection track history — each track represents one continuous sighting of an object (person, vehicle, etc.) across frames. Includes dwell time, bounding box trajectory, and class. Useful for behavior analysis and loitering investigation.',
    {
      cameraId:   z.string().optional().describe('Filter by camera ID'),
      objectClass: z.string().optional().describe('Filter by object class (e.g. person, car, bicycle)'),
      from:       z.string().optional().describe('ISO8601 start time'),
      to:         z.string().optional().describe('ISO8601 end time'),
      limit:      z.number().int().min(1).max(200).optional().describe('Max results (default 30)'),
      inProgressOnly: z.boolean().optional().describe('Only return tracks still in progress (not yet ended)'),
    },
    async ({ cameraId, objectClass, from, to, limit = 30, inProgressOnly }) => {
      try {
        const params = { limit };
        if (cameraId)     params.cameraId = cameraId;
        if (objectClass)  params.class    = objectClass;
        if (from)         params.from     = from;
        if (to)           params.to       = to;

        const { tracks = [], total } = await client.get('/api/analysis/detection-tracks', params);

        let results = tracks;
        if (inProgressOnly) results = results.filter(t => t.inProgress);

        if (results.length === 0) {
          return { content: [{ type: 'text', text: 'No detection tracks found.' }] };
        }

        const lines = results.map(t => {
          const start = t.firstSeen ? new Date(t.firstSeen).toISOString() : 'N/A';
          const end   = t.lastSeen  ? new Date(t.lastSeen).toISOString()  : t.inProgress ? '(ongoing)' : 'N/A';
          const dwell = t.dwellTime != null ? `${t.dwellTime.toFixed(1)}s` : 'N/A';
          return [
            `Track ${t.objectId || t.id} — ${t.class || 'unknown'}${t.inProgress ? ' [ACTIVE]' : ''}`,
            `  Camera   : ${t.cameraId || 'N/A'}`,
            `  First    : ${start}`,
            `  Last     : ${end}`,
            `  Dwell    : ${dwell}`,
            t.confidence != null ? `  Conf     : ${(t.confidence * 100).toFixed(1)}%` : null,
          ].filter(Boolean).join('\n');
        });

        const header = `Detection Tracks: ${results.length}${total != null ? ` of ${total}` : ''}\n`;
        return { content: [{ type: 'text', text: header + lines.join('\n\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ── get_analysis_metrics ───────────────────────────────────────────────────
  server.tool(
    'get_analysis_metrics',
    'Get the AI analysis server dashboard metrics: inference throughput (FPS), model info, queue depth, GPU utilization, detection counts by class, and pipeline health. Use to assess AI pipeline performance.',
    {},
    async () => {
      try {
        const metrics = await client.get('/api/analysis/metrics');

        const lines = [
          'AI Analysis Metrics',
          `  Status        : ${metrics.status || 'N/A'}`,
          `  Mode          : ${metrics.mode || 'N/A'}`,
          metrics.fps             != null ? `  Throughput    : ${metrics.fps} FPS` : null,
          metrics.queueDepth      != null ? `  Queue Depth   : ${metrics.queueDepth}` : null,
          metrics.gpuUtil         != null ? `  GPU Util      : ${metrics.gpuUtil}%` : null,
          metrics.modelName               ? `  Model         : ${metrics.modelName}` : null,
          metrics.totalDetections != null ? `  Total Detected: ${metrics.totalDetections}` : null,
        ];

        if (metrics.detectionsByClass && typeof metrics.detectionsByClass === 'object') {
          lines.push('  By Class:');
          for (const [cls, cnt] of Object.entries(metrics.detectionsByClass)) {
            lines.push(`    ${cls}: ${cnt}`);
          }
        }

        if (metrics.cameras && Array.isArray(metrics.cameras)) {
          lines.push(`  Active Pipelines: ${metrics.cameras.filter(c => c.running).length}/${metrics.cameras.length}`);
        }

        return {
          content: [{ type: 'text', text: lines.filter(Boolean).join('\n') }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}
