import { z } from 'zod';

export function registerCameraTools(server, client) {
  server.tool(
    'get_camera_status',
    'Get the current status of cameras: pipeline running state, AI inference enabled, stream type, and any error messages.',
    {
      cameraId: z.string().optional().describe('Specific camera ID (omit for all cameras)'),
    },
    async ({ cameraId }) => {
      try {
        const { data: cameras = [] } = await client.get('/api/cameras');
        const results = cameraId ? cameras.filter(c => c.id === cameraId) : cameras;

        if (results.length === 0) {
          return { content: [{ type: 'text', text: cameraId ? `Camera not found: ${cameraId}` : 'No cameras configured.' }] };
        }

        const lines = results.map(c => {
          const running = c.pipelineStatus?.running;
          const status  = running ? '🟢 Running' : '🔴 Stopped';
          return [
            `Camera: ${c.name || c.id}`,
            `  ID:         ${c.id}`,
            `  Type:       ${c.type || 'rtsp'}`,
            `  URL:        ${c.url || 'N/A'}`,
            `  Status:     ${status}`,
            `  AI Enabled: ${c.aiEnabled ? 'Yes' : 'No'}`,
            c.pipelineStatus?.error ? `  Error:      ${c.pipelineStatus.error}` : null,
          ].filter(Boolean).join('\n');
        });

        const runningCount = results.filter(c => c.pipelineStatus?.running).length;
        return {
          content: [{
            type: 'text',
            text: `Cameras: ${runningCount}/${results.length} running\n\n${lines.join('\n\n')}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_zone_config',
    'Get the monitoring zone configuration for a camera: polygon boundary, dwell threshold, target object classes, and schedule.',
    {
      cameraId: z.string().describe('Camera ID to retrieve zones for'),
    },
    async ({ cameraId }) => {
      try {
        const { data: zones = [] } = await client.get(`/api/cameras/${cameraId}/zones`);

        if (zones.length === 0) {
          return { content: [{ type: 'text', text: `No zones configured for camera: ${cameraId}` }] };
        }

        const lines = zones.map(z =>
          [
            `Zone: ${z.name} (${z.id})`,
            `  Type:           ${z.type || 'MONITOR'}`,
            `  Dwell Threshold:${z.dwellThreshold || 30}s`,
            `  Polygon:        ${z.polygon?.length || 0} vertices`,
            `  Target Classes: ${(z.targetClasses || ['human']).join(', ')}`,
            z.reentryWindow ? `  Re-entry Window: ${z.reentryWindow}s` : null,
            z.schedule ? `  Schedule:       ${JSON.stringify(z.schedule)}` : null,
          ].filter(Boolean).join('\n')
        );

        return {
          content: [{ type: 'text', text: `${zones.length} zone(s) for camera ${cameraId}:\n\n${lines.join('\n\n')}` }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'update_zone_threshold',
    'Update the dwell time threshold (in seconds) for a specific monitoring zone. Use to reduce false positives (increase) or improve sensitivity (decrease). Valid range: 5–3600 seconds.',
    {
      cameraId:       z.string().describe('Camera ID'),
      zoneId:         z.string().describe('Zone ID to update'),
      dwellThreshold: z.number().int().min(5).max(3600).describe('New dwell threshold in seconds (5–3600)'),
    },
    async ({ cameraId, zoneId, dwellThreshold }) => {
      try {
        const { data } = await client.put(
          `/api/cameras/${cameraId}/zones/${zoneId}`,
          { dwellThreshold }
        );
        return {
          content: [{
            type: 'text',
            text: `Zone "${data?.name || zoneId}" threshold updated to ${dwellThreshold}s.`,
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}
