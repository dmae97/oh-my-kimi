<p align="center">
  <img src="readmeasset/omk-marketing-control.webp" alt="OMK//CONTROL provider-neutral skill routing, evidence gates, and parallel delivery lanes" width="100%" />
</p>

<p align="center">
  <img src="readmeasset/omkgirl.png" alt="OMK girl mascot — operator avatar for the OMK//CONTROL coding harness" width="420" />
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
  <a href="https://github.com/dmae97/omk/releases/tag/v0.90.8"><img alt="Release" src="https://img.shields.io/badge/release-v0.90.8-00d7ff?style=flat-square" /></a>
</p>

> New issues and PRs from new contributors are auto-closed by default. Maintainers review auto-closed issues daily. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Installation

```bash
npm install -g open-multi-agent-kit --ignore-scripts
```

Then run it:

```bash
omk --version
omk
```

Or without a global install:

```bash
npx --ignore-scripts open-multi-agent-kit
```

Library packages:

```bash
npm install omk-agent-core   # Agent runtime with tool calling and state management
npm install omk-ai           # Unified multi-provider LLM API
npm install omk-tui          # Terminal UI library with differential rendering
```

---

# OMK Agent Harness Mono Repo

This is the home of the omk agent harness project including our self extensible coding agent.

* **[open-multi-agent-kit](packages/coding-agent)**: Interactive coding agent CLI
* **[omk-agent-core](packages/agent)**: Agent runtime with tool calling and state management
* **[omk-ai](packages/ai)**: Unified multi-provider LLM API (OpenAI, Anthropic, Google, …)

To learn more about omk:

