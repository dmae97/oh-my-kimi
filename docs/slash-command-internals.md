# Slash command internals

This document describes how slash commands are discovered, deduplicated, surfaced in interactive mode, and expanded at prompt time in `coding-agent`.

## Implementation files

- [`src/extensibility/slash-commands.ts`](../packages/coding-agent/src/extensibility/slash-commands.ts)
- [`src/capability/slash-command.ts`](../packages/coding-agent/src/capability/slash-command.ts)
- [`src/discovery/builtin.ts`](../packages/coding-agent/src/discovery/builtin.ts)
- [`src/discovery/claude.ts`](../packages/coding-agent/src/discovery/claude.ts)
- [`src/discovery/codex.ts`](../packages/coding-agent/src/discovery/codex.ts)
- [`src/discovery/claude-plugins.ts`](../packages/coding-agent/src/discovery/claude-plugins.ts)
- [`src/capability/index.ts`](../packages/coding-agent/src/capability/index.ts)
- [`src/discovery/helpers.ts`](../packages/coding-agent/src/discovery/helpers.ts)
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`src/modes/interactive-mode.ts`](../packages/coding-agent/src/modes/interactive-mode.ts)
- [`src/modes/controllers/input-controller.ts`](../packages/coding-agent/src/modes/controllers/input-controller.ts)
- [`src/modes/utils/ui-helpers.ts`](../packages/coding-agent/src/modes/utils/ui-helpers.ts)
- [`src/modes/controllers/command-controller.ts`](../packages/coding-agent/src/modes/controllers/command-controller.ts)

## 1) Discovery model

Slash commands are a capability (`id: "slash-commands"`) keyed by command name (`key: cmd => cmd.name`).

The capability registry loads all registered providers, sorted by provider priority descending, and deduplicates by key with **first wins** semantics.

### Provider precedence

Current slash-command providers and priorities:

1. `native` (OMP) — priority `100`
2. `claude` — priority `80`
3. `claude-plugins` — priority `70`
4. `codex` — priority `70`

Tie behavior: equal-priority providers keep registration order. Current import order registers `claude-plugins` before `codex`, so plugin commands win over codex commands on name collisions.

### Name-collision behavior

For `slash-commands`, collisions are resolved strictly by capability dedup:

- highest-precedence item is kept in `result.items`
- lower-precedence duplicates remain only in `result.all` and are marked `_shadowed = true`

This applies across providers and also within a provider if it returns duplicate names.

### File scanning behavior

Providers mostly use `loadFilesFromDir(...)`, which currently:

- defaults to non-recursive matching (`*.md`)
- uses native glob with `gitignore: true`, `hidden: false`
- reads each matched file and transforms it into a `SlashCommand`

So hidden files/directories are not loaded, and ignored paths are skipped.

## 2) Provider-specific source paths and local precedence

## `native` provider (`builtin.ts`)

Search roots come from `.omp` directories:

- project: `<cwd>/.omp/commands/*.md`
- user: `~/.omp/agent/commands/*.md`

`getConfigDirs()` returns project first, then user, so **project native commands beat user native commands** when names collide.

## `claude` provider (`claude.ts`)

Loads:

- user: `~/.claude/commands/*.md`
- project: `<cwd>/.claude/commands/*.md`

The provider pushes user items before project items, so **user Claude commands beat project Claude commands** on same-name collisions inside this provider.

## `codex` provider (`codex.ts`)

Loads:

- user: `~/.codex/commands/*.md`
- project: `<cwd>/.codex/commands/*.md`

Both sides are loaded then flattened in user-first order, so **user Codex commands beat project Codex commands** on collisions.

Codex command content is parsed with frontmatter stripping (`parseFrontmatter`), and command name can be overridden by frontmatter `name`; otherwise filename is used.

## `claude-plugins` provider (`claude-plugins.ts`)

Loads plugin command roots from `~/.claude/plugins/installed_plugins.json`, then scans `<pluginRoot>/commands/*.md`.

Ordering follows registry iteration order and per-plugin entry order from that JSON data. There is no additional sort step.

## 3) Materialization to runtime `FileSlashCommand`

`loadSlashCommands()` in `src/extensibility/slash-commands.ts` converts capability items into `FileSlashCommand` objects used at prompt time.

For each command:

1. parse frontmatter/body (`parseFrontmatter`)
2. description source:
   - `frontmatter.description` if present
   - else first non-empty body line (trimmed, max 60 chars with `...`)
3. keep parsed body as executable template content
4. compute a display source string like `via Claude Code Project`

Frontmatter parse severity is source-dependent:

- `native` level -> parse errors are `fatal`
- `user`/`project` levels -> parse errors are `warn` with fallback parsing

### Bundled fallback commands

After filesystem/provider commands, embedded command templates are appended (`EMBEDDED_COMMAND_TEMPLATES`) if their names are not already present.

Current embedded set comes from `src/task/commands.ts` and is used as a fallback (`source: "bundled"`).

