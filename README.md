<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/hero.png?raw=true" alt="Pi Monorepo">
</p>

<p align="center">
  <strong>AI coding agent for the terminal</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent"><img src="https://img.shields.io/npm/v/@oh-my-pi/pi-coding-agent?style=flat&colorA=222222&colorB=CB3837" alt="npm version"></a>
  <a href="https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/CHANGELOG.md"><img src="https://img.shields.io/badge/changelog-keep-E05735?style=flat&colorA=222222" alt="Changelog"></a>
  <a href="https://github.com/can1357/oh-my-pi/actions"><img src="https://img.shields.io/github/actions/workflow/status/can1357/oh-my-pi/ci.yml?style=flat&colorA=222222&colorB=3FB950" alt="CI"></a>
  <a href="https://github.com/can1357/oh-my-pi/blob/main/LICENSE"><img src="https://img.shields.io/github/license/can1357/oh-my-pi?style=flat&colorA=222222&colorB=58A6FF" alt="License"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&colorA=222222&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/Rust-DEA584?style=flat&colorA=222222&logo=rust&logoColor=white" alt="Rust"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=flat&colorA=222222" alt="Bun"></a>
  <a href="https://discord.gg/4NMW9cdXZa"><img src="https://img.shields.io/badge/Discord-5865F2?style=flat&colorA=222222&logo=discord&logoColor=white" alt="Discord"></a>
</p>

<p align="center">
  Fork of <a href="https://github.com/badlogic/pi-mono">badlogic/pi-mono</a> by <a href="https://github.com/mariozechner">@mariozechner</a>
</p>

## Table of Contents

