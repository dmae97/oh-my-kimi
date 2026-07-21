<p align="center">
  <img src="https://raw.githubusercontent.com/dmae97/open-multi-agent-kit/v0.90.4/readmeasset/omk-control.webp" alt="OMK//CONTROL Night City Ops Console for routing agents, evidence gates, telemetry, MCP scope, and operator control" width="100%" />
</p>

<h1 align="center">OMK</h1>

<p align="center">
  <strong>OMK//CONTROL — provider-neutral multi-agent control plane for coding workflows.</strong>
</p>

<p align="center">
  Models execute. OMK routes, verifies, measures, and controls.
</p>

<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/open-multi-agent-kit"><img alt="npm" src="https://img.shields.io/npm/v/open-multi-agent-kit?style=flat-square" /></a>
  <a href="https://github.com/dmae97/omk/releases/tag/v0.91.0"><img alt="Release" src="https://img.shields.io/badge/release-v0.91.0-00d7ff?style=flat-square" /></a>
</p>

> New issues and PRs from new contributors are auto-closed by default. Maintainers review auto-closed issues daily. See [CONTRIBUTING.md](https://github.com/dmae97/open-multi-agent-kit/blob/v0.90.4/CONTRIBUTING.md).

---

## OMK//CONTROL TUI

<p align="center">
  <img src="https://raw.githubusercontent.com/dmae97/open-multi-agent-kit/v0.90.4/readmeasset/omk_tui.png" alt="OMK//CONTROL terminal dashboard — live DAG lanes, provider routing, MCP health, evidence gates, and telemetry in Night City Ops Console style" width="100%" />
</p>

The OMK//CONTROL startup surface is the default operator view. The header reads `omk v<package.version> · OMK//CONTROL`, using the published `open-multi-agent-kit` package version as the single source of truth.

The default dark TUI theme uses the `omk-control-grid-dark` Night City palette and keeps the control sidebar focused on route, evidence, loop, MCP, runtime, skills, and context budget state.

## Release v0.91.0

This feature release moves footer resource metrics to whole-machine telemetry, ships the WCAG-verified Aurora theme pair, stabilizes the AdaptOrch Work Packet Loop package as a CLI runtime dependency, and adds two built-in subscription providers (Qwen, Grok).

| Area | What changed |
|------|--------------|
| Footer metrics | CPU/MEM now reflect the whole machine (`os.cpus()` busy %, `totalmem - freemem`) instead of the OMK process, with percentage-based warning/error thresholds. |
| Themes | `omk-aurora-dark` / `omk-aurora-light`: WCAG-verified contrast (body ≥14:1, semantic ≥4.5:1), stepped thinking-level ramp, aliases `aurora` / `aurora-dark` / `aurora-light`. |
| AdaptOrch | `omk-adaptorch-wpl` promoted to stable as a CLI runtime dependency; opt-in global-only `adaptorchBridge` advisory hints for the auto thinking-level resolver (default off). |
| Providers | New built-in subscription providers under `/login`: Qwen (Qwen Code Subscription) and Grok (xAI OAuth Proxy). |

GitHub-focused release notes live in [RELEASE_NOTES_v0.91.0.md](https://github.com/dmae97/omk/blob/v0.91.0/.github/RELEASE_NOTES_v0.91.0.md). The GitHub release workflow also extracts the canonical release body from [packages/coding-agent/CHANGELOG.md](https://github.com/dmae97/omk/blob/v0.91.0/packages/coding-agent/CHANGELOG.md).

## Release v0.90.8

This patch release adds the tool-free GPT-5.6 MoA model, ordered path-safe tool-batch waves, global context-budget controls, and evidence-gated computer-use integrations.

| Area | What changed |
|------|--------------|
| Models | Added `openai-codex/gpt-5.6-moa`: bounded concurrent Sol/Terra analysis with a single Sol synthesis, plus hardened Codex terminal and cancellation handling. |
| Agent loop | Ordered `partitionToolBatchWaves` preserve safe parallel reads while path conflicts and unknown calls remain sequential. |
| Context control | Added global `contextBudget.enabled` and `compaction.model`; planner cache selection stays within the remaining tier budget. |
| Evidence / verification | Correctness Wall fixtureless live OA now requires a bound MCP handler and otherwise stays preview-only; the evidence ledger is tamper-evident. |
| Computer use | Added a project-local Stagehand extension and `omk-computeruse` skill with explicit operator approval and redacted results. |
| Release safety | Nested extension `node_modules` are excluded from release staging while extension source and lockfiles remain versioned. |

GitHub-focused release notes live in [RELEASE_NOTES_v0.90.8.md](https://github.com/dmae97/omk/blob/v0.90.8/.github/RELEASE_NOTES_v0.90.8.md). The GitHub release workflow also extracts the canonical release body from [packages/coding-agent/CHANGELOG.md](https://github.com/dmae97/omk/blob/v0.90.8/packages/coding-agent/CHANGELOG.md).

OMK is a minimal terminal coding harness. Adapt omk to your workflows, not the other way around, without having to fork and modify omk internals. Extend it with TypeScript [Extensions](#extensions), [Skills](#skills), [Prompt Templates](#prompt-templates), and [Themes](#themes). Put your extensions, skills, prompt templates, and themes in [OMK Packages](#omk-packages) and share them with others via npm or git.

OMK ships with powerful defaults but skips features like sub agents and plan mode. Instead, you can ask omk to build what you want or install a third party omk package that matches your workflow.

OMK runs in four modes: interactive, print or JSON, RPC for process integration, and an SDK for embedding in your own apps. See [openclaw/openclaw](https://github.com/openclaw/openclaw) for a real-world SDK integration.

## Share your OSS coding agent sessions

If you use omk for open source work, please share your coding agent sessions.

Public OSS session data helps improve models, prompts, tools, and evaluations using real development workflows.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, share OMK session JSONL files from `~/.omk/agent/sessions/` with a Hugging Face dataset or another public archive. Include the OMK version, provider/model, and repository context when it is safe to publish.

## Table of Contents

- [Quick Start](#quick-start)
- [Providers & Models](#providers--models)
- [Interactive Mode](#interactive-mode)
  - [Editor](#editor)
  - [Commands](#commands)
  - [Keyboard Shortcuts](#keyboard-shortcuts)
  - [Message Queue](#message-queue)
- [Sessions](#sessions)
  - [Branching](#branching)
  - [Compaction](#compaction)
- [Settings](#settings)
- [Context Files](#context-files)
- [Customization](#customization)
  - [Prompt Templates](#prompt-templates)
  - [Skills](#skills)
  - [Extensions](#extensions)
  - [Themes](#themes)
  - [OMK Packages](#omk-packages)
- [Programmatic Usage](#programmatic-usage)
- [Philosophy](#philosophy)
- [CLI Reference](#cli-reference)

---

## Quick Start

```bash
npm install -g --ignore-scripts open-multi-agent-kit
```

`--ignore-scripts` disables dependency lifecycle scripts during install. OMK does not require install scripts for normal npm installs.

Installer alternative:

```bash
curl -fsSL https://omk.dev/install.sh | sh
```

Authenticate with an API key or an existing subscription:

```bash
omk
/login  # Then select provider and sign in with OAuth or save an API key
```

Then just talk to omk. By default, omk gives the model four tools: `read`, `write`, `edit`, and `bash`. The model uses these to fulfill your requests. Add capabilities via [skills](#skills), [prompt templates](#prompt-templates), [extensions](#extensions), or [omk packages](#omk-packages).

**Platform notes:** [Windows](docs/windows.md) | [Termux (Android)](docs/termux.md) | [tmux](docs/tmux.md) | [Terminal setup](docs/terminal-setup.md) | [Shell aliases](docs/shell-aliases.md)

---

## Providers & Models

For each built-in provider, omk maintains a list of tool-capable models, updated with every release. Authenticate via subscription (`/login`) or API key, then select any model from that provider via `/model` (or Ctrl+L).

**Subscriptions:**
- Anthropic Claude Pro/Max
- OpenAI ChatGPT Plus/Pro (Codex)
- GitHub Copilot

**API keys:**
- Anthropic
- Ant Ling
- OpenAI
- Azure OpenAI
- DeepSeek
- NVIDIA NIM
- Google Gemini
- Google Vertex
- Amazon Bedrock
- Mistral
- Groq
- Cerebras
- Cloudflare AI Gateway
- Cloudflare Workers AI
- xAI
- OpenRouter
- Vercel AI Gateway
- ZAI
- ZAI Coding Plan (China)
- OpenCode Zen
- OpenCode Go
- Hugging Face
- Fireworks
- Together AI
- Kimi For Coding
- MiniMax
- Xiaomi MiMo
- Xiaomi MiMo Token Plan (China)
- Xiaomi MiMo Token Plan (Amsterdam)
- Xiaomi MiMo Token Plan (Singapore)
- Zyloo

See [docs/providers.md](docs/providers.md) for detailed setup instructions.

**Custom providers & models:** Add providers via `~/.omk/agent/models.json` if they speak a supported API (OpenAI, Anthropic, Google). For custom APIs or OAuth, use extensions. See [docs/models.md](docs/models.md) and [docs/custom-provider.md](docs/custom-provider.md).

---

## Interactive Mode

<p align="center"><img src="https://raw.githubusercontent.com/dmae97/open-multi-agent-kit/v0.90.4/packages/coding-agent/docs/images/interactive-mode.png" alt="Interactive Mode" width="600"></p>

The interface from top to bottom:

- **Startup header** - Shows shortcuts (`/hotkeys` for all), loaded AGENTS.md files, prompt templates, skills, and extensions
- **Messages** - Your messages, assistant responses, tool calls and results, notifications, errors, and extension UI
- **Editor** - Where you type; border color indicates thinking level
- **Footer** - Working directory, session name, total token/cache usage (`↑` input, `↓` output, `R` cache read, `W` cache write, `CH` latest cache hit rate), cost, context usage, current model

The editor can be temporarily replaced by other UI, like built-in `/settings` or custom UI from extensions (e.g., a Q&A tool that lets the user answer model questions in a structured format). [Extensions](#extensions) can also replace the editor, add widgets above/below it, a status line, custom footer, or overlays.

### Editor

| Feature | How |
|---------|-----|
| File reference | Type `@` to fuzzy-search project files |
| Path completion | Tab to complete paths |
| Multi-line | Shift+Enter (or Ctrl+Enter on Windows Terminal) |
| Images | Ctrl+V to paste (Alt+V on Windows), or drag onto terminal |
| Skills/bash launcher | `!` opens skill autocomplete, `!skill:name prompt` invokes a skill, `! command` runs bash with context, `!! command` runs bash without context |

Standard editing keybindings for delete word, undo, etc. See [docs/keybindings.md](docs/keybindings.md).

### Commands

Type `/` in the editor to trigger commands. [Extensions](#extensions) can register custom commands, [skills](#skills) are available as `/skill:name`, `!skill:name`, or `!name` for known skills, and [prompt templates](#prompt-templates) expand via `/templatename`.

| Command | Description |
|---------|-------------|
| `/login`, `/logout` | OAuth authentication |
| `/model` | Switch models |
| `/scoped-models` | Enable/disable models for Ctrl+P cycling |
| `/settings` | Thinking level, theme, message delivery, transport |
| `/resume` | Pick from previous sessions |
| `/new` | Start a new session |
| `/name <name>` | Set session display name |
| `/session` | Show session info (file, ID, messages, tokens, cost) |
| `/tree` | Jump to any point in the session and continue from there |
| `/trust` | Save project trust decision for future sessions (restart required) |
| `/fork` | Create a new session from a previous user message |
| `/clone` | Duplicate the current active branch into a new session |
| `/compact [prompt]` | Manually compact context, optional custom instructions |
| `/copy` | Copy last assistant message to clipboard |
| `/export [file]` | Export session to HTML file |
| `/share` | Upload as private GitHub gist with shareable HTML link |
| `/reload` | Reload keybindings, extensions, skills, prompts, and context files (themes hot-reload automatically) |
| `/hotkeys` | Show all keyboard shortcuts |
| `/changelog` | Display version history |
| `/quit` | Quit omk |

### Keyboard Shortcuts

See `/hotkeys` for the full list. Customize via `~/.omk/agent/keybindings.json`. See [docs/keybindings.md](docs/keybindings.md).

**Commonly used:**

| Key | Action |
|-----|--------|
| Ctrl+C | Clear editor |
| Ctrl+C twice | Quit |
| Escape | Cancel/abort |
| Escape twice | Open `/tree` |
| Ctrl+L | Open model selector |
| Ctrl+P / Shift+Ctrl+P | Cycle scoped models forward/backward |
| Shift+Tab | Cycle thinking level |
| Ctrl+O | Collapse/expand tool output |
| Ctrl+T | Collapse/expand thinking blocks |

### Message Queue

Submit messages while the agent is working:

- **Enter** queues a *steering* message, delivered after the current assistant turn finishes executing its tool calls
- **Alt+Enter** queues a *follow-up* message, delivered only after the agent finishes all work
- **Escape** aborts and restores queued messages to editor
- **Alt+Up** retrieves queued messages back to editor

On Windows Terminal, `Alt+Enter` is fullscreen by default. Remap it in [docs/terminal-setup.md](docs/terminal-setup.md) so omk can receive the follow-up shortcut.

Configure delivery in [settings](docs/settings.md): `steeringMode` and `followUpMode` can be `"one-at-a-time"` (default, waits for response) or `"all"` (delivers all queued at once). `transport` selects provider transport preference (`"sse"`, `"websocket"`, or `"auto"`) for providers that support multiple transports.

---

## Sessions

Sessions are stored as JSONL files with a tree structure. Each entry has an `id` and `parentId`, enabling in-place branching without creating new files. See [docs/session-format.md](docs/session-format.md) for file format.

### Management

Sessions auto-save to `~/.omk/agent/sessions/` organized by working directory.

```bash
omk -c                  # Continue most recent session
omk -r                  # Browse and select from past sessions
omk --no-session        # Ephemeral mode (don't save)
omk --name "my task"    # Set session display name at startup
omk --session <path|id> # Use specific session file or ID
omk --fork <path|id>    # Fork specific session file or ID into a new session
```

Use `/session` in interactive mode to see the current session ID before reusing it with `--session <id>` or `--fork <id>`.

### Branching

**`/tree`** - Navigate the session tree in-place. Select any previous point, continue from there, and switch between branches. All history preserved in a single file.

<p align="center"><img src="https://raw.githubusercontent.com/dmae97/open-multi-agent-kit/v0.90.4/packages/coding-agent/docs/images/tree-view.png" alt="Tree View" width="600"></p>

- Search by typing, fold/unfold and jump between branches with Ctrl+←/Ctrl+→ or Alt+←/Alt+→, page with ←/→
- Filter modes (Ctrl+O): default → no-tools → user-only → labeled-only → all
- Press Shift+L to label entries as bookmarks and Shift+T to toggle label timestamps

**`/fork`** - Create a new session file from a previous user message on the active branch. Opens a selector, copies the active path up to that point, and places the selected prompt in the editor for modification.

**`/clone`** - Duplicate the current active branch into a new session file at the current position. The new session keeps the full active-path history and opens with an empty editor.

**`--fork <path|id>`** - Fork an existing session file or partial session UUID directly from the CLI. This copies the full source session into a new session file in the current project.

### Compaction

Long sessions can exhaust context windows. Compaction summarizes older messages while keeping recent ones.

**Manual:** `/compact` or `/compact <custom instructions>`

**Automatic:** Enabled by default. Triggers on context overflow (recovers and retries) or when approaching the limit (proactive). Configure via `/settings` or `settings.json`.

Compaction is lossy. The full history remains in the JSONL file; use `/tree` to revisit. Customize compaction behavior via [extensions](#extensions). See [docs/compaction.md](docs/compaction.md) for internals.

---

## Settings

Use `/settings` to modify common options, or edit JSON files directly:

| Location | Scope |
|----------|-------|
| `~/.omk/agent/settings.json` | Global (all projects) |
| `.omk/settings.json` | Project (overrides global) |

See [docs/settings.md](docs/settings.md) for all options.

### Project Trust

On interactive startup, omk asks before trusting a project folder that contains project-local settings, resources, or project `.agents/skills` and has no saved decision for the folder or a parent folder in `~/.omk/agent/trust.json`. Trusting a project allows omk to load `.omk/settings.json` and `.omk` resources, install missing project packages, and execute project extensions.

Before the trust decision, omk loads only context files, user/global extensions, and CLI `-e` extensions so they can handle the `project_trust` event. Project-local extensions, project package-managed extensions, and project settings are loaded only after the project is trusted. This split also applies when switching to a session from a different cwd whose trust has not been resolved in the current process.

Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust prompt. Without an applicable saved trust decision, they use `defaultProjectTrust` from global settings: `ask` (default) and `never` ignore those project resources, while `always` trusts them. Pass `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run.

If no extension or saved decision applies, `defaultProjectTrust` controls the fallback behavior. Set it to `"ask"`, `"always"`, or `"never"` in `~/.omk/agent/settings.json`, or change it with `/settings`.

`omk config` and package commands use the same project trust flow, except `omk update` never prompts. Pass `--approve` to trust project-local settings for one command or `--no-approve` to ignore them.

Use `/trust` in interactive mode to save a project trust decision for future sessions, including trust for the immediate parent folder. It writes `~/.omk/agent/trust.json` only; the current session is not reloaded, so restart omk for changes to take effect.

### Telemetry and update checks

OMK has two separate startup features:

- **Update check:** fetches `https://omk.dev/api/latest-version` to check whether a newer OMK version exists. Disable it with `OMK_SKIP_VERSION_CHECK=1`. Disabling update checks only turns off this check.
- **Install/update telemetry:** after first install or a changelog-detected update, sends an anonymous version ping to `https://omk.dev/api/report-install`. This setting also controls optional provider attribution headers for OpenRouter, Cloudflare, and direct NVIDIA NIM requests. Opt out by setting `enableInstallTelemetry` to `false` in `settings.json`, or by setting `OMK_TELEMETRY=0`. This does not disable update checks; OMK may still contact `omk.dev` for the latest version unless update checks are disabled or offline mode is enabled.

Use `--offline` or `OMK_OFFLINE=1` to disable all startup network operations described here, including update checks, package update checks, and install/update telemetry.

---

## Context Files

OMK loads `AGENTS.md` (or `CLAUDE.md`) at startup from:
- `~/.omk/agent/AGENTS.md` (global)
- Parent directories (walking up from cwd)
- Current directory

Override context files are also discovered in the same locations:
- `AGENTS.override.md`
- `AGENTS.GODMODE.md`
- `GODMODE.md`
- `ENI.override.md`

These override files are loaded in addition to `AGENTS.md`/`CLAUDE.md` and are concatenated with them. Use them for project-specific rules, conventions, and common commands that must coexist with or extend base instructions.

Disable context file loading with `--no-context-files` (or `-nc`).

### System Prompt

Replace the default system prompt with `.omk/SYSTEM.md` (project) or `~/.omk/agent/SYSTEM.md` (global). Append without replacing via `APPEND_SYSTEM.md`.

---

## Customization

### Prompt Templates

Reusable prompts as Markdown files. Type `/name` to expand.

```markdown
<!-- ~/.omk/agent/prompts/review.md -->
Review this code for bugs, security issues, and performance problems.
Focus on: {{focus}}
```

Place in `~/.omk/agent/prompts/`, `.omk/prompts/`, or a [omk package](#omk-packages) to share with others. See [docs/prompt-templates.md](docs/prompt-templates.md).

### Skills

On-demand capability packages following the [Agent Skills standard](https://agentskills.io). Invoke via `/skill:name`, `!skill:name`, or `!name` when the name is unambiguous, or let the agent load them automatically.

```markdown
<!-- ~/.omk/agent/skills/my-skill/SKILL.md -->
# My Skill
Use this skill when the user asks about X.

## Steps
1. Do this
2. Then that
```

Place in `~/.omk/agent/skills/`, `~/.agents/skills/`, `.omk/skills/`, or `.agents/skills/` (from `cwd` up through parent directories) or a [omk package](#omk-packages) to share with others. See [docs/skills.md](docs/skills.md).

### Extensions

<p align="center"><img src="https://raw.githubusercontent.com/dmae97/open-multi-agent-kit/v0.90.4/packages/coding-agent/docs/images/doom-extension.png" alt="Doom Extension" width="600"></p>

TypeScript modules that extend omk with custom tools, commands, keyboard shortcuts, event handlers, and UI components.

```typescript
export default function (omk: ExtensionAPI) {
  omk.registerTool({ name: "deploy", ... });
  omk.registerCommand("stats", { ... });
  omk.on("tool_call", async (event, ctx) => { ... });
}
```

The default export can also be `async`. omk waits for async extension factories before startup continues, which is useful for one-time initialization such as fetching remote model lists before calling `omk.registerProvider()`.

**What's possible:**
- Custom tools (or replace built-in tools entirely)
- Sub-agents and plan mode
- Custom compaction and summarization
- Permission gates and path protection
- Custom editors and UI components
- Status lines, headers, footers
- Git checkpointing and auto-commit
- SSH and sandbox execution
- MCP server integration
- Make omk look like Claude Code
- Games while waiting (yes, Doom runs)
- ...anything you can dream up

Place in `~/.omk/agent/extensions/`, `.omk/extensions/`, or a [omk package](#omk-packages) to share with others. See [docs/extensions.md](docs/extensions.md) and [examples/extensions/](examples/extensions/).

### Themes

Built-in: `dark`, `light`. Themes hot-reload: modify the active theme file and omk immediately applies changes.

Place in `~/.omk/agent/themes/`, `.omk/themes/`, or a [omk package](#omk-packages) to share with others. See [docs/themes.md](docs/themes.md).

### OMK Packages

Bundle and share extensions, skills, prompts, and themes via npm or git. Find packages on [npmjs.com](https://www.npmjs.com/search?q=keywords%3Aomk-package) or [Discord](https://discord.com/channels/1456806362351669492/1457744485428629628).

> **Security:** OMK packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform any action including running executables. Review source code before installing third-party packages.

```bash
omk install npm:@foo/omk-tools
omk install npm:@foo/omk-tools@1.2.3      # pinned version
omk install git:github.com/user/repo
omk install git:github.com/user/repo@v1  # tag or commit
omk install git:git@github.com:user/repo
omk install git:git@github.com:user/repo@v1  # tag or commit
omk install https://github.com/user/repo
omk install https://github.com/user/repo@v1      # tag or commit
omk install ssh://git@github.com/user/repo
omk install ssh://git@github.com/user/repo@v1    # tag or commit
omk remove npm:@foo/omk-tools
omk uninstall npm:@foo/omk-tools          # alias for remove
omk list
omk update                               # update omk and packages (skips pinned packages)
omk update --extensions                  # update packages only
omk update --self                        # update omk only
omk update --self --force                # reinstall omk even if current
omk update npm:@foo/omk-tools             # update one package
omk config                               # enable/disable extensions, skills, prompts, themes
```

Packages install to `~/.omk/agent/git/` (git) or `~/.omk/agent/npm/` (npm). Use `-l` for project-local installs (`.omk/git/`, `.omk/npm/`). Git `@ref` values are pinned tags or commits; pinned packages are skipped by `omk update`, so use `omk install git:host/user/repo@new-ref` to move an existing package to a new ref. Git packages install dependencies with `npm install --omit=dev` by default, so runtime deps must be listed under `dependencies`; when `npmCommand` is configured, git packages use plain `install` for compatibility with wrappers. If you use a Node version manager and want package installs to reuse a stable npm context, set `npmCommand` in `settings.json`, for example `["mise", "exec", "node@20", "--", "npm"]`.

Create a package by adding a `omk` key to `package.json`:

```json
{
  "name": "my-omk-package",
  "keywords": ["omk-package"],
  "omk": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Without a `omk` manifest, omk auto-discovers from conventional directories (`extensions/`, `skills/`, `prompts/`, `themes/`).

See [docs/packages.md](docs/packages.md).

---

## Programmatic Usage

### SDK

```typescript
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "open-multi-agent-kit";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
});

await session.prompt("What files are in the current directory?");
```

For advanced multi-session runtime replacement, use `createAgentSessionRuntime()` and `AgentSessionRuntime`.

See [docs/sdk.md](docs/sdk.md) and [examples/sdk/](examples/sdk/).

### RPC Mode

For non-Node.js integrations, use RPC mode over stdin/stdout:

```bash
omk --mode rpc
```

RPC mode uses strict LF-delimited JSONL framing. Clients must split records on `\n` only. Do not use generic line readers like Node `readline`, which also split on Unicode separators inside JSON payloads.

See [docs/rpc.md](docs/rpc.md) for the protocol.

---

## Philosophy

OMK is aggressively extensible so it doesn't have to dictate your workflow. Features that other tools bake in can be built with [extensions](#extensions), [skills](#skills), or installed from third-party [omk packages](#omk-packages). This keeps the core minimal while letting you shape omk to fit how you work.

**No MCP.** Build CLI tools with READMEs (see [Skills](#skills)), or build an extension that adds MCP support. [Why?](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/)

**No sub-agents.** There's many ways to do this. Spawn omk instances via tmux, or build your own with [extensions](#extensions), or install a package that does it your way.

**No permission popups.** Run in a container, or build your own confirmation flow with [extensions](#extensions) inline with your environment and security requirements.

**No plan mode.** Write plans to files, or build it with [extensions](#extensions), or install a package.

**No built-in to-dos.** They confuse models. Use a TODO.md file, or build your own with [extensions](#extensions).

**No background bash.** Use tmux. Full observability, direct interaction.

The goal is a small core with workflow-specific behavior supplied by user code and packages.

---

## CLI Reference

```bash
omk [options] [@files...] [messages...]
```

### Package Commands

```bash
omk install <source> [-l]     # Install package, -l for project-local
omk remove <source> [-l]      # Remove package
omk uninstall <source> [-l]   # Alias for remove
omk update [source|self|omk]   # Update omk and packages (skips pinned packages)
omk update --extensions       # Update packages only
omk update --self             # Update omk only
omk update --self --force     # Reinstall omk even if current
omk update --extension <src>  # Update one package
omk list                      # List installed packages
omk config                    # Enable/disable package resources
```

`omk config` and project package commands accept `--approve`/`--no-approve` to trust or ignore project-local settings for one command. `omk update` never prompts for project trust.

### Modes

| Flag | Description |
|------|-------------|
| (default) | Interactive mode |
| `-p`, `--print` | Print response and exit |
| `--mode json` | Output all events as JSON lines (see [docs/json.md](docs/json.md)) |
| `--mode rpc` | RPC mode for process integration (see [docs/rpc.md](docs/rpc.md)) |
| `--export <in> [out]` | Export session to HTML |

In print mode, omk also reads piped stdin and merges it into the initial prompt:

```bash
cat README.md | omk -p "Summarize this text"
```

### Model Options

| Option | Description |
|--------|-------------|
| `--provider <name>` | Provider (anthropic, openai, google, etc.) |
| `--model <pattern>` | Model pattern or ID (supports `provider/id` and optional `:<thinking>`) |
| `--api-key <key>` | API key (overrides env vars) |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `--models <patterns>` | Comma-separated patterns for Ctrl+P cycling |
| `--list-models [search]` | List available models |

### Session Options

| Option | Description |
|--------|-------------|
| `-c`, `--continue` | Continue most recent session |
| `-r`, `--resume` | Browse and select session |
| `--session <path\|id>` | Use specific session file or partial UUID |
| `--fork <path\|id>` | Fork specific session file or partial UUID into a new session |
| `--session-dir <dir>` | Custom session storage directory |
| `--no-session` | Ephemeral mode (don't save) |
| `--name <name>`, `-n <name>` | Set session display name at startup |

### Tool Options

| Option | Description |
|--------|-------------|
| `--tools <list>`, `-t <list>` | Allowlist specific tool names across built-in, extension, and custom tools |
| `--exclude-tools <list>`, `-xt <list>` | Disable specific tool names across built-in, extension, and custom tools |
| `--no-builtin-tools`, `-nbt` | Disable built-in tools by default but keep extension/custom tools enabled |
| `--no-tools`, `-nt` | Disable all tools by default |

Available built-in tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`

### Resource Options

| Option | Description |
|--------|-------------|
| `-e`, `--extension <source>` | Load extension from path, npm, or git (repeatable) |
| `--no-extensions` | Disable extension discovery |
| `--skill <path>` | Load skill (repeatable) |
| `--no-skills` | Disable skill discovery |
| `--prompt-template <path>` | Load prompt template (repeatable) |
| `--no-prompt-templates` | Disable prompt template discovery |
| `--theme <path>` | Load theme (repeatable) |
| `--no-themes` | Disable theme discovery |
| `--no-context-files`, `-nc` | Disable AGENTS.md and CLAUDE.md context file discovery |

Combine `--no-*` with explicit flags to load exactly what you need, ignoring settings.json (e.g., `--no-extensions -e ./my-ext.ts`).

### Other Options

| Option | Description |
|--------|-------------|
| `--system-prompt <text>` | Replace default prompt (context files and skills still appended) |
| `--append-system-prompt <text>` | Append to system prompt |
| `--verbose` | Force verbose startup |
| `-a`, `--approve` | Trust project-local files for this run |
| `-na`, `--no-approve` | Ignore project-local files for this run |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

### File Arguments

Prefix files with `@` to include in the message:

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

# Model with provider prefix (no --provider needed)
omk --model openai/gpt-4o "Help me refactor"

# Model with thinking level shorthand
omk --model sonnet:high "Solve this complex problem"

# Limit model cycling
omk --models "claude-*,gpt-4o"

# Read-only mode
omk --tools read,grep,find,ls -p "Review the code"

# Disable one extension or built-in tool while keeping the rest available
omk --exclude-tools ask_question

# High thinking level
omk --thinking high "Solve this complex problem"
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `OMK_CODING_AGENT_DIR` | Override config directory (default: `~/.omk/agent`) |
| `OMK_CODING_AGENT_SESSION_DIR` | Override session storage directory (overridden by `--session-dir`) |
| `OMK_PACKAGE_DIR` | Override package directory (useful for Nix/Guix where store paths tokenize poorly) |
| `OMK_OFFLINE` | Disable startup network operations, including update checks, package update checks, and install/update telemetry |
| `OMK_SKIP_VERSION_CHECK` | Skip the OMK version update check at startup. This prevents the `omk.dev` latest-version request |
| `OMK_TELEMETRY` | Override install/update telemetry and provider attribution headers. Use `1`/`true`/`yes` to enable or `0`/`false`/`no` to disable. This does not disable update checks |
| `OMK_CACHE_RETENTION` | Set to `long` for extended prompt cache (Anthropic: 1h, OpenAI: 24h) |
| `VISUAL`, `EDITOR` | External editor for Ctrl+G |

---

## Contributing & Development

See [CONTRIBUTING.md](https://github.com/dmae97/open-multi-agent-kit/blob/v0.90.4/CONTRIBUTING.md) for guidelines and [docs/development.md](docs/development.md) for setup, forking, and debugging.

---

## License

MIT

## See Also

- [omk-ai](https://www.npmjs.com/package/omk-ai): Core LLM toolkit
- [omk-agent-core](https://www.npmjs.com/package/omk-agent-core): Agent framework
- [omk-tui](https://www.npmjs.com/package/omk-tui): Terminal UI components
