<p align="center">
  <img
    src="readmeasset/omk-marketing-control.webp"
    alt="OMK//CONTROL provider-neutral routing, evidence gates, and parallel lanes"
    width="100%"
  />
</p>

<p align="center">
  <img
    src="readmeasset/omkgirl.png"
    alt="OMK girl — operator avatar for the OMK//CONTROL coding harness"
    width="420"
  />
</p>

<h1 align="center">OMK</h1>

<p align="center">
  <strong>Open Multi-Agent Kit — provider-neutral coding agent, multi-agent orchestration, and evidence-gated control plane.</strong>
</p>

<p align="center">
  OMK is an open-source multi-agent coding harness: route work across models,
  bound parallel lanes, block outcomes, and keep replayable evidence for Codex,
  Claude Code, OpenCode, and local agents.
</p>

<p align="center">
  <em>Keywords:</em> multi-agent orchestration · coding agent CLI · provider-neutral LLM router ·
  evidence-gated automation · agent skills · MCP · DAG parallel agents · session recovery
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/open-multi-agent-kit"><img alt="npm version" src="https://img.shields.io/npm/v/open-multi-agent-kit?style=flat-square&label=npm" /></a>
  <a href="https://www.npmjs.com/package/open-multi-agent-kit"><img alt="npm downloads per month" src="https://img.shields.io/npm/dm/open-multi-agent-kit?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/open-multi-agent-kit"><img alt="npm total downloads" src="https://img.shields.io/npm/dt/open-multi-agent-kit?style=flat-square&label=total%20downloads" /></a>
  <a href="https://github.com/dmae97/omk/releases/latest"><img alt="latest release" src="https://img.shields.io/github/v/release/dmae97/omk?style=flat-square&label=release" /></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/npm/l/open-multi-agent-kit?style=flat-square" /></a>
  <img alt="supported Node.js version" src="https://img.shields.io/node/v/open-multi-agent-kit?style=flat-square" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/open-multi-agent-kit"><img alt="open-multi-agent-kit npm version" src="https://img.shields.io/npm/v/open-multi-agent-kit?style=flat-square&label=open-multi-agent-kit" /></a>
  <a href="https://www.npmjs.com/package/omk-ai"><img alt="omk-ai npm version" src="https://img.shields.io/npm/v/omk-ai?style=flat-square&label=omk-ai" /></a>
  <a href="https://www.npmjs.com/package/omk-agent-core"><img alt="omk-agent-core npm version" src="https://img.shields.io/npm/v/omk-agent-core?style=flat-square&label=omk-agent-core" /></a>
  <a href="https://www.npmjs.com/package/omk-tui"><img alt="omk-tui npm version" src="https://img.shields.io/npm/v/omk-tui?style=flat-square&label=omk-tui" /></a>
  <a href="https://www.npmjs.com/package/omk-adaptorch-wpl"><img alt="omk-adaptorch-wpl npm version" src="https://img.shields.io/npm/v/omk-adaptorch-wpl?style=flat-square&label=omk-adaptorch-wpl" /></a>
</p>

---

## Scope. Verify. Replay

**What is OMK?** A verified, provider-neutral **control plane for coding agents**
(Codex, Claude Code, OpenCode, local models). It turns a goal into a bounded DAG,
runs parallel lanes with owned paths, blocks “done” without fresh evidence, and
stores replayable receipts for review and recovery.

Use OMK when you need multi-agent software engineering with acceptance predicates,
not chat that only *claims* the build is green.

| Problem | OMK |
| --- | --- |
| Parallel agents overwrite the same work | Resource claims and owned paths bound each lane |
| An agent says "done" before the build is green | Acceptance predicates block unverified completion |
| A session crashes midway | Replayable state and session repair preserve the run |
| The preferred model changes | The control and evidence model stays stable |

---

## OMK in motion

Ten short captures of the control plane's main workflows.

### 1 · Install and boot

<p align="center">
  <img src="readmeasset/demos/01-install-boot.gif" alt="OMK install and boot" width="820" />
</p>

### 2 · Goal to DAG

<p align="center">
  <img src="readmeasset/demos/02-goal-to-dag.gif" alt="OMK goal decomposition into a DAG" width="820" />
</p>

### 3 · Parallel lanes

<p align="center">
  <img src="readmeasset/demos/03-parallel-lanes.gif" alt="OMK parallel execution lanes" width="820" />
</p>

### 4 · Provider routing

<p align="center">
  <img src="readmeasset/demos/04-provider-routing.gif" alt="OMK provider-neutral routing" width="820" />
</p>

