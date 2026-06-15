# Advisor and WATCHDOG.md

The advisor is an optional second model attached to a session. It reviews the primary agent's transcript after each turn, can inspect the workspace with read-only tools, and injects concise advice back into the primary session.

The advisor is not a second executor. It cannot edit files, run commands, approve actions, or change session state directly.

## Implementation files

- [`src/advisor/runtime.ts`](../packages/coding-agent/src/advisor/runtime.ts)
- [`src/advisor/advise-tool.ts`](../packages/coding-agent/src/advisor/advise-tool.ts)
- [`src/advisor/watchdog.ts`](../packages/coding-agent/src/advisor/watchdog.ts)
- [`src/prompts/advisor/system.md`](../packages/coding-agent/src/prompts/advisor/system.md)
- [`src/prompts/advisor/advise-tool.md`](../packages/coding-agent/src/prompts/advisor/advise-tool.md)
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`src/slash-commands/builtin-registry.ts`](../packages/coding-agent/src/slash-commands/builtin-registry.ts)
- [`src/config/settings-schema.ts`](../packages/coding-agent/src/config/settings-schema.ts)

---

## Enabling the advisor

The advisor requires both:

1. `advisor.enabled: true`
2. a model assigned to the `advisor` model role

Example:

```yaml
modelRoles:
  advisor: anthropic/claude-sonnet-4-5:medium

advisor:
  enabled: true
```

The advisor role uses normal model-role resolution, including provider-prefixed ids, canonical ids, and optional thinking suffixes.

Slash commands:

| Command | Effect |
|---|---|
| `/advisor` | Toggle the persisted `advisor.enabled` setting. |
| `/advisor on` | Enable the setting and start the runtime when an advisor model is assigned. |
| `/advisor off` | Disable the setting and stop the runtime. |
| `/advisor status` | Show active model, context usage, token usage, and cost. |
| `/advisor dump` | Print the advisor's compact transcript. |
| `/advisor dump raw` | Print the advisor's full dump with system prompt, tools, thinking, and calls. |

If `advisor.enabled` is true but no `modelRoles.advisor` value resolves to an available model, status reports that the setting is enabled but no advisor model is assigned.

## What the advisor sees

At each primary turn end, `AdvisorRuntime` receives only the new transcript delta since the last advisor update. Deltas are rendered with `formatSessionHistoryMarkdown(..., { includeThinking: true })`, so the advisor can review assistant reasoning as well as user-visible text, tool calls, and tool results.

Advisor messages already injected into the primary transcript are filtered out before the next delta is rendered. This prevents the advisor from recursively reviewing its own advice.

When the primary transcript is rewritten, the advisor runtime is reset:

- compaction
- session switch/resume
- branch/fork style history replacement
- context-maintenance re-prime when the advisor's own context cannot fit

Reset clears the advisor's private in-memory transcript and rewinds its cursor. The next advisor update replays the current bounded primary transcript instead of continuing from stale pre-rewrite context.

When the advisor is enabled mid-session, the cursor seeds to the current primary transcript length. That avoids replaying the whole old conversation on the first enabled turn.

## Tools and isolation

The advisor receives a hard-isolated read-only tool set:

- `read`
- `search`
- `find`
- `advise`

The read/search/find tools are built against a distinct `ToolSession` whose session id is suffixed with `-advisor`. The advisor therefore does not share the primary agent's file snapshots, seen-lines tracking, conflict state, summary cache, or edit/yield capabilities.

The `advise` tool accepts one note and an optional severity:

| Severity | Delivery | Intended use |
|---|---|---|
| omitted / `nit` | Non-interrupting aside, batched into the primary transcript at the next step boundary. | Cleanup, simplification, low-risk edge cases. |
| `concern` | Interrupting steering message. | Material risk, likely wrong direction, missing constraint, hallucinated API. |
| `blocker` | Interrupting steering message. | Continuing would clearly waste work or produce broken output. |

Interrupting advice is sent through the steering channel and can abort in-flight tools at the next steering boundary. Non-interrupting notes are batched into one custom `advisor` transcript card with this prefix:

```text
Advisor (a senior reviewer watching your work — weigh it, don't blindly obey):
```

When you deliberately interrupt the agent (Esc, or a cancel from collab, ACP, RPC, the SDK, or an extension), the advisor stops auto-resuming it. An interrupting `concern`/`blocker` raised while the run is stopped is recorded as a visible advisor card instead of restarting the turn, and a concern already in flight when you interrupt is preserved the same way rather than driving a surprise resume. The advice re-enters context the next time you resume — a new message, the `.`/`c` continue shortcut, or a steer/follow-up. A normal yield is unaffected: the advisor can still steer and resume a run the agent ended on its own.

