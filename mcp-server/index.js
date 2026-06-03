import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport }   from '@modelcontextprotocol/sdk/server/sse.js';
import express                  from 'express';
import cors                     from 'cors';

import { createServer, TOOL_CATALOG, RESOURCE_CATALOG } from './create-server.js';

const BASE_URL        = process.env.LTS_BASE_URL    || 'http://localhost:3080';
const TRANSPORT       = process.env.TRANSPORT       || 'stdio';
const MCP_PORT        = parseInt(process.env.MCP_PORT || '3002', 10);
const MCP_AUTH_TOKEN  = process.env.MCP_AUTH_TOKEN  || '';
// Public base URL used in /schema — override when behind a reverse proxy or tunnel
const PUBLIC_BASE_URL = process.env.MCP_PUBLIC_URL  || `http://localhost:${MCP_PORT}`;

// ─── HTTP/SSE mode ────────────────────────────────────────────────────────────
if (TRANSPORT === 'http') {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Optional Bearer-token guard
  function requireAuth(req, res, next) {
    if (!MCP_AUTH_TOKEN) return next();
    const header = req.headers.authorization || '';
    if (header !== `Bearer ${MCP_AUTH_TOKEN}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  }

  // Map sessionId → SSEServerTransport for POST /message routing
  const sessions = new Map();

  // GET /sse — client opens SSE stream; a new McpServer is created per connection
  app.get('/sse', requireAuth, async (req, res) => {
    const server    = createServer(BASE_URL);
    const transport = new SSEServerTransport('/message', res);

    sessions.set(transport.sessionId, transport);
    transport.onclose = () => {
      sessions.delete(transport.sessionId);
      console.error(`[LTS MCP] SSE session closed — ${transport.sessionId}`);
    };

    console.error(`[LTS MCP] SSE session opened — ${transport.sessionId}`);
    await server.connect(transport);
  });

  // POST /message?sessionId=XXX — client sends JSON-RPC messages
  app.post('/message', requireAuth, async (req, res) => {
    const transport = sessions.get(req.query.sessionId);
    if (!transport) {
      return res.status(404).json({ error: 'Session not found' });
    }
    await transport.handlePostMessage(req, res);
  });

  // GET /schema — static tool/resource catalog for GPT Action registration
  app.get('/schema', (_req, res) => {
    res.json({
      name:      'lts-mcp-server',
      version:   '1.0.0',
      baseUrl:   PUBLIC_BASE_URL,
      sseUrl:    `${PUBLIC_BASE_URL}/sse`,
      tools:     TOOL_CATALOG,
      resources: RESOURCE_CATALOG,
    });
  });

  // GET /health — liveness probe
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', transport: 'http', ltsBaseUrl: BASE_URL });
  });

  app.listen(MCP_PORT, () => {
    console.error(`[LTS MCP] HTTP/SSE server listening on port ${MCP_PORT}`);
    console.error(`[LTS MCP] SSE endpoint  → http://localhost:${MCP_PORT}/sse`);
    console.error(`[LTS MCP] Schema        → http://localhost:${MCP_PORT}/schema`);
    console.error(`[LTS MCP] LTS API       → ${BASE_URL}`);
    if (MCP_AUTH_TOKEN) {
      console.error('[LTS MCP] Bearer auth  → enabled');
    }
  });

// ─── stdio mode (default — Claude Code / Claude API) ─────────────────────────
} else {
  const server    = createServer(BASE_URL);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[LTS MCP] stdio server running — connected to ${BASE_URL}`);
}
