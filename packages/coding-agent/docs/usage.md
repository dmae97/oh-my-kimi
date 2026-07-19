# Using OMK

This page collects day-to-day usage details that do not fit on the quickstart page.

## Interactive Mode

<p align="center"><img src="images/interactive-mode.png" alt="Interactive Mode" width="600"></p>

The interface has four main areas:

- **Startup header** - shortcuts, loaded context files, prompt templates, skills, and extensions
- **Messages** - user messages, assistant responses, tool calls, tool results, notifications, errors, and extension UI
- **Editor** - where you type; border color indicates the current thinking level
- **Footer** - working directory, session name, token/cache usage, cost, context usage, and current model

The editor can be replaced temporarily by built-in UI such as `/settings` or by custom extension UI.

### Editor Features

| Feature | How |
|---------|-----|
| File reference | Type `@` to fuzzy-search project files |
| Path completion | Press Tab to complete paths |
| Multi-line input | Shift+Enter, or Ctrl+Enter on Windows Terminal |
| Images | Paste with Ctrl+V, Alt+V on Windows, or drag into the terminal |
| Skill/bash launcher | `!` opens skill completion; `!skill:name prompt` invokes a skill; `!omk <role-or-request>` routes through OMK role hubs |
| Shell command | `! command` runs and sends output to the model |
| Hidden shell command | `!! command` runs without sending output to the model |
| External editor | Ctrl+G opens `$VISUAL` or `$EDITOR` |

See [Keybindings](keybindings.md) for all shortcuts and customization.

## Slash Commands

Type `/` in the editor to open command completion. Extensions can register custom commands, skills are available as `/skill:name`, `!skill:name`, or `!name` for known skills, `!omk <role-or-request>` selects an OMK role hub such as frontend, backend, loop, or plan, and prompt templates expand via `/templatename`.

| Command | Description |
|---------|-------------|
| `/login`, `/logout` | Manage OAuth or API-key credentials |
| `/model` | Switch models, then choose thinking level |
| `/think` | Choose thinking level, or `auto` to route per task through v4 |
| `/scoped-models` | Enable/disable models for Ctrl+P cycling |
| `/settings` | Thinking level, theme, message delivery, transport |
| `/resume` | Pick from previous sessions |
| `/new` | Start a new session |
| `/name <name>` | Set session display name |
| `/session` | Show session file, ID, messages, tokens, and cost |
| `/tree` | Jump to any point in the session and continue from there |
| `/fork` | Create a new session from a previous user message |
| `/clone` | Duplicate the current active branch into a new session |
| `/compact [prompt]` | Manually compact context, optionally with custom instructions |
| `/copy` | Copy last assistant message to clipboard |
| `/export [file]` | Export session to HTML |
| `/share` | Upload as private GitHub gist with shareable HTML link |
| `/reload` | Reload keybindings, extensions, skills, prompts, and context files |
| `/hotkeys` | Show all keyboard shortcuts |
| `/changelog` | Display version history |
| `/quit` | Quit omk |

## Automatic Thinking Level Routing

`/think <level>` sets the thinking level manually. Manual levels always win: choosing a concrete level leaves auto routing, so no auto router runs.

`/think auto` enables the deterministic local v4 router (no network calls). Versioned auto commands are no longer accepted; choose `/think auto` for automatic routing or `/think <level>` for a manual override.

The auto router classifies each prompt into a task class (trivial, simple edit, code generation, debug, refactor, review, plan) and maps it to a recommended level, from `minimal` for trivial prompts up to `xhigh` for planning work.

The routing core is deterministic and local. It looks only at bounded turn signals such as:

- prompt length
- presence of code fences or diff markers
- keyword families
- leading intent, localized edit objects, diagnostic evidence, review scope, plan briefs, refactor cues, and implementation objects
- bounded negation of whole-prompt matches and short-range compound-intent detection across a leading conjunction
- recent auto-router task history in the session
- context pressure buckets
- the subagent lane type, when one is set

v4 reports a confidence band (`high`, `medium`, `low`), the score margin between the top two task classes, and a fallback reason on every turn, none of which carry prompt text. When confidence is low or no weighted signal decided the class, v4 raises the resolved level by one step above what the same task class would otherwise resolve to; confidence never lowers it. v4 is checked against a gold-set evaluation harness with fixed train/dev/holdout splits and accuracy, macro-F1, severe-under-allocation, and class-flip/McNemar checks.

