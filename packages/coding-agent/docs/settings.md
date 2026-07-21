# Settings

OMK uses JSON settings files with project settings overriding global settings, except settings explicitly marked global-only.

| Location | Scope |
|----------|-------|
| `~/.omk/agent/settings.json` | Global (all projects) |
| `.omk/settings.json` | Project (current directory) |

Edit directly or use `/settings` for common options.

## All Settings

### Model & Thinking

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultProvider` | string | - | Default provider (e.g., `"anthropic"`, `"openai"`) |
| `defaultModel` | string | - | Default model ID |
| `defaultThinkingLevel` | string | - | `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"` |
| `hideThinkingBlock` | boolean | `false` | Hide thinking blocks in output |
| `thinkingBudgets` | object | - | Custom token budgets per thinking level |
| `reasoningRouterLearning` | object | - | Opt-in v4 router learning bias (global settings file only) |
| `adaptorchBridge` | object | - | Opt-in AdaptOrch advisory bridge for the auto thinking-level resolver (global settings file only) |

#### thinkingBudgets

```json
{
  "thinkingBudgets": {
    "minimal": 1024,
    "low": 4096,
    "medium": 10240,
    "high": 32768
  }
}
```

#### reasoningRouterLearning

```json
{
  "reasoningRouterLearning": {
    "enabled": false,
    "biasSnapshotPath": "~/.omk/agent/router-bias.json",
    "feedbackLedgerPath": "~/.omk/agent/router-feedback.jsonl"
  }
}
```

#### adaptorchBridge

Advisory-only hint source for the v4 auto thinking-level resolver. Read from the **global** settings file only — a project-scope `.omk/settings.json` value is ignored by design. Default is fully off; the bridge is circuit-breaker protected and TTL-cached, and its hint can only nudge the resolved level by a bounded ±2 steps.

```json
{
  "adaptorchBridge": {
    "enabled": false,
    "ttlMs": 300000,
    "timeoutMs": 1500,
    "maxConsultsPerSession": 5,
    "failureThreshold": 3
  }
}
```

### UI & Display

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `theme` | string | `"dark"` | Theme name (`"dark"`, `"light"`, or custom) |
| `quietStartup` | boolean | `false` | Hide startup header |
| `collapseChangelog` | boolean | `false` | Show condensed changelog after updates |
| `enableInstallTelemetry` | boolean | `true` | Send an anonymous install/update version ping after first install or changelog-detected updates. This does not control update checks |
| `doubleEscapeAction` | string | `"tree"` | Action for double-escape: `"tree"`, `"fork"`, or `"none"` |
| `treeFilterMode` | string | `"default"` | Default filter for `/tree`: `"default"`, `"no-tools"`, `"user-only"`, `"labeled-only"`, `"all"` |
| `editorPaddingX` | number | `0` | Horizontal padding for input editor (0-3) |
| `autocompleteMaxVisible` | number | `5` | Max visible items in autocomplete dropdown (3-20) |
| `showHardwareCursor` | boolean | `false` | Show the terminal cursor while TUI positions it for IME support |

### Telemetry and update checks

`enableInstallTelemetry` only controls the anonymous install/update ping to `the OMK install telemetry endpoint`. Opting out of telemetry does not disable update checks; OMK can still fetch `the OMK latest-version endpoint` to look for the latest version.

Set `OMK_SKIP_VERSION_CHECK=1` to disable the OMK version update check. Use `--offline` or `OMK_OFFLINE=1` to disable all startup network operations described here, including update checks, package update checks, and install/update telemetry.

### Warnings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `warnings.anthropicExtraUsage` | boolean | `true` | Show a warning when Anthropic subscription auth may use paid extra usage |

```json
{
  "warnings": {
    "anthropicExtraUsage": false
  }
}
```

### Compaction

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `compaction.enabled` | boolean | `true` | Enable auto-compaction |
| `compaction.model` | string | session model | Authenticated canonical `provider/model` used only for compaction |
| `compaction.reserveTokens` | number | `16384` | Legacy/default output reserve (tokens reserved for the LLM response) |
| `compaction.reservedOutputTokens` | number | `reserveTokens` | Optional override for output-only reserve |
| `compaction.reservedToolResultTokens` | number | `0` | Reserve tokens for pending tool results |
| `compaction.safetyMarginTokens` | number | `0` | Extra safety margin added to the reserve |
| `compaction.imageReserveTokens` | number | `0` | Reserve tokens for image content |
| `compaction.keepRecentTokens` | number | `20000` | Recent tokens to keep (not summarized) |
| `compaction.maxUsageRatio` | number | `0.9` | Normal trigger ratio (fraction of context window) |
| `compaction.rearmRatio` | number | `0.75 × maxUsageRatio` | Ratio below which a triggered compaction can rearm |
| `compaction.emergencyRatio` | number | `0.98` | Emergency compaction ratio |