### 5 · Evidence gate

<p align="center">
  <img src="readmeasset/demos/05-evidence-gate.gif" alt="OMK evidence gate" width="820" />
</p>

### 6 · Skill routing

<p align="center">
  <img src="readmeasset/demos/06-skill-routing.gif" alt="OMK skill routing" width="820" />
</p>

### 7 · MCP health

<p align="center">
  <img src="readmeasset/demos/07-mcp-health.gif" alt="OMK MCP health view" width="820" />
</p>

### 8 · Context budget

<p align="center">
  <img src="readmeasset/demos/08-context-budget.gif" alt="OMK context budget" width="820" />
</p>

### 9 · Session doctor

<p align="center">
  <img src="readmeasset/demos/09-session-doctor.gif" alt="OMK session doctor" width="820" />
</p>

### 10 · Packages and themes

<p align="center">
  <img src="readmeasset/demos/10-packages-themes.gif" alt="OMK packages and themes" width="820" />
</p>

---

## What OMK controls

- **Execution scope** — resource claims, owned paths, bounded parallel lanes
- **Completion** — declared predicates and fresh verification
- **Evidence** — commands, exit status, workspace state, receipts
- **Recovery** — replayable session state and repair tooling
- **Providers** — one operator model across supported coding agents

---

## Installation

```bash
npm install -g open-multi-agent-kit --ignore-scripts
omk --version
omk
```

Or without a global install:

```bash
npx --ignore-scripts open-multi-agent-kit
```

The `open-multi-agent-kit` package ships OMK.

---

## OMK//CONTROL TUI

The OMK//CONTROL startup surface is the default operator view.
The header reads `omk v<package.version> · OMK//CONTROL`, using the
installed workspace package version as its source of truth.

<p align="center">
  <img
    src="readmeasset/omk_tui.png"
    alt="OMK//CONTROL terminal dashboard"
    width="100%"
  />
</p>

---

## Core concepts

### Scope

`!omk plan` turns a fuzzy objective into a bounded DAG: owned paths,
ordered waves, and an acceptance predicate attached to every node before
a single line of code is written.

### Predicates

The Correctness Wall intercepts writes and runs acceptance predicates.
A red predicate blocks completion — a green-looking reply is never a
release signal.

### Receipts

Every verified run produces a receipt: commands, exit codes, workspace
state, evidence digest, and timestamps. Receipts are inspectable artifacts,
not marketing claims.

### Replay

`omk session doctor` detects unterminated turns and orphan results, then
plans a dry-run repair against the tamper-evident replay ledger. An
interrupted run is a recoverable state, not a loss.

---

## Supported agents and providers

OMK is provider-neutral. The underlying agent can be Codex, Claude Code,
OpenCode, or a local model; the execution and evidence
model stays consistent.

Providers stay interchangeable. The routing layer picks the best arm
for the task, but the control plane never changes when you swap models.

---

## Verification boundary

OMK is not a security sandbox for arbitrary hostile code by default.
Supported verification and sandbox modes are documented explicitly.
Any run without the required evidence is labeled `UNVERIFIED`.

See [containerization.md](packages/coding-agent/docs/containerization.md)
for sandbox patterns: OpenShell, Gondolin micro-VM, and plain Docker.

---

## Extensions, MCP, and skills

OMK packages distribute skills, extensions, prompts, and themes through
one control plane. Build a package once, install it through `omk`, pin
it, scope it to a project when needed.

Public repository skills are listed in [SKILLS.md](SKILLS.md). Operator installs
can also load hubs such as **`omk-marketing`** (routes the bundled marketing/
SEO skill pack) without dumping every skill into context.

### Marketing, SEO, and AEO skill map

For growth work, start with `!skill:omk-marketing` (or `/skill:omk-marketing`).
It routes to the smallest subset of the marketingskills pack. Common intents:

| Intent | Skills to load |
| --- | --- |
| **SEO / AEO / discoverability** | `seo-audit`, `ai-seo`, `programmatic-seo`, `schema`, `site-architecture`, `content-strategy` |
| **Positioning & research** | `product-marketing`, `customer-research`, `competitors`, `competitor-profiling`, `marketing-plan`, `marketing-psychology` |
| **Copy & content** | `copywriting`, `copy-editing`, `content-strategy`, `emails`, `social`, `video`, `image`, `ad-creative` |
| **Conversion** | `cro`, `signup`, `onboarding`, `paywalls`, `popups`, `pricing`, `offers`, `ab-test-setup`, `ab-testing` |
| **Acquisition** | `ads`, `paid` routes via `ads`/`ad-creative`, `cold-email`, `directory-submissions`, `lead-magnets`, `free-tools`, `aso`, `sms` |
| **Lifecycle & revenue** | `churn-prevention`, `referrals`, `revops`, `sales-enablement`, `prospecting`, `co-marketing`, `community-marketing`, `public-relations`, `launch` |
| **Measurement & ops** | `analytics`, `marketing-loops`, `marketing-ideas`, `marketing-council` |