* [Project demos from Mario](https://www.threads.com/@been_yg?hl=ko)
* [Browse all public Skills](SKILLS.md)
* [Read the documentation](https://omk.dev/docs/latest), but you can also ask the agent to explain itself

## OMK//CONTROL TUI

<p align="center">
  <img src="readmeasset/omk_tui.png" alt="OMK//CONTROL terminal dashboard — live DAG lanes, provider routing, MCP health, evidence gates, and telemetry in Night City Ops Console style" width="100%" />
</p>

The OMK//CONTROL startup surface is the default operator view. The header reads `omk v<package.version> · OMK//CONTROL`, using the installed workspace package version as its source of truth.

The default dark TUI theme uses the `omk-control-grid-dark` Night City palette and keeps the control sidebar focused on route, evidence, loop, MCP, runtime, skills, and context budget state.

## One control plane: deploy skills with OMK

OMK is not another model shell. It is the control plane around the models you already use: provider routing, scoped tools and MCP, evidence gates, parallel execution, and an operator-visible terminal surface.

**Official skill distribution uses OMK packages.** Build a package once, install it through `omk`, pin it, scope it to a project when needed, and enable or disable its resources from the same control plane. This README intentionally does not send users through a separate skills launcher.

```bash
# Global, pinned OMK package
omk install npm:open-multi-agent-kit@0.90.9

# Project-local, pinned Git package
omk install -l git:github.com/dmae97/open-multi-agent-kit@v0.90.9

# Inspect and control the installed resources
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

### From objective to verified delivery

| Need | OMK route | Output |
| --- | --- | --- |
| Shape a capability | `!omk plan a bounded goal` | Constraints, owned paths, and acceptance predicates |
| Run a bounded workflow | `!omk-loop <goal>` | Evidence-gated implementation, recovery, and a terminal status |
| Route marketing work | `!skill:omk-marketing <objective>` | One primary marketing skill plus at most one prerequisite support skill |
| Extend the harness | `omk install <pinned-package>` | Versioned extensions, skills, prompts, and themes under OMK control |

Use the minimum necessary skills per turn—usually one to three. A skill is loaded when it earns its place in the task, not because it happens to be installed.

### Why teams choose OMK

- **Control, not lock-in.** Keep providers interchangeable while retaining one execution, evidence, and operator model.
- **Evidence before completion.** A green-looking response is not a release signal; declared predicates and fresh verification are.
- **Parallelism with boundaries.** Independent work can run concurrently while owned paths, side effects, and evidence remain explicit.
- **Extensibility without a fork.** Ship skills, extensions, prompts, and themes as OMK packages instead of teaching every contributor a separate runtime.

The proof standard is operational: evaluate OMK against your own task completion, verification coverage, setup time, and recovery behavior. We do not claim an unmeasured benchmark win over another harness.

## Local freeze v0.90.9

The workspace packages are locally frozen at `0.90.9`; this is not an npm or GitHub release. Local build/check, keyless tests, npm packs, isolated npm/Bun installs, and the Linux x64 Bun binary/archive passed; live-provider and other-OS coverage remain outside this freeze. Publication, push, tag, dist-tag, and trusted-publisher mutations remain blocked pending authoritative WORM release infrastructure.

`dag-v2` is the local workspace default; validate it against your workload and preserve `waves-v1` (or set `OMK_TOOL_SCHEDULER=waves-v1`) as the process-local rollback. Run `omk session doctor --session <path|id> --repair --dry-run` before a repair, and use `omk provider doctor <provider-id> --level 0` to inspect provider configuration without a model probe. Package, CLI, config, session, RPC, and SDK compatibility are not newly certified by this freeze; validate existing integrations against the local workspace.
Local-freeze notes live in [.github/RELEASE_NOTES_v0.90.9.md](.github/RELEASE_NOTES_v0.90.9.md).

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

GitHub-focused release notes live in [.github/RELEASE_NOTES_v0.90.8.md](.github/RELEASE_NOTES_v0.90.8.md). The GitHub release workflow also extracts the canonical release body from [packages/coding-agent/CHANGELOG.md](packages/coding-agent/CHANGELOG.md).

## Share your OSS coding agent sessions

If you use OMK or other coding agents for open source work, publish sanitized sessions from `.omk/agent/sessions`.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

## All Packages

| Package | Description |
|---------|-------------|
| **[omk-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[omk-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[open-multi-agent-kit](packages/coding-agent)** | Interactive coding agent CLI |
| **[omk-tui](packages/tui)** | Terminal UI library with differential rendering |

For Slack/chat automation and workflow integrations, use OMK extensions and MCP servers.

## Adaptorch MCP integration

[AdaptOrch MCP](https://adaptorch.ai.kr) is a separate, proprietary reliability-kernel service (not part of
this monorepo) that OMK can route orchestration tasks through: topology-aware DAG routing, multi-model
synthesis, and consistency verification. It is versioned `0.1.0` — an MVP stage — with a public-ready free
Starter tier and paid Pro/Team tiers, and is backed by a published paper
([arXiv:2602.16873](https://arxiv.org/abs/2602.16873)).

The `adaptorch` and `adaptorch-prod` MCP servers plus the `adaptorch-route` and `adaptorch-synthesize` skills
ship in OMK's default `omk-core-verified` execution preset, so they are available from the first prompt of a
default session without extra setup. Actually invoking AdaptOrch (e.g. `adaptorch_run`) still requires an
`ADAPTORCH_CONTROL_PLANE_TOKEN` (a dev token is auto-set for a local control plane at `127.0.0.1:8000`) and
follows normal task-routing rules rather than firing on every message.

This is distinct from `packages/adaptorch-wpl` in this monorepo, an experimental, design-stage Work Packet
Loop package that is not yet wired into the `open-multi-agent-kit` CLI — see that package's own README for its
current status.

## Permissions & Containerization

OMK does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it.

If you need stronger boundaries, containerize or sandbox OMK. See [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) for three patterns:

- **OpenShell**: run the whole `omk` process in a policy-controlled sandbox.
- **Gondolin extension**: keep `omk` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole `omk` process in a local container for simple isolation.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).

## Development

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build        # Build all packages
npm run check        # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./omk-test.sh        # Run OMK from sources (can be run from any directory)
```

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `OMK_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent shrinkwrap.
- The published CLI package includes `packages/coding-agent/npm-shrinkwrap.json`, generated from the root lockfile, to pin transitive deps for npm users.
- Release smoke tests use `npm run release:local` to build, pack, and create isolated npm and Bun installs outside the repo before tagging a release.
- Local release installs, documented npm installs, and `omk update --self` use `--ignore-scripts` where supported.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Shrinkwrap generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## License

MIT