All numeric token reserves must be non-negative safe integers. Ratios must be finite and in `(0, 1]`. Invalid values fail session creation instead of silently weakening the policy.

```json
{
  "compaction": {
    "enabled": true,
    "model": "zai/glm-5.2",
    "reserveTokens": 16384,
    "reservedToolResultTokens": 8192,
    "safetyMarginTokens": 1024,
    "keepRecentTokens": 20000,
    "maxUsageRatio": 0.9,
    "rearmRatio": 0.7,
    "emergencyRatio": 0.98
  }
}
```

### Context Budget

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `contextBudget.enabled` | boolean | `false` | Globally enable prompt resource budgeting and its in-memory, session-scoped plan/representation cache |

```json
{
  "contextBudget": { "enabled": true }
}
```

This setting is global-only: `.omk/settings.json` cannot enable or disable it. Use `OMK_CONTEXT_GOVERNOR=1` to force it on for one process or `OMK_CONTEXT_GOVERNOR=0` to force it off for a baseline run. The cache is never persisted or shared between sessions.

### Agent Tool Execution

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `agent.toolScheduler` | string | `"dag-v2"` | Deterministic resource-claim scheduler. Use `"waves-v1"` for compatibility rollback |
| `agent.maxToolConcurrency` | number | `4` | Maximum calls in one DAG level; `0` removes the cap |
| `agent.toolTimeoutMs` | number | `0` | Fallback tool execution timeout in milliseconds; `0` disables the fallback timer |
| `agent.toolTimeouts` | object | built-in defaults | Per-tool-name timeout overrides; `0` disables that tool's timer |

Built-in defaults are 30 seconds for `read`, `grep`, `find`, and `ls`; 60 seconds for `edit` and `write`; and 300 seconds for `bash`. Explicit `agent.toolTimeouts` entries override these defaults. Extension/custom tools without a per-name value use `agent.toolTimeoutMs`. Timeout values must be integer milliseconds from `0` through `2147483647`.

```json
{
  "agent": {
    "toolScheduler": "dag-v2",
    "maxToolConcurrency": 4,
    "toolTimeoutMs": 0,
    "toolTimeouts": {
      "read": 30000,
      "write": 60000,
      "bash": 300000,
      "my_mcp_tool": 120000,
      "my_browser_tool": 180000
    }
  }
}
```

`OMK_TOOL_SCHEDULER` overrides the file setting for one process. Set it to `waves-v1` for rollback or `dag-v2` to force the resource DAG. Invalid scheduler and timeout values fail session creation instead of silently weakening the policy.

The DAG preserves source-order result artifacts. `bash`, unknown tools, and extension tools without explicit resource claims remain exclusive. Tool timeout is logical cancellation: OMK closes the tool call and signals cancellation, but arbitrary JavaScript or external side effects may continue if the tool ignores that signal.

### Branch Summary

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `branchSummary.reserveTokens` | number | `16384` | Tokens reserved for branch summarization |
| `branchSummary.skipPrompt` | boolean | `false` | Skip "Summarize branch?" prompt on `/tree` navigation (defaults to no summary) |

### Retry

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `retry.enabled` | boolean | `true` | Enable automatic agent-level retry on transient errors |
| `retry.maxRetries` | number | `3` | Maximum agent-level retry attempts |
| `retry.baseDelayMs` | number | `2000` | Base delay for agent-level exponential backoff (2s, 4s, 8s) |
| `retry.provider.timeoutMs` | number | SDK default | Provider/SDK request timeout in milliseconds |
| `retry.provider.maxRetries` | number | `0` | Provider/SDK retry attempts |
| `retry.provider.maxRetryDelayMs` | number | `60000` | Max server-requested delay before failing (60s) |