Load **one primary skill** (plus at most one supporter). Prefer evidence
(`analytics`, research) before spend or publish actions.

### Harness Graph (agents × skills × hooks × MCP)

Repository checkouts include a **build-time harness control plane** under
[`.omk/harness-graph/`](.omk/harness-graph/):

```bash
bash .omk/harness-graph/run.sh
# read: .omk/harness-graph/out/dashboard.md  ·  SCORECARD.md
```

It inventories agent→skill/hook/MCP edges, ranks bipartite SPOFs, clusters skills
(Louvain), scores association lift, recommends wiring (hybrid CF), and fail-closes
on new dead links. See the [harness-graph README](.omk/harness-graph/README.md)
and [scorecard](.omk/harness-graph/SCORECARD.md).

```bash
# Global, pinned OMK package
omk install npm:some-omk-package@1.2.3

# Project-local, pinned Git package
omk install -l git:github.com/example/omk-package@v1.2.3

# Inspect and control installed resources
omk list
omk config
omk update --extensions
```

A skills-only package is an ordinary OMK package:

```json
{
  "name": "omk-workflows",
  "keywords": ["omk-package"],
  "omk": {
    "skills": ["./skills"]
  }
}
```

Use the minimum necessary skills per turn — usually one to three.
A skill is loaded when it earns its place in the task, not because it
happens to be installed.

---

## SDK packages

