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
  - [Memory](#memory)
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
  - [Marketplace](#marketplace)
- [CLI Reference](#cli-reference)
- [Tools](#tools)
- [Programmatic Usage](#programmatic-usage)
  - [SDK](#sdk)
  - [RPC Mode](#rpc-mode)
  - [ACP Mode](#acp-mode)
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

### + Eval Tool (Multi-Language Code Execution)

<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/python.webp?raw=true" alt="eval">
</p>

Persistent multi-language REPL for the agent. One tool, two backends, a shared helper prelude — replaces the previous standalone Python tool:

- **Cell header format**: One header per cell — `*** Cell <lang>:"<title>" [t:<duration>] [rst]`. `lang` is `py` or `js`; `t:` sets a per-cell timeout, `rst` wipes the cell's own language kernel before running
- **Python backend**: Spawns one `python -u runner.py` subprocess per kernel speaking NDJSON over stdin/stdout. Cancellation sends `SIGINT` (real `KeyboardInterrupt`); the same subprocess is reused across cells in session mode. No Jupyter dependency
- **JavaScript backend**: Worker-pool runtime with `process`, Web APIs, `Buffer`, `fs/promises`, and `Bun` globals; top-level `await` works, static ESM imports are rewritten to resolve against the session cwd
- **Shared prelude**: `read`, `write`, `display`, `tree`, `diff`, `env`, `output`, plus `tool.<name>(args)` to invoke any session tool (read, write, edit, github, …) from inside a cell
- **Browser-tab JS shares the runtime**: `browser` tool `run` cells expose the same helper globals and ESM rewriting as `eval` JS cells
- **Magics without IPython**: `%pip`, `%cd`, `%env`, `%time`, `%timeit`, `%%bash`, `%%capture`, `%%writefile`, `!shell`, … work natively in the subprocess backend
- **Markdown / image rendering**: `display()` accepts text, JSON, dataframes, figures, images; `text/markdown` output renders inline; mermaid fences render as graphics in iTerm2 / Kitty
- Toggle backends via `eval.py` / `eval.js` settings; install Python with `omp setup python`

### + LSP Integration (Language Server Protocol)

<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/lspv.webp?raw=true" alt="lsp">
</p>

Full IDE-like code intelligence with automatic formatting and diagnostics:

- **13 LSP operations**: `diagnostics`, `definition`, `type_definition`, `implementation`, `references`, `hover`, `symbols`, `rename`, `rename_file`, `code_actions`, `request`, `capabilities`, `status`, `reload`
- **Format-on-write**: Auto-format code using the language server's formatter (rustfmt, gofmt, prettier, etc.)
- **Diagnostics on write/edit**: Immediate feedback on syntax errors and type issues after every file change
- **Workspace diagnostics**: Check entire project for errors with `lsp` action `diagnostics` (without a file)
- **40+ language configs**: Out-of-the-box support for Rust, Go, Python, TypeScript, Java, Kotlin, Scala, Haskell, OCaml, Elixir, Ruby, PHP, C#, Lua, Nix, and many more
- **File renames**: `rename_file` routes through `workspace/willRenameFiles` / `didRenameFiles` so import updates land before the disk move; `apply: false` previews edits
- **Arbitrary requests**: `request` invokes any LSP method with auto-built `textDocument`/`position` params or raw JSON payload
- **Local binary resolution**: Auto-discovers project-local LSP servers in `node_modules/.bin/`, `.venv/bin/`, etc.
- **Symbol disambiguation**: `occurrence` parameter resolves repeated symbols on the same line

### + DAP Integration (Debug Adapter Protocol)

Drive a real debugger from the agent — set breakpoints, step through code, inspect threads/stack/variables, and pause runaway processes — instead of bisecting with `printf`:

- **27 debug operations**: `launch`, `attach`, `set_breakpoint` / `remove_breakpoint` (source or function, with optional `condition`), `set_instruction_breakpoint`, `data_breakpoint_info` / `set_data_breakpoint`, `continue`, `step_over` / `step_in` / `step_out`, `pause`, `evaluate` (`context: "repl"` for raw debugger commands), `stack_trace`, `threads`, `scopes`, `variables`, `disassemble`, `read_memory` / `write_memory`, `modules`, `loaded_sources`, `output` (captured stdout/stderr), `custom_request`, `terminate`, `sessions`
- **14 bundled adapters**: `gdb`, `lldb-dap`, `codelldb`, `debugpy`, `dlv`, `js-debug-adapter`, `netcoredbg`, `kotlin-debug-adapter`, `rdbg` (Ruby), `php-debug-adapter`, `bash-debug-adapter`, `dart-debug-adapter`, `flutter-debug-adapter`, `elixir-ls-debugger`
- **Auto-selection**: Adapter is inferred from program path / extension + workspace root markers (`Cargo.toml`, `go.mod`, `pyproject.toml`, …); override with `adapter: "lldb-dap"` when you want a specific debugger
- **Local + remote**: `pid` for local attach, `port` for remote attach where the adapter supports it
- **Pause runaway code**: `pause` interrupts a running program so the agent can inspect threads / stack / variables before deciding to `continue` or `terminate`
- **Single active session**: One debug session at a time per agent; `terminate` cleans up; `sessions` lists tracked sessions
- Gated by `debug.enabled` (default `true`); the adapter binary must be reachable on `PATH` (or the program's project dir) at launch time

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

Parallel execution framework with specialized agents, live peer messaging, and real-time streaming:

- **7 bundled agents**: `explore`, `plan`, `designer`, `reviewer`, `librarian`, `task`, `quick_task`
- **IRC peer messaging**: Subagents see live siblings + parent in their `# IRC Peers` block and can DM each other mid-flight via the `irc` tool, so a serial waterfall can become parallel with one round-trip clarification
- **Real-time artifact streaming**: Task outputs stream as they're created, not just at completion
- **Full output access**: Read complete subagent output via `agent://<id>` resources (or extract a JSON field via `agent://<id>/path`) when previews truncate
- **Isolation backends**: `task.isolation.mode` selects from `auto`, `apfs`, `btrfs`, `zfs`, `reflink`, `overlayfs`, `projfs`, `block-clone`, `rcopy` (PAL-backed copy-on-write filesystems), with patch or branch merge strategies
- **Async background jobs**: Background execution with configurable concurrency (up to 100 jobs); the unified `job` tool handles `poll`, `cancel`, and `list` with per-agent ownership scoping
- **Agent Control Center**: `/agents` dashboard for managing and creating custom agents
- **AI-powered agent creation**: Generate custom agent definitions with the architect model
- **Per-agent model overrides**: Assign specific models to individual agents via swarm extension
- User-level (`~/.omp/agent/agents/`) and project-level (`.omp/agents/`) custom agents

### + IRC Peer Messaging

Live agent-to-agent messaging across parent and subagent sessions — no file polling, no orchestrator round-trips:

- **`irc` tool**: `op: "list"` enumerates visible peers (`0-Main`, task ids like `0-AuthLoader`); `op: "send"` delivers a DM or `to: "all"` broadcast
- **Synchronous side-channel**: The recipient generates a prose reply on an ephemeral turn even while its main loop is mid-tool-call; the exchange is injected into both transcripts on the next turn
- **Live in-chat rendering**: The main agent's UI relays every peer exchange so the human sees coordination happen
- **`AgentRegistry`**: Process-global registry pre-registers each subagent before its system prompt is built, so initial `# IRC Peers` blocks reflect siblings spawned in the same batch
- Gated by `irc.enabled` (default `true`)

### + GitHub as Virtual Filesystem

Issues, PRs, and diffs are addressable as virtual markdown files. The agent doesn't learn a new tool surface to browse GitHub — it just `read`s a URL, the same way it reads any other file. No copy-pasting issue bodies into prompts, no scraping PR pages, no separate "github" subcommand to remember:

- **Read an issue**: `read issue://1234` — rendered as markdown with title, author, labels, body, and threaded comments
- **Read a PR**: `read pr://1234` (append `?comments=0` to skip the discussion). Each PR view points the agent at the matching diff URL
- **Read a diff**: `read pr://1234/diff` (changed-file listing), `read pr://1234/diff/3` (third file only), `read pr://1234/diff/all` (full unified diff). Hashline anchors work on diff slices, so the agent can quote a hunk by anchor without reproducing whitespace
- **Browse**: bare `read issue://` or `read pr://` lists recent items; filter with `?state=open|closed|merged|all`, `?author=`, `?label=`, `?limit=`
- **Cross-repo**: `read issue://owner/repo/N` works the same way for repositories outside the current checkout
- **Background refresh**: A soft TTL serves recent fetches instantly; a hard TTL serves stale-but-readable while a background fetch refreshes the cache, so the agent never blocks on a network round-trip to re-read the same issue mid-session

The complementary `github` tool covers the operations a URL can't model: `pr_create`, `pr_checkout`, `pr_push`, `run_watch`, and the `search_*` family (issues, PRs, code, commits, repos) with relative-time filters like `since: "3d"` / `until: "1w"`. Search calls `gh api` directly so multi-qualifier queries (`is:merged is:pr`) reach GitHub verbatim instead of getting silently re-quoted by `gh search`.

### + Hindsight Memory

Opt-in long-term memory backend that records facts, retrieves them on relevant turns, and curates project-level mental models:

- **Three tools**: `retain` (queue a memory write — non-blocking, batched up to 16 items / 5s), `recall` (search prior memories), `reflect` (post-session summarization)
- **Scoping modes**: `hindsight.scoping` is `global`, `per-project`, or `per-project-tagged` (default — global + project memories merge on recall via tags)
- **Mental models**: Bank-level curated summaries injected as `<mental_models>` developer instructions. Built-in seeds for user preferences, project conventions, and project decisions; manage via `/memory mm list|show|refresh|history|seed|reload|delete`
- **First-turn recall**: Auto-injects relevant memories as a `<memories>` block before the opening user message
- **Retention hygiene**: `<mental_models>` and recall blocks are stripped before storing transcripts so curated context never feeds back as new memory
- **Backend selector**: `memory.backend` is `off`, `local`, or `hindsight`; subagents persist into the parent's bank

### + ACP Mode (Agent Client Protocol)

Run omp as an ACP server over stdio so any compliant editor or harness can drive it:

- **`omp acp` subcommand**: Launches with the same stdout-quiet semantics as `--mode rpc` so no banner leaks into the JSON-RPC channel
- **Client bridge**: When the client advertises capabilities, `bash` routes through `terminal/*`, `read`/`write` route through `fs/read_text_file` / `fs/write_text_file` (surfacing unsaved editor buffers), and `bash`/`edit`/`write`/`ast_edit` are gated by `session/request_permission` (with `allow_always` / `reject_always` decisions remembered for the session)
- **Slash-command parity**: ACP equivalents for `/jobs`, `/changelog`, `/dump`, `/copy`, `/hotkeys`, `/extensions`, `/agents`, `/model`, `/plan`, `/loop`, `/btw`, `/login`, `/logout`, `/resume`, `/tree`, `/branch`, `/new`, `/drop`, `/handoff`, `/fork`, `/export`, `/share`, `/todo`, `/memory`, `/move`, `/mcp`, `/ssh`, `/marketplace`, `/plugins`, plus `/skill:<name>`
- **Plan mode advertised as ACP mode**: `session/new`/`load`/`resume`/`fork` expose a `plan` mode alongside `default`; `session/set_mode` toggles plan-mode for the next turn
- **Rich tool reporting**: Edit results emit `diff` `ToolCallContent` (per-file `oldText` / `newText`); `tool_call_update` `locations` refresh from in-flight args; `StopReason` differentiates `end_turn`, `max_tokens`, `refusal`, `cancelled`
- **Custom extension methods** are prefixed `_omp/*` per the ACP `_`-prefix requirement for non-spec methods

### + Loop Mode

`/loop [count|duration]` re-issues the last user prompt automatically:

- **Bounded by count or time**: `/loop 10` stops after 10 iterations; `/loop 10m` / `/loop 10min` stops after the duration; bare `/loop` toggles unbounded mode
- **Configurable per-iteration action**: Repeat the last prompt, run a stored prompt, or fire a custom action
- **Status line**: Enabled status surfaces the configured limit and remaining budget
- **Strict argument parsing**: Malformed counts or durations surface a usage error instead of silently enabling unbounded loop

### + Conflict Resolution

First-class git merge-conflict workflow inside `read` and `write`:

- **`read` detection**: Each fully-formed column-0 marker block (`<<<<<<<` … `>>>>>>>`) is registered with a session-stable `#N` id and a warning badge (`⚠ N`) on the read tool UI. `read <path>:conflicts` returns a one-line-per-block index of every unresolved conflict
- **Inspect sides**: `read conflict://<N>` shows the recorded region; `read conflict://<N>/ours|theirs|base` shows one side with original-file line alignment
- **Resolve with content tokens**: `write({ path: "conflict://<N>", content })` splices the recorded marker region. `content` may be replacement text or any combination of shorthand tokens `@ours`, `@theirs`, `@base`, `@both`
- **Bulk resolve**: `write({ path: "conflict://*", content })` expands tokens per conflict across every registered block in one call
- **Safe splice**: Validates the live file still contains the recorded markers before splicing, and re-locates the block by exact marker content if line numbers have shifted out-of-band

### + Internal URL Read Schemes

`read` is the single entry point for everything the agent might need to inspect — files, URLs, and a family of internal schemes:

- **`local://`** — session-shared artifacts (`local://PLAN.md`, briefs passed to subagents)
- **`agent://<id>` / `agent://<id>/<json.path>`** — full subagent output, with optional JSON field extraction
- **`artifact://<id>`** — spilled tool output truncated in the live transcript
- **`memory://root`** — project memory summary
- **`issue://<N>` / `pr://<N>`** — GitHub issues, PRs, and diffs as virtual markdown files (see GitHub as Virtual Filesystem)
- **`mcp://<uri>`** — MCP resource fetched via the active manager
- **`skill://<name>` / `skill://<name>/<path>`** — skill instructions and files
- **`rule://<name>`** — rule details
- **`conflict://<N>`** — merge-conflict regions captured by a prior read

Resolution is process-global so parents and subagents see each other's outputs without explicit wiring.

### + Recipe Tool (Project Task Runner)

Run project tasks through one tool that auto-detects every common runner in the working directory:

- **Auto-detection**: `package.json` scripts (including workspace packages), `Cargo.toml` bin/example/test targets, `Justfile`, `Makefile`, `Taskfile.yml`
- **Single `op` argument**: `op: "test"` or `op: "build --release"`; monorepo namespacing uses `/` (`pkg-a/test`, `crate/bin/server`)
- **Runner-qualified syntax**: `runnerId:task` disambiguates identical task names across multiple runners
- **Auto-availability**: Requesting `bash` automatically pulls in `recipe` when a supported manifest is detected; `bash` stays independently available
- **Unified output**: Same shape as `bash` — exit code, stdout/stderr merged, artifact spillover for long output

### + Model Roles

<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/models.webp?raw=true" alt="models">
</p>

Configure different models for different purposes with automatic discovery:

- **Role-based routing**: `default`, `smol`, `slow`, `plan`, and `commit` roles
- **Configurable discovery**: Role defaults are auto-resolved and can be overridden per role
- **Role-based selection**: Task tool agents can use `model: pi/smol` for cost-effective exploration
- **Generic OpenAI-compat discovery**: Any provider exposing `/v1/models` (llama.cpp, Ollama, LM Studio, vLLM, OpenRouter forks) is auto-enumerated; keyless-by-design providers are treated as authenticated
- **Explicit prefixes are honored**: `<provider>/<id>` no longer silently falls back to a different provider when the exact pair isn't in the bundled catalog
- CLI args (`--smol`, `--slow`, `--plan`) and env vars (`PI_SMOL_MODEL`, `PI_SLOW_MODEL`, `PI_PLAN_MODEL`)
- Configure roles interactively via `/model` selector and persist assignments to settings

### + Todo Tool (Task Tracking)

Structured task management with phased progress tracking:

- **Phased task lists**: Organize work into named phases with ordered tasks; the renderer numbers phases visually (Ⅰ. Ⅱ. Ⅲ. …)
- **Content-addressed identity**: Tasks are identified by their `content` text and phases by their `name` — no synthetic IDs
- **5 operations**: `init` (setup), `add_phase`, `add_task`, `update` (status changes), `remove_task`, plus `note` for follow-up text
- **4 task states**: `pending`, `in_progress`, `completed`, `abandoned`
- **Auto-normalization**: Ensures exactly one task is `in_progress` at all times
- **Persistent panel**: Todo list displays above the editor with real-time progress
- **`/todo` slash command**: `edit`, `copy`, `start`, `done`, `drop`, `rm`, `append`, `replace`, `export`, `import` operations with fuzzy phase/content matching
- **Markdown export/import**: `/todo export [path]` and `/todo import [path]` round-trip through `TODO.md`
- **Completion reminders**: Agent warned when stopping with incomplete todos (`todo.reminders` setting)

### + Ask Tool (Interactive Questioning)

<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/ask.webp?raw=true" alt="ask">
</p>

Structured user interaction with typed options:

- **Multiple choice questions**: Present options with descriptions for user selection
- **Multi-select support**: Allow multiple answers when choices aren't mutually exclusive
- **Multi-part questions**: Ask multiple related questions in sequence via `questions` array parameter
- **No default timeout**: `ask.timeout` defaults to `0` (wait indefinitely); set to a non-zero seconds value to auto-select the recommended option

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
- **Stable tool ordering**: Reconnects no longer reshuffle the tools array, preserving Anthropic prompt caching across MCP transport flaps
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
- **Persistent connections**: Reuses SSH connections across commands for faster execution; OpenSSH `%C` ControlMaster sockets so different user/port/jump-host combos don't share a master
- **OS/shell detection**: Automatically detects remote OS and shell type
- **SSHFS mounts**: Optional automatic mounting of remote directories
- **Compat mode**: Windows host support with automatic shell probing; native Windows callers skip multiplexing (Win32-OpenSSH does not support it)

### + Browser Tool (Puppeteer with Stealth)

Headless browser automation with 14 stealth scripts to evade bot detection:

- **`open` / `run` / `close` flow**: Named tabs survive across `run` calls and across subagents; `run` executes async JavaScript with `page`, `browser`, `tab`, `display`, `assert`, `wait` in scope
- **Shared runtime with `eval`**: Tab JS exposes the same helper globals (`read`, `write`, `display`, `tool.<name>`) and supports top-level `await` plus static ESM imports rewritten against the session cwd
- **Tab helpers**: `tab.observe()` accessibility snapshot with stable element ids, `tab.id(n)`, `tab.click`, `tab.fill`, `tab.type`, `tab.select`, `tab.uploadFile`, `tab.drag`, `tab.scrollIntoView`, `tab.waitForUrl`, `tab.waitForResponse`, `tab.evaluate`, `tab.screenshot`, `tab.extract`
- **Drive Electron desktop apps**: Same tool, same selectors — point it at any CDP-enabled Electron binary and the agent can click buttons, fill forms, run JS in the renderer, screenshot, and observe the accessibility tree. `app.path: "/Applications/Cursor.app/Contents/MacOS/Cursor"` spawns (or reuses) the app with `--remote-debugging-port`; `app.cdp_url: "http://127.0.0.1:9222"` attaches to an already-running instance; `app.target: "Settings"` substring-matches a `BrowserWindow` title/URL when the app exposes several. Used in practice to debug VS Code, Cursor, Slack, Discord, Spotify, and any Electron / NW.js / CEF wrapper that exposes CDP
- **14 stealth plugins**: toString tampering, WebGL fingerprinting, audio context, screen dimensions, font enumeration, plugin/mime-type mocking, hardware concurrency, codec availability, iframe detection, locale spoofing, worker detection, and more
- **User agent spoofing**: Removes `HeadlessChrome`, generates proper Client Hints brand lists, applies overrides via CDP Network and Emulation domains
- **Selector flexibility**: CSS, `aria/`, `text/`, `xpath/`, `pierce/` query handlers for Shadow DOM piercing
- **Reader mode**: `tab.extract()` uses Mozilla Readability for clean article extraction
- **Headless/visible toggle**: Switch modes at runtime via `/browser` command or `browser.headless` setting
- **One-command Chromium fetch**: `omp setup browser` downloads a known-good Chromium; prebuilt binaries embed the tab worker entry via `with { type: "file" }` so single-file binaries no longer fail with `Timed out initializing browser tab worker`
- **NixOS support**: Automatically detects NixOS (`/etc/NIXOS`) and resolves a system Chromium since Puppeteer's bundled binary cannot run on a non-FHS system

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
- **Disable events**: Extensions can subscribe to `credential_disabled` to react when an OAuth token is soft-disabled (e.g. `invalid_grant`) without regex-matching error messages

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
- **Persistent prompt history**: SQLite-backed with `Ctrl+R` search across sessions; substring fallback for FTS5-missed infix queries
- **Grouped tool display**: Consecutive Read calls shown in compact tree view
- **Streaming text preview**: Real-time delta updates during agent output
- **`/context` panel**: Estimated context-usage breakdown for the active session
- **Overlay UI**: Custom hooks can display components as bottom-centered overlays
- **Configurable tab width**: `display.tabWidth` setting with `.editorconfig` integration
- **Ctrl+D draft persistence**: Pressing Ctrl+D with editor text saves it as a per-session draft; resuming the session restores it
- **Scrollback preservation**: Uses home+erase-below instead of clear-screen
- **Emergency terminal restore**: Crash handlers prevent terminal corruption
- **Power assertions**: macOS `power.preventIdleSleep` / `preventSystemSleep` / `declareUserActive` / `preventDisplaySleep` settings keep the machine awake only while a prompt is in flight

### + Hashline Edits (v3)

Hashline gives every line a short content-hash anchor. The model references anchors instead of reproducing text — no whitespace reproduction, no "string not found", no ambiguous matches. If the file changed since the last read, hashes won't match and the edit is rejected before anything gets corrupted.

Hashline v3 adds:

- **Atom mode**: Compact patch language with `+`/`-`/`=`/`<` ops, range-delete (`-LidA..LidB`), range-replace (`LidA..LidB=TEXT`), and continuation lines (`\TEXT` / `\`) for multi-line replacements
- **`splice_block`**: Bracketed `(anchor)`, `[anchor]`, `[anchor`, `anchor]` locators target whole nodes or block bodies with auto-inferred delimiters (`{` for C-family, `(` for Lisp-family)
- **Structural ordinals**: Anchor a single repeated symbol on a line via ordinal disambiguation
- **Multiline sed**: `sed` as an object (`{pat, rep, g?, i?}`) with sequential chaining when multiple `sed` ops target the same anchor; global by default
- **Stale-anchor recovery**: When anchors no longer match, edits replay against a session-scoped read/search snapshot and 3-way-merge onto the current file; success output flags when recovery was used
- **Brace-shape heuristics**: Auto-absorb of duplicated structural-closing lines (`}`, `);`, `]`) when keeping them would unbalance brackets; warnings when `@Lid` lands on an opener at sibling indent (likely off-by-one foot-gun)
- **Inline syntax**: `< ANCHOR>TEXT` and `+ ANCHOR>TEXT` (separator configurable via `PI_HL_SEP`, default `>`) for one-line prepends/appends without a payload block
- **`\*** Abort` recovery marker\*\*: Stream corruption mid-patch aborts safely instead of applying partial edits

Benchmarked across 16 models, 180 tasks, 3 runs each:

- **Grok Code Fast 1**: 6.7% → 68.3% — a _tenfold_ improvement hidden behind mechanical patch failures
- **Gemini 3 Flash**: +5pp over `str_replace`, beating Google's own best attempt
- **Grok 4 Fast**: 61% fewer output tokens — stopped burning context on retry loops
- **MiniMax**: more than doubled success rate
- Matches or beats `str_replace` for nearly every model tested; weakest models gain the most

### + Native Engine (Rust N-API)

~27,000 lines of Rust across three crates (`pi-natives`, `pi-shell`, `pi-ast`) compiled to a platform-tagged N-API addon, providing performance-critical operations without shelling out to external commands:

| Module         |  Lines | What it does                                                                                                                                         | Powered by                                                        |
| -------------- | -----: | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **grep**       | ~1,900 | Regex search over files and in-memory content, parallel/sequential modes, glob/type filtering, context lines, fuzzy find for autocomplete            | `grep-regex`, `grep-searcher`, `grep-matcher` (ripgrep internals) |
| **shell**      | ~3,700 | Embedded bash execution with persistent sessions, streaming output, timeout/abort, custom builtins, command minimizer (`pi-shell` crate)             | [brush-shell](https://github.com/reubeno/brush) (vendored)        |
| **text**       | ~1,450 | ANSI-aware visible width, truncation with ellipsis, column slicing, text wrapping that preserves SGR codes across line breaks — all UTF-16 optimized | `unicode-width`, `unicode-segmentation`                           |
| **keys**       | ~1,490 | Kitty keyboard protocol parser with legacy xterm/VT100 fallback, modifier support, PHF perfect-hash lookup                                           | `phf`                                                             |
| **summarize**  | ~1,040 | Tree-sitter structural source summaries with configurable body / comment elision; backs `read`'s default code summary output (`pi-ast` crate)        | `tree-sitter`, `ast-grep-core`                                    |
| **ast**        | ~1,000 | ast-grep pattern matching and structural rewrites driving the `ast_edit` / `ast_grep` tools                                                          | `ast-grep-core`                                                   |
| **fs_cache**   |   ~840 | Mtime-keyed file cache shared by read/grep/lsp so repeated reads of the same file are zero-IO                                                        | —                                                                 |
| **highlight**  |   ~470 | Syntax highlighting with 11 semantic color categories, 30+ language aliases                                                                          | `syntect`                                                         |
| **pty**        |   ~455 | Native PTY allocation for `bash` `pty: true` (sudo, ssh interactive prompts)                                                                         | `portable-pty`                                                    |
| **workspace**  |   ~385 | Workspace tree walker with gitignore + AGENTS.md discovery in one pass                                                                               | `ignore`, `git2`                                                  |
| **glob**       |   ~410 | Filesystem discovery with glob patterns, type filtering, mtime sorting, `.gitignore` respect                                                         | `ignore`, `globset` (ripgrep internals)                           |
| **appearance** |   ~270 | Mode 2031 detection + native macOS dark/light appearance via CoreFoundation FFI                                                                      | `core-foundation`                                                 |
| **power**      |   ~270 | macOS power-assertion API for idle/system/display-sleep prevention during in-flight prompts                                                          | `IOKit` FFI                                                       |
| **task**       |   ~260 | Blocking work scheduler on libuv thread pool, cooperative/external cancellation, timeout, profiling hooks                                            | `tokio`, `napi`                                                   |
| **iso**        |   ~245 | ISO 8601 / RFC 3339 datetime parsing and formatting                                                                                                  | `time`                                                            |
| **prof**       |   ~240 | Always-on circular buffer profiler with folded-stack output and optional SVG flamegraph generation                                                   | `inferno`                                                         |
| **fd**         |   ~250 | Filesystem walker for `find`-tool replacement                                                                                                        | `ignore`                                                          |
| **ps**         |   ~195 | Cross-platform process tree kill and descendant listing — `/proc` on Linux, `libproc` on macOS, `CreateToolhelp32Snapshot` on Windows                | `libc`                                                            |
| **image**      |   ~190 | Decode/encode PNG/JPEG/WebP/GIF, resize with 5 sampling filters                                                                                      | `image`                                                           |
| **clipboard**  |    ~80 | Text copy and image read from system clipboard — no `xclip`/`pbcopy` needed                                                                          | `arboard`                                                         |
| **tokens**     |    ~65 | O200k / Cl100k BPE token counting for context budgets; both tables embedded                                                                          | `tiktoken-rs`                                                     |
| **html**       |    ~50 | HTML-to-Markdown conversion with optional content cleaning                                                                                           | `html-to-markdown-rs`                                             |

Supported platforms: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`.

### ... and many more

- **`omp acp` subcommand**: Run as an Agent Client Protocol server over stdio
- **`omp config` subcommand**: Manage settings from CLI (`list`, `get`, `set`, `reset`, `path`)
- **`omp setup` subcommand**: Install optional dependencies (`omp setup python`, `omp setup browser`)
- **`omp stats` subcommand**: Local observability dashboard for AI usage (requests, cost, cache rate, tokens/s) with input/output token totals
- **`omp jupyter` was removed**: the Python `eval` backend now runs as a subprocess (no Jupyter dependency)
- **`xhigh` thinking level**: Extended reasoning for Anthropic models with increased token budgets
- **Hide-thinking toggle**: `Ctrl+T` instructs the provider to omit reasoning summaries entirely, not just hide them client-side
- **Background mode**: `/background` detaches UI and continues agent execution
- **Completion notifications**: Configurable bell/OSC99/OSC9 when agent finishes
- **65+ built-in themes**: Catppuccin, Dracula, Nord, Gruvbox, Tokyo Night, Poimandres, and material variants
- **Automatic dark/light switching**: Mode 2031 terminal detection, native macOS appearance via CoreFoundation FFI, COLORFGBG fallback
- **Auto environment detection**: OS, distro, kernel, CPU, GPU, shell, terminal, DE in system prompt
- **Git context**: System prompt includes branch, status, recent commits
- **Workspace tree in system prompt**: Recency-sorted depth-≤3 tree of recent files / directories with truncation notices
- **AGENTS.md context discovery**: gitignore-aware walk that surfaces directory-scoped AGENTS.md and forwards results to subagents (no redundant rescans on spawn)
- **Bun runtime**: Native TypeScript execution, faster startup, all packages migrated
- **Centralized file logging**: Debug logs with daily rotation to `~/.omp/logs/`
- **Bash interceptor**: Optionally block shell commands that have dedicated tools — checks the original command before `cd …&&` normalization
- **Per-command PTY control**: `bash` tool supports `pty: true` for commands requiring a real terminal (sudo, ssh)
- **@file auto-read**: Type `@path/to/file` in prompts to inject file contents inline
- **AST tools**: `ast_grep` and `ast_edit` for syntax-aware code search and codemods via ast-grep
- **Plan mode**: ExitPlanMode offers three approvals — execute (purge), keep full transcript, or compact context (re-anchors plan on a fresh cache breakpoint)
- **`/btw` ephemeral turns**: One-shot model query that doesn't pollute the session transcript
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
curl -fsSL https://raw.githubusercontent.com/can1357/oh-my-pi/main/scripts/install.sh | sh -s -- --binary --ref v15.0.0

# Install branch/commit via source
curl -fsSL https://raw.githubusercontent.com/can1357/oh-my-pi/main/scripts/install.sh | sh -s -- --source --ref main
```

```powershell
# Install release tag via binary
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/can1357/oh-my-pi/main/scripts/install.ps1))) -Binary -Ref v15.0.0
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
| Fireworks (`fireworks`)                         | `FIREWORKS_API_KEY`                          |
| Hugging Face (`huggingface`)                    | `HUGGINGFACE_HUB_TOKEN` or `HF_TOKEN`        |
| Synthetic                                       | `SYNTHETIC_API_KEY`                          |
| NVIDIA (`nvidia`)                               | `NVIDIA_API_KEY`                             |
| NanoGPT (`nanogpt`)                             | `NANO_GPT_API_KEY`                           |
| Together (`together`)                           | `TOGETHER_API_KEY`                           |
| Ollama (`ollama`)                               | `OLLAMA_API_KEY` _(optional)_                |
| Ollama Cloud (`ollama-cloud`)                   | `OLLAMA_CLOUD_API_KEY`                       |
| LiteLLM (`litellm`)                             | `LITELLM_API_KEY`                            |
| LM Studio (`lm-studio`)                         | `LM_STUDIO_API_KEY` _(optional)_             |
| llama.cpp (`llama.cpp`)                         | `LLAMA_CPP_API_KEY` _(optional)_             |
| Xiaomi MiMo (`xiaomi`)                          | `XIAOMI_API_KEY`                             |
| Moonshot (`moonshot`)                           | `MOONSHOT_API_KEY`                           |
| Venice (`venice`)                               | `VENICE_API_KEY`                             |
| Kilo Gateway (`kilo`)                           | `KILO_API_KEY`                               |
| GitLab Duo (`gitlab-duo`)                       | `GITLAB_TOKEN` _(or OAuth)_                  |
| Cursor (`cursor`)                               | _OAuth only_                                 |
| Antigravity (`google-antigravity`)              | _OAuth only_                                 |
| Jina (`jina`, web search)                       | `JINA_API_KEY`                               |
| Kagi (`kagi`, web search)                       | `KAGI_API_KEY`                               |
| Tavily (`tavily`, web search)                   | `TAVILY_API_KEY`                             |
| Parallel (`parallel`, web search)               | `PARALLEL_API_KEY`                           |
| Perplexity                                      | `PERPLEXITY_API_KEY` or `PERPLEXITY_COOKIES` |
| xAI                                             | `XAI_API_KEY`                                |
| OpenRouter                                      | `OPENROUTER_API_KEY`                         |
| OpenCode Go (`opencode-go`)                     | `OPENCODE_API_KEY`                           |
| OpenCode Zen (`opencode-zen`)                   | `OPENCODE_API_KEY`                           |
| Z.AI                                            | `ZAI_API_KEY`                                |
| ZenMux (`zenmux`)                               | `ZENMUX_API_KEY`                             |
| MiniMax Coding Plan (`minimax-code`)            | `MINIMAX_CODE_API_KEY`                       |
| MiniMax Coding Plan CN (`minimax-code-cn`)      | `MINIMAX_CODE_CN_API_KEY`                    |
| Alibaba Coding Plan (`alibaba-coding-plan`)     | `ALIBABA_CODING_PLAN_API_KEY`                |
| Qwen Portal (`qwen-portal`)                     | `QWEN_OAUTH_TOKEN` or `QWEN_PORTAL_API_KEY`  |
| vLLM (`vllm`)                                   | `VLLM_API_KEY`                               |
| Cloudflare AI Gateway (`cloudflare-ai-gateway`) | `CLOUDFLARE_AI_GATEWAY_API_KEY`              |
| Vercel AI Gateway (`vercel-ai-gateway`)         | `AI_GATEWAY_API_KEY`                         |
| Qianfan (`qianfan`)                             | `QIANFAN_API_KEY`                            |

See [Environment Variables](docs/environment-variables.md) for the full list.

**Option 2: `/login` (interactive auth / API key setup)**

Use `/login` with supported providers (alphabetical):

- Alibaba Coding Plan (`alibaba-coding-plan`)
- Anthropic (Claude Pro/Max)
- Antigravity (`google-antigravity`, Gemini 3 / Claude / GPT-OSS)
- Cerebras (`cerebras`)
- ChatGPT Plus/Pro (Codex, `openai-codex`)
- Cloudflare AI Gateway (`cloudflare-ai-gateway`)
- Cursor (`cursor`)
- Fireworks (`fireworks`)
- GitHub Copilot (`github-copilot`)
- GitLab Duo (`gitlab-duo`)
- Google Cloud Code Assist (Gemini CLI, `google-gemini-cli`)
- Hugging Face Inference (`huggingface`)
- Kagi (`kagi`)
- Kilo Gateway (`kilo`)
- Kimi Code (`kimi-code`)
- LiteLLM (`litellm`)
- LM Studio (local / self-hosted, `lm-studio`)
- llama.cpp (local / self-hosted, `llama.cpp`)
- MiniMax Coding Plan (International, `minimax-code`)
- MiniMax Coding Plan (China, `minimax-code-cn`)
- Moonshot (Kimi API, `moonshot`)
- NanoGPT (`nanogpt`)
- NVIDIA (`nvidia`)
- Ollama (local / self-hosted, `ollama`)
- Ollama Cloud (`ollama-cloud`)
- OpenCode Go (`opencode-go`)
- OpenCode Zen (`opencode-zen`)
- Parallel (`parallel`, web search)
- Perplexity
- Qianfan (`qianfan`)
- Qwen Portal (`qwen-portal`)
- Synthetic
- Tavily (`tavily`, web search)
- Together (`together`)
- Venice (`venice`)
- Vercel AI Gateway (`vercel-ai-gateway`)
- vLLM (local OpenAI-compatible, `vllm`)
- Xiaomi MiMo (`xiaomi`)
- Z.AI (GLM Coding Plan)
- ZenMux (`zenmux`)

**Provider-specific login notes:**

- **`ollama`** — API key optional. Leave unset for local no-auth instances; set `OLLAMA_API_KEY` for authenticated hosts.
- **`llama.cpp`** — API key optional. Leave unset for local no-auth instances; set `LLAMA_CPP_API_KEY` for authenticated hosts.
- **`lm-studio`** — API key optional. Leave unset for local no-auth instances; set `LM_STUDIO_API_KEY` for authenticated hosts.
- **`vllm`** — paste your key in `/login` (or use `VLLM_API_KEY`). For local no-auth servers, any placeholder value works (for example `vllm-local`).
- **`nanogpt`** — `/login nanogpt` opens `https://nano-gpt.com/api` and prompts for your `sk-...` key (or set `NANO_GPT_API_KEY`). Validates the key via NanoGPT's models endpoint, not a fixed model entitlement.
- **`cloudflare-ai-gateway`** — set the provider base URL to `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic` (for example in `~/.omp/agent/models.yml`).

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

#### 5) Manage subagents via `/agents`

Open the Agent Control Center to inspect, configure, and toggle subagents (the `task` tool's dispatch targets).

Run `/agents` and:

- Browse discovered agents (built-in, project, user, and marketplace-installed)
- Inspect each agent's source file, model, tools, and system prompt
- Enable/disable agents per project, or scope-toggle to user/project
- Open the underlying agent definition for editing

---

---

## Usage

### Slash Commands

These are **in-chat slash commands** (not CLI subcommands).

| Command                            | Description                                                                                                                                                                                                           |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/settings`                        | Open settings menu                                                                                                                                                                                                    |
| `/plan [prompt]`                   | Toggle plan mode                                                                                                                                                                                                      |
| `/model` (`/models`)               | Open model selector                                                                                                                                                                                                   |
| `/fast [on\|off\|status]`          | Toggle OpenAI service-tier fast mode                                                                                                                                                                                  |
| `/loop [count\|duration]`          | Toggle loop mode (re-submits next prompt after each yield)                                                                                                                                                            |
| `/export [path]`                   | Export session to HTML                                                                                                                                                                                                |
| `/dump`                            | Copy session transcript to clipboard                                                                                                                                                                                  |
| `/share`                           | Upload session as a secret GitHub gist                                                                                                                                                                                |
| `/copy [last\|code\|all\|cmd]`     | Copy last agent message / code block(s) / last bash or python command                                                                                                                                                 |
| `/todo <subcommand>`               | View/edit todo list (`edit`, `copy`, `export`, `import`, `append`, `start`, `done`, `drop`, `rm`)                                                                                                                     |
| `/session [info\|delete]`          | Show session info or delete the current session                                                                                                                                                                       |
| `/usage`                           | Show provider usage and limits                                                                                                                                                                                        |
| `/jobs`                            | Show async background jobs status                                                                                                                                                                                     |
| `/changelog [full]`                | Show changelog entries                                                                                                                                                                                                |
| `/hotkeys`                         | Show keyboard shortcuts                                                                                                                                                                                               |
| `/tools`                           | Show tools currently visible to the agent                                                                                                                                                                             |
| `/context`                         | Show estimated context usage breakdown                                                                                                                                                                                |
| `/extensions` (`/status`)          | Open Extension Control Center dashboard                                                                                                                                                                               |
| `/agents`                          | Open Agent Control Center dashboard                                                                                                                                                                                   |
| `/tree`                            | Navigate session tree (switch branches)                                                                                                                                                                               |
| `/branch`                          | Branch from a previous message (tree or message selector)                                                                                                                                                             |
| `/fork`                            | Fork from a previous message into a new session                                                                                                                                                                       |
| `/resume`                          | Open session picker                                                                                                                                                                                                   |
| `/new`                             | Start a new session                                                                                                                                                                                                   |
| `/drop`                            | Delete current session and start a new one                                                                                                                                                                            |
| `/compact [focus]`                 | Manually compact session context                                                                                                                                                                                      |
| `/handoff [focus]`                 | Hand off context to a new session                                                                                                                                                                                     |
| `/btw <question>`                  | Ephemeral side question using the current context                                                                                                                                                                     |
| `/retry`                           | Retry the last failed agent turn                                                                                                                                                                                      |
| `/rename <title>`                  | Rename the current session                                                                                                                                                                                            |
| `/move <path>`                     | Move session to a different working directory                                                                                                                                                                         |
| `/background` (`/bg`)              | Detach UI and continue running in background                                                                                                                                                                          |
| `/browser [headless\|visible]`     | Toggle browser headless/visible mode                                                                                                                                                                                  |
| `/mcp <subcommand>`                | Manage MCP servers (`add`, `list`, `remove`, `test`, `reauth`, `unauth`, `enable`, `disable`, `smithery-search`, `smithery-login`, `smithery-logout`, `reconnect`, `reload`, `resources`, `prompts`, `notifications`) |
| `/ssh <subcommand>`                | Manage SSH hosts (`add`, `list`, `remove`)                                                                                                                                                                            |
| `/memory <subcommand>`             | Inspect/clear/rebuild memory (`view`, `clear`/`reset`, `enqueue`/`rebuild`, `mm list\|show\|refresh\|history\|seed\|delete\|reload`)                                                                                  |
| `/marketplace <subcommand>`        | Manage marketplace sources and plugins (`add`, `remove`, `update`, `list`, `discover`, `install`, `uninstall`, `installed`, `upgrade`)                                                                                |
| `/plugins [list\|enable\|disable]` | View and manage installed plugins (npm + marketplace)                                                                                                                                                                 |
| `/reload-plugins`                  | Reload skills, commands, hooks, tools, agents, and MCP                                                                                                                                                                |
| `/force <tool> [prompt]`           | Force the next turn to use a specific tool                                                                                                                                                                            |
| `/debug`                           | Open debug tools selector                                                                                                                                                                                             |
| `/login` / `/logout`               | OAuth login/logout                                                                                                                                                                                                    |
| `/exit` (`/quit`)                  | Exit interactive mode                                                                                                                                                                                                 |

Installed skills are dispatchable as `/skill:<name>`. Bundled custom commands include `/review` (interactive code review launcher).

### Editor Features

**File reference (`@`):** Type `@` to fuzzy-search project files. Respects `.gitignore`.

**Path completion (Tab):** Complete relative paths, `../`, `~/`, etc.

**Drag & drop:** Drag files from your file manager into the terminal.

**Paste images (Ctrl+V):** Paste images from the clipboard alongside drag-and-drop attachment.

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

| Key                   | Action                                                      |
| --------------------- | ----------------------------------------------------------- |
| Tab                   | Path completion / accept autocomplete                       |
| Escape                | Cancel autocomplete / abort streaming                       |
| Ctrl+C                | Clear editor (first) / exit (second)                        |
| Ctrl+D                | Exit (when editor is empty)                                 |
| Ctrl+Z                | Suspend to background (use `fg` in shell to resume)         |
| Shift+Tab             | Cycle thinking level                                        |
| Ctrl+P / Shift+Ctrl+P | Cycle role models (slow/default/smol), temporary on shift   |
| Alt+P                 | Select model temporarily                                    |
| Ctrl+L                | Open model selector                                         |
| Alt+Shift+P           | Toggle plan mode                                            |
| Ctrl+R                | Search prompt history                                       |
| Ctrl+O                | Toggle tool output expansion                                |
| Ctrl+T                | Toggle thinking mode (hide reasoning summaries server-side) |
| Ctrl+G                | Edit message in external editor (`$VISUAL` or `$EDITOR`)    |
| Alt+H                 | Toggle speech-to-text recording                             |

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
omp --no-session           # Ephemeral mode (don't save)
```

Session IDs are Snowflake-style hex IDs (not UUIDs).

### Context Compaction

Long sessions can exhaust context windows. Compaction summarizes older messages while keeping recent context.

**Manual:** `/compact` or `/compact Focus on the API changes`

**Automatic:** Enable via `/settings`.

- **Overflow recovery**: model returns context overflow; compact and retry.
- **Threshold maintenance**: context exceeds configured headroom after a successful turn.

**Plan mode:** when approving a plan, `Approve and compact context` distills the plan-mode discussion into a summary and starts execution in the same session — a middle ground between `Approve and execute` (fresh context) and `Approve and keep context` (full history preserved).

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

### Memory

omp ships two memory backends, selected via `memory.backend` (`off | local | hindsight`).

**Legacy local backend (`memory.backend: local`)**

The agent extracts durable knowledge from past sessions and injects a compact summary at startup. The pipeline runs in the background and never blocks the active session. Memory is isolated per project (working directory) and stored under `~/.omp/agent/memories/`. The agent can pull deeper context via `memory://root/MEMORY.md` and `memory://root/skills/<name>/SKILL.md`.

Manage via the `/memory` slash command:

- `/memory view` — show current injection payload
- `/memory clear` (or `/memory reset`) — delete all memory data and artifacts
- `/memory enqueue` (or `/memory rebuild`) — force consolidation at next startup

> See [Memory Documentation](docs/memory.md).

**Hindsight backend (`memory.backend: hindsight`)**

Opt-in remote memory backed by [Hindsight](https://hindsight.vectorize.io) (Cloud or self-hosted). Instead of injecting a static summary, Hindsight surfaces three tools to the agent — `retain` (store durable facts), `recall` (search prior memories), and `reflect` (synthesise an answer across many memories) — and runs an auto-recall on the first turn so prior context lands before the model speaks.

- **Per-session state**: each session aliases a bank; subagents reuse the parent's bank so retains/recalls persist to the same place.
- **Bank scoping**: `hindsight.scoping` selects `global` (one shared bank), `per-project` (isolated per cwd), or `per-project-tagged` (shared bank with `project:<cwd>` tags so global + project memories merge on recall).
- **Mental models**: long-running curated summaries (user preferences, project conventions) are seeded once per bank and refreshed automatically after consolidations; an `<mental_models>` block is spliced into the system prompt.
- **Maintenance**: `/memory mm list|show|refresh|history|seed|delete|reload` from the TUI; `/memory view|clear|enqueue` still apply.

Configure via `hindsight.apiUrl`, `hindsight.apiToken`, `hindsight.bankId`, and `hindsight.scoping` in `config.yml`.

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

**Path-scoped model config:** `modelRoles` and other model selectors can be overridden per working directory by nesting a `paths:` map under the setting — useful for pinning a heavier model on one repo without changing the global default. See [docs/models.md](docs/models.md).

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
  autoContinue: true

memory:
  backend: local # off | local | hindsight

skills:
  enabled: true

terminal:
  showImages: true

display:
  tabWidth: 4 # Tab rendering width (.editorconfig integration)

topP: -1 # Nucleus sampling (0-1, -1 = provider default)
topK: -1 # Top-K tokens (-1 = provider default)
minP: -1 # Minimum probability (0-1, -1 = provider default)

tools:
  discoveryMode: all # off | mcp-only | all

eval:
  py: true
  js: true

recipe:
  enabled: true

irc:
  enabled: true

github:
  cache:
    enabled: true
    softTtlSec: 300
    hardTtlSec: 86400

plan:
  enabled: true

async:
  enabled: false
  maxJobs: 100

task:
  eager: false
  isolation:
    # auto lets the native PAL pick the best CoW backend; explicit values
    # pin to one of: apfs | btrfs | zfs | reflink | overlayfs | projfs |
    # block-clone | rcopy | none
    mode: none
    merge: patch # patch | branch
    commits: generic # generic | ai
```

`modelRoles` may use either canonical ids or explicit `provider/model` selectors. `modelProviderOrder` decides which provider backs a canonical model when multiple equivalent variants are available.

Legacy migration notes:

- `settings.json` → `config.yml`
- `queueMode` → `steeringMode`
- flat `theme: "..."` → `theme.dark` / `theme.light`
- `memories.enabled: true|false` → `memory.backend: local|off`
- `task.isolation.enabled` + legacy modes (`worktree`, `fuse-overlay`, `fuse-projfs`) → `task.isolation.mode` enum (`auto`, `apfs`, `btrfs`, `zfs`, `reflink`, `overlayfs`, `projfs`, `block-clone`, `rcopy`, `none`)

---

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
- Also discovered: `~/.claude/commands/`, `.claude/commands/`, `~/.codex/commands/`, `.codex/commands/`

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

TypeScript custom commands are also supported — drop an `index.ts` into a per-command folder and default-export a factory:

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
- CLI: `--hook <path>` (treated as an alias for `--extension`)

```typescript
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function (omp: HookAPI) {
  omp.on("tool_call", async (event, ctx) => {
    if (
      event.toolName === "bash" &&
      /sudo/.test(event.input.command as string)
    ) {
      const ok = await ctx.ui.confirm(
        "Allow sudo?",
        event.input.command as string,
      );
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

> See [Hooks Documentation](docs/hooks.md) and [examples/hooks/](packages/coding-agent/examples/hooks/). For richer integrations (tools + commands + events from one module) prefer `ExtensionAPI`.

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

### Marketplace

omp ships a Claude-compatible plugin marketplace: discover, install, and manage plugins (skills, commands, hooks, MCP/LSP servers) from Git-hosted catalogs or local directories.

A **marketplace** is a Git repo (or directory) with a `.claude-plugin/marketplace.json` catalog. A **plugin** is identified as `name@marketplace` (e.g. `code-review@claude-plugins-official`) and can be installed at **user** scope (default, `~/.omp/plugins/`) or **project** scope (`.omp/plugins/`, shadows user installs).

```text
/marketplace add anthropics/claude-plugins-official
/marketplace discover                # browse catalogs
/marketplace install code-review@claude-plugins-official
/marketplace list | remove | update | uninstall | upgrade | installed
/plugins list                        # all installed plugins (npm + marketplace)
/plugins enable|disable <name@marketplace>
```

Or just type `/marketplace` with no arguments to open the interactive browser. The same operations are available via `omp plugin ...` from the CLI.

> See [Marketplace Documentation](docs/marketplace.md).

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
| `--mode <mode>`                       | Output mode: `text`, `json`, `rpc`, `acp`, `rpc-ui`                |
| `--print`, `-p`                       | Non-interactive: process prompt and exit                           |
| `--continue`, `-c`                    | Continue most recent session                                       |
| `--resume`, `-r [id\|path]`           | Resume by ID prefix/path (or open picker if omitted)               |
| `--session <value>`                   | Alias of `--resume`                                                |
| `--session-dir <dir>`                 | Directory for session storage and lookup                           |
| `--no-session`                        | Don't save session                                                 |
| `--fork <id>`                         | Fork from a specific message ID                                    |
| `--tools <tools>`                     | Restrict to comma-separated built-in tool names                    |
| `--no-tools`                          | Disable all built-in tools                                         |
| `--no-lsp`                            | Disable LSP integration                                            |
| `--no-pty`                            | Disable PTY-based interactive bash execution                       |
| `--extension <path>`, `-e`            | Load extension file (repeatable)                                   |
| `--hook <path>`                       | Load hook/extension file (repeatable)                              |
| `--plugin-dir <path>`                 | Load plugin from directory (repeatable)                            |
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

| Command        | Description                                                      |
| -------------- | ---------------------------------------------------------------- |
| `acp`          | Run as an Agent Client Protocol server (editor integration)      |
| `agents`       | Manage agent definitions (e.g. `omp agents unpack`)              |
| `commit`       | Generate and apply git commits with the agentic commit pipeline  |
| `config`       | Inspect or edit settings (`config.yml`)                          |
| `grep`         | Standalone content search using the in-tree ripgrep wrapper      |
| `grievances`   | Review queued tool-issue / autoqa grievances                     |
| `plugin`       | Manage npm-installed plugins                                     |
| `read`         | CLI inspector for files, archives, tool outputs, and `*://` URIs |
| `search` (`q`) | Run the multi-provider web-search tool from the shell            |
| `setup`        | First-run setup (Python kernel, OAuth, model defaults)           |
| `shell`        | Spawn an interactive shell session through omp's bash runtime    |
| `ssh`          | Manage SSH host definitions used by the `ssh` tool               |
| `stats`        | Inspect session/usage statistics                                 |
| `update`       | Update the installed omp binary                                  |

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

# Non-interactive prompt
omp -p "List all .ts files in src/"

# Continue / resume
omp -c "What did we discuss?"
omp -r abc123

# Restrict toolset for a read-only review
omp --tools read,search,find -p "Review the architecture"

# Editor integration (ACP server, stdio transport)
omp acp

# Agentic commit on staged changes
omp commit

# Inspect a tool output by artifact URI
omp read 'artifact://abc123'

# Model cycling with patterns
omp --models "sonnet:high,haiku:low"

# Export a session to HTML
omp --export session.jsonl output.html
```

### Environment Variables

| Variable                                          | Description                                              |
| ------------------------------------------------- | -------------------------------------------------------- |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.       | Provider credentials                                     |
| `PI_CODING_AGENT_DIR`                             | Override agent data directory (default: `~/.omp/agent`)  |
| `PI_PACKAGE_DIR`                                  | Override package directory resolution                    |
| `PI_SMOL_MODEL`, `PI_SLOW_MODEL`, `PI_PLAN_MODEL` | Role-model overrides                                     |
| `PI_NO_PTY`                                       | Disable PTY-based bash execution                         |
| `PI_PY`, `PI_JS`                                  | Gate the python / JavaScript backends of the `eval` tool |
| `PI_HL_SEP`                                       | Override the hashline payload separator (single char)    |
| `OMP_GITHUB_CACHE_DB`                             | Override the GitHub view cache database path             |
| `VISUAL`, `EDITOR`                                | External editor for Ctrl+G                               |

See [Environment Variables](docs/environment-variables.md) for the complete reference.

---

## Tools

Use `--tools <list>` to restrict available built-in tools.

### Built-in Tool Names (`--tools`)

| Tool               | Description                                                                             |
| ------------------ | --------------------------------------------------------------------------------------- |
| `ask`              | Ask the user structured follow-up questions (interactive mode)                          |
| `bash`             | Execute shell commands                                                                  |
| `eval`             | Run code in a persistent kernel (Python and JavaScript backends)                        |
| `calc`             | Deterministic calculator/evaluator                                                      |
| `ssh`              | Execute commands on configured SSH hosts                                                |
| `github`           | Op-based wrapper around the GitHub CLI (`repo_view`, `pr_*`, `search_*`, `run_watch`)   |
| `recipe`           | Run a recipe / target from the project's task runner (bun, just, make, …)               |
| `irc`              | Send short messages between live agents (main ↔ subagents)                              |
| `edit`             | In-place file editing with anchors                                                      |
| `write`            | Create/overwrite files                                                                  |
| `find`             | Find files by glob pattern                                                              |
| `search`           | Search file contents (regex)                                                            |
| `ast_grep`         | Structural code search using AST matching (ast-grep)                                    |
| `ast_edit`         | Structural AST-aware code rewrites (ast-grep)                                           |
| `lsp`              | Language server actions (multi-operation)                                               |
| `debug`            | Debugger access via DAP (launch/attach, breakpoints, stepping, threads/stack/variables) |
| `read`             | Read files, directories, archives, SQLite, PDFs, notebooks, URLs                        |
| `inspect_image`    | Extract image content with a vision model                                               |
| `render_mermaid`   | Render Mermaid diagrams to ASCII or PNG                                                 |
| `browser`          | Browser automation tool (model-facing name: `puppeteer`)                                |
| `task`             | Launch subagents for parallel execution                                                 |
| `job`              | Manage async background jobs (poll, cancel, list)                                       |
| `todo_write`       | Phased task tracking with progress management                                           |
| `web_search`       | Multi-provider web search                                                               |
| `search_tool_bm25` | Tool-discovery search over hidden built-in / MCP / extension tools                      |
| `generate_image`   | Generate or edit images using Gemini image models                                       |
| `checkpoint`       | Save a workspace checkpoint                                                             |
| `rewind`           | Rewind the workspace to a previous checkpoint                                           |
| `retain`           | Persist a memory note (hindsight backend)                                               |
| `recall`           | Recall memory notes (hindsight backend)                                                 |
| `reflect`          | Trigger memory consolidation (hindsight backend)                                        |

Notes:

- `ask` requires interactive UI.
- `ssh` requires configured SSH hosts.
- Some tools are setting-gated and are excluded from the active toolset unless enabled:
  - `calc` ← `calc.enabled`
  - `browser` ← `browser.enabled`
  - `github` ← `github.enabled`
  - `recipe` ← `recipe.enabled`
  - `irc` ← `irc.enabled` (and only attached to the main agent when `async.enabled` is true)
  - `inspect_image` ← `inspect_image.enabled`
  - `render_mermaid` ← `renderMermaid.enabled`
  - `web_search` ← `web_search.enabled`
  - `find` / `search` ← `find.enabled` / `search.enabled`
  - `ast_grep` / `ast_edit` ← `astGrep.enabled` / `astEdit.enabled`
  - `lsp` ← `lsp.enabled` (and `--no-lsp` is not set)
  - `checkpoint` / `rewind` ← `checkpoint.enabled`
  - `debug` ← `debug.enabled`
  - `search_tool_bm25` ← `tools.discoveryMode !== "off"` (or legacy `mcp.discoveryMode`)
  - `retain` / `recall` / `reflect` ← `memory.backend === "hindsight"`
  - `eval` python/JS backends individually gated by `eval.py` / `eval.js` (or the `PI_PY` / `PI_JS` env vars)

Example:

`omp --tools read,search,find -p "Review this codebase"`

For adding new tools, see [Custom Tools](#custom-tools).

---

## Programmatic Usage

### SDK

For embedding omp in Node.js/TypeScript applications, use the SDK:

```typescript
import {
  ModelRegistry,
  SessionManager,
  createAgentSession,
  discoverAuthStorage,
} from "@oh-my-pi/pi-coding-agent";
const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh();
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
});
session.subscribe((event) => {
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
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
# or, for embedders that want to drive the TUI (tool cards, dialogs, selectors) over the protocol:
omp --mode rpc-ui --no-session
```

Send JSON commands on stdin:

```json
{"id":"req-1","type":"prompt","message":"List all .ts files"}
{"id":"req-2","type":"abort"}
{"id":"req-3","type":"get_login_providers"}
{"id":"req-4","type":"login","providerId":"anthropic"}
{"id":"req-5","type":"handoff"}
```

Responses are emitted as `type: "response"`; session events and extension UI requests stream on stdout as they occur.

Available command families (non-exhaustive): `prompt` / `steer` / `follow_up` / `abort` / `abort_and_prompt`, `new_session` / `switch_session` / `branch` / `handoff`, `get_state` / `get_messages` / `get_session_stats`, `set_model` / `cycle_model` / `get_available_models`, `set_thinking_level`, `compact` / `set_auto_compaction`, `bash` / `abort_bash`, `set_host_tools` (register host-side tools the agent can call back into), `get_login_providers` / `login`, `export_html`.

`--mode rpc-ui` adds full UI plumbing on top of the same protocol: tool execution cards, selectors, dialogs, and other interactive surfaces are streamed as `extension_ui_request` frames that the embedder must answer with `extension_ui_response`. `--mode rpc` keeps it headless (no UI requests).

> See [RPC Documentation](docs/rpc.md) for the full protocol.

### ACP Mode

For embedding in editors that speak the [Agent Client Protocol](https://github.com/zed-industries/agent-client-protocol) (e.g. Zed):

```bash
omp acp
# equivalent to: omp --mode acp
```

ACP mode starts a JSON-RPC server over stdio. It does **not** require a configured model at startup — the client can drive `initialize` and `authenticate` (including `/login`) before any model is selected. A `terminal` auth method is advertised when the client opts in via `clientCapabilities.auth.terminal` and falls back to an embedded interactive login flow.

When the client advertises capabilities at `initialize`, the agent routes tool I/O through them via the `ClientBridge` abstraction (`packages/coding-agent/src/session/client-bridge.ts`):

- `bash` → `terminal/create` + `terminal/output` (per-call client-side terminals)
- `read` → `fs/read_text_file` (so unsaved editor buffers and in-memory edits are visible)
- `write` → `fs/write_text_file` (writes go through the editor and let it track agent changes)
- `bash`, `edit`, `write`, and `ast_edit` are gated behind `session/request_permission` when the client supports it; `allow_always` / `reject_always` decisions are remembered per tool for the session lifetime

Slash commands available to ACP clients reach feature parity with the TUI for non-interactive flows, including `/model`, `/plan`, `/loop`, `/login`, `/logout`, `/agents`, `/extensions`, `/plugins`, `/marketplace`, `/mcp`, `/ssh`, `/session`, `/branch`, `/fork`, `/new`, `/resume`, `/drop`, `/handoff`, `/move`, `/memory`, `/todo`, `/jobs`, `/changelog`, `/dump`, `/copy`, `/hotkeys`, `/btw`, `/tree`, `/export`, `/share`, plus all `/skill:<name>` commands. The full set is registered in `packages/coding-agent/src/slash-commands/acp-builtins.ts`.

Beyond stock ACP methods, the agent exposes a small set of `_omp/*` extension methods for omp-aware clients (renamed from `omp/*` in 15.0.0 to match the ACP spec's `_`-prefix requirement for non-spec methods):

- `_omp/sessions/listAll` — paginated cross-cwd session index
- `_omp/projects/list` — discovered project cwds with session counts
- `_omp/chats/byCwd` — sessions filtered by working directory
- `_omp/usage` — token/cost rollup for active sessions
- `_omp/extensions` / `_omp/extensions/toggle` — list and toggle discovered extensions

Mode-aware notifications are also wired up: `session/set_mode` and `session/set_session_config_option("mode", …)` both emit `current_mode_update`; `/model` emits `config_option_update` after a model switch so client config selectors stay in sync; `tool_call_update.locations` is kept fresh from in-flight tool args so editors can "follow along" multi-file edits.

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

| Crate                                                         | Description                                                                                         |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **[pi-natives](crates/pi-natives)**                           | Core Rust native addon (N-API `cdylib`) used by `@oh-my-pi/pi-natives`; aggregates the crates below |
| **[pi-shell](crates/pi-shell)**                               | Embedded shell / PTY / process management split out of `pi-natives` (wraps `brush-*`)               |
| **[pi-ast](crates/pi-ast)**                                   | tree-sitter-based code summarizer and AST utilities (50+ language grammars)                         |
| **[pi-iso](crates/pi-iso)**                                   | Task isolation backend resolver: APFS clones, btrfs/zfs reflinks, overlayfs, projfs, rcopy          |
| **[brush-core-vendored](crates/brush-core-vendored)**         | Vendored fork of [brush-shell](https://github.com/reubeno/brush) for embedded bash execution        |
| **[brush-builtins-vendored](crates/brush-builtins-vendored)** | Vendored bash builtins (cd, echo, test, printf, read, export, etc.)                                 |

---

## License

MIT. See [LICENSE](LICENSE).

Copyright (c) 2025 Mario Zechner  
Copyright (c) 2025-2026 Can Bölük