- [Highlights](#highlights)
- [Installation](#installation)
- [Getting Started](#getting-started)
  - [Terminal Setup](#terminal-setup)
  - [API Keys & OAuth](#api-keys--oauth)
  - [First 15 Minutes (Recommended)](#first-15-minutes-recommended)
- [Usage](#usage)
  - [Slash Commands](#slash-commands)
  - [Editor Features](#editor-features)
  - [Keyboard Shortcuts](#keyboard-shortcuts)
  - [Bash Mode](#bash-mode)
  - [Image Support](#image-support)
- [Sessions](#sessions)
  - [Session Management](#session-management)
  - [Context Compaction](#context-compaction)
  - [Branching](#branching)
  - [Autonomous Memory](#autonomous-memory)
- [Configuration](#configuration)
  - [Project Context Files](#project-context-files)
  - [Custom System Prompt](#custom-system-prompt)
  - [Custom Models and Providers](#custom-models-and-providers)
  - [Settings File](#settings-file)
- [Extensions](#extensions)
  - [Themes](#themes)
  - [Custom Slash Commands](#custom-slash-commands)
  - [Skills](#skills)
  - [Hooks](#hooks)
  - [Custom Tools](#custom-tools)
- [CLI Reference](#cli-reference)
- [Tools](#tools)
- [Programmatic Usage](#programmatic-usage)
  - [SDK](#sdk)
  - [RPC Mode](#rpc-mode)
  - [HTML Export](#html-export)
- [Philosophy](#philosophy)
- [Development](#development)
- [Monorepo Packages](#monorepo-packages)
- [License](#license)

---

## Highlights

### + Commit Tool (AI-Powered Git Commits)

AI-powered conventional commit generation with intelligent change analysis:

- **Agentic mode**: Tool-based git inspection with `git-overview`, `git-file-diff`, `git-hunk` for fine-grained analysis
- **Split commits**: Automatically separates unrelated changes into atomic commits with dependency ordering
- **Hunk-level staging**: Stage individual hunks when changes span multiple concerns
- **Changelog generation**: Proposes and applies changelog entries to `CHANGELOG.md` files
- **Commit validation**: Detects filler words, meta phrases, and enforces conventional commit format
- **Legacy mode**: `--legacy` flag for deterministic pipeline when preferred
- Run via `omp commit` with options: `--push`, `--dry-run`, `--no-changelog`, `--context`

### + Python Tool (IPython Kernel)

<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/python.webp?raw=true" alt="python">
</p>

Execute Python code with a persistent IPython kernel and rich helper prelude:

- **Streaming output**: Real-time stdout/stderr with image and JSON rendering
- **Prelude helpers**: File I/O, search, find/replace, line operations, shell, and text utilities built into the kernel
- **Line operations**: `lines()`, `insert_at()`, `delete_lines()`, `delete_matching()` and related helpers for precise edits
- **Shared gateway**: Resource-efficient kernel reuse across sessions (`python.sharedGateway` setting)
- **Custom modules**: Load extensions from `.omp/modules/` and `~/.omp/agent/modules/`
- **Rich output**: Supports `display()` for HTML, Markdown, images, and interactive JSON trees
- **Markdown rendering**: Python cell output with Markdown content renders inline
- **Mermaid diagrams**: Renders mermaid code blocks as inline graphics in iTerm2/Kitty terminals
- Install dependencies via `omp setup python`

### + LSP Integration (Language Server Protocol)

<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/lspv.webp?raw=true" alt="lsp">
</p>

Full IDE-like code intelligence with automatic formatting and diagnostics:

- **11 LSP operations**: `diagnostics`, `definition`, `type_definition`, `implementation`, `references`, `hover`, `symbols`, `rename`, `code_actions`, `status`, `reload`
- **Format-on-write**: Auto-format code using the language server's formatter (rustfmt, gofmt, prettier, etc.)
- **Diagnostics on write/edit**: Immediate feedback on syntax errors and type issues after every file change
- **Workspace diagnostics**: Check entire project for errors with `lsp` action `diagnostics` (without a file)
- **40+ language configs**: Out-of-the-box support for Rust, Go, Python, TypeScript, Java, Kotlin, Scala, Haskell, OCaml, Elixir, Ruby, PHP, C#, Lua, Nix, and many more
- **Local binary resolution**: Auto-discovers project-local LSP servers in `node_modules/.bin/`, `.venv/bin/`, etc.
- **Symbol disambiguation**: `occurrence` parameter resolves repeated symbols on the same line

### + Time Traveling Streamed Rules (TTSR)

<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/ttsr.webp?raw=true" alt="ttsr">
</p>

Zero context-use rules that inject themselves only when needed:

- **Pattern-triggered injection**: Rules define regex triggers that watch the model's output stream
- **Just-in-time activation**: When a pattern matches, the stream aborts, the rule injects as a system reminder, and the request retries
- **Zero upfront cost**: TTSR rules consume no context until they're actually relevant
- **One-shot per session**: Each rule only triggers once, preventing loops
- Define via `ttsrTrigger` field in rule files (regex pattern)

Example: A "don't use deprecated API" rule only activates when the model starts writing deprecated code, saving context for sessions that never touch that API.

### + Interactive Code Review

<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/review.webp?raw=true" alt="review">
</p>

Structured code review with priority-based findings:

- **`/review` command**: Interactive mode selection (branch comparison, uncommitted changes, commit review)
- **Structured findings**: `report_finding` tool with priority levels (P0-P3: critical → nit)
- **Verdict rendering**: aggregates findings into approve/request-changes/comment
- Combined result tree showing verdict and all findings

### + Task Tool (Subagent System)

<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/task.webp?raw=true" alt="task">
</p>

Parallel execution framework with specialized agents and real-time streaming:

- **6 bundled agents**: explore, plan, designer, reviewer, task, quick_task
- **Parallel exploration**: Reviewer agent can spawn explore agents for large codebase analysis
- **Real-time artifact streaming**: Task outputs stream as they're created, not just at completion
- **Full output access**: Read complete subagent output via `agent://<id>` resources when previews truncate
- **Isolation backends**: `isolated: true` runs tasks in git worktrees, Unix fuse-overlay filesystems, or Windows ProjFS (`fuse-projfs`), with patch or branch merge strategies
- **Async background jobs**: Background execution with configurable concurrency (up to 100 jobs) and `poll` tool for blocking on results
- **Agent Control Center**: `/agents` dashboard for managing and creating custom agents
- **AI-powered agent creation**: Generate custom agent definitions with the architect model
- **Per-agent model overrides**: Assign specific models to individual agents via swarm extension
- User-level (`~/.omp/agent/agents/`) and project-level (`.omp/agents/`) custom agents

### + Model Roles

<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/models.webp?raw=true" alt="models">
</p>

Configure different models for different purposes with automatic discovery:

- **Role-based routing**: `default`, `smol`, `slow`, `plan`, and `commit` roles
- **Configurable discovery**: Role defaults are auto-resolved and can be overridden per role
- **Role-based selection**: Task tool agents can use `model: pi/smol` for cost-effective exploration
- CLI args (`--smol`, `--slow`, `--plan`) and env vars (`PI_SMOL_MODEL`, `PI_SLOW_MODEL`, `PI_PLAN_MODEL`)
- Configure roles interactively via `/model` selector and persist assignments to settings

### + Todo Tool (Task Tracking)

Structured task management with phased progress tracking:

- **Phased task lists**: Organize work into named phases with ordered tasks
- **5 operations**: `replace` (setup), `add_phase`, `add_task`, `update` (status changes), `remove_task`
- **4 task states**: `pending`, `in_progress`, `completed`, `abandoned`
- **Auto-normalization**: Ensures exactly one task is `in_progress` at all times
- **Persistent panel**: Todo list displays above the editor with real-time progress
- **Completion reminders**: Agent warned when stopping with incomplete todos (`todo.reminders` setting)
- **Toggle visibility**: `Ctrl+T` expands/collapses the todo panel

### + Ask Tool (Interactive Questioning)

<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/ask.webp?raw=true" alt="ask">
</p>

Structured user interaction with typed options:

- **Multiple choice questions**: Present options with descriptions for user selection
- **Multi-select support**: Allow multiple answers when choices aren't mutually exclusive
- **Multi-part questions**: Ask multiple related questions in sequence via `questions` array parameter

### + Custom TypeScript Slash Commands

<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/slash.webp?raw=true" alt="slash">
</p>

Programmable commands with full API access:

- Create at `~/.omp/agent/commands/[name]/index.ts` or `.omp/commands/[name]/index.ts`
- Export factory returning `{ name, description, execute(args, ctx) }`
- Full access to `HookCommandContext` for UI dialogs, session control, shell execution
- Return string to send as LLM prompt, or void for fire-and-forget actions
- Also loads from Claude Code directories (`~/.claude/commands/`, `.claude/commands/`)

### + Universal Config Discovery

<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/discovery.webp?raw=true" alt="discovery">
</p>

Unified capability-based discovery that loads configuration from 8 AI coding tools:

- **Multi-tool support**: Claude Code, Cursor, Windsurf, Gemini, Codex, Cline, GitHub Copilot, VS Code
- **Discovers everything**: MCP servers, rules, skills, hooks, tools, slash commands, prompts, context files
- **Native format support**: Cursor MDC frontmatter, Windsurf rules, Cline `.clinerules`, Copilot `applyTo` globs, Gemini `system.md`, Codex `AGENTS.md`
- **Provider attribution**: See which tool contributed each configuration item
- **Discovery settings**: Enable/disable individual providers via `/extensions` interactive dashboard
- **Priority ordering**: Multi-path resolution across `.omp`, `.claude`, `.codex`, and `.gemini` directories

### + MCP & Plugin System

<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/perplexity.webp?raw=true" alt="perplexity">
</p>

Full Model Context Protocol support with external tool integration:

- Stdio and HTTP transports for connecting to MCP servers
- **OAuth support**: Explicit `clientId` and `callbackPort` in MCP server config, manual OAuth callbacks via slash commands
- **Browser server filtering**: Automatically filters browser-type MCP servers to prevent conflicts with built-in browser tool
- **Automatic Exa filtering**: Extracts Exa API keys and prefers the native Exa integration
- **Config schema + setup guide**: [`docs/mcp-config.md`](./docs/mcp-config.md) and [`packages/coding-agent/src/config/mcp-schema.json`](./packages/coding-agent/src/config/mcp-schema.json)
- Plugin CLI (`omp plugin install/enable/configure/doctor`)
- Hot-loadable plugins from `~/.omp/plugins/` with npm/bun integration
- `disabledServers` works on both project-level and user-level third-party servers

### + Web Search & Fetch

<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/arxiv.webp?raw=true" alt="arxiv">
</p>

Multi-provider search and full-page scraping with specialized handlers:

- **Multi-provider search**: `auto`, `exa`, `brave`, `jina`, `kimi`, `zai`, `anthropic`, `perplexity`, `gemini`, `codex`, `synthetic`
- **Specialized handlers**: Site-specific extraction for code hosts, registries, research sources, forums, and docs
- **Package registries**: npm, PyPI, crates.io, Hex, Hackage, NuGet, Maven, RubyGems, Packagist, pub.dev, Go packages
- **Security databases**: NVD, OSV, CISA KEV vulnerability data
- HTML-to-markdown conversion with link preservation

### + SSH Tool

Remote command execution with persistent connections:

- **Project discovery**: Reads SSH hosts from `ssh.json` / `.ssh.json` in your project
- **Host management**: Add, remove, and list hosts via `omp ssh` CLI or `/ssh` slash command
- **Persistent connections**: Reuses SSH connections across commands for faster execution
- **OS/shell detection**: Automatically detects remote OS and shell type
- **SSHFS mounts**: Optional automatic mounting of remote directories
- **Compat mode**: Windows host support with automatic shell probing

### + Browser Tool (Puppeteer with Stealth)

Headless browser automation with 14 stealth scripts to evade bot detection:

- **Automation actions**: Navigate, click, type, fill, scroll, drag, screenshot, evaluate JS, and extract readable content
- **Accessibility snapshots**: Observe interactive elements via the accessibility tree with numeric IDs for reliable targeting
- **14 stealth plugins**: Custom scripts covering toString tampering, WebGL fingerprinting, audio context, screen dimensions, font enumeration, plugin/mime-type mocking, hardware concurrency, codec availability, iframe detection, locale spoofing, worker detection, and more
- **User agent spoofing**: Removes `HeadlessChrome` identifier, generates proper Client Hints brand lists, applies overrides via CDP Network and Emulation domains
- **Selector flexibility**: CSS, `aria/`, `text/`, `xpath/`, `pierce/` query handlers for Shadow DOM piercing
- **Reader mode**: `extract_readable` action uses Mozilla Readability for clean article extraction
- **Headless/visible toggle**: Switch modes at runtime via `/browser` command or `browser.headless` setting
- **NixOS support**: Automatically detects NixOS (`/etc/NIXOS`) and resolves a system Chromium (`chromium` on PATH, `~/.nix-profile/bin/chromium`, or `/run/current-system/sw/bin/chromium`) since Puppeteer's bundled binary cannot run on a non-FHS system

### + Cursor Provider

Use your Cursor Pro subscription for AI completions:

- **Browser-based OAuth**: Authenticate through Cursor's OAuth flow
- **Tool execution bridge**: Maps Cursor's native tools to omp equivalents (read, write, shell, diagnostics)
- **Conversation caching**: Persists context across requests in the same session
- **Shell streaming**: Real-time stdout/stderr during command execution

### + Multi-Credential Support

Distribute load across multiple API keys:

- **Round-robin distribution**: Automatically cycles through credentials per session
- **Usage-aware selection**: For OpenAI Codex, checks account limits before credential selection
- **Automatic fallback**: Switches credentials mid-session when rate limits are hit
- **Consistent hashing**: FNV-1a hashing ensures stable credential assignment per session

### + Image Generation

Create images directly from the agent:

- **Gemini integration**: Uses `gemini-3-pro-image-preview` by default
- **OpenRouter fallback**: Automatically uses OpenRouter when `OPENROUTER_API_KEY` is set
- **Inline display**: Images render in terminals supporting Kitty/iTerm2 graphics
- Saves to temp files and reports paths for further manipulation

### + TUI Overhaul

Modern terminal interface with smart session management:

- **Auto session titles**: Sessions automatically titled based on first message using commit model, fallback to smol
- **Welcome screen**: Logo, tips, recent sessions with selection
- **Powerline footer**: Model, cwd, git branch/status, token usage, context %
- **LSP status**: Shows which language servers are active and ready
- **Hotkeys**: `?` displays shortcuts when editor empty
- **Persistent prompt history**: SQLite-backed with `Ctrl+R` search across sessions
- **Grouped tool display**: Consecutive Read calls shown in compact tree view
- **Streaming text preview**: Real-time delta updates during agent output
- **Overlay UI**: Custom hooks can display components as bottom-centered overlays
- **Configurable tab width**: `display.tabWidth` setting with `.editorconfig` integration
- **Scrollback preservation**: Uses home+erase-below instead of clear-screen
- **Emergency terminal restore**: Crash handlers prevent terminal corruption

### + Hashline Edits

Hashline gives every line a short content-hash anchor. The model references anchors instead of reproducing text — no whitespace reproduction, no "string not found", no ambiguous matches. If the file changed since the last read, hashes won't match and the edit is rejected before anything gets corrupted.

Benchmarked across 16 models, 180 tasks, 3 runs each:

- **Grok Code Fast 1**: 6.7% → 68.3% — a _tenfold_ improvement hidden behind mechanical patch failures
- **Gemini 3 Flash**: +5pp over `str_replace`, beating Google's own best attempt
- **Grok 4 Fast**: 61% fewer output tokens — stopped burning context on retry loops
- **MiniMax**: more than doubled success rate
- Matches or beats `str_replace` for nearly every model tested; weakest models gain the most

### + Native Engine (Rust N-API)

~7,500 lines of Rust compiled to a platform-tagged N-API addon, providing performance-critical operations without shelling out to external commands:

| Module        |  Lines | What it does                                                                                                                                         | Powered by                                                        |
| ------------- | -----: | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **grep**      | ~1,300 | Regex search over files and in-memory content, parallel/sequential modes, glob/type filtering, context lines, fuzzy find for autocomplete            | `grep-regex`, `grep-searcher`, `grep-matcher` (ripgrep internals) |
| **shell**     | ~1,025 | Embedded bash execution with persistent sessions, streaming output, timeout/abort, custom builtins                                                   | [brush-shell](https://github.com/reubeno/brush) (vendored)        |
| **text**      | ~1,280 | ANSI-aware visible width, truncation with ellipsis, column slicing, text wrapping that preserves SGR codes across line breaks — all UTF-16 optimized | `unicode-width`, `unicode-segmentation`                           |
| **keys**      | ~1,300 | Kitty keyboard protocol parser with legacy xterm/VT100 fallback, modifier support, PHF perfect-hash lookup                                           | `phf`                                                             |
| **highlight** |   ~475 | Syntax highlighting with 11 semantic color categories, 30+ language aliases                                                                          | `syntect`                                                         |
| **glob**      |   ~340 | Filesystem discovery with glob patterns, type filtering, mtime sorting, `.gitignore` respect                                                         | `ignore`, `globset` (ripgrep internals)                           |
| **task**      |   ~350 | Blocking work scheduler on libuv thread pool, cooperative/external cancellation, timeout, profiling hooks                                            | `tokio`, `napi`                                                   |
| **ps**        |   ~290 | Cross-platform process tree kill and descendant listing — `/proc` on Linux, `libproc` on macOS, `CreateToolhelp32Snapshot` on Windows                | `libc`                                                            |
| **prof**      |   ~250 | Always-on circular buffer profiler with folded-stack output and optional SVG flamegraph generation                                                   | `inferno`                                                         |
| **image**     |   ~150 | Decode/encode PNG/JPEG/WebP/GIF, resize with 5 sampling filters                                                                                      | `image`                                                           |
| **clipboard** |    ~95 | Text copy and image read from system clipboard — no `xclip`/`pbcopy` needed                                                                          | `arboard`                                                         |
| **html**      |    ~50 | HTML-to-Markdown conversion with optional content cleaning                                                                                           | `html-to-markdown-rs`                                             |

Supported platforms: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`.

### ... and many more

- **`omp config` subcommand**: Manage settings from CLI (`list`, `get`, `set`, `reset`, `path`)
- **`omp setup` subcommand**: Install optional dependencies (e.g., `omp setup python` for Jupyter kernel)
- **`omp stats` subcommand**: Local observability dashboard for AI usage (requests, cost, cache rate, tokens/s)
- **`xhigh` thinking level**: Extended reasoning for Anthropic models with increased token budgets
- **Background mode**: `/background` detaches UI and continues agent execution
- **Completion notifications**: Configurable bell/OSC99/OSC9 when agent finishes
- **65+ built-in themes**: Catppuccin, Dracula, Nord, Gruvbox, Tokyo Night, Poimandres, and material variants
- **Automatic dark/light switching**: Mode 2031 terminal detection, native macOS appearance via CoreFoundation FFI, COLORFGBG fallback
- **Auto environment detection**: OS, distro, kernel, CPU, GPU, shell, terminal, DE in system prompt
- **Git context**: System prompt includes branch, status, recent commits
- **Bun runtime**: Native TypeScript execution, faster startup, all packages migrated
- **Centralized file logging**: Debug logs with daily rotation to `~/.omp/logs/`
- **Bash interceptor**: Optionally block shell commands that have dedicated tools
- **Per-command PTY control**: Bash tool supports `pty: true` for commands requiring a real terminal (sudo, ssh)
- **@file auto-read**: Type `@path/to/file` in prompts to inject file contents inline
- **AST tools**: `ast_grep` and `ast_edit` for syntax-aware code search and codemods via ast-grep
- **Sampling controls**: `topP`, `topK`, `minP`, `presencePenalty`, `repetitionPenalty` settings for fine-grained model tuning

---

## Installation

### Via Bun (recommended)

Requires [Bun](https://bun.sh) **>= 1.3.7**:

```bash
bun install -g @oh-my-pi/pi-coding-agent
```

### Via installer script

**Linux / macOS:**

```bash
curl -fsSL https://raw.githubusercontent.com/can1357/oh-my-pi/main/scripts/install.sh | sh
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/can1357/oh-my-pi/main/scripts/install.ps1 | iex
```

By default, the installer uses Bun when available (and compatible), otherwise installs the prebuilt binary.

Options:

- POSIX (`install.sh`): `--source`, `--binary`, `--ref <ref>`, `-r <ref>`
- PowerShell (`install.ps1`): `-Source`, `-Binary`, `-Ref <ref>`
- `--ref`/`-Ref` with binary mode must reference a release tag; branch/commit refs require source mode

Set custom install directory with `PI_INSTALL_DIR`.

Examples:

```bash
# Source install (Bun)
curl -fsSL https://raw.githubusercontent.com/can1357/oh-my-pi/main/scripts/install.sh | sh -s -- --source

# Install release tag via binary
curl -fsSL https://raw.githubusercontent.com/can1357/oh-my-pi/main/scripts/install.sh | sh -s -- --binary --ref v3.20.1

# Install branch/commit via source
curl -fsSL https://raw.githubusercontent.com/can1357/oh-my-pi/main/scripts/install.sh | sh -s -- --source --ref main
```

```powershell
# Install release tag via binary
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/can1357/oh-my-pi/main/scripts/install.ps1))) -Binary -Ref v3.20.1
# Install branch/commit via source
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/can1357/oh-my-pi/main/scripts/install.ps1))) -Source -Ref main
```

### Via [mise](https://mise.jdx.dev)

```bash
mise use -g github:can1357/oh-my-pi
```

### Manual download

Download binaries directly from [GitHub Releases](https://github.com/can1357/oh-my-pi/releases/latest).

---

## Getting Started

### Terminal Setup

Pi uses the [Kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) for reliable modifier key detection. Most modern terminals support this protocol, but some require configuration.

**Kitty, iTerm2:** Work out of the box.

**Ghostty:** Add to your Ghostty config (`~/.config/ghostty/config`):

```
keybind = alt+backspace=text:\x1b\x7f
keybind = shift+enter=text:\n
```

**wezterm:** Create `~/.wezterm.lua`:

```lua
local wezterm = require 'wezterm'
local config = wezterm.config_builder()
config.enable_kitty_keyboard = true
return config
```

**Windows Terminal:** Does not support the Kitty keyboard protocol. Shift+Enter cannot be distinguished from Enter. Use Ctrl+Enter for multi-line input instead. All other keybindings work correctly.

### API Keys & OAuth

**Option 1: Environment variables** (common examples)

| Provider                                        | Environment Variable                         |
| ----------------------------------------------- | -------------------------------------------- |
| Anthropic                                       | `ANTHROPIC_API_KEY`                          |
| OpenAI                                          | `OPENAI_API_KEY`                             |
| Google                                          | `GEMINI_API_KEY`                             |
| Mistral                                         | `MISTRAL_API_KEY`                            |
| Groq                                            | `GROQ_API_KEY`                               |
| Cerebras                                        | `CEREBRAS_API_KEY`                           |
| Hugging Face (`huggingface`)                    | `HUGGINGFACE_HUB_TOKEN` or `HF_TOKEN`        |
| Synthetic                                       | `SYNTHETIC_API_KEY`                          |
| NVIDIA (`nvidia`)                               | `NVIDIA_API_KEY`                             |
| NanoGPT (`nanogpt`)                             | `NANO_GPT_API_KEY`                           |
| Together (`together`)                           | `TOGETHER_API_KEY`                           |
| Ollama (`ollama`)                               | `OLLAMA_API_KEY` _(optional)_                |
| LiteLLM (`litellm`)                             | `LITELLM_API_KEY`                            |
| LM Studio (`lm-studio`)                         | `LM_STUDIO_API_KEY` _(optional)_             |
| llama.cpp (`llama.cpp`)                         | `LLAMA_CPP_API_KEY` _(optional)_             |
| Xiaomi MiMo (`xiaomi`)                          | `XIAOMI_API_KEY`                             |
| Moonshot (`moonshot`)                           | `MOONSHOT_API_KEY`                           |
| Venice (`venice`)                               | `VENICE_API_KEY`                             |
| Kilo Gateway (`kilo`)                           | `KILO_API_KEY`                               |
| GitLab Duo (`gitlab-duo`)                       | _OAuth only_                                 |
| Jina (`jina`, web search)                       | `JINA_API_KEY`                               |
| Perplexity                                      | `PERPLEXITY_API_KEY` or `PERPLEXITY_COOKIES` |
| xAI                                             | `XAI_API_KEY`                                |
| OpenRouter                                      | `OPENROUTER_API_KEY`                         |
| Z.AI                                            | `ZAI_API_KEY`                                |
| Qwen Portal (`qwen-portal`)                     | `QWEN_OAUTH_TOKEN` or `QWEN_PORTAL_API_KEY`  |
| vLLM (`vllm`)                                   | `VLLM_API_KEY`                               |
| Cloudflare AI Gateway (`cloudflare-ai-gateway`) | `CLOUDFLARE_AI_GATEWAY_API_KEY`              |
| Vercel AI Gateway (`vercel-ai-gateway`)         | `AI_GATEWAY_API_KEY`                         |
| Qianfan (`qianfan`)                             | `QIANFAN_API_KEY`                            |

See [Environment Variables](docs/environment-variables.md) for the full list.

**Option 2: `/login` (interactive auth / API key setup)**

Use `/login` with supported providers:

- Anthropic (Claude Pro/Max)
- ChatGPT Plus/Pro (Codex)
- GitHub Copilot
- Google Cloud Code Assist (Gemini CLI)
- Antigravity (Gemini 3, Claude, GPT-OSS)
- Cursor
- Kimi Code
- Perplexity
- NVIDIA (`nvidia`)
- NanoGPT (`nanogpt`)
- Hugging Face Inference (`huggingface`)
- OpenCode Zen
- Kilo Gateway (`kilo`)
- GitLab Duo (`gitlab-duo`)
- Qianfan (`qianfan`)
- Ollama (local / self-hosted, `ollama`)
- LM Studio (local / self-hosted, `lm-studio`)
- llama.cpp (local / self-hosted, `llama.cpp`)
- vLLM (local OpenAI-compatible, `vllm`)
- Z.AI (GLM Coding Plan)
- Synthetic
- Together (`together`)
- LiteLLM (`litellm`)
- Xiaomi MiMo (`xiaomi`)
- Moonshot (Kimi API, `moonshot`)
- Venice (`venice`)
- MiniMax Coding Plan (International / China)
- Qwen Portal (`qwen-portal`)
- Cloudflare AI Gateway (`cloudflare-ai-gateway`)
- Vercel AI Gateway (`vercel-ai-gateway`)

For `ollama`, API key is optional. Leave it unset for local no-auth instances, or set `OLLAMA_API_KEY` for authenticated hosts.
For `llama.cpp`, API key is optional. Leave it unset for local no-auth instances, or set `LLAMA_CPP_API_KEY` for authenticated hosts.
For `lm-studio`, API key is optional. Leave it unset for local no-auth instances, or set `LM_STUDIO_API_KEY` for authenticated hosts.
For `vllm`, paste your key in `/login` (or use `VLLM_API_KEY`). For local no-auth servers, any placeholder value works (for example `vllm-local`).
For `nanogpt`, `/login nanogpt` opens `https://nano-gpt.com/api` and prompts for your `sk-...` key (or set `NANO_GPT_API_KEY`). Login validates the key via NanoGPT's models endpoint (not a fixed model entitlement).
For `cloudflare-ai-gateway`, set provider base URL to
`https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic`
(for example in `~/.omp/agent/models.yml`).

```bash
omp
/login
```

**Credential behavior:**

- `/login` appends credentials for the provider (it does not wipe existing entries)
- `/logout` clears saved credentials for the selected provider
- Credentials are stored in `~/.omp/agent/agent.db`
- For the same provider, saved API key credentials are selected before OAuth credentials

### First 15 Minutes (Recommended)

This is the practical onboarding flow for new users.

#### 1) Set up providers

- **API keys** (fastest): export `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, etc.
- **OAuth subscriptions**: run `/login` and authenticate with your provider account

#### 2) Configure model roles via `/model`

Use `/model` in the TUI and assign role models:

- `default` → normal implementation work
- `smol` → fast/cheap exploration and lightweight tasks
- `slow` → deep reasoning for complex debugging/refactors
- `plan` → model used while plan mode is active (`/plan`)
- `commit` → model used by commit/changelog workflows

This setup is interactive and persisted for you.

#### 3) Use `/plan` before making large changes

`/plan` toggles plan mode. Use it when you want architecture and execution sequencing before edits.

Typical flow:

1. Run `/plan`
2. Ask for a concrete implementation plan
3. Refine the plan
4. Approve and execute

#### 4) Review context via `/extensions`

If context usage is unexpectedly high, inspect discovered external provider assets (rules/prompts/context/hooks/extensions).

Run `/extensions` and:

- Browse provider tabs (`Tab` / `Shift+Tab`)
- Inspect each item source (`via <provider>` + file path)
- Disable full providers or specific items you don't want (`Space`)

---

## Usage

### Slash Commands

These are **in-chat slash commands** (not CLI subcommands).
| Command | Description |
| ------- | ----------- |
| `/settings` | Open settings menu |
| `/plan` | Toggle plan mode |
| `/model` (`/models`) | Open model selector |
| `/export [path]` | Export session to HTML |
| `/dump` | Copy session transcript to clipboard |
| `/share` | Upload session as a secret gist |
| `/session` | Show session info and usage |
| `/usage` | Show provider usage and limits |
| `/hotkeys` | Show keyboard shortcuts |
| `/extensions` (`/status`) | Open Extension Control Center |
| `/changelog` | Show changelog entries |
| `/tree` | Navigate session tree |
| `/branch` | Open branch selector (tree or message selector, based on settings) |
| `/fork` | Fork from a previous message |
| `/resume` | Open session picker |
| `/new` | Start a new session |
| `/compact [focus]` | Compact context manually |
| `/handoff [focus]` | Hand off context to a new session |
| `/browser [headless\|visible]` | Toggle browser mode |
| `/mcp ...` | Manage MCP servers |
| `/memory ...` | Inspect/clear/rebuild memory state |
| `/move <path>` | Move current session to a different cwd |
| `/background` (`/bg`) | Detach UI and continue in background |
| `/debug` | Open debug tools |
| `/copy` | Copy last agent message |
| `/login` / `/logout` | OAuth login/logout |
| `/exit` (`/quit`) | Exit interactive mode |

Bundled custom slash commands include `/review` (interactive code review launcher).

### Editor Features

**File reference (`@`):** Type `@` to fuzzy-search project files. Respects `.gitignore`.

**Path completion (Tab):** Complete relative paths, `../`, `~/`, etc.

**Drag & drop:** Drag files from your file manager into the terminal.

**Multi-line paste:** Pasted content is collapsed in preview but sent in full.

**Message queuing:** Submit messages while the agent is working; queue behavior is configurable in `/settings`.

### Keyboard Shortcuts

**Navigation:**

| Key                      | Action                                       |
| ------------------------ | -------------------------------------------- |
| Arrow keys               | Move cursor / browse history (Up when empty) |
| Option+Left/Right        | Move by word                                 |
| Ctrl+A / Home / Cmd+Left | Start of line                                |
| Ctrl+E / End / Cmd+Right | End of line                                  |

**Editing:**

| Key                       | Action                  |
| ------------------------- | ----------------------- |
| Enter                     | Send message            |
| Shift+Enter / Alt+Enter   | New line                |
| Ctrl+W / Option+Backspace | Delete word backwards   |
| Ctrl+U                    | Delete to start of line |
| Ctrl+K                    | Delete to end of line   |

**Other:**

| Key                   | Action                                                    |
| --------------------- | --------------------------------------------------------- |
| Tab                   | Path completion / accept autocomplete                     |
| Escape                | Cancel autocomplete / abort streaming                     |
| Ctrl+C                | Clear editor (first) / exit (second)                      |
| Ctrl+D                | Exit (when editor is empty)                               |
| Ctrl+Z                | Suspend to background (use `fg` in shell to resume)       |
| Shift+Tab             | Cycle thinking level                                      |
| Ctrl+P / Shift+Ctrl+P | Cycle role models (slow/default/smol), temporary on shift |
| Alt+P                 | Select model temporarily                                  |
| Ctrl+L                | Open model selector                                       |
| Alt+Shift+P           | Toggle plan mode                                          |
| Ctrl+R                | Search prompt history                                     |
| Ctrl+O                | Toggle tool output expansion                              |
| Ctrl+T                | Toggle todo list expansion                                |
| Ctrl+G                | Edit message in external editor (`$VISUAL` or `$EDITOR`)  |
| Alt+H                 | Toggle speech-to-text recording                           |

### Bash Mode

Prefix commands with `!` to execute them and include output in context:

```bash
!git status
!ls -la
```

Use `!!` to execute but **exclude output from LLM context**:

```bash
!!git status
```

Output streams in real-time. Press Escape to cancel.

### Image Support

**Attach images by reference:**

```text
What's in @/path/to/image.png?
```

Or paste/drop images directly (`Ctrl+V` or drag-and-drop).

Supported formats: `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`

Toggle inline images via `/settings` or set `terminal.showImages: false`.

---

## Sessions

Sessions are stored as JSONL with a tree structure for branching and replay.

See [docs/session.md](docs/session.md) for the file format and API.

### Session Management

Sessions auto-save to `~/.omp/agent/sessions/` (grouped by working directory).

```bash
omp --continue             # Continue most recent session
omp -c

omp --resume               # Open session picker
omp -r

omp --resume <id-prefix>   # Resume by session ID prefix
omp --resume <path>        # Resume by explicit .jsonl path
omp --session <value>      # Alias of --resume
omp --no-session    # Ephemeral mode (don't save)
```

Session IDs are Snowflake-style hex IDs (not UUIDs).

### Context Compaction

Long sessions can exhaust context windows. Compaction summarizes older messages while keeping recent context.

**Manual:** `/compact` or `/compact Focus on the API changes`

**Automatic:** Enable via `/settings`.

- **Overflow recovery**: model returns context overflow; compact and retry.
- **Threshold maintenance**: context exceeds configured headroom after a successful turn.

**Configuration** (`~/.omp/agent/config.yml`):

```yaml
compaction:
  enabled: true
  reserveTokens: 16384
  keepRecentTokens: 20000
  autoContinue: true
```

See [docs/compaction.md](docs/compaction.md) for internals and hook integration.

### Branching

**In-place navigation (`/tree`):** Navigate the session tree without creating new files.

- Search by typing, page with ←/→
- Filter modes (`Ctrl+O`): default → no-tools → user-only → labeled-only → all
- Press `Shift+L` to label entries as bookmarks

**Create new session (`/branch` / `/fork`):** Branch to a new session file from a selected previous message.

### Autonomous Memory

When enabled, the agent extracts durable knowledge from past sessions and injects it at startup. The pipeline runs in the background and never blocks the active session.

Memory is isolated per project (working directory) and stored under `~/.omp/agent/memories/`. At session start, a compact summary is injected into the system prompt. The agent can read deeper context via `memory://root/MEMORY.md` and `memory://root/skills/<name>/SKILL.md`.

Manage via the `/memory` slash command:

- `/memory view` — show current injection payload
- `/memory clear` — delete all memory data and artifacts
- `/memory enqueue` — force consolidation at next startup

> See [Memory Documentation](docs/memory.md).

---

## Configuration

### Project Context Files

omp discovers project context from supported config directories (for example `.omp`, `.claude`, `.codex`, `.gemini`).

Common files:

- `AGENTS.md`
- `CLAUDE.md`

Use these for:

- Project instructions and guardrails
- Common commands and workflows
- Architecture documentation
- Coding/testing conventions

### Custom System Prompt

Replace the default system prompt by creating `SYSTEM.md`:

1. **Project-local:** `.omp/SYSTEM.md` (takes precedence)
2. **Global:** `~/.omp/agent/SYSTEM.md` (fallback)
   `--system-prompt` overrides both files. Use `--append-system-prompt` to append additional instructions.

### Custom Models and Providers

Add custom providers/models via `~/.omp/agent/models.yml`.

`models.json` is still supported for legacy configs, but `models.yml` is the modern format.

> See [models.yml provider integration guide](docs/models.md) for schema and merge behavior.

```yaml
providers:
  ollama:
    baseUrl: http://localhost:11434/v1
    apiKey: OLLAMA_API_KEY
    api: openai-completions
    models:
      - id: llama-3.1-8b
        name: Llama 3.1 8B (Local)
        reasoning: false
        input: [text]
        cost:
          input: 0
          output: 0
          cacheRead: 0
          cacheWrite: 0
        contextWindow: 128000
        maxTokens: 32000

  llama.cpp:
    baseUrl: http://127.0.0.1:8080
    api: openai-responses
    auth: none
    discovery:
      type: llama.cpp

equivalence:
  overrides:
    zenmux/codex: gpt-5.3-codex
    p-codex/codex: gpt-5.3-codex
  exclude:
    - demo/codex-preview
```

**Supported APIs:** `openai-completions`, `openai-responses`, `openai-codex-responses`, `azure-openai-responses`, `anthropic-messages`, `google-generative-ai`, `google-vertex`

Canonical ids are official upstream model ids such as `claude-sonnet-4-6` or `gpt-5.3-codex`. Use `equivalence.overrides` to map custom provider variants into those canonical groups while keeping explicit `provider/model` selection available.

### Settings File

Global settings are stored in:

- `~/.omp/agent/config.yml`

Project overrides are loaded from discovered project settings files (commonly `.omp/settings.json`).

Global `config.yml` example:

```yaml
theme:
  dark: titanium
  light: light

enabledModels:
  - "anthropic/*"
  - "gpt-5.3-codex"
  - "gemini-2.5-pro:high"

modelRoles:
  default: claude-sonnet-4-6
  plan: claude-opus-4-6:high
  smol: anthropic/claude-sonnet-4-6
modelProviderOrder:
  - github-copilot
  - zenmux
  - openai
defaultThinkingLevel: high

retry:
  enabled: true
  # Number of retries before giving up on rate limits/server errors
  maxRetries: 3
  # Wait this long as a base (exponentially backed off) unless the API provides a retry-after-ms
  baseDelayMs: 2000
  # Configure role-specific model fallback chains
  fallbackChains:
    default:
      - "openai/gpt-4o-mini"
      - "openai/gpt-4o"
    plan:
      - "anthropic/claude-sonnet-4-6:high"
      - "openai/o3:high"
  # Whether to revert to the primary model when a fallback's cooldown expires
  fallbackRevertPolicy: cooldown-expiry
steeringMode: one-at-a-time
followUpMode: one-at-a-time
interruptMode: immediate

shellPath: C:\\path\\to\\bash.exe
hideThinkingBlock: false
collapseChangelog: false

disabledProviders: []
disabledExtensions: []

compaction:
  enabled: true
  reserveTokens: 16384
  keepRecentTokens: 20000

skills:
  enabled: true

terminal:
  showImages: true

topP: -1 # Nucleus sampling (0-1, -1 = provider default)
topK: -1 # Top-K tokens (-1 = provider default)
minP: -1 # Minimum probability (0-1, -1 = provider default)

display:
  tabWidth: 4 # Tab rendering width (.editorconfig integration)

async:
  enabled: false
  maxJobs: 100

task:
  eager: false
  isolation:
    mode: none # none | worktree | fuse-overlay | fuse-projfs
    merge: patch # patch | branch
```

`modelRoles` may use either canonical ids or explicit `provider/model` selectors. `modelProviderOrder` decides which provider backs a canonical model when multiple equivalent variants are available.

Legacy migration notes:

- `settings.json` → `config.yml`
- `queueMode` → `steeringMode`
- flat `theme: "..."` → `theme.dark` / `theme.light`

---

## Extensions

### Themes

Built-in themes include `dark`, `light`, and many bundled variants.

**Automatic dark/light switching**: omp detects terminal appearance via Mode 2031, native macOS CoreFoundation FFI, or `COLORFGBG` fallback, and switches between `theme.dark` and `theme.light` automatically.

Select theme via `/settings` or set in `~/.omp/agent/config.yml`:

```yaml
theme:
  dark: titanium
  light: light
```

**Custom themes:** create `~/.omp/agent/themes/*.json`.

> See [Theme Documentation](docs/theme.md).

### Custom Slash Commands

Define reusable prompt commands as Markdown files:

- Global: `~/.omp/agent/commands/*.md`
- Project: `.omp/commands/*.md`

```markdown
---
description: Review staged git changes
---

Review the staged changes (`git diff --cached`). Focus on:

- Bugs and logic errors
- Security issues
- Error handling gaps
```

Filename (without `.md`) becomes the command name.

Argument placeholders:

- `$1`, `$2`, ... positional arguments
- `$@` and `$ARGUMENTS` for all arguments joined

TypeScript custom commands are also supported:

- `~/.omp/agent/commands/<name>/index.ts`
- `.omp/commands/<name>/index.ts`

Bundled TypeScript command: `/review`.

### Skills

Skills are capability packages loaded on-demand.

Common locations:

- `~/.omp/agent/skills/*/SKILL.md`
- `.omp/skills/*/SKILL.md`
- `~/.claude/skills/*/SKILL.md`, `.claude/skills/*/SKILL.md`
- `~/.codex/skills/*/SKILL.md`, `.codex/skills/*/SKILL.md`

```markdown
---
name: brave-search
description: Web search via Brave Search API.
---

# Brave Search
```

`description` drives matching; `name` defaults to the folder name when omitted.

Disable skills with `omp --no-skills` or `skills.enabled: false`.

> See [Skills Documentation](docs/skills.md).

### Hooks

Hooks are TypeScript modules that subscribe to lifecycle events.

Hook locations:

- Global: `~/.omp/agent/hooks/pre/*.ts`, `~/.omp/agent/hooks/post/*.ts`
- Project: `.omp/hooks/pre/*.ts`, `.omp/hooks/post/*.ts`
- CLI: `--hook <path>`

```typescript
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/hooks";

export default function (omp: HookAPI) {
	omp.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash" && /sudo/.test(event.input.command as string)) {
			const ok = await ctx.ui.confirm("Allow sudo?", event.input.command as string);
			if (!ok) return { block: true, reason: "Blocked by user" };
		}
		return undefined;
	});
}
```

Inject messages from hooks with:

```ts
omp.sendMessage(message, { triggerTurn: true });
```

> See [Hooks Documentation](docs/hooks.md) and [examples/hooks/](packages/coding-agent/examples/hooks/).

### Custom Tools

Custom tools extend the built-in toolset and are callable by the model.

Auto-discovered locations:

- Global: `~/.omp/agent/tools/*/index.ts`
- Project: `.omp/tools/*/index.ts`

```typescript
import { Type } from "@sinclair/typebox";
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
const factory: CustomToolFactory = () => ({
	name: "greet",
	label: "Greeting",
	description: "Generate a greeting",
	parameters: Type.Object({
		name: Type.String({ description: "Name to greet" }),
	}),
	async execute(_toolCallId, params) {
		const { name } = params as { name: string };
		return { content: [{ type: "text", text: `Hello, ${name}!` }] };
	},
});
export default factory;
```

> See [Custom Tools Documentation](docs/custom-tools.md) and [examples/custom-tools/](packages/coding-agent/examples/custom-tools/).

---

## CLI Reference

```bash
omp [options] [@files...] [messages...]
omp <command> [args] [flags]
```

### Options

| Option                                | Description                                                        |
| ------------------------------------- | ------------------------------------------------------------------ |
| `--provider <name>`                   | Provider hint (legacy; prefer `--model`)                           |
| `--model <id>`                        | Model ID (supports fuzzy match)                                    |
| `--smol <id>`                         | Override the `smol` role model for this run                        |
| `--slow <id>`                         | Override the `slow` role model for this run                        |
| `--plan <id>`                         | Override the `plan` role model for this run                        |
| `--models <patterns>`                 | Comma-separated model patterns for role cycling                    |
| `--list-models [pattern]`             | List available models (optional fuzzy filter)                      |
| `--thinking <level>`                  | Thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `--api-key <key>`                     | API key (overrides environment/provider lookup)                    |
| `--system-prompt <text\|file>`        | Replace system prompt                                              |
| `--append-system-prompt <text\|file>` | Append to system prompt                                            |
| `--mode <mode>`                       | Output mode: `text`, `json`, `rpc`                                 |
| `--print`, `-p`                       | Non-interactive: process prompt and exit                           |
| `--continue`, `-c`                    | Continue most recent session                                       |
| `--resume`, `-r [id\|path]`           | Resume by ID prefix/path (or open picker if omitted)               |
| `--session <value>`                   | Alias of `--resume`                                                |
| `--session-dir <dir>`                 | Directory for session storage and lookup                           |
| `--no-session`                        | Don't save session                                                 |
| `--tools <tools>`                     | Restrict to comma-separated built-in tool names                    |
| `--no-tools`                          | Disable all built-in tools                                         |
| `--no-lsp`                            | Disable LSP integration                                            |
| `--no-pty`                            | Disable PTY-based interactive bash execution                       |
| `--extension <path>`, `-e`            | Load extension file (repeatable)                                   |
| `--hook <path>`                       | Load hook/extension file (repeatable)                              |
| `--no-extensions`                     | Disable extension discovery (`-e` paths still load)                |
| `--no-skills`                         | Disable skills discovery and loading                               |
| `--skills <patterns>`                 | Comma-separated glob patterns to filter skills                     |
| `--no-rules`                          | Disable rules discovery and loading                                |
| `--allow-home`                        | Allow starting from home dir without auto-chdir                    |
| `--no-title`                          | Disable automatic session title generation                         |
| `--export <file> [output]`            | Export session to HTML                                             |
| `--help`, `-h`                        | Show help                                                          |
| `--version`, `-v`                     | Show version                                                       |

### Subcommands

`omp` also ships dedicated subcommands:

- `commit`
- `config`
- `grep`
- `jupyter`
- `plugin`
- `search` (alias: `q`)
- `setup`
- `shell`
- `ssh`
- `stats`
- `update`

### File Arguments

Include files with `@` prefix:

```bash
omp @prompt.md "Answer this"
omp @screenshot.png "What's in this image?"
omp @requirements.md @design.png "Implement this"
```

Text files are wrapped in `<file ...>` blocks. Images are attached.

### Examples

```bash
# Interactive mode
omp
# Non-interactive
omp -p "List all .ts files in src/"
omp -c "What did we discuss?"
# Resume by ID prefix
omp -r abc123

# Model cycling with patterns
omp --models "sonnet:high,haiku:low"

# Restrict toolset for read-only review
omp --tools read,grep,find -p "Review the architecture"
# Export session
omp --export session.jsonl output.html
```

### Environment Variables

| Variable                                          | Description                                             |
| ------------------------------------------------- | ------------------------------------------------------- |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.       | Provider credentials                                    |
| `PI_CODING_AGENT_DIR`                             | Override agent data directory (default: `~/.omp/agent`) |
| `PI_PACKAGE_DIR`                                  | Override package directory resolution                   |
| `PI_SMOL_MODEL`, `PI_SLOW_MODEL`, `PI_PLAN_MODEL` | Role-model overrides                                    |
| `PI_NO_PTY`                                       | Disable PTY-based bash execution                        |
| `VISUAL`, `EDITOR`                                | External editor for Ctrl+G                              |

See [Environment Variables](docs/environment-variables.md) for the complete reference.

---

## Tools

Use `--tools <list>` to restrict available built-in tools.

### Built-in Tool Names (`--tools`)

| Tool             | Description                                                    |
| ---------------- | -------------------------------------------------------------- |
| `ask`            | Ask the user structured follow-up questions (interactive mode) |
| `bash`           | Execute shell commands                                         |
| `python`         | Execute Python code in IPython kernel                          |
| `calc`           | Deterministic calculator/evaluator                             |
| `ssh`            | Execute commands on configured SSH hosts                       |
| `edit`           | In-place file editing with anchors                             |
| `find`           | Find files by glob pattern                                     |
| `grep`           | Search file content                                            |
| `ast_grep`       | Structural code search using AST matching (ast-grep)           |
| `ast_edit`       | Structural AST-aware code rewrites (ast-grep)                  |
| `lsp`            | Language server actions (11 operations)                        |
| `notebook`       | Edit Jupyter notebooks                                         |
| `read`           | Read files/directories (default text cap: 3000 lines)          |
| `browser`        | Browser automation tool (model-facing name: `puppeteer`)       |
| `task`           | Launch subagents for parallel execution                        |
| `poll`           | Block on async background jobs                                 |
| `todo_write`     | Phased task tracking with progress management                  |
| `fetch`          | Fetch and extract URL content                                  |
| `web_search`     | Multi-provider web search                                      |
| `write`          | Create/overwrite files                                         |
| `generate_image` | Generate or edit images using Gemini image models              |

Notes:

- Some tools are setting-gated (`calc`, `browser`, etc.)
- `ask` requires interactive UI
- `ssh` requires configured SSH hosts

Example:

`omp --tools read,grep,find -p "Review this codebase"`

For adding new tools, see [Custom Tools](#custom-tools).

---

## Programmatic Usage

### SDK

For embedding omp in Node.js/TypeScript applications, use the SDK:

```typescript
import { ModelRegistry, SessionManager, createAgentSession, discoverAuthStorage } from "@oh-my-pi/pi-coding-agent";
const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh();
const { session } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage,
	modelRegistry,
});
session.subscribe((event) => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	}
});
await session.prompt("What files are in the current directory?");
```

The SDK provides control over:

- Model selection and thinking level
- System prompt (replace or append)
- Built-in/custom tools
- Hooks, skills, context files, slash commands
- Session persistence (`SessionManager`)
- Settings (`Settings`)
- API key and OAuth resolution

> See [SDK Documentation](docs/sdk.md) and [examples/sdk/](packages/coding-agent/examples/sdk/).

### RPC Mode

For embedding from other languages or process isolation:

```bash
omp --mode rpc --no-session
```

Send JSON commands on stdin:

```json
{"id":"req-1","type":"prompt","message":"List all .ts files"}
{"id":"req-2","type":"abort"}
```

Responses are emitted as `type: "response"`; session events stream on stdout as they occur.

> See [RPC Documentation](docs/rpc.md) for the full protocol.

### HTML Export

```bash
omp --export session.jsonl              # Auto-generated filename
omp --export session.jsonl output.html  # Custom filename
```

Works with session files and JSON event logs from `--mode json`.

---

## Philosophy

omp is a fork of [pi-mono](https://github.com/badlogic/pi-mono) by [Mario Zechner](https://github.com/mariozechner), extended with a batteries-included coding workflow.

Key ideas:

- Keep interactive terminal-first UX for real coding work
- Include practical built-ins (tools, sessions, branching, subagents, extensibility)
- Make advanced behavior configurable rather than hidden

---

## Development

### Debug Command

`/debug` opens tools for debugging, reporting, and profiling.

For architecture and contribution guidelines, see [packages/coding-agent/DEVELOPMENT.md](packages/coding-agent/DEVELOPMENT.md).

---

## Monorepo Packages

| Package                                                   | Description                                                                |
| --------------------------------------------------------- | -------------------------------------------------------------------------- |
| **[@oh-my-pi/pi-ai](packages/ai)**                        | Multi-provider LLM client with streaming and model/provider integration    |
| **[@oh-my-pi/pi-agent-core](packages/agent)**             | Agent runtime with tool calling and state management                       |
| **[@oh-my-pi/pi-coding-agent](packages/coding-agent)**    | Interactive coding agent CLI and SDK                                       |
| **[@oh-my-pi/pi-tui](packages/tui)**                      | Terminal UI library with differential rendering                            |
| **[@oh-my-pi/pi-natives](packages/natives)**              | N-API bindings for grep, shell, image, text, syntax highlighting, and more |
| **[@oh-my-pi/omp-stats](packages/stats)**                 | Local observability dashboard for AI usage statistics                      |
| **[@oh-my-pi/pi-utils](packages/utils)**                  | Shared utilities (logging, streams, dirs/env/process helpers)              |
| **[@oh-my-pi/swarm-extension](packages/swarm-extension)** | Swarm orchestration extension package                                      |

### Rust Crates

| Crate                                                         | Description                                                                                  |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **[pi-natives](crates/pi-natives)**                           | Core Rust native addon used by `@oh-my-pi/pi-natives`                                        |
| **[brush-core-vendored](crates/brush-core-vendored)**         | Vendored fork of [brush-shell](https://github.com/reubeno/brush) for embedded bash execution |
| **[brush-builtins-vendored](crates/brush-builtins-vendored)** | Vendored bash builtins (cd, echo, test, printf, read, export, etc.)                          |

---

## License

MIT. See [LICENSE](LICENSE).

Copyright (c) 2025 Mario Zechner  
Copyright (c) 2025-2026 Can Bölük
