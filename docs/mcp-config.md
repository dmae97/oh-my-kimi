# MCP configuration in OMP

This guide explains how to add, edit, and validate MCP servers for the OMP coding agent.

Source of truth in code:

- Runtime config types: `packages/coding-agent/src/mcp/types.ts`
- Config writer: `packages/coding-agent/src/mcp/config-writer.ts`
- Loader + validation: `packages/coding-agent/src/mcp/config.ts`
- Standalone `mcp.json` discovery: `packages/coding-agent/src/discovery/mcp-json.ts`
- Schema: `packages/coding-agent/src/config/mcp-schema.json`

## Preferred config locations

OMP can discover MCP servers from multiple tools (`.claude/`, `.cursor/`, `.vscode/`, `opencode.json`, and more), but for OMP-native configuration you should usually use one of these files:

- Project: `.omp/mcp.json`
- User: `~/.omp/agent/mcp.json`

OMP also accepts fallback standalone files in the project root:

- `mcp.json`
- `.mcp.json`

Use `.omp/mcp.json` or `~/.omp/agent/mcp.json` when you want OMP to own the configuration. Use root `mcp.json` / `.mcp.json` only when you want a portable fallback file that other MCP clients may also read.

## Add a schema reference

Add this line at the top of the file for editor autocomplete and validation:

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {}
}
```

OMP now writes this automatically when `/mcp add`, `/mcp enable`, `/mcp disable`, `/mcp reauth`, or other config-writing flows create or update an OMP-managed MCP file.

## File shape

OMP supports this top-level structure:

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "server-name": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "some-mcp-server"]
    }
  },
  "disabledServers": ["server-name"]
}
```

Top-level keys:

- `$schema` — optional JSON Schema URL for tooling
- `mcpServers` — map of server name to server config
- `disabledServers` — user-level denylist used to turn off discovered servers by name; runtime loading reads this list from `~/.omp/agent/mcp.json`

Server names must match `^[a-zA-Z0-9_.-]{1,100}$`.

## Supported server fields

Shared fields for every transport:

- `enabled?: boolean` — skip this server when `false`
- `timeout?: number` — connection timeout in milliseconds
- `auth?: { ... }` — auth metadata used by OMP for OAuth/API-key flows
- `oauth?: { ... }` — explicit OAuth client settings used during auth/reauth

### `stdio` transport

`stdio` is the default when `type` is omitted.

Required:

- `command: string`

Optional:

- `type?: "stdio"`
- `args?: string[]`
- `env?: Record<string, string>`
- `cwd?: string`

Example:

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/Users/alice/projects",
        "/Users/alice/Documents"
      ]
    }
  }
}
```

This follows the official Filesystem MCP server package (`@modelcontextprotocol/server-filesystem`).

### `http` transport

Required:

- `type: "http"`
- `url: string`

Optional:

- `headers?: Record<string, string>`

Example:

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/"
    }
  }
}
```

This matches GitHub's hosted GitHub MCP server endpoint.

### `sse` transport

Required:

- `type: "sse"`
- `url: string`

Optional:

- `headers?: Record<string, string>`

Example:

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "legacy-remote": {
      "type": "sse",
      "url": "https://example.com/mcp/sse"
    }
  }
}
```

`sse` is still supported for compatibility, but the MCP spec now prefers Streamable HTTP (`type: "http"`) for new servers.

## Auth fields

OMP understands two auth-related objects.

### `auth`

```json
{
  "type": "oauth" | "apikey",
  "credentialId": "optional-stored-credential-id",
  "tokenUrl": "optional-token-endpoint",
  "clientId": "optional-client-id",
  "clientSecret": "optional-client-secret"
}
```

Use this when OMP should remember how to rehydrate credentials for a server.

### `oauth`

```json
{
  "clientId": "...",
  "clientSecret": "...",
  "redirectUri": "...",
  "callbackPort": 3334,
  "callbackPath": "/oauth/callback"
}
```

Use this when the MCP server requires explicit OAuth client settings.

Slack is the clearest current example. Slack's MCP server is hosted at `https://mcp.slack.com/mcp`, uses Streamable HTTP, and requires confidential OAuth with your Slack app's client credentials.

Example:

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "slack": {
      "type": "http",
      "url": "https://mcp.slack.com/mcp",
      "oauth": {
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      },
      "auth": {
        "type": "oauth",
        "tokenUrl": "https://slack.com/api/oauth.v2.user.access",
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      }
    }
  }
}
```

Relevant Slack endpoints from Slack's docs:

- MCP endpoint: `https://mcp.slack.com/mcp`
- Authorization endpoint: `https://slack.com/oauth/v2_user/authorize`
- Token endpoint: `https://slack.com/api/oauth.v2.user.access`

## Common copy-paste examples

### Filesystem server via stdio

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/absolute/path/one",
        "/absolute/path/two"
      ]
    }
  }
}
```

### GitHub hosted server via HTTP

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/"
    }
  }
}
```

