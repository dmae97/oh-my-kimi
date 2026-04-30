# MCP runtime lifecycle

This document describes how MCP servers are discovered, connected, exposed as tools, refreshed, and torn down in the coding-agent runtime.

## Lifecycle at a glance

1. **SDK startup** calls `discoverAndLoadMCPTools()` (unless MCP is disabled).
2. **Discovery** (`loadAllMCPConfigs`) resolves MCP server configs from capability sources, filters disabled/project/Exa entries, and preserves source metadata.
3. **Manager connect phase** (`MCPManager.connectServers`) starts per-server connect + `tools/list` in parallel.
4. **Fast startup gate** waits up to 250ms, then may return:
   - fully loaded `MCPTool`s,
   - failures per server,
   - or cached `DeferredMCPTool`s for still-pending servers.
5. **SDK wiring** merges MCP tools into runtime tool registry for the session.
6. **Post-connect enrichment** best-effort loads resources, resource templates, prompts, and optional resource subscriptions.
7. **Live session** can refresh MCP tools via `/mcp` flows (`disconnectAll` + rediscover + `session.refreshMCPTools`) and can reconnect individual servers on transport close or `/mcp reconnect`.
8. **Teardown** happens when callers invoke `disconnectServer`/`disconnectAll`; manager also clears MCP tool/resource/prompt registrations for disconnected servers.

## Discovery and load phase

### Entry path from SDK

`createAgentSession()` in `src/sdk.ts` performs MCP startup when `enableMCP` is true (default):

- calls `discoverAndLoadMCPTools(cwd, { ... })`,
- passes `authStorage`, cache storage, and `mcp.enableProjectConfig` setting,
- always sets `filterExa: true`,
- logs per-server load/connect errors,
- stores returned manager in `toolSession.mcpManager` and session result.

If `enableMCP` is false, MCP discovery is skipped entirely.

### Config discovery and filtering

`loadAllMCPConfigs()` (`src/mcp/config.ts`) loads canonical MCP server items through capability discovery, then converts to legacy `MCPServerConfig`.

Filtering behavior:

- `enableProjectConfig: false` removes project-level entries (`_source.level === "project"`).
- `enabled: false` servers are skipped before connect attempts.
- Exa servers are filtered out by default and API keys are extracted for native Exa tool integration.

Result includes both `configs` and `sources` (metadata used later for provider labeling).

### Discovery-level failure behavior

`discoverAndLoadMCPTools()` distinguishes two failure classes:

- **Discovery hard failure** (exception from `manager.discoverAndConnect`, typically from config discovery): returns an empty tool set and one synthetic error `{ path: ".mcp.json", error }`.
- **Per-server runtime/connect failure**: manager returns partial success with `errors` map; other servers continue.

So startup does not fail the whole agent session when individual MCP servers fail.

## Manager state model

`MCPManager` tracks runtime lifecycle with separate registries:

- `#connections: Map<string, MCPServerConnection>` — fully connected servers.
- `#pendingConnections: Map<string, Promise<MCPServerConnection>>` — handshake in progress.
- `#pendingToolLoads: Map<string, Promise<{ connection, serverTools }>>` — connected but tools still loading.
- `#tools: CustomTool[]` — current MCP tool view exposed to callers.
- `#sources: Map<string, SourceMeta>` — provider/source metadata even before connect completes.
- `#pendingReconnections: Map<string, Promise<MCPServerConnection | null>>` — reconnects in progress after a dropped transport or explicit reconnect.
- `#serverConfigs: Map<string, MCPServerConfig>` — original unresolved configs preserved so reconnect can re-resolve credentials without leaking resolved tokens.

`getConnectionStatus(name)` derives status from these maps:

- `connected` if in `#connections`,
- `connecting` if pending connect, pending tool load, or pending reconnect,
- `disconnected` otherwise.

## Connection establishment and startup timing

## Per-server connect pipeline

For each discovered server in `connectServers()`:

1. store/update source metadata,
2. skip if already connected/pending/reconnecting,
3. validate transport fields (`validateServerConfig`),
4. resolve auth/shell substitutions (`#resolveAuthConfig`),
5. call `connectToServer(name, resolvedConfig)` with manager notification/request handlers,
6. wire HTTP OAuth refresh and transport `onClose` reconnect handling,
7. call `listTools(connection)`,
8. cache tool definitions (`MCPToolCache.set`) best-effort,
9. best-effort load resources, resource templates, prompts, and subscriptions after tools load.

`connectToServer()` behavior (`src/mcp/client.ts`):

- creates stdio or HTTP/SSE transport,
- performs MCP `initialize`,
- for HTTP/SSE, starts the optional background SSE listener before `notifications/initialized`,
- sends `notifications/initialized`,
- uses timeout (`config.timeout` or 30s default),
- closes transport on init failure.

### Fast startup gate + deferred fallback

`connectServers()` waits on a race between:

- all connect/tool-load tasks settled, and
- `STARTUP_TIMEOUT_MS = 250`.

After 250ms:

- fulfilled tasks become live `MCPTool`s,
- rejected tasks produce per-server errors,
- still-pending tasks:
  - use cached tool definitions if available (`MCPToolCache.get`) to create `DeferredMCPTool`s,
  - otherwise block until those pending tasks settle.

This is a hybrid startup model: fast return when cache is available, correctness wait when cache is not.

### Background completion behavior

Each pending `toolsPromise` also has a background continuation that eventually:

- replaces that server’s tool slice in manager state via `#replaceServerTools`,
- writes cache,
- logs late failures only after startup (`allowBackgroundLogging`).

## Tool exposure and live-session availability

### Startup registration

