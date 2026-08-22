<p align="center">
  <img
    src="readmeasset/omk-girl-control.png"
    alt="OMK Girl operating the OMK//CONTROL console with a scoped task DAG and verified evidence panel"
    width="100%"
  />
</p>

<h1 align="center">OMK</h1>

<p align="center">
  <strong>Open Multi-Agent Kit</strong><br />
  Scope the work. Route the right agents. Verify every release.
</p>

<p align="center">
  Provider-neutral coding-agent CLI and multi-agent control plane for Codex,
  Claude Code, OpenCode, and local models.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/open-multi-agent-kit"><img alt="npm version" src="https://img.shields.io/npm/v/open-multi-agent-kit?style=flat-square&label=npm" /></a>
  <a href="https://www.npmjs.com/package/open-multi-agent-kit"><img alt="npm downloads per month" src="https://img.shields.io/npm/dm/open-multi-agent-kit?style=flat-square" /></a><br />
  <a href="https://github.com/dmae97/omk/releases/latest"><img alt="latest GitHub release" src="https://img.shields.io/github/v/release/dmae97/omk?style=flat-square&label=release" /></a><br />
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/npm/l/open-multi-agent-kit?style=flat-square" /></a>
  <img alt="supported Node.js version" src="https://img.shields.io/node/v/open-multi-agent-kit?style=flat-square" />
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#control-loop">Control loop</a> ·
  <a href="#verification-boundary">Safety boundary</a><br />
  <a href="#published-packages">Packages</a> ·
  <a href="packages/coding-agent/docs/index.md">Documentation</a>
</p>

---

## Why OMK

Coding agents can produce code quickly. They can also overlap work, lose state,
route to the wrong model, and claim completion before the build is green. OMK
adds a control plane around that work.

| Problem | OMK invariant | Inspectable output |
| --- | --- | --- |
| Parallel agents overwrite each other | Owned paths and resource claims bound every lane | DAG and workspace state |
| A model says “done” too early | Acceptance predicates require fresh evidence | Commands, exits, and receipts |
| A provider or model changes | Routing stays separate from the execution contract | Provider-attributed attempts |
| A session stops midway | Replayable state supports session recovery | Ledger, repair plan, durable goal |

OMK is for engineering work that needs a checkable result, not a convincing chat
response.

## Quick start

```bash
npm install -g open-multi-agent-kit --ignore-scripts
omk --version
omk
```

Without a global install:

```bash
npx --ignore-scripts open-multi-agent-kit
```

Requirements: Node.js 22.19 or newer. The published CLI package is
`open-multi-agent-kit`.

## Control loop

<p align="center">
  <img
    src="readmeasset/omk-control-loop.gif"
    alt="Animated OMK control loop showing Scope, Route, Verify, and Replay"
    width="900"
  />
</p>

1. **Scope** — turn a goal into a bounded DAG with owned paths, ordered waves,
   resource claims, and acceptance predicates.
2. **Route** — select models, agent skills, MCP tools, and extensions for the
   job without changing the evidence contract.
3. **Verify** — run the declared build, type, test, audit, and release gates.
   Required red predicates block completion.
4. **Replay** — preserve receipts, repair interrupted sessions, and continue
   durable goals from explicit reducer state.

The animation changes once every 1.5 seconds and contains no flashing. The four
steps above are the complete text alternative.

## OMK//CONTROL

The default operator surface shows active work, routing, context, MCP state, and
verification signals in one terminal UI.

<p align="center">
  <img
    src="landing/assets/omk_tui.jpg"
    alt="OMK//CONTROL terminal dashboard showing model routing, tools, and session status"
    width="960"
  />
</p>

The header reads `omk v<package.version> · OMK//CONTROL`; the installed package
version is the source of truth.

## What ships

### Multi-agent execution

- Bounded DAG parallel agents with deterministic ready-lane ordering.
- Per-lane owned paths and resource claims.
- Explicit cancellation, timeout, and retry settlement.
- Durable goals and checkpointed continuation across bounded rounds.

### Evidence and recovery

- Acceptance predicates backed by fresh command evidence.
- Versioned observations, evaluation results, and runtime decisions.
- Replay ledgers, receipts, session repair, and SDK session inspection.
- Advisory judging that cannot replace required deterministic gates.

### Routing and extensibility

- Provider-neutral model registry through `omk-ai`.
- Agent skills loaded on demand instead of dumped into every prompt.
- MCP runtime client with lazy stdio server startup and registered tools.
- Extensions for tools, commands, events, providers, themes, and UI surfaces.

See [providers](packages/coding-agent/docs/providers.md),
[MCP](packages/coding-agent/docs/mcp.md),
[skills](packages/coding-agent/docs/skills.md), and
[extensions](packages/coding-agent/docs/extensions.md).

