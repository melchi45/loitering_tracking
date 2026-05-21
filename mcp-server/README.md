# LTS MCP Server

Model Context Protocol server for the **LTS-2026 Loitering Tracking System**.  
Exposes detection events, alerts, camera status, and analytics as MCP tools and resources so that any MCP-compatible LLM (Claude, OpenAI Agents) can query the system in natural language.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│              MCP Client Layer                            │
│  Claude Code  │  Claude API  │  OpenAI Agents  │  GPT  │
└───────────────────────────┬─────────────────────────────┘
                            │  MCP Protocol
                            │  stdio  /  HTTP + SSE
┌───────────────────────────▼─────────────────────────────┐
│            lts-mcp-server  (this package)               │
│                                                          │
│  Tools (10)              Resources (4)                   │
│  · query_loitering_events  · lts://cameras              │
│  · get_tracking_history    · lts://alerts/active        │
│  · get_active_alerts       · lts://zones/{cameraId}     │
│  · explain_alert           · lts://system/summary       │
│  · acknowledge_alert                                     │
│  · get_camera_status                                     │
│  · get_zone_config                                       │
│  · update_zone_threshold                                 │
│  · get_analytics_summary                                 │
│  · generate_security_report                              │
└───────────────────────────┬─────────────────────────────┘
                            │  HTTP REST
┌───────────────────────────▼─────────────────────────────┐
│          LTS-2026 Express API  (localhost:3001)          │
└─────────────────────────────────────────────────────────┘
```

---

## Prerequisites

| Requirement | Version |
|---|---|
| Node.js | ≥ 20 (ESM) |
| LTS-2026 backend | Running on `http://localhost:3001` |

---

## Installation

```bash
cd mcp-server
npm install
```

---

## Running

### stdio mode — Claude Code / Claude API (default)

```bash
node index.js
# or
npm start
```

The server reads from stdin and writes to stdout. Launched automatically by Claude Code via `.claude/settings.json`.

### HTTP/SSE mode — OpenAI Agents / ChatGPT Actions

```bash
TRANSPORT=http node index.js
# or
npm run start:http
```

Starts an Express server on port 3002 (configurable via `MCP_PORT`).

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `LTS_BASE_URL` | `http://localhost:3001` | LTS REST API base URL |
| `TRANSPORT` | `stdio` | Transport mode: `stdio` or `http` |
| `MCP_PORT` | `3002` | HTTP/SSE listen port |
| `MCP_AUTH_TOKEN` | _(empty)_ | Bearer token for HTTP transport (optional) |

---

## Claude Code Integration

Already configured in `.claude/settings.json`. The MCP server starts automatically when Claude Code launches.

To verify the connection, ask Claude:
> "What cameras are currently running?"

### Manual setup (if needed)

Add to `.claude/settings.json`:

```json
{
  "mcpServers": {
    "lts": {
      "command": "node",
      "args": ["mcp-server/index.js"],
      "env": { "LTS_BASE_URL": "http://localhost:3001" }
    }
  }
}
```

---

## VS Code Integration

Already configured in `.vscode/mcp.json`. The `lts` server is registered for Copilot/extension compatibility.

---

## OpenAI Agents Integration

Start the HTTP/SSE server:

```bash
TRANSPORT=http MCP_PORT=3002 node index.js
```

Connect with the OpenAI Agents SDK:

```python
from openai.agents import MCPServerSse

lts_server = MCPServerSse(
    name="lts",
    params={"url": "http://localhost:3002/sse"},
)
```

With Bearer auth:

```bash
TRANSPORT=http MCP_AUTH_TOKEN=my-secret-token node index.js
```

```python
lts_server = MCPServerSse(
    name="lts",
    params={
        "url": "http://localhost:3002/sse",
        "headers": {"Authorization": "Bearer my-secret-token"},
    },
)
```

### Schema endpoint

`GET http://localhost:3002/schema` returns a JSON catalog of all tools and resources, useful for manual GPT Action registration.

### Health check

`GET http://localhost:3002/health` returns `{ "status": "ok" }`.

---

## HTTP/SSE Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/sse` | Establish SSE stream (one session per connection) |
| `POST` | `/message?sessionId=XXX` | Send JSON-RPC message to an active session |
| `GET` | `/schema` | Tool and resource catalog (JSON) |
| `GET` | `/health` | Liveness probe |

---

## Tools Reference

| Tool | Access | Description |
|---|---|---|
| `query_loitering_events` | read | Query events with time / camera / dwell filters |
| `get_tracking_history` | read | Full appearance history for a tracked object |
| `get_active_alerts` | read | Unacknowledged alerts sorted by recency |
| `explain_alert` | read | Risk assessment + zone config + object history for one alert |
| `acknowledge_alert` | **write** | Mark an alert as reviewed |
| `get_camera_status` | read | Pipeline status and AI-enabled flag per camera |
| `get_zone_config` | read | Zone polygon, threshold, and schedule |
| `update_zone_threshold` | **write** | Change dwell time threshold (5–3600 s) |
| `get_analytics_summary` | read | Event counts, dwell stats, peak hour, alert rates |
| `generate_security_report` | read | Full markdown shift report |

---

## Resources Reference

| URI | Description |
|---|---|
| `lts://cameras` | All cameras with pipeline status (JSON) |
| `lts://alerts/active` | Current unacknowledged alerts (JSON) |
| `lts://zones/{cameraId}` | Zone config for a specific camera (JSON) |
| `lts://system/summary` | Aggregated system health snapshot (JSON) |

---

## Running Tests

```bash
npm test
```

Uses Node.js built-in test runner (`node:test`). No additional dependencies required.  
All 34 tests should pass.

---

## Project Structure

```
mcp-server/
├── index.js            # Entry point — transport selection (stdio / HTTP)
├── create-server.js    # McpServer factory + static tool/resource catalog
├── lts-client.js       # HTTP fetch wrapper for the LTS REST API
├── resources.js        # MCP resource handlers (lts://*)
├── package.json
├── SYSTEM_PROMPT.md    # Recommended LLM system prompt fragments
└── tools/
    ├── loitering.js    # query_loitering_events, get_tracking_history
    ├── alerts.js       # get_active_alerts, explain_alert, acknowledge_alert
    ├── cameras.js      # get_camera_status, get_zone_config, update_zone_threshold
    └── analytics.js    # get_analytics_summary, generate_security_report
```

---

## Security Notes

- stdio transport has no authentication (process isolation is the security boundary).
- HTTP transport supports optional Bearer token via `MCP_AUTH_TOKEN`.
- Write operations are limited to `acknowledge_alert` and `update_zone_threshold`.
- All tool inputs are validated via Zod schemas before reaching the LTS API.
- Never commit tokens or API keys; use environment variables exclusively.