When a provider requests a retry delay longer than `retry.provider.maxRetryDelayMs` (e.g., Google's "quota will reset after 5h"), the request fails immediately with an informative error instead of waiting silently. Set to `0` to disable the cap.

Keep `retry.provider.maxRetries` at `0` unless provider-level retries are explicitly needed. Setting it above `0` can make SDK/provider retries handle out-of-usage-limit errors before OMK sees them, which may block the agent until the provider quota resets in some circumstances.

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "provider": {
      "timeoutMs": 3600000,
      "maxRetries": 0,
      "maxRetryDelayMs": 60000
    }
  }
}
```

### Message Delivery

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `steeringMode` | string | `"one-at-a-time"` | How steering messages are sent: `"all"` or `"one-at-a-time"` |
| `followUpMode` | string | `"one-at-a-time"` | How follow-up messages are sent: `"all"` or `"one-at-a-time"` |
| `transport` | string | `"auto"` | Preferred transport for providers that support multiple transports: `"sse"`, `"websocket"`, `"websocket-cached"`, or `"auto"` |
| `httpIdleTimeoutMs` | number | `300000` | HTTP header/body idle timeout in milliseconds, also used by providers with explicit stream idle timeouts. Set to `0` to disable. |
| `websocketConnectTimeoutMs` | number | `15000` | WebSocket connect/open handshake timeout in milliseconds for providers that support WebSocket transports. Set to `0` to disable. |

### Terminal & Images

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `terminal.showImages` | boolean | `true` | Show images in terminal (if supported) |
| `terminal.imageWidthCells` | number | `60` | Preferred inline image width in terminal cells |
| `terminal.clearOnShrink` | boolean | `false` | Clear empty rows when content shrinks (can cause flicker) |
| `images.autoResize` | boolean | `true` | Resize images to 2000x2000 max |
| `images.blockImages` | boolean | `false` | Block all images from being sent to LLM |

### Shell

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `shellPath` | string | - | Custom shell path (e.g., for Cygwin on Windows) |
| `shellCommandPrefix` | string | - | Prefix for every bash command (e.g., `"shopt -s expand_aliases"`) |
| `npmCommand` | string[] | - | Command argv used for npm package lookup/install operations (e.g., `["mise", "exec", "node@20", "--", "npm"]`) |

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

`npmCommand` is used for all npm package-manager operations, including installs, uninstalls, and dependency installs inside git packages. User-scoped npm packages install under `~/.omk/agent/npm/`; project-scoped npm packages install under `.omk/npm/`. Use argv-style entries exactly as the process should be launched. When `npmCommand` is configured, git package dependency installs use plain `install` to avoid npm-specific flags in wrappers or alternate package managers.

### Sessions

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sessionDir` | string | - | Directory where session files are stored. Accepts absolute or relative paths, plus `~`. |

```json
{ "sessionDir": ".omk/sessions" }
```

When multiple sources specify a session directory, precedence is `--session-dir`, `OMK_CODING_AGENT_SESSION_DIR`, then `sessionDir` in settings.json.

### Model Cycling

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabledModels` | string[] | - | Model patterns for Ctrl+P cycling (same format as `--models` CLI flag) |

```json
{
  "enabledModels": ["claude-*", "gpt-4o", "gemini-2*"]
}
```

### Markdown

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `markdown.codeBlockIndent` | string | `"  "` | Indentation for code blocks |

### Resources

These settings define where to load extensions, skills, prompts, and themes from.

Paths in `~/.omk/agent/settings.json` resolve relative to `~/.omk/agent`. Paths in `.omk/settings.json` resolve relative to `.omk`. Absolute paths and `~` are supported.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `packages` | array | `[]` | npm/git packages to load resources from |
| `extensions` | string[] | `[]` | Local extension file paths or directories |
| `skills` | string[] | `[]` | Local skill file paths or directories |
| `prompts` | string[] | `[]` | Local prompt template paths or directories |
| `themes` | string[] | `[]` | Local theme file paths or directories |
| `enableSkillCommands` | boolean | `true` | Register skills as `/skill:name` commands |

Arrays support glob patterns and exclusions. Use `!pattern` to exclude. Use `+path` to force-include an exact path and `-path` to force-exclude an exact path.

#### packages

String form loads all resources from a package:

```json
{
  "packages": ["omk-skills", "@org/my-extension"]
}
```

Object form filters which resources to load:

```json
{
  "packages": [
    {
      "source": "omk-skills",
      "skills": ["brave-search", "transcribe"],
      "extensions": []
    }
  ]
}
```

See [packages.md](packages.md) for package management details.

## Example

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-20250514",
  "defaultThinkingLevel": "medium",
  "theme": "dark",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },
  "contextBudget": { "enabled": true },
  "retry": {
    "enabled": true,
    "maxRetries": 3
  },
  "enabledModels": ["claude-*", "gpt-4o"],
  "warnings": {
    "anthropicExtraUsage": true
  },
  "packages": ["omk-skills"]
}
```

## Project Overrides

Project settings (`.omk/settings.json`) override global settings. Nested objects are merged. `contextBudget` is the exception: it is read from global settings only.

```json
// ~/.omk/agent/settings.json (global)
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 16384 }
}

// .omk/settings.json (project)
{
  "compaction": { "reserveTokens": 8192 }
}

// Result
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 8192 }
}
```
