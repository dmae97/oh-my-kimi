<p align="center">
  <img
    src="readmeasset/omk-hero.svg"
    alt="OMK, Open Multi-Agent Kit. Scope the work. Route the right agents. Verify every release. The mark shows a four-stage control loop with three routed lanes."
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
| Concurrent work can collide | Tool claims serialize conflicts; optional orchestration workflows must declare path ownership | Tool schedule and workspace state |
| A model says “done” too early | Explicit verification workflows require fresh evidence; prompt settlement alone is not proof | Commands, exits, and receipts |
| A provider or model changes | Routing stays separate from the execution contract | Provider-attributed attempts |
| A session stops midway | Replayable state supports session recovery | Ledger, repair plan, durable goal |

OMK is for engineering work that needs a checkable result, not a convincing chat
response.

## Harness target

OMK targets state-of-the-art quality as a CLI coding-agent harness. The target
covers reliable task completion, cost and latency, context and tool efficiency,
bounded orchestration, safe execution, recovery, and verifiable outcomes.

**Current status: SOTA is not verified.** OMK does not claim leadership from
feature counts, test counts, self-scores, or roadmap projections. A comparative
claim requires a dated, reproducible, same-model evaluation against a named
cohort. See the [measurement protocol](packages/coding-agent/docs/metrics.md).

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

1. **Scope** — bound the goal, paths, resources, and acceptance predicates. A
   selected orchestration workflow may also supply a DAG; an ordinary prompt
   remains one agent/tool loop.
2. **Route** — select models, agent skills, MCP tools, and extensions for the
   job without changing the evidence contract.
3. **Verify** — explicit evidence workflows run declared build, type, test,
   audit, and release gates. Required red predicates block those workflows.
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

### Execution and optional orchestration

- One provider/tool loop with the CLI's deterministic `dag-v2` tool-call scheduler.
- An optional subagent extension plus packaged lane and shard primitives; the
  internal lane launcher and automatic command sharding are not default CLI paths.
- Explicit cancellation, timeout, and retry settlement.
- Durable goals and checkpointed continuation across bounded rounds.

### Evidence and recovery

- Verified-bash receipts, replay ledgers, session repair, and SDK inspection.
- Versioned `omk-protocol` observations, evaluations, and decisions for callers
  that explicitly adopt the protocol.
