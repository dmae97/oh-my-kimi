# Task Agent Discovery and Selection

This document describes how the task subsystem discovers agent definitions, merges multiple sources, and resolves a requested agent at execution time.

It covers runtime behavior as implemented today, including precedence, invalid-definition handling, and spawn/depth constraints that can make an agent effectively unavailable.

## Implementation files

- [`src/task/discovery.ts`](../packages/coding-agent/src/task/discovery.ts)
- [`src/task/agents.ts`](../packages/coding-agent/src/task/agents.ts)
- [`src/task/types.ts`](../packages/coding-agent/src/task/types.ts)
- [`src/task/index.ts`](../packages/coding-agent/src/task/index.ts)
- [`src/task/commands.ts`](../packages/coding-agent/src/task/commands.ts)
- [`src/prompts/agents/task.md`](../packages/coding-agent/src/prompts/agents/task.md)
- [`src/prompts/tools/task.md`](../packages/coding-agent/src/prompts/tools/task.md)
- [`src/discovery/helpers.ts`](../packages/coding-agent/src/discovery/helpers.ts)
- [`src/config.ts`](../packages/coding-agent/src/config.ts)
- [`src/task/executor.ts`](../packages/coding-agent/src/task/executor.ts)

---

## Agent definition shape

Task agents normalize into `AgentDefinition` (`src/task/types.ts`):

- `name`, `description`, `systemPrompt` (required for a valid loaded agent)
- optional `tools`, `spawns`, `model`, `thinkingLevel`, `output`, `blocking`
- `source`: `"bundled" | "user" | "project"`
- optional `filePath`

Parsing comes from frontmatter via `parseAgentFields()` (`src/discovery/helpers.ts`):

- missing `name` or `description` => invalid (`null`), caller treats as parse failure
- `tools` accepts CSV or array; if provided, `yield` is auto-added
- `spawns` accepts `*`, CSV, or array
- backward-compat behavior: if `spawns` missing but `tools` includes `task`, `spawns` becomes `*`
- `output` is passed through as opaque schema data

## Bundled agents

Bundled agents are embedded at build time (`src/task/agents.ts`) using text imports.

`EMBEDDED_AGENT_DEFS` defines:

- `explore`, `plan`, `designer`, `reviewer` from prompt files
- `task` and `quick_task` from shared `task.md` body plus injected frontmatter

Loading path:

1. `loadBundledAgents()` parses embedded markdown with `parseAgent(..., "bundled", "fatal")`
2. results are cached in-memory (`bundledAgentsCache`)
3. `clearBundledAgentsCache()` is test-only cache reset

Because bundled parsing uses `level: "fatal"`, malformed bundled frontmatter throws and can fail discovery entirely.

## Filesystem and plugin discovery

`discoverAgents(cwd, home)` (`src/task/discovery.ts`) merges agents from multiple places before appending bundled definitions.

### Discovery inputs

1. User config agent dirs from `getConfigDirs("agents", { project: false })`
2. Nearest project agent dirs from `findAllNearestProjectConfigDirs("agents", cwd)`
3. Claude plugin roots (`listClaudePluginRoots(home)`) with `agents/` subdirs
4. Bundled agents (`loadBundledAgents()`)

### Actual source order

Source-family order comes from `getConfigDirs("", { project: false })`, which is derived from `priorityList` in `src/config.ts`:

1. `.omp`
2. `.claude`
3. `.codex`
4. `.gemini`

For each source family, discovery order is:

1. nearest project dir for that source (if found)
2. user dir for that source

After all source-family dirs, plugin `agents/` dirs are appended (project-scope plugins first, then user-scope).

Bundled agents are appended last.

### Important caveat: stale comments vs current code

`discovery.ts` header comments still mention `.pi` and do not mention `.codex`/`.gemini`. Actual runtime order is driven by `src/config.ts` and currently uses `.omp`, `.claude`, `.codex`, `.gemini`.

## Merge and collision rules

Discovery uses first-wins dedup by exact `agent.name`:

- A `Set<string>` tracks seen names.
- Loaded agents are flattened in directory order and kept only if name unseen.
- Bundled agents are filtered against the same set and only added if still unseen.

Implications:

