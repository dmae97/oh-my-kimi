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
  A terminal coding agent that lets you switch models without starting a new session.
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
  <a href="#what-runs-by-default">Default or opt-in?</a> ·
  <a href="#evidence-and-limits">Evidence and limits</a><br />
  <a href="#faq">Choosing OMK</a> ·
  <a href="packages/coding-agent/docs/index.md">Documentation</a>
</p>

---

## Why OMK

Choose a model, work on your repository, then switch models with `/model` when
another one suits the next step. The conversation stays in the same session.
You can also stop and return later with `/resume` or `omk -c`.

OMK is a standalone CLI, not a plugin for Claude Code or OpenCode. It supports
[subscription providers, API keys, and local models](packages/coding-agent/docs/providers.md).
Start with one agent that reads files, edits code, and runs commands. Add
subagents or explicit verification workflows when you need them; neither is
required for your first task.

## Quick start

Requires Node.js 22.19 or newer. Start in the repository you want to work on:

```bash
npm install -g open-multi-agent-kit --ignore-scripts
omk --version
cd your-project
omk
```

Without a global install, run `npx --ignore-scripts open-multi-agent-kit` from
that directory.

1. Run `/login` to authenticate a supported subscription or API-key provider.
2. Run `/model` to choose an available model.
3. Try a read-only first task:

```text
Summarize this repository and identify the commands used to check it.
Read the project configuration to support your answer. Do not edit files.
```

After the reply, use `/model` to choose another configured model and ask it to
review the answer. You stay in the same session. This is manual model switching,
not parallel agents or an independent correctness check.

For a bug fix, name the failing behavior and ask for a regression test, the
smallest fix, and the check commands with their exit codes. Review the diff and
those results yourself; a request to run tests does not enable a verification
gate.