- Acceptance predicates backed by fresh evidence in those explicit workflows.
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
omk install npm:omk-book-to-skill@0.97.0
npm install omk-tui
```

## Repository understanding

`v0.97.0` shipped the OpenWiki policy and workflow, but no versioned corpus or
integrity checker. Current Worktree-only hardening remains blocked by the
security gates below:

- **`openwiki/`** — absent. The previous untracked corpus was removed after the
  hardened gate proved it carried fabricated evidence: 8 frontmatter symbols
  that no declared source path defines (`AgentLoop`, `getModel`, `DeepWall`,
  `loadExtensions`, `createExtensionRuntime`, `main`), 45 references to `@omk/*`
  package names this repository does not publish, and a
  restatement of this README's `Scope -> Route -> Verify -> Replay` loop as a
  strict engine state machine, which is not what the source implements.
  CI regenerates the corpus; nothing is lost.
- **`scripts/check-openwiki.mjs`** — worktree checker. An `interrupted` corpus
  now fails unless `openwiki/.manual-review.json` binds a review to the exact
  corpus digest, and every frontmatter symbol must bind to one of that page's
  own `source_paths` as a whole identifier.
- **`scripts/check-openwiki-output.mjs`** — output gate. The scheduled workflow
  may write, upload, and open a PR for `openwiki/` and nothing else, so a model
  reading this repository cannot reach `AGENTS.md`, `CLAUDE.md`, or the workflow
  that runs it. The gate runs once before the artifact leaves the read-only
  generating job and again before the PR, because the publishing job holds write
  permissions the first one does not.
- **`.understand-anything/`** — optional local structural graph used by Pi Lens;
  it is not published or injected into prompts by default. To reach a session,
  attach it through OMK's [MCP client](packages/coding-agent/docs/mcp.md) like
  any other server; there is no second, bespoke path for it.

Source and tests remain authoritative. Until the blockers above close and the
corpus ships, treat both generated indexes as untrusted working-tree or local
advisory data.

## OMK + AdaptOrch

<a href="https://adaptorch.com/?utm_source=github&utm_medium=readme&utm_campaign=omk">
  <img
    src="readmeasset/omk-adaptorch-banner.svg"
    alt="OMK writes and runs code. AdaptOrch checks what it wrote. correctness_claim: false — it ran, and this is what happened."
    width="100%"
  />
</a>

Your agent produces 200 lines in ten seconds. You cannot read 200 lines in ten
seconds, so you skim — and skimming catches typos while missing the function
that quietly returns the wrong number. Then you merge, on a feeling, twenty
times a day.

Code is the one thing an AI produces that a machine can grade, because you can
simply run it. AdaptOrch does that: it copies your project into an isolated
sandbox, applies the change, runs the tests before and after, and returns one
page.

- Every file the change touched, including the ones nobody asked for.
- The test result before the change and after it — that gap is the evidence.
  A suite that is merely green proves much less than one that failed first.
- A verdict in words, with environment failures separated from code failures,
  so a dead network is never reported as a broken change.

That separation is the part worth having. "All green" means nothing if the test
was deleted; "I fixed it" means nothing if the test was already passing.

**What it does not claim: semantic correctness.** Shadow reports carry
`correctness_claim=false`, and hidden tests, gold patches, and oracle labels are
blocked as selector inputs. AdaptOrch reports — it never rewrites your code,
picks a different answer, or merges for you. Its published 30-task ledger
benchmark (synthetic tasks, not a real repository) records 8 broken changes
caught and 1 the gate itself got wrong; both numbers ship with the raw log.

Starter is free and self-hosted on your own machine. A bring-your-own model key
is required on every tier, so nothing executes without your key. It works
alongside any coding agent, OMK included.

### Two ways to reach it

**Hosted API (start here).** `omk-adaptorch-wpl` ships `AdaptOrchApiClient`, a
typed client for the AdaptOrch User API v1. It needs an API key and nothing
else — no engine install, no server process. The package still opens no network
I/O of its own, so you pass in `fetch` and keep ownership of the HTTP stack:

```ts
import { createAdaptOrchApiClientFromEnv } from "omk-adaptorch-wpl";

// undefined unless ADAPTORCH_API_KEY is set, so AdaptOrch stays opt-in
const adaptorch = createAdaptOrchApiClientFromEnv(fetch);
const run = await adaptorch?.submitRun({ subtasks: [{ prompt: "check this patch" }] });
const evidence = run && (await adaptorch?.getEvidence(run.run_id));
```

A tenant key (`ado_` prefix) is sent only as `X-API-Key`, never also in
`Authorization`; any other credential is sent as a bearer token. Plaintext HTTP
is refused except for an exact loopback host, and a credential is scrubbed from
any error message before it is raised.

**MCP server (local engine).** AdaptOrch also ships an MCP server
(`adaptorch-mcp`), which OMK attaches like any other MCP server — see
[MCP](packages/coding-agent/docs/mcp.md). This path wraps a *local* parent
engine, so it requires that engine installed. The tool surface is tiered, and
the tier matters: nine core tools reach a remote tenant, while trace and
topology reads exist only in a full or local deployment.

| Tier | Tools |
| --- | --- |
| Core (every deployment) | `adaptorch_run`, `adaptorch_get_run`, `adaptorch_get_artifacts`, `adaptorch_list_runs`, `adaptorch_cancel_run`, `adaptorch_server_metrics`, `adaptorch_capabilities`, `adaptorch_usage`, `adaptorch_plan_catalog` |
| Full or local only | `adaptorch_get_traces`, `adaptorch_route_topology` |

There are no benchmark or verification tools in that surface. `AdaptOrchClient`
in `omk-adaptorch-wpl` is a typed wrapper over these names, and exports the two
tiers as `ADAPTORCH_REMOTE_TOOLS` and `ADAPTORCH_FULL_ONLY_TOOLS` so a caller
cannot advertise a tool the tenant cannot reach. It ships no transport: supply
one, or attach the server through OMK's MCP client and let it own the boundary.

**[Review AdaptOrch plans →](https://adaptorch.com/?utm_source=github&utm_medium=readme&utm_campaign=omk#pricing)** · [claim boundary](https://adaptorch.com/claim-boundary?utm_source=github&utm_medium=readme&utm_campaign=omk)

OMK remains the local, MIT-licensed control plane and does not require
AdaptOrch; installing OMK does not create an account. `omk-adaptorch-wpl` in
this repository exposes Work Packet state, client, and adjudication primitives
rather than wiring AdaptOrch into the default CLI loop.

**These are two different products.** OMK is this MIT-licensed local control
plane: it scopes, routes, and runs work on your machine. AdaptOrch is a
separate commercial evidence layer that inspects a change after something
writes it. They share a visual design language because they are built by the
same people, not because they are the same product or one is a tier of the
other. Neither requires the other, and OMK ships nothing that calls AdaptOrch
by default.

<sub>The AdaptOrch name and marks identify that separate proprietary product
and appear here with permission. They are excluded from this repository's MIT
grant — see [LICENSE](LICENSE).</sub>

## Prior art

The design decisions behind OMK's context, routing, memory, and orchestration
layers are grounded in published work rather than invented in isolation. Each
row below was retrieved and read directly; claims are at abstract level, which
is the evidence grade this table asserts and no more.

| Paper | Mechanism it establishes | Where OMK applies it |
| --- | --- | --- |
| [arXiv:2608.22752](https://arxiv.org/abs/2608.22752) — *The Compaction Cliff in Long-Running AI Agent Memory* | Uniform summarization erodes rules and episodic logs at the same rate; measured safety-rule retention falls to 53% after one compaction and 10% after five. Type-tagged deterministic operators fix it. | Type-aware compaction triage: rule-typed items survive N rounds byte-identical |
| [arXiv:2608.23023](https://arxiv.org/abs/2608.23023) — *Most of the LLM Routing Gap Is Task Type* | Most routing gain is reachable with a fixed task-type table; run-to-run flips must not be credited as wins. | Frozen task-class table plus the 2-run stability rule in the promotion gate |
| [arXiv:2506.16655](https://arxiv.org/abs/2506.16655) — *Arch-Router: Aligning LLM Routing with Human Preferences* | Indirection: a classifier emits a label, a policy table maps label to decision, so models change without retraining. | `classifyTaskV4` plus `TASK_CLASS_THINKING_LEVELS` |
| [arXiv:2605.09894](https://arxiv.org/abs/2605.09894) — *Deterministic vs. LLM-Controlled Orchestration* | Holding model, prompts, and tools constant and varying only execution control, deterministic orchestration matched accuracy, improved worst-case robustness, and cut tokens up to 3.5x. | Deterministic scheduler and planned lanes; execution control is never delegated to the model |
| [arXiv:2608.15565](https://arxiv.org/abs/2608.15565) — *Admission Without Answers* | Label-free admission on execution success alone admits substantial contamination; an accept/abstain/escalate decision is required. | Verified-memory admission design (spec 019), abstain is not stored |
| [arXiv:2608.23471](https://arxiv.org/abs/2608.23471) — *InjecMEM: Memory Injection Attack on LLM Agent Memory Systems* | Single-interaction memory injection is a reproduced attack frame against agent memory. | Retrieved memory is injected only as provenance-tagged data, never fused into instruction position |

The table lists what OMK actually applies. The wider survey it was drawn from,
including the approaches deliberately **not** adopted, is working material that
is not published with the repository.

## Documentation

- [Documentation index](packages/coding-agent/docs/index.md)
- [Usage](packages/coding-agent/docs/usage.md)
- [Turn metrics and harness evaluation](packages/coding-agent/docs/metrics.md)
- [Providers and models](packages/coding-agent/docs/providers.md)
- [Automation and SDK](packages/coding-agent/docs/sdk.md)
- [Run protocol](packages/coding-agent/docs/run-protocol.md)
- [Runtime algorithms and direction](packages/coding-agent/docs/runtime-algorithms.md)
- [Specification index](specs/README.md)
- [Sessions and recovery](packages/coding-agent/docs/sessions.md)
- [Security](packages/coding-agent/docs/security.md)
- [Containerization](packages/coding-agent/docs/containerization.md)
- [Public skill catalog](SKILLS.md)
- [Changelog](packages/coding-agent/CHANGELOG.md)
- [Release notes for v0.98.1](.github/RELEASE_NOTES_v0.98.1.md)

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

The default is an interactive coding-agent and tool loop. OMK also ships
optional orchestration extensions and explicit protocol/evidence APIs; internal
lane and shard primitives are not automatic multi-agent execution.

### Does OMK require one specific model provider?

No. Providers can change while the execution and evidence contracts remain
stable. Provider-specific capabilities still vary and are documented explicitly.

### How does OMK decide that work is complete?

An ordinary prompt ends when the agent loop and queued continuations settle;
`prompt_settled` is not a correctness verdict. In an explicit protocol/evidence
workflow, required predicates must pass with fresh evidence. Chat text, reviewer
opinion, or stale output cannot replace that gate.

### Can OMK recover an interrupted run?

Yes. Replay state, receipts, durable goals, and session repair preserve enough
structure for bounded recovery instead of silently starting over.

## Recent releases

> Historical correction: the immutable v0.97.0 notes below announced a
> versioned OpenWiki corpus, but that release still ignored `/openwiki/` and did
> not contain the corpus or checker. See the current repository-understanding
> section above for the working-tree repair.

<!-- releases:start -->

## Release v0.98.1



Release notes live in [RELEASE_NOTES_v0.98.1.md](.github/RELEASE_NOTES_v0.98.1.md).

## Release v0.98.0

### Added

- Added `omk doctor resources --report [--json]`, a bounded local aggregate of resource-admission journals. It reports pressure/actions, would-throttle counts, reason coverage, probe partial/timeout counts, and a 30-record reason-qualified sample floor without exposing paths, run IDs, decision IDs, digests, a command field, or raw host capacity. Journal discovery and descriptor reads are bounded and reject symlink escapes. The sample flag never promotes `adaptive`; human review remains mandatory.
- Added three repository gates to `npm run check`. `check:import-cycles` is a Tarjan-SCC ratchet whose unit is the module rather than the cycle, because a cycle's identity changes when a single edge merges it while "is this module trapped in a cycle" stays answerable across refactors; entering a cycle fails the build and leaving one tightens the baseline. `check:dep-tree` holds `npm ls` problems against a baseline while never baselining a dangling bin symlink. `check:feature-claims` gained two gates beyond file existence: twelve placeholder tokens are rejected as evidence, and at least one production module under `packages/*/src` must import the evidence module, so a claim can no longer be satisfied by an unwired file containing the word `export`. Importer resolution is path-precise, since this repository holds both `core/hooks/types.ts` and `core/extensions/types.ts` and basename matching would credit one module's wiring to the other.
- Added a conservative type-aware compaction slice for the default compactor. Explicit uppercase user-authored rule/invariant markers are extracted deterministically, credential-redacted, and bound to user-entry/line digests; assistant/tool, attached file/stdin, and model-generated or forged marker sections are rejected. Up to 64 validated source records are persisted in additive compaction details only when their canonical block matches the prior summary, and a five-round property test preserves that block byte-identically. Custom hook summaries, branch summaries, natural-language classification, and cross-session memory remain out of scope.

### Changed

- Interactive TTY completion sounds are enabled by default at final `prompt_settled`. Successful prompts keep the 5-second duration floor, while failed and aborted/stopped prompts notify immediately. Intermediate `agent_end`, retry, continuation, and tool states remain silent; current subagent work stays covered by its enclosing tool call, while future direct child/shard paths must wire the settlement counters before activation; RPC, JSON, print mode, and CI never play sounds. Sound backends now use fixed absolute executables, a minimal environment without inherited `PATH` or credentials, and a neutral temp cwd; WSL uses BEL rather than PATH-resolved PowerShell. Set `notifications.completionSound.enabled: false` or `OMK_COMPLETION_SOUND=0` to opt out, and use `onSuccess`, `onFailure`, or the new `onAbort` switch per terminal outcome.
- Split the failure-classification and message-snapshot cores out of `agent-session.ts` into `core/session-failure-cause.ts` and `core/agent-session-snapshot.ts` (92 pure lines each), dropping the session module from 4,287 to 4,113 pure lines. This is a move-only change with no behaviour difference: session state that the extracted code read off `this` is now passed in as arguments. Both cores carry ordering contracts that are easy to break silently and were previously unreachable from a direct test — provider classification must match quota/billing exhaustion before the generic 401/403 auth patterns, because `403 ... usage limit for this billing cycle` is transient per cycle and must fail over rather than terminate the turn as auth, and it must match upstream 5xx as network before the protocol fallback so guidance points at retry rather than transcript sanitize; the snapshot core rejects a `Date`, class instance, getter, or cycle at replacement time instead of letting it be flattened when SessionManager persists the message as JSON. Twenty-eight characterization tests now pin both orderings. The 512-character termination-message cap now references `MAX_SESSION_TERMINATION_MESSAGE_LENGTH` instead of repeating the literal.
- The reasoning-router weight promotion gate now refuses evidence it cannot trust. Every gold row is replayed under both policies and only rows whose repeated observations agree can carry promotion credit, so a routing "win" that flips between two identical runs is withheld instead of banked. Because the classifier is deterministic the replay doubles as a determinism attestation: if nondeterminism ever reaches the routing path the rows land in the unstable bucket and the gate blocks rather than crediting whichever run scored better. Promotion evidence must also declare that the candidate was measured against the frozen reference policy, closing a hole where a candidate could qualify by beating a caller-chosen weak opponent. The new blockers are `insufficient_replays`, `unstable_evidence`, and `baseline_not_frozen`, and they are reported ahead of the statistical blockers because a p-value computed over unstable rows is not a weaker result but a result about nothing.

### Fixed

- Releases no longer regenerate the model catalogs from live provider APIs. `release.mjs` ran `generate-models` and `generate-image-models` as "release artifacts", but both fetch provider endpoints, so the shipped catalog was a function of which APIs answered the machine cutting the release and which credentials it happened to hold. A v0.98.0 attempt regenerated 1,279 models down to 1,217, losing 26 of 57 Cloudflare entries and 32 OpenRouter entries while other providers gained models — a mixed result that cannot be read as either upstream retirement or local unreachability, which is exactly the ambiguity that must not be resolved silently during a release. The typecheck caught it only because tests happened to reference two of the dropped ids. The catalogs are now committed artifacts refreshed deliberately through `npm run models:refresh` and reviewed as their own change; the release still regenerates the shrinkwrap, which is derived from the lockfile already in the tree.
- The release stalled after the version bump because nothing retargeted the README release pointer. `check-release-consistency.mjs` reads the first `RELEASE_NOTES_v*.md` match in `README.md` as the advertised release surface, and that match is the documentation index entry, which sits above the generated block that `sync-readme-releases.mjs` rewrites — so the value deciding the gate was one no script maintained. The sync now retargets the index entry to the newest release, leaving links inside generated sections pointing at their own versions, and the script gained a main guard so importing it for tests no longer rewrites the repository.
- The release stalled again at `check:dep-tree` because the version scripts run `npm install --package-lock-only`, which updates the lockfile while leaving stale physical copies under each package's `node_modules` that shadow the workspace links. The tree is now rebuilt right after the bump, on both the bump-type and explicit-version paths, so the checks run against the release as it actually is.
- The OpenWiki integrity gate no longer trusts an unreviewed corpus. An `interrupted` generator pass previously warned and passed whenever `.last-update.json` recorded the current `HEAD`, so a partial corpus was trusted right until the next commit — and from that commit on the stale-head branch failed, meaning the repository could not accept any commit at all while a corpus sat in that state. An interrupted corpus now fails unless `openwiki/.manual-review.json` binds a review to the exact corpus digest. Anchoring the record to content rather than to a commit is what lets an approved corpus survive later commits, since code moving on is a staleness warning while any edit to the corpus invalidates the review outright. Frontmatter `symbols:` entries must now bind to one of that page's own `source_paths:` as a whole identifier; the previous check searched one concatenated haystack of the entire repository, which cannot fail for any plausible-looking identifier. Running the hardened gate against the existing corpus reported 8 symbols bound to no declared source path (`AgentLoop`, where the real export is the function `agentLoop`, plus `getModel`, `DeepWall`, `loadExtensions`, `createExtensionRuntime`, and `main`), so that corpus was removed rather than hand-patched, which the next generator run would overwrite. An absent corpus is now a reported warning rather than a failure: it lives in no commit, and one that does not exist cannot mislead a reader.
- Slack `xoxe-` tokens (app-configuration and refresh tokens) escaped secret redaction, because the pattern matched only `xox[abprs]`.
- Release workflows no longer build with write access. The binary job held `contents: write` without needing it; write permission is now isolated to a separate release job that consumes an artifact. The build also verifies that `SOURCE_REF` resolves to the commit `RELEASE_TAG` names, closing a path where an arbitrary ref could be built and published under a tag's name, and every action is pinned to a commit SHA.
- Standing instructions no longer score lowest exactly when the agent is working. `scoreContextFileRelevance()` ranked context files by query/item token overlap, which read "no evidence" two different ways: 0.9 when there was no query at all, but 0.1 when a query existed and simply did not overlap. Measured against this repository's own `AGENTS.md`, a blended score of 0.900 with no query fell to 0.420 for "fix the WSL clipboard paste bug" and "why is the import cycle gate failing". The baseline is now a floor rather than a starting value, with coverage distributing only the headroom above it (`baseline + (1 - baseline) * coverage`), so zero coverage lands exactly on the baseline and both readings of "no evidence" reach the same conclusion. Monotonicity holds, so existing ordering contracts survive. Skills are deliberately left on lexical scoring, which is the correct signal for them because a skill really does have a topic scope. This subsystem is opt-in (`contextBudget.enabled` or `OMK_CONTEXT_GOVERNOR=1`) and off by default.
- Detecting the built-in stream function no longer relies on reference identity. Callers decide whether provider credentials are mandatory by asking whether the stream function is still the built-in one, and `fn === streamSimple` answers that with object identity — which is not dependable, because this package can legitimately load twice in one process (a workspace symlink beside an installed copy, or two dependents resolving different versions). The comparison then reported "custom stream function" for what was really the built-in one and a credential check silently relaxed. The built-in is now branded through `Symbol.for`, whose per-realm registry gives every copy of the module the same symbol.
- Tool-timeout settlement moved out of the agent loop into a pure decision module, and teardown now has a grace window that distinguishes a late-settling tool which may have touched the workspace from one that never started executing. Only the former raises session risk. The bash tool now discloses the timeout in its result so truncated output is not mistaken for a short successful run.
- Extension startup diagnostics now keep every explicitly requested source fatal, including inline factories, direct files, manifest/directory entry points, opaque package sources, and symlinked entries. Only uncorrelated discovered-package failures may downgrade to warnings, so a missing security extension cannot silently disappear while stale optional discovery no longer kills every headless lane.
- Image paste is now reachable inside Windows Terminal. `Ctrl+V` was the only default binding outside native Windows, but Windows Terminal binds that key to its own paste action and never forwards it, so every session running inside it — WSL included — had no working image-paste key at all: the terminal swallowed the keypress, tried to paste clipboard text, and after a `Win+Shift+S` capture there was none. `Alt+V` is now bound alongside `Ctrl+V` on every platform, so whichever key the host terminal actually delivers works.
- Pasting a Windows screenshot into the prompt on WSL no longer fails silently. WSLg publishes the captured image as `image/bmp`, so the Wayland read succeeded and disqualified the PowerShell reader behind it — and when BMP conversion was unavailable (a packaged binary whose image-codec wasm sidecar is missing), the whole read returned nothing and the keypress did literally nothing. Each clipboard source now converts its own read, so an unconvertible format falls through to the next source instead of ending the search; the PowerShell reader returns PNG directly and needs no converter.
- Scrolling back through a finished answer no longer runs into stale copies of the prompt box and footer. On WSL/Windows Terminal every screen-clearing redraw pushed the live frame into scrollback, so long reports were chopped apart by repeated prompt boxes. Redraws now repaint the screen in place.
- Long answers no longer lose their beginning when earlier transcript rows change. Repairing a row above the viewport (a late tool result replacing its loader, an earlier prompt box re-rendering) reprinted the whole transcript from that row down, evicting the start of the current report from the terminal's scrollback. The repair repaint is now bounded to a few screens.

### Removed

- Removed ten unreachable internal modules totalling 1,855 pure lines of code: a superseded context-budget governor and its `lean-ctx` predecessor, an unused sandbox policy evaluator (the live path is the workspace sandbox policy), leftover read-anchor and recovery-checkpoint helpers from the removed OMP seam, and a dead guardrails/lane-grant cluster. None were exported from the package's public entry points, so no import can break; the shipped tarball simply carries less code. Each removal was verified by symbol-level reference search, public-barrel absence, and a full type-check and test run rather than by a dead-code reporter alone. `image-resize-worker`, which is loaded by path and bundled separately, was correctly retained.

Release notes live in [RELEASE_NOTES_v0.98.0.md](.github/RELEASE_NOTES_v0.98.0.md).

## Release v0.97.0

### Added

- Added the repository-understanding default: a generated `openwiki/` evidence index with grounded, staleness-tracked claims, OpenWiki managed blocks in root `AGENTS.md`/`CLAUDE.md`, a scheduled `openwiki-update` GitHub Actions workflow (Gemini provider by default), and a README section describing the local-wiki protocol for fresh sessions. The vendored `oh-my-pi` tree was removed; README now acknowledges pi (badlogic/pi-mono) and oh-my-pi as upstream origins.
- Added global-only `defaultActiveSkills` so operator-selected, user-scoped skill names can stay active in every prompt while full instructions remain on-demand.
- The model registry now keeps a bounded audit trail of every successfully loaded `models.json` (last 10 snapshots) and warns when model entries disappear between loads, so silent config rewrites by other sessions surface immediately instead of losing custom models.
- Images pasted or dragged into the interactive editor now attach as preview chips above the input through a bounded in-memory attachment store instead of per-paste temp files. Attachments are released exactly when their prompt is accepted and stay attached for retry when the turn fails before acceptance.
- Compaction summarization now walks the configured resilience failover chain once when the summarization model hits quota/billing exhaustion; if every candidate is also quota-blocked it fails with a new non-retryable `compaction.quota_exhausted` termination cause whose guidance points at `/model`, `compaction.model`, or waiting for reset.
- Upstream availability failures (gateway 5xx passthroughs, streams ending without a finish reason) are classified as network errors, and the retry path first rotates to another authenticated route serving the same underlying model family before falling back to the standard retry/failover chain.

### Changed

- YOLO mode (`OMK_YOLO` / `OMK_COMMAND_SAFETY=0` / `OMK_DISABLE_COMMAND_SAFETY`) is now evaluated in one place, the shared command-safety gate decision engine: every verdict — including block-tier commands and privilege prompts — runs without prompting, and the RPC headless bash safety floor honors the same opt-out.
- Refreshed the bundled model catalog (new DeepSeek V4 Flash Vision experimental routes and Thinking Machines Inkling free routes; removed dead free-tier aliases).

### Security

- The bash command-safety classifier now extracts command substitutions (`$(...)`, backticks, `<(...)`/`>(...)`) with quote-aware matching and recursively classifies their bodies up to a bounded depth, merging every risk signal by severity instead of returning on the first hit, so a destructive body such as `echo $(rm -rf ~)` can no longer ride behind a benign-looking outer command.

### Fixed

- Empty streamed completions (`stop` with no text, thinking, or tool call) are now treated as dead streams and retried within the existing retry budget instead of being accepted as a successful turn.

Release notes live in [RELEASE_NOTES_v0.97.0.md](.github/RELEASE_NOTES_v0.97.0.md).

<!-- releases:end -->

## Acknowledgments

OMK builds on [pi](https://github.com/badlogic/pi-mono) — Mario Zechner's
MIT-licensed coding-agent harness — and began from the
[oh-my-pi](https://github.com/can1357/oh-my-pi) fork. The vendored tree was
removed in this release line; OMK `0.9x` is OMK-native (see
[`specs/constitution.md`](specs/constitution.md)), and the design debt to both
projects stands. Thank you.

## License

MIT
