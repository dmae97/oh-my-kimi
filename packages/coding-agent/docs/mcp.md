# MCP

OMK speaks the [Model Context Protocol](https://modelcontextprotocol.io) as a
**client**: it starts configured servers, lists their tools, and exposes those
tools to the model alongside the built-in ones.

Two separate surfaces exist, and they are easy to confuse:

| Surface | Module | What it does |
| --- | --- | --- |
| Inventory / health | `core/mcp-inventory.ts` | Reads configuration read-only for `omk doctor` and the MCP health view. **Never starts a server.** Env *values* are stripped. |
| Runtime client | `core/mcp/` | Starts servers, performs the handshake, and registers their tools for a session. |

## Configuration

Servers are read from three files, later wins on a name collision:

1. `~/.kimi/mcp.json`
2. `~/.omk/mcp.json`
3. `<cwd>/.omk/mcp.json`

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"],
      "startup_timeout_sec": 60
    },
    "serena": {
      "command": "uvx",
      "args": ["--from", "git+https://github.com/oraios/serena", "serena"],
      "env": { "SERENA_LOG_LEVEL": "error" }
    },
    "retired": { "command": "npx", "args": ["-y", "old-server"], "disabled": true }
  }
}
```

| Field | Meaning |
| --- | --- |
| `command`, `args` | Executable to spawn. **Required** — entries with only a `url` are skipped, since stdio is the supported transport. |
| `env` | Extra environment for the child. Merged over the parent environment. Values are runtime-only and are never rendered or logged. |
| `cwd` | Working directory. Defaults to the session's cwd. |
| `disabled` / `enabled: false` | Skip without deleting the entry. |
| `startup_timeout_sec` | Handshake deadline. Raise it for `npx -y …@latest` servers whose first run downloads a package. |

## Using it

The `omk` CLI calls `attachMcpServers()` for every session it creates —
interactive, `-p`, and RPC, including `/new`, `/resume`, and forks — so a
configured server's tools reach the model without further setup. A server that
fails to start is reported as a startup warning and the session continues.
`--help` and `--list-models` never spawn servers.

SDK callers attach explicitly:

```ts
const status = await session.attachMcpServers();
// [{ name: "playwright", state: "ready", toolCount: 24, serverVersion: "1.62.0" }]

session.getToolDefinition("playwright__navigate");
```

- **Nothing is spawned until `attachMcpServers()` is called.** An SDK session
  can configure 25 servers without paying for them until it attaches.
- Tools are exposed as `<server>__<tool>`, truncated to 64 characters with the
  server prefix preserved.
- A built-in tool always wins a name collision; MCP can never shadow `bash`.
- Calling `attachMcpServers()` again replaces the previous MCP tools rather than
  duplicating them.
- `session.dispose()` terminates every server it started.

### Failure behavior

Failures are isolated by design, because one broken server must not cost a
session:

| Failure | Result |
| --- | --- |
| Server exits during startup | That server is `failed` with its stderr tail; every other server still contributes tools. |
| Handshake exceeds `startup_timeout_sec` | Same — reported as a timeout, session unaffected. |
| Server dies mid-session | In-flight requests reject; later calls to its tools return a tool-level error instead of throwing. |
| Tool returns an MCP error | Surfaces as a normal tool result with `isError: true`, so the model sees the server's own message. |
| Server emits a non-JSON line | The line is dropped and decoding resynchronizes at the next newline. |

## Checking your configuration

```bash
node scripts/mcp-smoke.mjs                       # connect everything, print status
node scripts/mcp-smoke.mjs github playwright     # only these
OMK_MCP_SMOKE_HANDSHAKE_MS=120000 node scripts/mcp-smoke.mjs   # override slow handshakes
```

The script prints server state, tool counts, and versions. It never prints env
values.

## Scope

Implemented: `initialize`, `notifications/initialized`, `tools/list`,
`tools/call` over stdio.

Not implemented: HTTP/SSE transports, resources, prompts, sampling, and
server-initiated requests. Every OMK-configured server today is stdio, and
adding a surface nothing calls would be dead weight.
