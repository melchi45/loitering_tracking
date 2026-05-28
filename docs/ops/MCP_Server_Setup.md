# Operations Guide
# MCP Server Setup

| | |
|---|---|
| **Document Reference** | OPS-LTS2026-MCP-001 |
| **Document Type** | Operations Guide |
| **Parent System** | LTS-2026-001 Loitering Detection & Tracking System |
| **Issue Date** | 2026-05-28 |
| **Status** | **✅ Active — stdio and HTTP/SSE modes operational** |
| **Repository** | [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking) |

---

The LTS MCP Server exposes Tools and Resources so that MCP-compatible LLMs (Claude Code, Claude API, OpenAI Agents, etc.) can interact with the system in natural language.

> **Prerequisite:** The LTS backend server must be running on `localhost:3001` before starting the MCP server.

## Installation

```bash
cd mcp-server && npm install
```

## stdio mode — Claude Code / Claude API (default)

```bash
cd mcp-server

# Start
npm start
# or
node index.js

# Development mode (auto-restart on file change)
npm run dev
```

Reads from stdin and writes to stdout.  
Claude Code launches it automatically based on `.claude/settings.json`.

## HTTP/SSE mode — OpenAI Agents / ChatGPT Actions

```bash
cd mcp-server

# Start on default port (3002)
npm run start:http
# or
TRANSPORT=http node index.js

# Custom port and auth token
TRANSPORT=http MCP_PORT=3002 MCP_AUTH_TOKEN=my-secret-token node index.js

# Development mode (file watch)
npm run dev:http
```

HTTP/SSE endpoints:

| Path | Description |
|---|---|
| `GET /sse` | Open SSE stream |
| `POST /message?sessionId=XXX` | Send JSON-RPC message |
| `GET /schema` | Tool and resource catalogue (JSON) |
| `GET /health` | Server health check (`{ "status": "ok" }`) |

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `LTS_BASE_URL` | `http://localhost:3001` | LTS REST API base URL |
| `TRANSPORT` | `stdio` | Transport mode: `stdio` or `http` |
| `MCP_PORT` | `3002` | HTTP/SSE listen port |
| `MCP_AUTH_TOKEN` | _(none)_ | Bearer token for HTTP transport (optional) |

## Manual Registration in Claude Code

Add the following to `.claude/settings.json`:

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

After registration, verify with:
> "Are there any cameras currently running?"

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — extracted from README.md §15.5 |
