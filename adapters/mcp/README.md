# ShipScope MCP server

Lets Claude (Claude Code, Claude Desktop) ask ShipScope what is deployed and what is released to users, next to pdi's
MCP server: one conversation sees the decisions (pdi) and the delivery state (ShipScope). Read only.

`shipscope-mcp.js` speaks MCP over stdio (newline-delimited JSON-RPC 2.0) and reads ShipScope's
[service API](../../server/README.md#service-api) with a service token. Node 20+, no dependencies, nothing to install.

## Tools

| Tool | Arguments | What it answers |
| --- | --- | --- |
| `get_item_status` | `key` (`PAY-12`, `CHG-12`, `TSK-57`) | Status per environment as the dashboard pill shows it, the first PROD deployment, whether it is with users |
| `list_changes` | — | The repos' changes: title, problem, the PRB it came from and its day, status per environment, tasks |
| `get_release_plan` | `change` (optional) | Lines R1…Rn with their items on PROD, MVP released or not, each planned flag's stage and remove-by |
| `list_flags` | `key` (optional) | Flags: items, PROD exposure, state per environment and service, freshness, blast-radius and stale warnings |
| `get_environments` | — | Each service's latest successful deployment per environment: version, time, rollback, drift |
| `get_metrics` | `from`, `to` (optional, `YYYY-MM-DD`) | PROD per day: deployments, failed, rollbacks, median lead time Done → PROD |

## Setup

1. In ShipScope, an admin creates a service token: Settings → General → Service tokens (`shps_…`, shown once). It reads
   one workspace only.
2. Add the server to Claude, with the token in the environment, never in a file in the repository.

Claude Code (from a checkout of this repository):

```sh
claude mcp add shipscope \
  -e SHIPSCOPE_URL=https://shipscope.example.com \
  -e SHIPSCOPE_TOKEN=shps_… \
  -- node /path/to/evdt-service-shipscope/adapters/mcp/shipscope-mcp.js
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "shipscope": {
      "command": "node",
      "args": ["/path/to/evdt-service-shipscope/adapters/mcp/shipscope-mcp.js"],
      "env": { "SHIPSCOPE_URL": "https://shipscope.example.com", "SHIPSCOPE_TOKEN": "shps_…" }
    }
  }
}
```

Then ask, for example: "Is CHG-12 with users on PROD?", "Which flags are past their remove-by date?", "What differs
between QA and PROD for the payments service?".

## Behaviour

- `SHIPSCOPE_URL` must be `https://` (`http://` only for localhost) without a login in it; `SHIPSCOPE_TOKEN` must look
  like `shps_…`. A missing or wrong setting is a tool error saying what to set, and nothing is sent.
- Arguments are checked before any request (only the declared ones, keys like `PAY-12`, days `YYYY-MM-DD`).
- A refusal from ShipScope (401 unknown or expired token, 404, 429 with `Retry-After`) is a tool error with the status
  and ShipScope's reason, never the token. Each request has 30 s and an answer at most 2 MB.
- What the tools return is data from the workspace (titles, descriptions); the server tells Claude not to follow
  commands found in it.