Built-in local bash requires `sandbox-exec` on macOS or `bwrap` plus
unprivileged user namespaces on Linux. It blocks network access and fails
closed if the backend is missing. See the [safety boundary](#verification-boundary)
and [full quickstart](packages/coding-agent/docs/quickstart.md) for setup.

## What runs by default

A fresh install starts one agent/tool loop after provider setup. It does not
turn each prompt into a multi-agent workflow or automatically certify its
answer.

| Capability | Fresh-install behavior | Where to start |
| --- | --- | --- |
| File editing, shell commands, saved sessions | Built in; tools run when called by the agent | [Usage](packages/coding-agent/docs/usage.md), [sessions](packages/coding-agent/docs/sessions.md) |
| Tool-call scheduling | `dag-v2` schedules resource conflicts within the agent loop; it does not launch a team | [Runtime algorithms](packages/coding-agent/docs/runtime-algorithms.md#tool-scheduling-and-settlement) |
| Subagents | Optional extension; load it and supply agent definitions | [Subagent setup and examples](packages/coding-agent/examples/extensions/subagent/README.md) |
| MCP servers, extra skills and extensions | Require configured servers or installed resources | [MCP](packages/coding-agent/docs/mcp.md), [skills](packages/coding-agent/docs/skills.md), [extensions](packages/coding-agent/docs/extensions.md) |
| Protocol verification and advisory judging | Explicit API/workflow opt-in; not a gate on ordinary prompts | [Run protocol](packages/coding-agent/docs/run-protocol.md) |
| Context budgeting | Off by default | [Settings](packages/coding-agent/docs/settings.md#context-budget) |
| AdaptOrch integration | Optional and separate; no service calls by default | [OMK + AdaptOrch](#omk--adaptorch) |

The internal lane launcher and automatic command-sharding primitives are not
connected to the default CLI path. Installing their packages is not the same
as enabling an orchestration workflow.

## Evidence and limits

No comparative benchmark result is published here yet. We have not established
that OMK solves more tasks than another harness, that multi-agent execution
improves success, or how much verification reduces false completion.

OMK targets state-of-the-art quality as a CLI coding-agent harness.
SOTA is not verified.

The evidence you can inspect today covers specific failure modes:

| Behavior covered | Regression evidence | Scope |
| --- | --- | --- |
| Missing test observations produce `inconclusive`; a required failing test produces `fail` | [Protocol tests](packages/protocol/test/protocol.test.ts) | Explicit protocol evaluation, without a waiver |
| Changed artifacts, wrong command bindings, or missing ledger evidence block acceptance | [Evidence binding tests](packages/coding-agent/test/evidence-gate-binding.test.ts) | Strict evidence gate and selected workspace scope |
| A relevant workspace mutation after verification makes the receipt stale | [Freshness tests](packages/coding-agent/test/evidence-freshness.test.ts) | Configured receipt and mutation tracking |

These tests exercise the gates, not the rate at which they catch real bugs.
An ordinary prompt finishes when its tool loop and queued work settle;
`prompt_settled` is not a correctness verdict.

A useful comparison must hold the model, provider configuration, tasks, budget,
and tool permissions constant, and label default versus opt-in workflows.
Report task success, cost, latency, and false completion (reported complete but
failing the declared checks), with its denominator and per-task outcomes.
The [measurement protocol](packages/coding-agent/docs/metrics.md#controlled-comparison-contract)
defines the reproducibility and privacy requirements. `omk stats` shows local
turn costs and tool failures; it does not score task correctness.

If you evaluate OMK, share a sanitized report and reproduction steps in a
[GitHub issue](https://github.com/dmae97/omk/issues). Include failed and
interrupted runs, not just successful examples.

## OMK//CONTROL

The terminal UI shows the selected model, tools, and session status. Additional
signals depend on the integrations you configure.

<p align="center">
  <img
    src="landing/assets/omk_tui.jpg"
    alt="OMK//CONTROL terminal dashboard showing model routing, tools, and session status"
    width="960"
  />
</p>

The header reads `omk v<package.version> · OMK//CONTROL`; the installed package
version is the source of truth.

## Control loop

<details>
<summary>How scope, routing, verification, and replay fit together</summary>

OMK's provider-neutral coding-agent CLI also exposes a multi-agent control
plane for explicitly configured workflows. The diagram describes that design,
not what every prompt automatically runs.

<p align="center">
  <img
    src="readmeasset/omk-control-loop.gif"
    alt="Animated OMK control loop showing Scope, Route, Verify, and Replay"
    width="900"
  />
</p>

The v0.98.3 SDK rejects incomplete first-party judge responses and exposes
deterministic ties; it is not an automatic TUI judge.

1. Scope the goal, paths, resources, and acceptance predicates. A selected
   orchestration workflow may also supply a DAG; an ordinary prompt remains
   one agent/tool loop.
2. Route work to models, agent skills, MCP tools, and extensions without
   changing the evidence contract.
3. Verify declared checks in explicit evidence workflows. Required failing
   checks block those workflows; advisory judging cannot replace them.
4. Preserve receipts and replay state for bounded session recovery; continue
   durable goals from explicit reducer state.

The animation changes once every 1.5 seconds and contains no flashing. The four
steps above are the complete text alternative.

</details>

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
boundary must cover more than built-in local bash. Explicit evidence workflows
cannot treat missing required evidence as a verified result.

## Providers

<details>
<summary>Provider integrations and published packages</summary>

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
omk install npm:omk-book-to-skill@0.98.3
npm install omk-tui
```

</details>

## Repository understanding

<details>
<summary>Optional indexes and trust limits</summary>

`v0.97.0` shipped the OpenWiki policy and workflow, but no versioned corpus or
integrity checker. The following integrity/output guards shipped in v0.98.0;
the generated corpus remains optional and is not bundled:

- **`openwiki/`** — absent. The previous untracked corpus was removed after the
  hardened gate proved it carried fabricated evidence: 8 frontmatter symbols
  that no declared source path defines (`AgentLoop`, `getModel`, `DeepWall`,
  `loadExtensions`, `createExtensionRuntime`, `main`), 45 references to `@omk/*`
  package names this repository does not publish, and a
  restatement of this README's `Scope -> Route -> Verify -> Replay` loop as a
  strict engine state machine, which is not what the source implements.
  CI regenerates the corpus; nothing is lost.
- **`scripts/check-openwiki.mjs`** — shipped integrity checker. An `interrupted` corpus
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

Source and tests remain authoritative. Shipped guards do not turn a generated
index into authority: treat corpus pages as local advisory data and recheck source.

</details>

## OMK + AdaptOrch

<a href="https://adaptorch.com/?utm_source=github&utm_medium=readme&utm_campaign=omk">
  <img
    src="readmeasset/omk-adaptorch-banner.svg"
    alt="OMK writes and runs code. AdaptOrch checks what it wrote. correctness_claim: false — it ran, and this is what happened."
    width="100%"
  />
</a>

OMK is this local, MIT-licensed coding agent. AdaptOrch is a separate
proprietary evidence service. Neither requires the other: installing OMK does
not create an AdaptOrch account or make calls to it by default.

For an optional integration, see the [WPL package and clients](packages/adaptorch-wpl/README.md)
and [MCP setup](packages/coding-agent/docs/mcp.md). The WPL package exposes
state, client, and adjudication primitives, not an automatic verification loop
for every CLI prompt.

AdaptOrch's shadow reports carry `correctness_claim=false`; they are not semantic
correctness proofs or OMK harness benchmark results.
[Review AdaptOrch plans](https://adaptorch.com/?utm_source=github&utm_medium=readme&utm_campaign=omk#pricing)
· [Claim boundary](https://adaptorch.com/claim-boundary?utm_source=github&utm_medium=readme&utm_campaign=omk)

<sub>The AdaptOrch name and marks identify that separate proprietary product
and appear here with permission. They are excluded from this repository's MIT
grant — see [LICENSE](LICENSE).</sub>

## Prior art

<details>
<summary>Research references, not OMK benchmark results</summary>

The design decisions behind OMK's context, routing, memory, and orchestration
layers are grounded in published work rather than invented in isolation. Each
row below was retrieved and read directly; claims are at abstract level, which
is the evidence grade this table asserts and no more.

| Paper | Mechanism it establishes | OMK implementation or design reference |
| --- | --- | --- |
| [arXiv:2608.22752](https://arxiv.org/abs/2608.22752) — *The Compaction Cliff in Long-Running AI Agent Memory* | Uniform summarization erodes rules and episodic logs at the same rate; measured safety-rule retention falls to 53% after one compaction and 10% after five. Type-tagged deterministic operators fix it. | Type-aware compaction triage: rule-typed items survive N rounds byte-identical |
| [arXiv:2608.23023](https://arxiv.org/abs/2608.23023) — *Most of the LLM Routing Gap Is Task Type* | Most routing gain is reachable with a fixed task-type table; run-to-run flips must not be credited as wins. | Frozen task-class table plus the 2-run stability rule in the promotion gate |
| [arXiv:2506.16655](https://arxiv.org/abs/2506.16655) — *Arch-Router: Aligning LLM Routing with Human Preferences* | Indirection: a classifier emits a label, a policy table maps label to decision, so models change without retraining. | `classifyTaskV4` plus `TASK_CLASS_THINKING_LEVELS` |
| [arXiv:2605.09894](https://arxiv.org/abs/2605.09894) — *Deterministic vs. LLM-Controlled Orchestration* | Holding model, prompts, and tools constant and varying only execution control, deterministic orchestration matched accuracy, improved worst-case robustness, and cut tokens up to 3.5x. | Deterministic scheduler and planned lanes; execution control is never delegated to the model |
| [arXiv:2608.15565](https://arxiv.org/abs/2608.15565) — *Admission Without Answers* | Label-free admission on execution success alone admits substantial contamination; an accept/abstain/escalate decision is required. | Verified-memory admission design (spec 019), abstain is not stored |
| [arXiv:2608.23471](https://arxiv.org/abs/2608.23471) — *InjecMEM: Memory Injection Attack on LLM Agent Memory Systems* | Single-interaction memory injection is a reproduced attack frame against agent memory. | Retrieved memory is injected only as provenance-tagged data, never fused into instruction position |

Entries include implemented mechanisms and design proposals; check the
[runtime status guide](packages/coding-agent/docs/runtime-algorithms.md) for
availability. The wider survey, including approaches not adopted, is working
material that is not published with the repository.

</details>

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
- [Release notes for v0.98.3](.github/RELEASE_NOTES_v0.98.3.md)

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

### Why use OMK instead of Claude Code?

Use it for provider choice within one CLI session, or to build workflows
against its public runtime and evidence APIs. For a single-provider workflow,
your current agent may be sufficient. Try the [read-only task above](#quick-start)
before moving existing work.

### How is this different from OpenCode with plugins?

OMK is a separate runtime with its own CLI, sessions, tool scheduler, and SDK.
One reason to choose it is to build your own acceptance workflow: define
required test observations in the [run protocol](packages/coding-agent/docs/run-protocol.md),
then have your automation reject `fail` or `inconclusive` results. Receipt
integrity and freshness still need their own configured checks.

For adding a tool or prompt to an existing OpenCode setup, a plugin may be the
smaller change. OMK's protocol is opt-in, not proof of better performance.

### Does multi-agent mean better results or automatic verification?

Not automatically. Subagents require setup, and verification must be part of
the chosen workflow. Its result covers the declared checks, not all behavior. See
[what runs by default](#what-runs-by-default) and [evidence and limits](#evidence-and-limits).

## Recent releases

<details>
<summary>Release notes and historical corrections</summary>

> Historical correction: the immutable v0.97.0 notes below announced a
> versioned OpenWiki corpus, but that release still ignored `/openwiki/` and did
> not contain the corpus or checker. See the current repository-understanding
> section above for the shipped guards and optional-corpus boundary.

<!-- releases:start -->

## Release v0.98.3

### Added

- Advisory-selection diagnostics now retain submitted/eligible/excluded counts, comparison availability, and top-score tie/margin data. Ties preserve caller rank while reporting `judge-tied` / `deterministic`; no correctness probability or default TUI judge is introduced.
- Claim-closure-to-WPL/VERA projection is tested across the public protocol and integration packages. It classifies supplied evidence and never grants release authority.
- A session workspace scope now reports what it could not bind. `resolveSessionWorkspaceScope()` drops dirty paths two ways — a 32-path cap and the normalized-path filter the receipt parser forces — and both were silent, so a receipt captured from a partial view of the working tree read exactly like one that saw all of it. The new `resolveSessionWorkspaceScopeReport(cwd, options?)` returns the same scope plus `totalDirtyPathCount`, `selectedPathCount`, `excludedPathCount`, `truncated`, a `completeness` of `complete` / `partial_truncated` / `partial_excluded` / `unavailable`, and an `excludedPathSetSha256` binding the dropped set. `SessionBashRuntime.workspaceScopeReport()` exposes it for the current session. `unavailable` is deliberately not `complete`: outside a worktree nothing was enumerated, so an empty artifact set is an absence of evidence rather than a clean tree. Dropping paths stays deliberate; hiding the drop was the defect. The scope cache is now keyed by `(cwd, maxPaths)` so a capped probe cannot serve a later full request its truncated answer.

### Fixed

- The first-party advisory model adapter now requires an explicit normal `stop`; complete score JSON from a truncated, aborted or missing completion state cannot override deterministic fallback. Cancellation before and after custom/model judge work prevents new calls and discards late advice, without additional completion calls or retries.
- Release documentation now separates internal trace/effect primitives from public opt-in APIs and records the existing CI token-authentication path without claiming OIDC provenance. The published v0.98.2 history is retained as an ancestor rather than re-created.

Release notes live in [RELEASE_NOTES_v0.98.3.md](.github/RELEASE_NOTES_v0.98.3.md).

## Release v0.98.2

### Added

- The `omk` CLI now connects configured MCP servers. `AgentSession.attachMcpServers()` was complete and tested but had no caller outside the SDK, so a `~/.omk/mcp.json` or `.omk/mcp.json` written by a CLI user spawned nothing and the control-panel MCP rows only ever showed the config inventory. The single CLI session factory now attaches on every session it creates — interactive, `-p`, RPC, `/new`, `/resume`, and forks — while `--help` and `--list-models` still spawn nothing. A server that fails to start becomes a startup warning naming the server and the reason (never an env value); the session continues with the servers that did connect.

### Fixed

- A dirty working-tree entry whose name the receipt parser rejects no longer kills every verified bash call in the session. `resolveSessionWorkspaceScope` handed the whole `git status` set to `captureWorkspaceFingerprint`, which throws on any path containing a backslash, `..`, or an empty segment; a mangled `\wsl.localhost\...` directory left in a repo root therefore failed each bash invocation with `workspace scope artifactPaths[N] must be a normalized root-relative path`, and subagent lanes lost their shell entirely. The scope builder now filters with the same `isNormalizedArtifactPath` predicate the parser enforces, which also subsumes the earlier one-off trailing-slash and nested-repository exclusions.
- A credential-less install no longer tells the user to `Run /login unknown`. The placeholder model resolved when no provider is configured carries the literal provider `unknown`, and the `provider_auth` recovery hint interpolated it verbatim; the hint now omits an unknown provider and mentions the API-key environment variable path for headless `-p` runs where `/login` is not available.
- Classified Anthropic's `claude_code_version_too_old` rejection (HTTP 400 carrying `invalid_request_error`) as a permanent configuration fault: it no longer enters the transient retry/failover loop, and the session failure cause reports `configuration`/`invalid` instead of the retryable protocol default. The usage and quota probes now read the spoofed Claude Code client version from omk-ai's single `CLAUDE_CODE_VERSION` constant, so every request presents the same user-agent as the messages API.
- Compaction now recovers from an OAuth token the provider rejects as expired while the stored expiry still lies ahead. ChatGPT/Codex answers `401 token_expired` days before the JWT `exp`, and because `compaction.model` can differ from the session model (`openai-codex/gpt-5.6-sol` under an `xai/grok-4.6` session), every turn kept succeeding while every compaction failed with "Provided authentication token is expired" — and the transient-retry classifier rightly never replays a 401. `AuthStorage.refreshRejectedOAuthToken()` now force-refreshes the rejected credential under the storage lock (skipping the refresh when another omk process already rotated it), and manual and automatic compaction retry the summarization once with the new token. A failed refresh names `/login <provider>`. Compaction failures are now attributed to the compaction model instead of the session model.
- Compaction now asks for an OAuth access token with at least ten minutes of remaining validity. Compaction resolves auth once and reuses it for a summarization that can stream for minutes with retries, so a token accepted seconds before expiry came back as a provider 401 mid-run. `AuthStorage.getApiKey()` accepts `minRemainingMs` and refreshes proactively, falling back to the still-valid token when that early refresh fails.

Release notes live in [RELEASE_NOTES_v0.98.2.md](.github/RELEASE_NOTES_v0.98.2.md).

## Release v0.98.1



Release notes live in [RELEASE_NOTES_v0.98.1.md](.github/RELEASE_NOTES_v0.98.1.md).

<!-- releases:end -->

</details>

## Acknowledgments

OMK builds on [pi](https://github.com/badlogic/pi-mono) — Mario Zechner's
MIT-licensed coding-agent harness — and began from the
[oh-my-pi](https://github.com/can1357/oh-my-pi) fork. The vendored tree was
removed in this release line; OMK `0.9x` is OMK-native (see
[`specs/constitution.md`](specs/constitution.md)), and the design debt to both
projects stands. Thank you.

## License

MIT