| Package | Description |
| --------- | ------------- |
| **[omk-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[omk-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[open-multi-agent-kit](packages/coding-agent)** | Interactive coding agent CLI |
| **[omk-tui](packages/tui)** | Terminal UI library with differential rendering |

```bash
npm install omk-agent-core   # Agent runtime
npm install omk-ai           # Multi-provider LLM API
npm install omk-tui          # Terminal UI
```

---

## Adaptorch MCP integration

[AdaptOrch MCP](https://adaptorch.ai.kr) is a separate, proprietary
reliability-kernel service (not part of this monorepo) that OMK can route
orchestration tasks through: topology-aware DAG routing, multi-model
synthesis, and consistency verification. Backed by a published paper
([arXiv:2602.16873](https://arxiv.org/abs/2602.16873)).

The `adaptorch` and `adaptorch-prod` MCP servers plus the `adaptorch-route`
and `adaptorch-synthesize` skills ship in OMK's default execution preset.
Actually invoking AdaptOrch still requires an `ADAPTORCH_CONTROL_PLANE_TOKEN`.

This is distinct from `packages/adaptorch-wpl` in this monorepo, the stable
Work Packet Loop package shipped as a runtime dependency of
`open-multi-agent-kit` since v0.91.0.

---

## Development

```bash
npm ci --ignore-scripts  # Install the locked dependency graph
npm run build            # Build all packages
npm run check            # Lint, format, and type check
npm test                 # Run the hermetic default test suite
./omk-test.sh            # Run OMK from sources
```

## Supply-chain hardening

- Direct external dependencies are pinned to exact versions.
- `.npmrc` sets `save-exact=true` and `min-release-age=2`.
- `package-lock.json` is the dependency ground truth.
- `npm run check` verifies pinned direct deps and the generated shrinkwrap.
- The published CLI includes `npm-shrinkwrap.json` to pin transitive deps.
- CI installs with `npm ci --ignore-scripts`; scheduled audits run `npm audit`.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and
[development.md](packages/coding-agent/docs/development.md) for project setup.

## Documentation

- [Read the documentation](packages/coding-agent/docs/index.md)
- [Browse all public Skills](SKILLS.md)
- [Harness Graph control plane](.omk/harness-graph/README.md)
- [Changelog (coding-agent / open-multi-agent-kit)](packages/coding-agent/CHANGELOG.md)
- [Release notes for v0.95.0](.github/RELEASE_NOTES_v0.95.0.md)
- [Unreleased draft notes](.github/RELEASE_NOTES_UNRELEASED.md)

### FAQ (AEO)

**Is OMK a coding agent or an orchestrator?** Both: `open-multi-agent-kit` is an
interactive coding-agent CLI; OMK//CONTROL adds multi-agent DAG lanes, skill/MCP
routing, and evidence gates on top.

**Which models does OMK support?** Provider-neutral — Codex, Claude, OpenCode Zen/Go,
Kimi, GLM/ZAI, local providers, and more via `omk-ai`. Swap models without changing
the control/evidence model.

**How is completion verified?** Acceptance predicates and fresh command evidence.
Unverified runs are labeled `UNVERIFIED`; green chat is not a release signal.

**Can OMK do marketing/SEO work?** Yes, via skills (`omk-marketing` hub + SEO/CRO/
content skills listed above). Publishing, ads spend, and outreach still require
explicit operator confirmation.

**Where do release notes live?** Versioned notes under [`.github/RELEASE_NOTES_v*.md`](.github/);
the coding-agent [CHANGELOG](packages/coding-agent/CHANGELOG.md) is the source of
truth and syncs the “Recent releases” block below (`npm run sync:readme-releases`).

## Recent releases

<!-- releases:start -->

## Release v0.95.0

### Added

- Added explicit multi-account subscription authentication: `/login` now opens an account picker for configured OAuth providers, offers a separate **Add another account** action, captures ChatGPT/Claude/Google email identities, and pins requests to the selected account without silent rotation or failover.
- Added multi-provider quota meters to the pinned STATUS RAIL: every configured Codex, Claude, Kimi Code, and GLM/ZAI subscription is shown together with independent windows and reset countdowns. Codex polling passively merges official `x-codex-primary-*`, `x-codex-secondary-*`, and `codex.rate_limits` signals when they are present. Claude Code's passive `anthropic-ratelimit-unified-*` headers preserve recent 5-hour/7-day values; when the usage endpoint is rate limited and the snapshot is incomplete, an account-scoped, hourly-capped one-token Haiku quota check mirrors Claude Code's startup fallback. Model Studio Token Plan is identified as `QWEN TOKEN PLAN` with `console-only quota` because its official usage endpoint requires an Alibaba Cloud console session rather than the plan API key; Qwen OAuth/Grok remain explicit `quota API unavailable` entries.

### Fixed

- Removed the persistent GitHub star prompt from interactive startup. The `/star` command remains available as an explicit, on-demand repository shortcut and no longer writes a tracking flag to settings.
- Anthropic-bound images now default to a 1,900 px longest edge and pass through a final header-level size guard, preventing sticky oversized-image request failures from clipboard and extension paths.
- Cancelling manual compaction now clears the transient compaction notice and restores queued input without duplicating messages.
- Refreshed built-in model metadata via `omk-ai` so OpenCode Zen (`opencode`) gains the `kimi-k3` entry that OpenCode Go (`opencode-go`) already had, with current provider handoff coverage for both catalogs.
- `glm-5.2` on OpenCode Zen/Go now exposes the `xhigh`/`max` thinking levels in the thinking-level selector (`Ctrl+T` / `/thinking`); it was previously capped at `high` because top-tier levels require an explicit `thinkingLevelMap` entry to appear.
- Auto-compaction now fails fast on insufficient-balance 429 responses instead of repeating the same quota error through every retry.

Release notes live in [RELEASE_NOTES_v0.95.0.md](.github/RELEASE_NOTES_v0.95.0.md).

## Release v0.94.1

### Added

- **Persistent GitHub star nudge** on interactive startup: first installs and anyone who has not confirmed a star keep seeing a nag banner every launch until they star <https://github.com/dmae97/omk> and run `/star` (writes global `githubStarred: true` in `~/.omk/agent/settings.json`). `/star reset` brings the nag back. Project settings cannot silence it.

Release notes live in [RELEASE_NOTES_v0.94.1.md](.github/RELEASE_NOTES_v0.94.1.md).

## Release v0.94.0

### Added

- **`diagnostics` is now a default-active tool** for new sessions (LLM-callable alongside `read`/`bash`/`edit`/`write`). It stays registered-but-inactive for sessions that pin their own tool list; opt out per session via `activeToolNames` or `excludedToolNames`.
- **Persistent skill-catalog cache** (`src/core/skills-catalog-cache.ts`): per-dir fingerprint walk (readdir/stat only) gates a JSON catalog at `<agentDir>/cache/skill-catalog-v1.json`. Repeat session starts skip all SKILL.md reads on unchanged trees (measured on this host: 105 ms cold → 41 ms warm for the full scan). Any add/edit/delete under a scanned tree invalidates exactly that dir; corrupt cache degrades to a clean miss. Atomic tmp+rename writes.
- **Hermetic test environment** (`test/setup-env.ts`): machine-level `OMK_*` and provider credential variables are scrubbed before every worker, so test results no longer depend on the developer shell (safety-gate suites saw env-disabled gates; live e2e suites ran against expired credentials instead of skipping). `LIVE_E2E=1` keeps provider keys when running the live suites on purpose.
- **`diagnostics` tool** (`src/core/tools/diagnostics.ts`): compiler-backed diagnostics via the project's own checkers — `tsc --noEmit`, `pyright`/`ruff`, `go vet`, `cargo check` — normalized to `SEVERITY path:line:col message`, per-language fail-soft (`skipped` instead of tool errors), 5 s TTL cache, 50-item cap, path/language auto-detect. Registered in `createAllToolDefinitions` and exported from the SDK (`createDiagnosticsTool`, `createDiagnosticsToolDefinition`).
- **Interactive sandbox promotion**: `session.setBashSandboxMode("audit" | "enforce" | "off")` switches the session sandbox at runtime (next spawn), with a `sandbox_audit` mode-change ledger entry; `session.bashSandboxMode` reads the effective mode. `SessionBashRuntime.setSandboxMode` backs it.
- **Default-on bash sandbox (opt-out).** Session bash now carries a default `audit`-mode sandbox preflight (workspace-write rooted at the session cwd, OS temp dir as extra write target). Spawns stay unwrapped but every decision lands in the replay ledger as a `sandbox_audit` event — a tamper-evident trail no other harness ships. `OMK_BASH_SANDBOX=enforce` activates the real OS backend (macOS `sandbox-exec` / Linux `bwrap`, auto-detected) and fails closed when unavailable; `=0` disables. New `onSpawnDecision` observer on `BashSandboxPreflight`, plus `createWorkspaceSandboxPolicy()` / `resolveBashSandboxMode()` SDK exports.
- **Git-aware verified-bash scope.** Session bash receipts now bind the git toplevel plus the sorted dirty set (staged/modified/untracked, capped at 32 paths, 1 s TTL cache) instead of an empty artifact set, so `captureWorkspaceFingerprint` records HEAD and a scope-limited dirty digest. Exported as `resolveSessionWorkspaceScope()`.

### Fixed

- **API provider registry is now a process-wide singleton** (`globalThis`-anchored in `omk-ai/api-registry`). Symlinked workspace dist copies consumed natively and the same files inlined by vite-node used to keep separate registries, so `registerFauxProvider` (and any runtime registration) was invisible to streamers resolving through the other copy — surfacing as "No API provider registered for api: ..." in agent loops. Also removed a stale nested `packages/agent/node_modules/omk-ai` copy (0.92.0) that shadowed the workspace build.

### Changed

- **Extracted `SessionCompactionService`** (`src/core/session-compaction-service.ts`): the compaction state machine — capture/lock, barrier evaluation, emergency tail repair, provenance capture, transaction begin, envelope commit — moved out of `AgentSession` (5,271 → 4,911 lines), which now delegates through thin one-line wrappers. Transaction symbols import from `compaction/transaction.ts` directly so the `compaction/index.js` vi.mock pattern in suites keeps working.
- **Extracted `SessionBashService`** (`src/core/session-bash-service.ts`): the full bash surface — `executeBash` (prefix/loadout/safety-floor/headless gate), `recordBashResult` with the streaming-deferral queue, `abortBash`, `flushPending` — moved out of `AgentSession`, which now delegates one line each. Ordering contract (queue while streaming, flush on turn end) is pinned by the bash-persistence suite.
- **Extracted `SessionBashRuntime`** (`src/core/session-bash-runtime.ts`) from `AgentSession`: verified-evidence executor, default sandbox preflight (audit/enforce), git-aware workspace scope, and the receipt-bound bash orchestration (`executeVerified`) now live in one lazily-initialized unit; the session delegates. No behavior change.

- **Verified bash is default-on (opt-out).** When an AgentSession has a replay ledger, LLM-callable `bash` and interactive/RPC `executeBash` bind through `executeVerifiedBash` (`executor: "bash-tool"`, receipts under `<sessionFile>.evidence`). Set `OMK_VERIFIED_BASH=0` for the legacy unverified path. Adapter gains `env`/`onData` fan-out and `createVerifiedBashOperations()` so session PI_* env and live streaming stay intact without import cycles. See [SDK — Evidence](packages/coding-agent/docs/sdk.md#evidence-and-verification) and [Environment Variables](packages/coding-agent/docs/environment-variables.md).

Release notes live in [RELEASE_NOTES_v0.94.0.md](.github/RELEASE_NOTES_v0.94.0.md).

<!-- releases:end -->

## License

MIT