## 4) Interactive mode: where command lists come from

Interactive mode combines multiple command sources for autocomplete and command routing.

At construction time it builds a pending command list from:

- built-ins (`BUILTIN_SLASH_COMMANDS`, includes argument completion and inline hints for selected commands)
- extension-registered slash commands (`extensionRunner.getRegisteredCommands(...)`)
- TypeScript custom commands (`session.customCommands`), mapped to slash command labels
- optional skill commands (`/skill:<name>`) when `skills.enableSkillCommands` is enabled

Then `init()` calls `refreshSlashCommandState(...)` to load file-based commands and install one `CombinedAutocompleteProvider` containing:

- pending commands above
- discovered file-based commands

`refreshSlashCommandState(...)` also updates `session.setSlashCommands(...)` so prompt expansion uses the same discovered file command set.

### Refresh lifecycle

Slash command state is refreshed:

- during interactive init
- after `/move` changes working directory (`handleMoveCommand` calls `resetCapabilities()` then `refreshSlashCommandState(newCwd)`)

There is no continuous file watcher for command directories.

### Other surfacing

The Extensions dashboard also loads `slash-commands` capability and displays active/shadowed command entries, including `_shadowed` duplicates.

## 5) Prompt pipeline placement

`AgentSession.prompt(...)` slash handling order (when `expandPromptTemplates !== false`):

1. **Extension commands** (`#tryExecuteExtensionCommand`)  
   If `/name` matches extension-registered command, handler executes immediately and prompt returns.
2. **TypeScript custom commands** (`#tryExecuteCustomCommand`)  
   Boundary only: if matched, it executes and may return:
   - `string` -> replace prompt text with that string
   - `void/undefined` -> treated as handled; no LLM prompt
3. **File-based slash commands** (`expandSlashCommand`)  
   If text still starts with `/`, attempt markdown command expansion.
4. **Prompt templates** (`expandPromptTemplate`)  
   Applied after slash/custom processing.
5. **Delivery**
   - idle: prompt is sent immediately to agent
   - streaming: prompt is queued as steer/follow-up depending on `streamingBehavior`

This is why slash command expansion sits before prompt-template expansion, and why custom commands can transform away the leading slash before file-command matching.

## 6) Expansion semantics for file-based slash commands

`expandSlashCommand(text, fileCommands)` behavior:

- only runs when text begins with `/`
- parses command name from first token after `/`
- parses args from remaining text via `parseCommandArgs`
- finds exact name match in loaded `fileCommands`
- if matched, applies:
  - positional replacement: `$1`, `$2`, ...
  - aggregate replacement: `$ARGUMENTS` and `$@`
  - then template rendering via `prompt.render` with `{ args, ARGUMENTS, arguments }`
- if no match, returns original text unchanged

### `parseCommandArgs` caveats

The parser is simple quote-aware splitting:

- supports `'single'` and `"double"` quoting to keep spaces
- strips quote delimiters
- does not implement backslash escaping rules
- unmatched quote is not an error; parser consumes until end

## 7) Unknown `/...` behavior

Unknown slash input is **not rejected** by core slash logic.

If command is not handled by extension/custom/file layers, `expandSlashCommand` returns original text, and the literal `/...` prompt proceeds through normal prompt-template expansion and LLM delivery.

Interactive mode separately hard-handles many built-ins in `InputController` (for example `/settings`, `/model`, `/mcp`, `/move`, `/exit`). Those are consumed before `session.prompt(...)` and therefore never reach file-command expansion in that path.

## 8) Streaming-time differences vs idle

## Idle path

- `session.prompt("/x ...")` runs command pipeline and either executes command immediately or sends expanded text directly.

## Streaming path (`session.isStreaming === true`)

- `prompt(...)` still runs extension/custom/file/template transforms first
- then requires `streamingBehavior`:
  - `"steer"` -> queue interrupt message (`agent.steer`)
  - `"followUp"` -> queue post-turn message (`agent.followUp`)
- if `streamingBehavior` is omitted, prompt throws an error

### Important command-specific streaming behavior

- Extension commands are executed immediately even during streaming (not queued as text).
- `steer(...)`/`followUp(...)` helper methods reject extension commands (`#throwIfExtensionCommand`) to avoid queuing command text for handlers that must run synchronously.
- Compaction queue replay uses `isKnownSlashCommand(...)` to decide whether queued entries should be replayed via `session.prompt(...)` (for known slash commands) vs raw steer/follow-up methods.

## 9) Error handling and failure surfaces

- Provider load failures are isolated; registry collects warnings and continues with other providers.
- Invalid slash command items (missing name/path/content or invalid level) are dropped by capability validation.
- Frontmatter parse failures:
  - native commands: fatal parse error bubbles
  - non-native commands: warning + fallback key/value parse
- Extension/custom command handler exceptions are caught and reported via extension error channel (or logger fallback for custom commands without extension runner), and treated as handled (no unintended fallback execution).