## Bounded catch-up with `advisor.syncBacklog`

`advisor.syncBacklog` is not lockstep turn execution. It is a bounded catch-up delay for the primary agent when the advisor falls behind.

Allowed values:

- `off` — never wait for advisor catch-up
- `1`
- `3`
- `5`

On primary turn end:

1. the primary turn delta is queued for the advisor
2. the advisor drain loop starts or continues in the background
3. if `advisor.syncBacklog` is not `off`, the primary agent waits only while advisor backlog is at or above the configured threshold
4. the wait is capped at 30 seconds
5. if the advisor catches up below the threshold, the primary continues immediately
6. if the cap expires, the primary continues anyway

Practical interpretation:

- `off` favors maximum primary throughput.
- `1` is the closest mode to synchronous review: after each queued advisor delta, the primary waits up to 30 seconds for backlog to return to zero.
- `3` and `5` allow more advisor lag before the primary pauses.

Advisor failures do not permanently stall the primary. A failed advisor prompt is retried; after three consecutive advisor failures, the runtime logs a warning, drops the backlog, and lets the session continue.

## WATCHDOG.md

`WATCHDOG.md` is advisor-only guidance. It is appended to the advisor system prompt; it is not injected into the primary agent's normal context and does not behave like `AGENTS.md`, `RULES.md`, or other context files.

Use it for review priorities: risks the advisor should watch for, project-specific traps, dangerous APIs, architectural boundaries, and quality bars that are useful to a reviewer but too noisy for the main executor.

Example:

```markdown
# Watchdog notes

Especially watch for:

- Changes that bypass the durable queue in `src/jobs/`.
- UI renderer paths that display unsanitized tool output.
- New worker spawns that do not re-enter the CLI host.
```

### Discovery locations

`discoverWatchdogFiles(cwd, agentDir)` loads every readable candidate from these locations:

1. user level: `<active agent dir>/WATCHDOG.md` (`~/.omp/agent/WATCHDOG.md` by default; relocated by `PI_CODING_AGENT_DIR`)
2. project levels while walking from `cwd` upward to the git repository root, or to the home directory when no repo root is found:
   - `<dir>/WATCHDOG.md`
   - `<dir>/.omp/WATCHDOG.md`

Unlike native context files, watchdog discovery does not stop at the nearest project file. Multiple project watchdog files can load together.

Candidates in hidden owner directories are ignored unless the file is inside an `.omp` directory. This keeps unrelated dot-directory conventions from being picked up accidentally while still allowing `.omp/WATCHDOG.md`.

### `@` imports

`WATCHDOG.md` content is expanded with the same `@` import helper used by context files:

- relative imports resolve from the importing file's directory
- `~/` resolves from the user's home directory
- imports inside fenced code blocks and inline code spans stay literal
- cycles are skipped
- missing or unreadable imports leave the original `@path` text in place

### Prompt order

Loaded watchdog blocks are sorted as:

1. user-level `WATCHDOG.md`
2. project-level files from farther ancestors down toward `cwd`

Each file is appended to the advisor system prompt as:

```xml
Especially pay attention to:
<attention>
...expanded watchdog content...
</attention>
```

Later project files sit closer to the end of the advisor prompt, so narrower directory guidance is more prominent than broad ancestor guidance.

## Subagents

`advisor.subagents` controls whether spawned task/eval subagents also get an advisor runtime.

- `false` (default): only the main session can run an advisor.
- `true`: eligible subagent sessions build their own advisor with the same settings/model-role resolution, then rerun `WATCHDOG.md` discovery for that subagent session's `cwd` and agent directory.

Subagent advisors remain isolated from the subagent's primary tool session in the same way the main advisor is isolated from the main agent.

## Cost and context behavior

Advisor usage is separate model usage. `/advisor status` reports advisor token counts and cost from the advisor agent's own transcript.

The advisor has its own append-only context. Before each advisor prompt, `AgentSession` estimates incoming tokens and may maintain advisor context:

1. try model-level context promotion when enabled and a larger compatible model is available
2. if promotion cannot fit enough context, compact the advisor's own message history
3. if compaction has no candidates or still cannot fit, re-prime from the current bounded primary transcript

The advisor transcript is in-memory for the session. It is retained while the session runs so `/advisor dump` can inspect it, but advisor state is not a replacement for the primary persisted transcript.
