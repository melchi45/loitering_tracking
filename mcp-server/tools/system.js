import { z } from 'zod';

export function registerSystemTools(server, client) {
  // ── get_server_status ──────────────────────────────────────────────────────
  server.tool(
    'get_server_status',
    'Get the current LTS server status including health, server mode (combined/streaming/analysis), uptime, DB type, and active camera count. Use to diagnose connectivity or verify the server is operational.',
    {
      includeMetrics: z.boolean().optional().describe('Include CPU/memory/GPU metrics (default false — requires admin access)'),
    },
    async ({ includeMetrics = false }) => {
      try {
        const health = await client.get('/health');

        const lines = [
          `LTS-2026 Server Status`,
          `  Status      : ${health.status || 'ok'}`,
          `  Mode        : ${health.mode || health.serverMode || 'combined'}`,
          `  Version     : ${health.version || 'N/A'}`,
          `  Uptime      : ${health.uptime != null ? `${Math.floor(health.uptime)}s` : 'N/A'}`,
          `  DB Type     : ${health.dbType || health.storageMode || 'json'}`,
          `  Cameras     : ${health.cameras ?? 'N/A'}`,
          `  Active Pipes: ${health.activePipelines ?? health.runningCameras ?? 'N/A'}`,
          health.mediamtxRunning != null ? `  MediaMTX    : ${health.mediamtxRunning ? 'running' : 'stopped'}` : null,
          health.ingestDaemon != null    ? `  Ingest Daemon: ${health.ingestDaemon ? 'running' : 'stopped'}` : null,
        ].filter(Boolean).join('\n');

        if (!includeMetrics) {
          return { content: [{ type: 'text', text: lines }] };
        }

        let metricsText = '';
        try {
          const metrics = await client.get('/admin/system');
          const cpu = metrics.cpu;
          const mem = metrics.memory;
          metricsText = [
            '',
            'System Metrics:',
            cpu  ? `  CPU Usage   : ${cpu.usage ?? 'N/A'}%` : null,
            mem  ? `  Memory RSS  : ${Math.round((mem.rss || 0) / 1024 / 1024)}MB` : null,
            mem  ? `  Heap Used   : ${Math.round((mem.heapUsed || 0) / 1024 / 1024)}MB` : null,
            metrics.gpu ? `  GPU         : ${JSON.stringify(metrics.gpu)}` : null,
          ].filter(Boolean).join('\n');
        } catch {
          metricsText = '\n(Metrics unavailable — admin access required)';
        }

        return { content: [{ type: 'text', text: lines + metricsText }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error fetching server status: ${err.message}` }], isError: true };
      }
    }
  );
}
