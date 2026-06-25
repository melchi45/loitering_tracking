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

  // ── add_camera ─────────────────────────────────────────────────────────────
  server.tool(
    'add_camera',
    'Add a new camera channel to the LTS system. Supports RTSP/ONVIF IP cameras and YouTube streams. The camera is registered in the database and its AI pipeline is started automatically.',
    {
      name:       z.string().min(1).describe('Display name for the camera'),
      url:        z.string().min(1).describe('RTSP URL (rtsp://...) or YouTube URL (https://youtube.com/...)'),
      type:       z.enum(['rtsp', 'youtube', 'webrtc']).optional().describe('Stream type (default rtsp)'),
      aiEnabled:  z.boolean().optional().describe('Enable AI inference on this camera (default true)'),
      username:   z.string().optional().describe('RTSP authentication username'),
      password:   z.string().optional().describe('RTSP authentication password (stored in DB, not logged)'),
      location:   z.string().optional().describe('Physical location description (e.g. "Entrance A - Floor 1")'),
    },
    async ({ name, url, type = 'rtsp', aiEnabled = true, username, password, location }) => {
      try {
        const body = { name, url, type, aiEnabled };
        if (username) body.username = username;
        if (password) body.password = password;
        if (location) body.location = location;

        const { data: cam } = await client.post('/api/cameras', body);

        return {
          content: [{
            type: 'text',
            text: [
              `Camera added successfully.`,
              `  ID       : ${cam.id}`,
              `  Name     : ${cam.name}`,
              `  URL      : ${cam.url?.replace(/:[^:@]*@/, ':***@') || url}`,
              `  Type     : ${cam.type || type}`,
              `  AI       : ${cam.aiEnabled ? 'enabled' : 'disabled'}`,
              cam.location ? `  Location : ${cam.location}` : null,
            ].filter(Boolean).join('\n'),
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error adding camera: ${err.message}` }], isError: true };
      }
    }
  );

  // ── update_camera ──────────────────────────────────────────────────────────
  server.tool(
    'update_camera',
    'Update an existing camera channel configuration (name, URL, AI enabled, location). Only the provided fields are changed.',
    {
      cameraId:  z.string().describe('Camera ID to update'),
      name:      z.string().optional().describe('New display name'),
      url:       z.string().optional().describe('New RTSP/YouTube URL'),
      aiEnabled: z.boolean().optional().describe('Enable or disable AI inference'),
      location:  z.string().optional().describe('Physical location description'),
    },
    async ({ cameraId, name, url, aiEnabled, location }) => {
      try {
        const body = {};
        if (name      !== undefined) body.name      = name;
        if (url       !== undefined) body.url        = url;
        if (aiEnabled !== undefined) body.aiEnabled  = aiEnabled;
        if (location  !== undefined) body.location   = location;

        if (Object.keys(body).length === 0) {
          return { content: [{ type: 'text', text: 'No fields to update. Provide at least one field.' }] };
        }

        const { data: cam } = await client.put(`/api/cameras/${cameraId}`, body);

        return {
          content: [{
            type: 'text',
            text: `Camera ${cameraId} updated.\n  Name: ${cam?.name || name || '—'}\n  AI: ${cam?.aiEnabled ?? aiEnabled ?? '—'}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error updating camera: ${err.message}` }], isError: true };
      }
    }
  );

  // ── delete_camera ──────────────────────────────────────────────────────────
  server.tool(
    'delete_camera',
    'Remove a camera channel from the LTS system. Stops the AI pipeline and deletes the camera record and its zones. This action is irreversible — confirm the camera ID before calling.',
    {
      cameraId: z.string().describe('Camera ID to delete'),
    },
    async ({ cameraId }) => {
      try {
        await client.delete(`/api/cameras/${cameraId}`);
        return {
          content: [{ type: 'text', text: `Camera ${cameraId} deleted successfully. Pipeline stopped and record removed.` }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error deleting camera: ${err.message}` }], isError: true };
      }
    }
  );

  // ── toggle_camera_ai ───────────────────────────────────────────────────────
  server.tool(
    'toggle_camera_ai',
    'Enable or disable the AI inference pipeline for a specific camera without stopping the video stream. Use to reduce GPU load or temporarily pause detections.',
    {
      cameraId: z.string().describe('Camera ID'),
      enabled:  z.boolean().describe('true to enable AI, false to disable'),
    },
    async ({ cameraId, enabled }) => {
      try {
        const { data } = await client.post(`/api/cameras/${cameraId}/ai/toggle`, { enabled });
        const state = data?.aiEnabled ?? enabled;
        return {
          content: [{ type: 'text', text: `Camera ${cameraId} AI inference ${state ? 'enabled' : 'disabled'}.` }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error toggling AI: ${err.message}` }], isError: true };
      }
    }
  );
}