Precedence:

- Manual `/think <level>` always wins.
- The router only resolves levels while `auto` mode is active.
- Auto-resolved levels apply per turn only and never overwrite the persisted default thinking level in settings.

Resolved levels are clamped to the model's capabilities: models without `xhigh`/`max` are capped at their highest supported level, and models without reasoning support bypass the router entirely.

The v4 learning path is available only through the global `reasoningRouterLearning` setting and is off by default. When `reasoningRouterLearning.enabled` is `true`, `/think auto` loads one validated bias snapshot for the session, applies a bounded `-2..2` ladder-step bias, and appends a privacy-safe feedback record containing only bounded enums, booleans, and buckets. Project-local settings cannot enable or redirect this feature, and the ledger never stores raw prompts, file paths, diffs, session identifiers, model/provider payloads, tool output, or hook output.

The Adaptorch advisory bridge module still ships as default-off groundwork only. It has no settings key, command, transport, or session call site yet, so it does not affect `/think auto` until a future transport and security review explicitly wire it.

## Message Queue

You can submit messages while the agent is still working:

- **Enter** queues a steering message, delivered after the current assistant turn finishes executing its tool calls.
- **Alt+Enter** queues a follow-up message, delivered after the agent finishes all work.
- **Escape** aborts and restores queued messages to the editor.
- **Alt+Up** retrieves queued messages back to the editor.

On Windows Terminal, Alt+Enter is fullscreen by default. Remap it as described in [Terminal setup](terminal-setup.md) if you want omk to receive the shortcut.

Configure delivery in [Settings](settings.md) with `steeringMode` and `followUpMode`.

## Sessions

Sessions are saved automatically to `~/.omk/agent/sessions/`, organized by working directory.

```bash
omk -c                  # Continue most recent session
omk -r                  # Browse and select a session
omk --no-session        # Ephemeral mode; do not save
omk --name "my task"    # Set session display name at startup
omk --session <path|id> # Use a specific session file or session ID
omk --fork <path|id>    # Fork a session into a new session file
```

Useful session commands:

- `/session` shows the current session file and ID.
- `/tree` navigates the in-file session tree and can summarize abandoned branches.
- `/fork` creates a new session from an earlier user message.
- `/clone` duplicates the current active branch into a new session file.
- `/compact` summarizes older messages to free context.

See [Sessions](sessions.md) and [Compaction](compaction.md) for details.

### Session Doctor and Recovery

```bash
omk session doctor                              # inspect all stored sessions
omk session doctor --session <path|id>          # inspect one session
omk session doctor --session <path|id> --repair --dry-run
omk session doctor --session <path|id> --repair
```

The doctor verifies the session's complete JSONL prefix, run journal, compaction envelopes/transactions, replay-evidence links, workspace, and provider/model binding. `--dry-run` plans repairs without writing. Repair mode rechecks file hashes under a lock before writing and only allows unambiguous missing tool results, exact trailing-fragment quarantine, unclosed-run crash recovery, and stale compaction abandonment. Duplicate/orphan tool results, duplicate IDs, broken hashes/chains, and changed preconditions are refused.

Session and journal bytes after the final newline are copied byte-for-byte to a `.quarantine-*` file before the original is atomically rewritten to its valid complete prefix. Opening a session uses the same complete-prefix rule; `SessionManager.getQuarantineReport()` reports any startup quarantine.

Each real agent run writes fsynced `run_started` and `run_finished` records to `<session>.runjournal`. An unclosed valid run is recorded as an inferred `process_crash` on the next startup. JSON/RPC emit `session_termination`; text and TUI errors include kind, provider/model, retryability, cause, run ID, and next action.

## Context Files

OMK loads `AGENTS.md` or `CLAUDE.md` at startup from:

- `~/.omk/agent/AGENTS.md` for global instructions
- parent directories, walking up from the current working directory
- the current directory

Use context files for project conventions, commands, safety rules, and preferences. Disable loading with `--no-context-files` or `-nc`.

### System Prompt Files

Replace the default system prompt with:

- `.omk/SYSTEM.md` for a project
- `~/.omk/agent/SYSTEM.md` globally

