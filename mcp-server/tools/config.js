import { z } from 'zod';

export function registerConfigTools(server, client) {
  // ── get_model_catalog ────────────────────────────────────────────────────────
  server.tool(
    'get_model_catalog',
    'Get the full AI model catalog: YOLO object-detection variants (YOLO26/YOLO12/YOLO11/YOLOv8 series) plus ' +
    'all other ONNX model families (face detection/recognition, PPE, fire & smoke, cloth-PAR, and the proposed ' +
    'human-parsing / appearance-reid families) — accuracy/speed benchmarks where available, download status, ' +
    'and which model is currently active per family. ' +
    'Only available in combined/analysis mode (analysisApi) — not exposed via the streaming-mode proxy.',
    {},
    async () => {
      try {
        const { activeFile, catalog = [] } = await client.get('/api/analysis/models');

        if (catalog.length === 0) {
          return { content: [{ type: 'text', text: 'No models registered in the catalog.' }] };
        }

        const lines = catalog.map(m => {
          const status = m.active
            ? 'ACTIVE'
            : m.downloading
              ? `downloading${m.downloadPercent != null ? ` ${m.downloadPercent}%` : ''}${m.converting ? ' (converting)' : ''}`
              : m.exists ? 'downloaded'
              : m.manualOnly ? 'manual export required' : 'not downloaded';
          const benchmark = m.mAP != null
            ? `    mAP=${m.mAP}  size=${m.size}px  CPU=${m.cpuMs}ms  T4=${m.t4Ms}ms  params=${m.params}  flops=${m.flops}`
            : null;
          return [
            `${m.active ? '▶ ' : '  '}${m.label} (${m.id}, ${m.series}${m.family ? `, family=${m.family}` : ''})`,
            benchmark,
            `    status=${status}${m.sizeBytes ? `  fileSize=${Math.round(m.sizeBytes / 1024 / 1024)}MB` : ''}${m.downloadError ? `  error=${m.downloadError}` : ''}`,
          ].filter(Boolean).join('\n');
        });

        return {
          content: [{
            type: 'text',
            text: `Active YOLO detector file: ${activeFile || 'none'}\n\n${lines.join('\n\n')}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ── get_fire_smoke_config ────────────────────────────────────────────────────
  server.tool(
    'get_fire_smoke_config',
    'Get the current fire/smoke detection confidence and NMS thresholds. ' +
    'Only available in combined/analysis mode — not exposed via the streaming-mode proxy.',
    {},
    async () => {
      try {
        const { confThreshold, nmsThreshold, available } = await client.get('/api/analysis/config/fire-smoke');

        if (!available) {
          return { content: [{ type: 'text', text: 'FireSmokeService is not loaded on this server.' }] };
        }

        return {
          content: [{
            type: 'text',
            text: [
              'Fire/Smoke detection config:',
              `  confThreshold: ${confThreshold}`,
              `  nmsThreshold:  ${nmsThreshold}`,
            ].join('\n'),
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ── get_tracker_config ───────────────────────────────────────────────────────
  server.tool(
    'get_tracker_config',
    'Get the current ByteTrack/Kalman-filter tracker parameters (track lifecycle, IoU threshold, ' +
    'adaptive process noise scales, multi-cue association weights). Useful for diagnosing ID switches ' +
    'or track loss before adjusting thresholds.',
    {
      key: z.string().optional().describe('Return only this single config key (e.g. "iouThreshold")'),
    },
    async ({ key }) => {
      try {
        const { data } = await client.get('/api/tracker/config');

        if (!data) {
          return { content: [{ type: 'text', text: 'Tracker config API returned no data.' }], isError: true };
        }

        if (key) {
          if (!(key in data)) {
            return { content: [{ type: 'text', text: `Unknown tracker config key: ${key}` }] };
          }
          return { content: [{ type: 'text', text: `${key} = ${data[key]}` }] };
        }

        const lines = Object.entries(data).map(([k, v]) => `  ${k}: ${v}`);
        return { content: [{ type: 'text', text: `Tracker config:\n${lines.join('\n')}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}