## Verification boundary

`AgentSession` built-in local bash uses OS sandbox enforcement by default:
`sandbox-exec` on macOS and `bwrap` plus unprivileged user namespaces on Linux.
Local shell spawns restrict writes to the workspace and OS temporary directory,
disable network access, and fail closed with `sandbox.backend_missing` when an
enforcement backend is unavailable.

This is **not** read-confidentiality or whole-process containment. Other file
tools, extension and custom-tool code, injected or remote `BashOperations`, and
the OMK process keep the permissions of the process running them. Use
[containerization](packages/coding-agent/docs/containerization.md) when the
boundary must cover more than built-in local bash. A run without required
evidence remains `UNVERIFIED`.

## Providers

OMK keeps routing separate from control and evidence. Codex, Claude Code,
OpenCode Zen/Go, Kimi, GLM/ZAI, native xAI/Grok, NVIDIA NIM, and local providers
can participate through `omk-ai` while the run contract stays stable.

Native `xai` keeps subscription OAuth and `XAI_API_KEY` billing separate. See
[provider setup](packages/coding-agent/docs/providers.md),
[provider resilience](packages/coding-agent/docs/provider-resilience.md), and
[Grok integration](packages/coding-agent/docs/grok-harness.md).

## Published packages

| Package | Purpose |
| --- | --- |
| [`open-multi-agent-kit`](packages/coding-agent) | Interactive coding-agent CLI and control plane |
| [`omk-agent-core`](packages/agent) | Agent runtime, tool execution, and DAG scheduling |
| [`omk-ai`](packages/ai) | Unified multi-provider LLM API |
| [`omk-protocol`](packages/protocol) | Versioned run contracts and semantic reducers |
| [`omk-adaptorch-wpl`](packages/adaptorch-wpl) | Work Packet Loop runtime |
| [`omk-book-to-skill`](packages/book-to-skill) | Optional document-to-skill compiler |
| [`omk-tui`](packages/tui) | Differential-rendered terminal UI library |

```bash
npm install omk-agent-core
npm install omk-ai
npm install omk-protocol
omk install npm:omk-book-to-skill@0.96.2
npm install omk-tui
```

## OMK + AdaptOrch

OMK is the local, MIT-licensed control plane. AdaptOrch is a separate,
proprietary hosted patch-evidence service. It requires its own account and is
not part of this repository or the `omk-adaptorch-wpl` package.