Append to the default prompt without replacing it with `APPEND_SYSTEM.md` in either location.

## Exporting and Sharing Sessions

Use `/export [file]` to write a session to HTML.

Use `/share` to upload a private GitHub gist with a shareable HTML link.

If you use omk for open source work and want to publish sessions for model, prompt, tool, and evaluation research, see [`badlogic/omk-share-hf`](https://github.com/badlogic/omk-share-hf). It publishes sessions to Hugging Face datasets.

## CLI Reference

```bash
omk [options] [@files...] [messages...]
```

### Package Commands

```bash
omk install <source> [-l]     # Install package, -l for project-local
omk remove <source> [-l]      # Remove package
omk uninstall <source> [-l]   # Alias for remove
omk update [source|self|omk]   # Update omk and packages; reconcile pinned git refs
omk update --extensions       # Update packages only; reconcile pinned git refs
omk update --self             # Update omk only
omk update --extension <src>  # Update one package
omk list                      # List installed packages
omk config                    # Enable/disable package resources
```

These commands manage omk packages, not the omk CLI installation. To uninstall omk itself, see [Quickstart](quickstart.md#uninstall).

See [OMK Packages](packages.md) for package sources and security notes.

### Session Doctor

```bash
omk session doctor [--session <path|id>] [--repair [--dry-run]]
```

Exit codes: `0` healthy or successfully repaired, `1` issues found or dry-run repairs available, `2` refused/usage/CAS failure.

### Provider Doctor

```bash
omk provider doctor <provider-id> [--level <0|1>] [--model <model-id>] [--timeout <ms>] [--probe-model <model-id>]
```

Diagnoses one provider and prints a single sanitized JSON document. Exit codes are stable: `0` ok, `1` diagnosis failed, `2` usage error. The legacy flag form `omk --doctor-provider <provider-id>` (with `--doctor-level`, `--doctor-model`, `--doctor-timeout`) remains an alias.

- **Level 0** (default) — static checks only, no network: config resolution, URL/scheme/address policy, model↔provider relation, credential presence.
- **Level 1** (`--level 1`) — adds non-generative, GET-only reachability probes (root + `/models`) with strict timeouts, no redirects, and DNS/address pinning. Results use the exact probe categories `ok | network | auth | unsupported-endpoint | server`: a root or `/models` 404 is neutral (`unsupported-endpoint`), 401/403 is an auth failure, and 5xx is a `server` failure.
- **Level 2** — reachable only via the explicit `--probe-model <model-id>` opt-in: sends one minimal-token generative request (`max_tokens: 1`) to the completions endpoint. **This may incur provider costs**; the JSON result marks it with `"costWarning": true`. No tool-call probe is ever sent.

Config sources, highest precedence first: `models.json`, `KIMI_BASE_URL`/`KIMI_MODEL_NAME` env, `~/.kimi/config.toml` root keys, then `[providers.<name>]` TOML tables with `type = "openai_legacy"` — the last are classified `custom-openai-compatible`, so native-only checks (login, native config) are skipped and endpoint reachability is checked instead. Credentials, URL userinfo/query/fragment, request bodies, and response bodies never appear in the output; malformed TOML is reported by line number only.

### Modes

| Flag | Description |
|------|-------------|
| default | Interactive mode |
| `-p`, `--print` | Print response and exit |
| `--mode json` | Output all events as JSON lines; see [JSON mode](json.md) |
| `--mode rpc` | RPC mode over stdin/stdout; see [RPC mode](rpc.md) |
| `--export <in> [out]` | Export a session to HTML |

In print mode, omk also reads piped stdin and merges it into the initial prompt:

```bash
cat README.md | omk -p "Summarize this text"
```

### Model Options

| Option | Description |
|--------|-------------|
| `--provider <name>` | Provider, such as `anthropic`, `openai`, or `google` |
| `--model <pattern>` | Model pattern or ID; supports `provider/id` and optional `:<thinking>` |
| `--api-key <key>` | API key, overriding environment variables |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `--models <patterns>` | Comma-separated patterns for Ctrl+P cycling |
| `--list-models [search]` | List available models |

### Session Options

| Option | Description |
|--------|-------------|
| `-c`, `--continue` | Continue the most recent session |
| `-r`, `--resume` | Browse and select a session |
| `--session <path\|id>` | Use a specific session file or partial UUID |
| `--fork <path\|id>` | Fork a session file or partial UUID into a new session |
| `--session-dir <dir>` | Custom session storage directory |
| `--no-session` | Ephemeral mode; do not save |
| `--name <name>`, `-n <name>` | Set session display name at startup |

### Tool Options

| Option | Description |
|--------|-------------|
| `--tools <list>`, `-t <list>` | Allowlist specific built-in, extension, and custom tools |
| `--exclude-tools <list>`, `-xt <list>` | Disable specific built-in, extension, and custom tools |
| `--no-builtin-tools`, `-nbt` | Disable built-in tools but keep extension/custom tools enabled |
| `--no-tools`, `-nt` | Disable all tools |

Built-in tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`.

### Resource Options

| Option | Description |
|--------|-------------|
| `-e`, `--extension <source>` | Load an extension from path, npm, or git; repeatable |
| `--no-extensions` | Disable extension discovery |
| `--skill <path>` | Load a skill; repeatable |
| `--no-skills` | Disable skill discovery |
| `--prompt-template <path>` | Load a prompt template; repeatable |
| `--no-prompt-templates` | Disable prompt template discovery |
| `--theme <path>` | Load a theme; repeatable |
| `--no-themes` | Disable theme discovery |
| `--no-context-files`, `-nc` | Disable `AGENTS.md` and `CLAUDE.md` discovery |

Combine `--no-*` with explicit flags to load exactly what you need, ignoring settings. Example:

```bash
omk --no-extensions -e ./my-extension.ts
```

### Other Options

| Option | Description |
|--------|-------------|
| `--system-prompt <text>` | Replace default prompt; context files and skills are still appended |
| `--append-system-prompt <text>` | Append to system prompt |
| `--verbose` | Force verbose startup |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

### File Arguments

Prefix files with `@` to include them in the message:

```bash
omk @prompt.md "Answer this"
omk -p @screenshot.png "What's in this image?"
omk @code.ts @test.ts "Review these files"
```

### Examples

```bash
# Interactive with initial prompt
omk "List all .ts files in src/"

# Non-interactive
omk -p "Summarize this codebase"

# Non-interactive with piped stdin
cat README.md | omk -p "Summarize this text"

# Named one-shot session
omk --name "release audit" -p "Audit this repository"

# Different model
omk --provider openai --model gpt-4o "Help me refactor"

# Model with provider prefix
omk --model openai/gpt-4o "Help me refactor"

# Model with thinking level shorthand
omk --model sonnet:high "Solve this complex problem"

# Limit model cycling
omk --models "claude-*,gpt-4o"

# Read-only mode
omk --tools read,grep,find,ls -p "Review the code"

# Disable one extension or built-in tool while keeping the rest available
omk --exclude-tools ask_question
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `OMK_CODING_AGENT_DIR` | Override config directory; default is `~/.omk/agent` |
| `OMK_CODING_AGENT_SESSION_DIR` | Override session storage directory; overridden by `--session-dir` |
| `OMK_PACKAGE_DIR` | Override package directory, useful for Nix/Guix store paths |
| `OMK_TOOL_SCHEDULER` | Override the tool scheduler with `dag-v2` or use `waves-v1` for process-local rollback |
| `OMK_OFFLINE` | Disable startup network operations, including update checks, package update checks, and install/update telemetry |
| `OMK_SKIP_VERSION_CHECK` | Skip the OMK version update check at startup. This prevents the `the OMK repository` latest-version request |
| `OMK_TELEMETRY` | Override install/update telemetry and provider attribution headers: `1`/`true`/`yes` or `0`/`false`/`no`. This does not disable update checks |
| `OMK_CACHE_RETENTION` | Set to `long` for extended prompt cache where supported |
| `VISUAL`, `EDITOR` | External editor for Ctrl+G |

## Design Principles

OMK keeps the core small and pushes workflow-specific behavior into extensions, skills, prompt templates, and packages.

It intentionally does not include built-in MCP, sub-agents, permission popups, plan mode, to-dos, or background bash. You can build or install those workflows as extensions or packages, or use external tools such as containers and tmux.

For the full rationale, read the [blog post](https://mariozechner.at/posts/2025-11-30-omk-coding-agent/).
