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
| --------- | ------ | --------- | ------------- |
| `defaultProvider` | string | - | Default provider (e.g., `"anthropic"`, `"openai"`) |
| `defaultModel` | string | - | Default model ID |
| `defaultThinkingLevel` | string | - | `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`, `"ultra"` |
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
    "enabled": false
  }
}
```

This opt-in remains global-only, but its default data is isolated per repository or git worktree under `~/.omk/agent/router-feedback/repositories/<opaque-scope>/`. The scope is derived from the canonical worktree root and never stores the raw path. Set `biasSnapshotPath` or `feedbackLedgerPath` only when intentionally overriding that isolation with fixed paths.

#### adaptorchBridge

Global-only, default-off lifecycle for a future v4 advisory source. The timeout, TTL, consult-budget, and circuit-breaker controls are wired, but the current transport is a no-op and cannot change the resolved level. A project-scope `.omk/settings.json` value is ignored by design.

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
| --------- | ------ | --------- | ------------- |
| `theme` | string | `"dark"` | Theme name (`"dark"`, `"light"`, or custom) |
| `quietStartup` | boolean | `false` | Hide startup header |
| `collapseChangelog` | boolean | `true` | Show condensed changelog after updates (set `false` for the full "What's New" block) |
| `footerSystemMetrics` | boolean | `false` | Show system-wide CPU/MEM usage in the footer stats line |
| `enableInstallTelemetry` | boolean | `true` | Send an anonymous install/update version ping after first install or changelog-detected updates. This does not control update checks |
| `doubleEscapeAction` | string | `"tree"` | Action for double-escape: `"tree"`, `"fork"`, or `"none"` |
| `treeFilterMode` | string | `"default"` | Default filter for `/tree`: `"default"`, `"no-tools"`, `"user-only"`, `"labeled-only"`, `"all"` |
| `editorPaddingX` | number | `0` | Horizontal padding for input editor (0-3) |
| `autocompleteMaxVisible` | number | `5` | Max visible items in autocomplete dropdown (3-20) |
| `showHardwareCursor` | boolean | `false` | Show the terminal cursor while TUI positions it for IME support |
| `pinStatusSidebar` | boolean | `false` | Pin the bottom status bar as a responsive right rail (opencode-style): width scales with the terminal (~26%, 34–48 cols), the MCP roster grows on taller terminals, and the content column shrinks to match so the prompt is never covered. Toggle anytime with `Ctrl+Q`. Also enabled by `OMK_PIN_STATUS_SIDEBAR=1` |

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
| --------- | ------ | --------- | ------------- |
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
| --------- | ------ | --------- | ------------- |
| `agent.toolScheduler` | string | `"dag-v2"` | Deterministic resource-claim scheduler. Use `"waves-v1"` for compatibility rollback |
| `agent.maxToolConcurrency` | number | `4` | Maximum calls in one DAG level; `0` removes the cap |
| `agent.toolTimeoutMs` | number | `0` | Fallback tool execution timeout in milliseconds; `0` disables the fallback timer |
| `agent.toolTimeouts` | object | built-in defaults | Per-tool-name timeout overrides; `0` disables that tool's timer |

Built-in defaults are 30 seconds for `read`, `grep`, `find`, and `ls`; 60 seconds for `edit` and `write`; and 300 seconds for `bash`. Explicit `agent.toolTimeouts` entries override these defaults. Extension tools may override settings per call with `resolveTimeoutMs(ctx)`; otherwise custom tools without a per-name value use `agent.toolTimeoutMs`. Timeout values must be integer milliseconds from `0` through `2147483647`.

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

### Resource Governor

The governor probes host capacity (memory, workspace disk, V8 heap, system CPU) and evaluates a resource admission decision, surfaced through `/resource [probe|policy]` in the TUI and `omk doctor resources [--json]` headless. In `observe` mode (default) it records decisions without changing behavior; in `adaptive`/`strict` modes each top-level prompt runs a bounded preflight probe and throttles the effective tool concurrency for that run (never above `agent.maxToolConcurrency`), restoring it when the run settles. Heavy-process caps are enforced at the governed bash boundary; the internal subagent-lane launcher is not wired into live child dispatch. Absent settings keep prior behavior unchanged.

| Setting | Type | Default | Description |
| --------- | ------ | --------- | ------------- |
| `resourceGovernor.enabled` | boolean | `true` | `false` forces mode `off` |
| `resourceGovernor.mode` | string | `"observe"` | `off` (disabled), `observe` (record only), `adaptive`/`strict` (throttle per-run tool concurrency under pressure) |
| `resourceGovernor.maxProbeMs` | number | `300` | Async probe deadline in ms; valid `50..5000` |
| `resourceGovernor.cpuSampleMs` | number | `180` | CPU two-sample interval in ms; valid `150..250` |
| `resourceGovernor.constrainedAvailableMemoryMiB` | number | `1536` | Below this effective available memory the host is `constrained` |
| `resourceGovernor.criticalAvailableMemoryMiB` | number | `512` | Below this it is `critical`; must be `<=` the constrained threshold |
| `resourceGovernor.constrainedDiskFreeMiB` | number | `4096` | Workspace free-disk threshold for `constrained` |
| `resourceGovernor.criticalDiskFreeMiB` | number | `1024` | Workspace free-disk threshold for `critical` |
| `resourceGovernor.constrainedHeapRatio` | number | `0.75` | V8 heap used/limit ratio for `constrained` |
| `resourceGovernor.criticalHeapRatio` | number | `0.85` | V8 heap ratio for `critical` |
| `resourceGovernor.busyCpuPercent` | number | `85` | System CPU percent that throttles; CPU alone never reports `critical` |
| `resourceGovernor.normalMaxToolConcurrency` | number | `4` | Admission tool cap at `normal` pressure |
| `resourceGovernor.constrainedMaxToolConcurrency` | number | `2` | Admission tool cap at `constrained` pressure |
| `resourceGovernor.criticalMaxToolConcurrency` | number | `1` | Admission tool cap at `critical` pressure |
| `resourceGovernor.normalMaxParallelLanes` | number | `4` | Subagent lane cap at `normal` |
| `resourceGovernor.constrainedMaxParallelLanes` | number | `2` | Subagent lane cap at `constrained` |
| `resourceGovernor.criticalMaxParallelLanes` | number | `1` | Subagent lane cap at `critical` |
| `resourceGovernor.normalMaxHeavyProcesses` | number | `2` | Heavy process cap at `normal` |
| `resourceGovernor.constrainedMaxHeavyProcesses` | number | `1` | Heavy process cap at `constrained` |
| `resourceGovernor.criticalMaxHeavyProcesses` | number | `1` | Heavy process cap at `critical` |

Validation is explicit and fail-closed: invalid values are reported (in `/resource policy` and `omk doctor resources --json` under `settingsErrors`) and the defaults apply for the failed area. Caps must satisfy `normal >= constrained >= critical` and stay within `1..64`; critical thresholds must not exceed constrained ones. Admission caps never raise user-configured caps (`agent.maxToolConcurrency` keeps precedence; `0` "unlimited" is limited to the admission cap in `adaptive` and `strict` modes).

`OMK_RESOURCE_GOVERNOR=off|observe|adaptive|strict` overrides the mode for one process, e.g. `OMK_RESOURCE_GOVERNOR=off omk` as a rollback switch.

### Completion Sound

Plays a short system sound when a long prompt finally settles (all retries and continuations drained), only in the interactive TUI on a real TTY — never in RPC, JSON, print mode, or CI. Default off. Backends use fixed executables with fixed arguments (macOS `afplay`, Windows/WSL PowerShell system sound, Linux `canberra-gtk-play`/`paplay`/`aplay`), falling back to the terminal bell. Sound failures are diagnostics only and never affect the prompt outcome.

| Setting | Type | Default | Description |
| --------- | ------ | --------- | ------------- |
| `notifications.completionSound.enabled` | boolean | `false` | Master switch; env `OMK_COMPLETION_SOUND` set to `0` or `1` overrides per process |
| `notifications.completionSound.minDurationMs` | number | `5000` | Only chime for prompts that ran at least this long |
| `notifications.completionSound.onSuccess` | boolean | `true` | Chime on completed prompts |
| `notifications.completionSound.onFailure` | boolean | `true` | Chime on failed prompts (user aborts never chime) |
| `notifications.completionSound.terminalBellFallback` | boolean | `true` | Fall back to the terminal BEL when no sound backend works |

```json
{
  "notifications": {
    "completionSound": { "enabled": true, "minDurationMs": 10000 }
  }
}
```

```json
{
  "resourceGovernor": {
    "mode": "observe",
    "constrainedAvailableMemoryMiB": 2048,
    "criticalAvailableMemoryMiB": 512
  }
}
```

### Branch Summary

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `branchSummary.reserveTokens` | number | `16384` | Tokens reserved for branch summarization |
| `branchSummary.skipPrompt` | boolean | `false` | Skip "Summarize branch?" prompt on `/tree` navigation (defaults to no summary) |

### Retry

| Setting | Type | Default | Description |
| --------- | ------ | --------- | ------------- |
| `retry.enabled` | boolean | `true` | Enable automatic agent-level retry on transient errors |
| `retry.maxRetries` | number | `3` | Maximum agent-level retry attempts |
| `retry.baseDelayMs` | number | `2000` | Base delay for agent-level exponential backoff (2s, 4s, 8s) |
| `retry.provider.timeoutMs` | number | SDK default | Provider/SDK request timeout in milliseconds |
| `retry.provider.maxRetries` | number | `0` | Provider/SDK retry attempts |
| `retry.provider.maxRetryDelayMs` | number | `60000` | Max server-requested delay before failing (60s) |

When a provider requests a retry delay longer than `retry.provider.maxRetryDelayMs` (e.g., Google's "quota will reset after 5h"), the request fails immediately with an informative error instead of waiting silently. Set to `0` to disable the cap.

Keep `retry.provider.maxRetries` at `0` unless provider-level retries are explicitly needed. Setting it above `0` can make SDK/provider retries handle out-of-usage-limit errors before OMK sees them, which may block the agent until the provider quota resets in some circumstances.

At the agent level, recognized quota and billing-cycle failures are retryable so OMK can first switch to an authenticated `providerResilience.failoverCandidates` entry. If no candidate qualifies, normal retry backoff applies. See [Provider Resilience](provider-resilience.md).

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
| --------- | ------ | --------- | ------------- |
| `steeringMode` | string | `"one-at-a-time"` | How steering messages are sent: `"all"` or `"one-at-a-time"` |
| `followUpMode` | string | `"one-at-a-time"` | How follow-up messages are sent: `"all"` or `"one-at-a-time"` |
| `transport` | string | `"auto"` | Preferred transport for providers that support multiple transports: `"sse"`, `"websocket"`, `"websocket-cached"`, or `"auto"` |
| `httpIdleTimeoutMs` | number | `300000` | HTTP header/body idle timeout in milliseconds, also used by providers with explicit stream idle timeouts. Set to `0` to disable. |
| `websocketConnectTimeoutMs` | number | `15000` | WebSocket connect/open handshake timeout in milliseconds for providers that support WebSocket transports. Set to `0` to disable. |

### Terminal & Images

| Setting | Type | Default | Description |
| --------- | ------ | --------- | ------------- |
| `terminal.showImages` | boolean | `true` | Show images in terminal (if supported) |
| `terminal.imageWidthCells` | number | `60` | Preferred inline image width in terminal cells |
| `terminal.clearOnShrink` | boolean | `false` | Clear empty rows when content shrinks (can cause flicker) |
| `images.autoResize` | boolean | `true` | Resize images to 2000x2000 max |
| `images.blockImages` | boolean | `false` | Block all images from being sent to LLM |

### Shell

| Setting | Type | Default | Description |
| --------- | ------ | --------- | ------------- |
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
| --------- | ------ | --------- | ------------- |
| `packages` | array | `[]` | npm/git packages to load resources from |
| `extensions` | string[] | `[]` | Local extension file paths or directories |
| `skills` | string[] | `[]` | Local skill file paths or directories |
| `defaultActiveSkills` | string[] | `[]` | Global-only list of up to 64 exact user-scoped skill names marked active in every prompt; full instructions remain on-demand |
| `prompts` | string[] | `[]` | Local prompt template paths or directories |
| `themes` | string[] | `[]` | Local theme file paths or directories |
| `enableSkillCommands` | boolean | `true` | Register skills as `/skill:name` commands |

Resource path arrays (`extensions`, `skills`, `prompts`, and `themes`) support glob patterns and exclusions. Use `!pattern` to exclude, `+path` to force-include an exact path, and `-path` to force-exclude one. `defaultActiveSkills` accepts exact names only.

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

Project settings (`.omk/settings.json`) override global settings. Nested objects are merged. Settings marked global-only, including `contextBudget` and `defaultActiveSkills`, are read from global settings only.

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