`discoverAndLoadMCPTools()` converts manager tools into `LoadedCustomTool[]` and decorates paths (`mcp:<server> via <providerName>` when known).

`createAgentSession()` then pushes these tools into `customTools`, which are wrapped and added to the runtime tool registry with names like `mcp__<server>_<tool>`.

### Tool calls

- `MCPTool` calls tools through an already connected `MCPServerConnection`.
- `DeferredMCPTool` waits for `waitForConnection(server)` before calling; this allows cached tools to exist before connection is ready.
- Both attempt a reconnect + single retry for retriable connection failures.

Both return structured tool output and convert remaining transport/tool errors into `MCP error: ...` tool content (abort remains abort).

## Refresh/reload paths (startup vs live reload)

### Initial startup path

- one-time discovery/load in `sdk.ts`,
- tools are registered in initial session tool registry.

### Interactive reload path

`/mcp reload` path (`src/modes/controllers/mcp-command-controller.ts`) does:

1. `mcpManager.disconnectAll()`,
2. `mcpManager.discoverAndConnect()`,
3. `session.refreshMCPTools(mcpManager.getTools())`.

`session.refreshMCPTools()` (`src/session/agent-session.ts`) removes all `mcp__` tools, re-wraps latest MCP tools, and re-activates tool set so MCP changes apply without restarting session.

There is also a follow-up path for late connections: after waiting for a specific server, if status becomes `connected`, it re-runs `session.refreshMCPTools(...)` so newly available tools are rebound in-session.

## Health, reconnect, and partial failure behavior

Current runtime behavior is connection-event driven:

- **No autonomous polling health monitor** in manager/client.
- **Automatic reconnect is wired to `transport.onClose`** for managed connections.
- Reconnect retries with backoff (`500`, `1000`, `2000`, `4000` ms), reloads tools, and notifies consumers on success.
- Tool calls that see retriable connection errors also attempt one reconnect + retry.
- Reconnect is also explicit via `/mcp reconnect <name>` or broader `/mcp reload`.

Operationally:

- one server failing does not remove tools from healthy servers,
- connect/list failures are isolated per server,
- stale tools may remain visible while reconnect is attempted; calls report MCP errors if recovery fails,
- tool cache, resource/prompt loading, subscriptions, and background updates are best-effort (warnings/errors logged, no hard stop).

## Teardown semantics

### Server-level teardown

`disconnectServer(name)`:

- removes pending entries, source metadata, saved config, resource refresh/subscription state,
- detaches `onClose` so explicit close does not trigger reconnect,
- closes transport if connected,
- filters manager tool state for names beginning with `mcp__${name}_`.

### Global teardown

`disconnectAll()`:

- detaches `onClose` for all active transports, then closes them with `Promise.allSettled`,
- clears pending maps, sources, saved configs, connections, subscriptions, resource refreshes, and manager tool list.

In current wiring, explicit teardown is used in MCP command flows (for reload/remove/disable). Startup stores the manager on the session; callers that need deterministic MCP shutdown should invoke manager disconnect methods.

## Failure modes and guarantees

| Scenario                                             | Behavior                                                                                                                  | Hard fail vs best-effort       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Discovery throws (capability/config load path)       | Loader returns empty tools + synthetic `.mcp.json` error                                                                  | Best-effort session startup    |
| Invalid server config                                | Server skipped with validation error entry                                                                                | Best-effort per server         |
| Connect timeout/init failure                         | Server error recorded; others continue                                                                                    | Best-effort per server         |
| `tools/list` still pending at startup with cache hit | Deferred tools returned immediately                                                                                       | Best-effort fast startup       |
| `tools/list` still pending at startup without cache  | Startup waits for pending to settle                                                                                       | Hard wait for correctness      |
| Late background tool-load failure                    | Logged after startup gate                                                                                                 | Best-effort logging            |
| Runtime dropped transport                            | Manager attempts reconnect; stale tools remain while reconnecting and future calls may retry once or fail with MCP errors | Best-effort automatic recovery |

## Public API surface

`src/mcp/index.ts` re-exports loader/manager/client APIs for external callers. `src/sdk.ts` exposes `discoverMCPServers()` as a convenience wrapper returning the same loader result shape.

## Implementation files

- [`src/mcp/loader.ts`](../packages/coding-agent/src/mcp/loader.ts) — loader facade, discovery error normalization, `LoadedCustomTool` conversion.
- [`src/mcp/manager.ts`](../packages/coding-agent/src/mcp/manager.ts) — lifecycle state registries, parallel connect/list flow, refresh/disconnect.
- [`src/mcp/client.ts`](../packages/coding-agent/src/mcp/client.ts) — transport setup, initialize handshake, list/call/disconnect.
- [`src/mcp/index.ts`](../packages/coding-agent/src/mcp/index.ts) — MCP module API exports.
- [`src/sdk.ts`](../packages/coding-agent/src/sdk.ts) — startup wiring into session/tool registry.
- [`src/mcp/config.ts`](../packages/coding-agent/src/mcp/config.ts) — config discovery/filtering/validation used by manager.
- [`src/mcp/tool-bridge.ts`](../packages/coding-agent/src/mcp/tool-bridge.ts) — `MCPTool` and `DeferredMCPTool` runtime behavior.
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts) — `refreshMCPTools` live rebinding.
- [`src/modes/controllers/mcp-command-controller.ts`](../packages/coding-agent/src/modes/controllers/mcp-command-controller.ts) — interactive reload/reconnect flows.
- [`src/task/executor.ts`](../packages/coding-agent/src/task/executor.ts) — subagent MCP proxying via parent manager connections.