**[Review AdaptOrch plans →](https://adaptorch.com/?utm_source=github&utm_medium=readme&utm_campaign=omk#pricing)**

## Documentation

- [Documentation index](packages/coding-agent/docs/index.md)
- [Usage](packages/coding-agent/docs/usage.md)
- [Providers and models](packages/coding-agent/docs/providers.md)
- [Automation and SDK](packages/coding-agent/docs/sdk.md)
- [Run protocol](packages/coding-agent/docs/run-protocol.md)
- [Sessions and recovery](packages/coding-agent/docs/sessions.md)
- [Security](packages/coding-agent/docs/security.md)
- [Containerization](packages/coding-agent/docs/containerization.md)
- [Public skill catalog](SKILLS.md)
- [Changelog](packages/coding-agent/CHANGELOG.md)
- [Release notes for v0.96.2](.github/RELEASE_NOTES_v0.96.2.md)

## Development

```bash
npm ci --ignore-scripts
npm run build
npm run check
npm test
npm run release:local
```

Direct dependencies are pinned, CI installs with `--ignore-scripts`, and the
published CLI includes a generated `npm-shrinkwrap.json`. Read
[CONTRIBUTING.md](CONTRIBUTING.md) and the
[development guide](packages/coding-agent/docs/development.md) before sending a
change.

## FAQ

### Is OMK a coding agent or an orchestrator?

Both. `open-multi-agent-kit` is an interactive coding-agent CLI;
OMK//CONTROL adds bounded orchestration, routing, evidence gates, and recovery.

### Does OMK require one specific model provider?

No. Providers can change while the execution and evidence contracts remain
stable. Provider-specific capabilities still vary and are documented explicitly.

### How does OMK decide that work is complete?

Declared acceptance predicates must pass with fresh command evidence. Chat text,
a reviewer opinion, or stale output cannot replace a required gate.

### Can OMK recover an interrupted run?

Yes. Replay state, receipts, durable goals, and session repair preserve enough
structure for bounded recovery instead of silently starting over.

## Recent releases

<!-- releases:start -->

## Release v0.96.2

### Added

- Added resource-aware host snapshots, admission decisions, generation-safe per-run tool-cap leases, workload classification, weighted FIFO permits, and `omk doctor resources` / `/resource` operator surfaces.
- Added internal Vitest, Jest, workspace, and Go shard planners plus a journaled executor with corruption quarantine, completed-shard resume, admission-aware execution, and aggregate `workload_shard_result.v1` evidence. Automatic session-command sharding is not enabled.
- Added an internal subagent lane launcher that enforces parent admission width and shares its permit pool; live child-launch wiring is not enabled.
- Added exactly-once `prompt_settled` and an opt-in completion sound.
- Added a local-only resource observation journal at `.omk/runs/<promptRunId>/resource-observations.jsonl`, recording bounded probe health, admission caps, classification, permit waits, settlement, and sound outcomes without raw host measurements.
- The `QWEN TOKEN PLAN` status entry now uses the official QwenCloud management CLI to show the seven-day usage window and reset time.

### Changed

- The session-termination classifier now accepts `resource.*` causes for memory, disk, CPU, heap, unavailable probes, and permit queue overflow. Only CPU pressure can qualify for automatic retry; live resource gates currently return bounded block results.
- `resourceGovernor.mode: "observe"` is the default and records decisions without enforcing caps. Both `"observe"` and `"off"` preserve v0.96.1 scheduling behavior.

### Fixed

- Top-level `omk --help` now lists `omk doctor resources [--json]`.
- Removed development-only `prepare` and `postinstall` hooks from the published CLI manifest; default npm installs no longer call an unshipped workspace-linking script.
- Bound resource observations and completion-sound results to their originating prompt journals, including consecutive fast observe-mode runs.
- Capped workspace shard plans at 16 while preserving every workspace through deterministic chunks.
- Ensured `prompt_settled` consistently follows `agent_end` as the final run event.

### Security

- Qwen quota discovery never sends an inference API key to a management endpoint, never reads browser cookies, and passes only non-secret process context to the QwenCloud child CLI.
- Removed the shipped subagent example's `offensive-jailbreak` skill route.

### Docs

- Documented an attributable AdaptOrch.com link for evaluating a separate hosted patch-evidence service; AdaptOrch remains distinct from the MIT-licensed OMK packages.

Release notes live in [RELEASE_NOTES_v0.96.2.md](.github/RELEASE_NOTES_v0.96.2.md).

## Release v0.96.1

### Added

- Added built-in harness loop extensions: identical-loop detection, compaction tool-pair repair, Kimi/K3/GLM/Grok/Claude prompt presets, and `/goal` with automatic continuation plus explicit `pause`, `resume`, evidence-gated `complete`, and `clear` lifecycle commands.
- Added pass-gated advisory best-of-N selection with strict weighted judge responses, forced-redacted candidate material, deterministic fallback, evaluation-bound request digests, and an explicit `ModelRegistry`-backed LLM adapter.
- Added digest-bound `Goal / Core / Verified / Open / Next` seam checkpoints to the existing durable-goal journal, including `/goal checkpoint <json>` and checkpoint-aware continuation.
- Added `omk sdk session status|tail|inspect|send` for external session controllers. Ambiguous selectors now fail closed, writes require exact IDs, active owners block concurrent access, and credential-shaped transcript text is redacted from output.
- Legacy `read` mode (`OMK_OMP_SEAMS=0`) now reports a private `0700` temporary spill directory with an exclusive `0600` file for recoverable line or byte truncation; it never writes beside or through the source path. A first line that alone exceeds the byte cap remains preview-only.

### Changed

- Sandbox backend probing is now cached per local bash operations instance. All enforce-mode fallback verdicts share the concrete missing-backend diagnosis (`bwrap`, user namespaces, `sandbox-exec`, or unsupported platform). Policy semantics are unchanged.
- Extracted the session system-prompt assembly from `AgentSession._rebuildSystemPrompt` into the pure `assembleSessionSystemPrompt` module (`core/session-system-prompt.ts`). Provider playbook resolution stays at the call site; the assembly is now directly testable.
- Extracted the retry/failover decisions from `AgentSession._isRetryableError` and `_prepareRetry` into the pure `core/provider-retry.ts` module (`isRetryableAssistantError`, `nextRetryAttempt`, `computeRetryDelayMs`). Retry ordering, backoff, and failover semantics are unchanged.
- Extracted the compaction gates from `AgentSession._checkCompaction` into the pure `core/compaction-gate.ts` module (`shouldSkipCompactionCheck`, `isSessionModelOverflow`). Gate ordering and staleness semantics are unchanged.
- Extracted the failover trigger and refused-model bookkeeping from `AgentSession._maybeFailoverFromSafetyStop` into `core/provider-retry.ts` (`isFailoverTriggerError`, `failoverModelKey`). Chain ordering and blacklist semantics are unchanged.
- Extracted the context-budget arithmetic from `AgentSession._getContextBudgetOptions` into the pure `core/prompt-budget.ts` module (`computePromptTokenBudget`, `computeResponseReserveTokens`). Env parsing stays at the call site; budget values are unchanged.
- Extracted the prompt-cache key transition classification from `AgentSession._recordPromptCachePlan` into the pure `core/prompt-cache.ts` module (`classifyPromptCacheTransition`). Counter and break-reason semantics are unchanged.
- Grok 4.5 / 4.3 now expose `/think max` and `ultra` in the selector. Those aliases still send xAI `reasoning_effort: "high"` because those models have no upstream `xhigh`/`max` tier.
- Native xAI SuperGrok usage now polls `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` and shows the weekly SuperGrok pool from `creditUsagePercent`. Stale `grok-oauth-proxy` credentials are dropped from `/login` and `/logout`.

### Fixed

- Durable-goal continuation now records and skips an unavailable WSL/project workspace instead of emitting an `ENODEV` extension stack after every failed provider attempt.
- Content/safety refusals are capped at one same-model retry when failover is unavailable, preventing the default transport retry budget from replaying the same refusal three times.
- Fable models remain visible in the model catalog, and a saved Fable default is honored when sticky-safety blocking is disabled.
- Claude models now omit discovered context files by default, avoiding provider false positives from unrelated instruction text; `OMK_CLAUDE_CONTEXT_FILES=1` restores the full context.
- Extension `resourceClaims` now survive both tool-definition adapters, allowing `dag-v2` to schedule non-conflicting custom tool calls concurrently instead of treating them as unclaimed exclusive work.
- Built-in tool-pair repair now uses the real `AgentMessage` contract (`toolCall` blocks and top-level `role: "toolResult"` messages), removing orphan pairs without unsafe message-shape casts.
- Pinned the transitive development dependency `nanoid` to 3.3.18, clearing GHSA-2v37-7h3g-55p8 from both full and production npm audits.

### Docs

- Redesigned the root README around the Scope → Route → Verify → Replay control loop with a WCAG-aware cyberpunk OMK Girl hero and slow feature GIF generated through GPT Image 2. The root `DESIGN.md` now defines public brand tokens, media budgets, and reduced-motion guidance.

### Removed

- Removed the `grok-oauth-proxy` provider path. Grok harness dispatch, failover, usage, and presets now use native `xai`. Stale `models.json` entries for `grok-oauth-proxy` are ignored instead of reappearing in `/login` and `/model`.

Release notes live in [RELEASE_NOTES_v0.96.1.md](.github/RELEASE_NOTES_v0.96.1.md).

## Release v0.96.0

### Added

- Added `omk-protocol`, the versioned `TaskSpec -> ExecutionAttempt -> Observation -> EvaluationResult -> RuntimeDecision` contract package, with runtime validators, explicit waivers, and pure semantic and runtime-decision reducers.
- Added `evidenceReceiptToObservation()` to project integrity-checked EvidenceReceipt v3 cores into immutable protocol facts. Legacy mutable `EvidenceStatus` and `TaskContract` verdict APIs remain compatible but are deprecated.
- Added the optional `omk-book-to-skill` package with compile/update commands, a pinned upstream workflow, advisory generated-skill scanning, and SHA-256 source/artifact provenance checks. Python extractors remain outside OMK core.
- Added deterministically seeded, bounded `fast-check` model and property suites for WPL transitions, replay migration and CAS, evidence freshness, subagent topology, run-journal CAS, and timeout/abort settlement ordering.

### Changed

- New replay events declare `jcs-rfc8785-v2` and hash RFC 8785-canonical payloads. Events without an algorithm remain verified as `json-stringify-v1`; mixed ledgers and exports preserve legacy records without rewriting them.

### Fixed

- NVIDIA NIM's `z-ai/glm-5.2` entry now transmits `reasoning_effort`, including the generated `max` thinking level; other NVIDIA models keep conservative compatibility defaults.
- Billing-cycle and quota exhaustion, including provider 403 usage-limit responses, now classify as `provider.rate_limit` and can switch to the first configured, authenticated resilience candidate before retry. Each attempt remains journaled, and a recovered retry ends with a later `completed` termination.
- Subagent DAG scheduling now sorts simultaneously ready lanes by lane ID, so topology aggregation does not depend on input insertion order.
- Local release bundles now include `omk-adaptorch-wpl`, allowing isolated installs of the full packed workspace without resolving that dependency from the registry.

Release notes live in [RELEASE_NOTES_v0.96.0.md](.github/RELEASE_NOTES_v0.96.0.md).

<!-- releases:end -->

## License

MIT