- Project overrides user for same source family.
- Higher-priority source family overrides lower (`.omp` before `.claude`, etc.).
- Non-bundled agents override bundled agents with the same name.
- Name matching is case-sensitive (`Task` and `task` are distinct).
- Within one directory, markdown files are read in lexicographic filename order before dedup.

## Invalid/missing agent file behavior

Per directory (`loadAgentsFromDir`):

- unreadable/missing directory: treated as empty (`readdir(...).catch(() => [])`)
- file read or parse failure: warning logged, file skipped
- parse path uses `parseAgent(..., level: "warn")`

Frontmatter failure behavior comes from `parseFrontmatter`:

- parse error at `warn` level logs warning
- parser falls back to a simple `key: value` line parser
- if required fields are still missing, `parseAgentFields` fails, then `AgentParsingError` is thrown and caught by caller (file skipped)

Net effect: one bad custom agent file does not abort discovery of other files.

## Agent lookup and selection

Lookup is exact-name linear search:

- `getAgent(agents, name)` => `agents.find(a => a.name === name)`

In synchronous task execution (`TaskTool.#executeSync`):

1. agents are rediscovered at execution time (`discoverAgents(this.session.cwd)`)
2. requested `params.agent` is resolved through `getAgent`
3. missing agent returns immediate tool response:
   - `Unknown agent "...". Available: ...`
   - no subprocess runs

### Description vs execution-time discovery

`TaskTool.create()` builds the tool description from discovery results at initialization time. `#executeSync` rediscovers agents, so the runtime set can differ from what was listed in the earlier tool description if agent files changed mid-session. The async entry path still uses the initialization-time list to decide whether an agent is marked `blocking` before scheduling.

## Structured-output guardrails and schema precedence

Runtime output schema precedence in `TaskTool.execute`:

1. task call `params.schema` when `task.simple` allows custom schemas
2. agent frontmatter `output`
3. parent session `outputSchema`

(`effectiveOutputSchema = outputSchema ?? effectiveAgent.output ?? this.session.outputSchema` when custom task schemas are enabled; otherwise task-call schema is skipped.)

Prompt-time guardrail text in `src/prompts/tools/task.md` warns about mismatch behavior for structured-output agents (`explore`, `reviewer`): output-format instructions in prose can conflict with built-in schema and produce `null` outputs.

This is guidance, not hard runtime validation logic in `discoverAgents`.

## Command discovery interaction

`src/task/commands.ts` is parallel infrastructure for workflow commands (not agent definitions), but it follows the same overall pattern:

- discover from capability providers first
- deduplicate by name with first-wins
- append bundled commands if still unseen
- exact-name lookup via `getCommand`

In `src/task/index.ts`, command helpers are re-exported with agent discovery helpers. Agent discovery itself does not depend on command discovery at runtime.

## Availability constraints beyond discovery

An agent can be discoverable but still unavailable to run because of execution guardrails.

### Disabled-agent settings

`TaskTool.#executeSync` checks `task.disabledAgents` after resolving the agent. If the requested name is disabled, execution returns an immediate error listing enabled alternatives when available.

### Parent spawn policy

`TaskTool.#executeSync` checks `session.getSessionSpawns()`:

- `"*"` => allow any
- `""` => deny all
- CSV list => allow only listed names

If denied: immediate `Cannot spawn '...'. Allowed: ...` response.

### Blocked self-recursion env guard

`PI_BLOCKED_AGENT` is read at tool construction. If request matches, execution is rejected with recursion-prevention message.

### Recursion-depth gating (task tool availability inside child sessions)

In `runSubprocess` (`src/task/executor.ts`):

- depth computed from `taskDepth`
- `task.maxRecursionDepth` controls cutoff
- when at max depth:
  - `task` tool is removed from child tool list
  - child `spawns` env is set to empty

So deeper levels cannot spawn further tasks even if the agent definition includes `spawns`.

## Plan mode caveat (current implementation)

`TaskTool.execute` computes an `effectiveAgent` for plan mode (prepends plan-mode prompt, forces read-only tool subset, clears spawns), but `runSubprocess` is called with `agent` rather than `effectiveAgent`.

Current effect:

- model override / thinking level / output schema are derived from `effectiveAgent`
- system prompt and tool/spawn restrictions from `effectiveAgent` are not passed through in this call path

This is an implementation caveat worth knowing when reading plan-mode behavior expectations.