### GitHub local server via Docker

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "github": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e",
        "GITHUB_PERSONAL_ACCESS_TOKEN",
        "ghcr.io/github/github-mcp-server"
      ],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "GITHUB_PERSONAL_ACCESS_TOKEN"
      }
    }
  }
}
```

This matches GitHub's official local Docker image `ghcr.io/github/github-mcp-server`.

### Slack hosted server via OAuth

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "slack": {
      "type": "http",
      "url": "https://mcp.slack.com/mcp",
      "oauth": {
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      },
      "auth": {
        "type": "oauth",
        "tokenUrl": "https://slack.com/api/oauth.v2.user.access",
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      }
    }
  }
}
```

## Secrets and variable resolution

This is the part that usually trips people up.

### In `.omp/mcp.json` and `~/.omp/agent/mcp.json`

Before OMP launches a stdio server or makes an HTTP/SSE request, it resolves stdio `env` values and HTTP/SSE `headers` values like this:

1. If a value starts with `!`, OMP runs the rest as a shell command with a 10s timeout and uses trimmed stdout.
2. If the command fails, times out, or prints only whitespace, that `env`/`headers` entry is omitted.
3. Otherwise OMP checks whether the value names an environment variable.
4. If that environment variable is set to a non-empty value, OMP uses the environment value; otherwise it uses the string literally.

Examples:

```json
{
  "env": {
    "GITHUB_PERSONAL_ACCESS_TOKEN": "GITHUB_PERSONAL_ACCESS_TOKEN"
  },
  "headers": {
    "X-MCP-Insiders": "true"
  }
}
```

That means this is valid and convenient for local secrets:

- `"GITHUB_PERSONAL_ACCESS_TOKEN": "GITHUB_PERSONAL_ACCESS_TOKEN"` → copy from the current shell environment
- `"Authorization": "Bearer hardcoded-token"` → use the literal value
- `"Authorization": "!printf 'Bearer %s' \"$GITHUB_TOKEN\""` → build the header from a command

### In root `mcp.json` and `.mcp.json`

The standalone fallback loader also expands `${VAR}` and `${VAR:-default}` inside strings during discovery for `command`, `args`, `env`, `cwd`, `url`, `headers`, `auth`, and `oauth`.

Example:

```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": {
        "Authorization": "Bearer ${GITHUB_TOKEN}"
      }
    }
  }
}
```

If you want the least surprising OMP behavior, prefer `.omp/mcp.json` or `~/.omp/agent/mcp.json` and use explicit env/header values.

## `disabledServers`

`disabledServers` is read from the user config file (`~/.omp/agent/mcp.json`) when a server is discovered from any source and you want OMP to ignore it without editing that other tool's config.

Example:

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "disabledServers": ["github", "slack"]
}
```

## `/mcp add` vs editing JSON directly

Use `/mcp add` when you want guided setup.

Use direct JSON editing when:

- you need a transport or auth option the wizard does not prompt for yet
- you want to paste a server definition from another MCP client
- you want schema-backed validation in your editor

After editing, use:

- `/mcp reload` to rediscover and reconnect servers in the current session
- `/mcp list` to see which config file a server came from
- `/mcp test <name>` to test a single server
- `/mcp reconnect <name>` to reconnect one server without rediscovering all configs
- `/mcp resources`, `/mcp prompts`, and `/mcp notifications` to inspect non-tool MCP capabilities

## Validation rules OMP enforces

From `validateServerConfig()` in `packages/coding-agent/src/mcp/config.ts`:

- `stdio` requires `command`
- `http` and `sse` require `url`
- a server cannot set both `command` and `url`
- unknown `type` values are rejected

Practical implications:

- Omitting `type` means `stdio`
- If you paste a remote server config and forget `"type": "http"`, OMP will treat it as `stdio` and complain that `command` is missing
- `sse` remains valid for compatibility, but new hosted servers should usually be configured as `http`

## Discovery and precedence

OMP does not merge duplicate server definitions across files. Discovery providers are prioritized, and the higher-priority definition wins. Separately, `disabledServers` from `~/.omp/agent/mcp.json` can suppress a discovered server by name.

In practice:

- prefer `.omp/mcp.json` or `~/.omp/agent/mcp.json` when you want an OMP-specific override
- keep server names unique across tools when possible
- use `disabledServers` in the user config when a third-party config keeps reintroducing a server you do not want

## Troubleshooting

### `Server "name": stdio server requires "command" field`

You probably omitted `type: "http"` on a remote server.

### `Server "name": both "command" and "url" are set`

Pick one transport. OMP treats `command` as stdio and `url` as http/sse.

### `/mcp add` worked but the server still does not connect

The JSON is valid, but the server may still be unreachable. Use `/mcp test <name>` and check whether:

- the binary or Docker image exists
- required environment variables are set
- the remote URL is reachable
- the OAuth or API token is valid

### The server exists in another tool's config but not in OMP

Run `/mcp list`. OMP discovers many third-party MCP files, but project-level loading can also be disabled via the `mcp.enableProjectConfig` setting, and a user-level `disabledServers` entry can suppress a server by name.

## References

- MCP transport spec: https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
- Filesystem server package: https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem
- GitHub MCP server: https://github.com/github/github-mcp-server
- Slack MCP server docs: https://docs.slack.dev/ai/slack-mcp-server/
