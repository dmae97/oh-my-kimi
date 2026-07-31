# OMK

Provider-neutral coding agent and multi-agent orchestration toolkit.

OMK routes work across models, constrains tools and paths, verifies outcomes, and keeps replayable evidence.

---

## Scope. Verify. Replay

OMK is a verified, provider-neutral control plane for Codex, Claude Code,
OpenCode, and local coding agents.

It scopes parallel work into bounded DAG lanes, blocks completion without
fresh evidence, and records replayable artifacts for review and recovery.

| Problem | OMK |
| --- | --- |
| Parallel agents overwrite the same work | Resource claims and owned paths bound each lane |
| An agent says "done" before the build is green | Acceptance predicates block unverified completion |
| A session crashes midway | Replayable state and session repair preserve the run |
| The preferred model changes | The control and evidence model stays stable |

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
- [Release notes](https://github.com/dmae97/omk/releases)

## Recent releases

<!-- releases:start -->

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

## Release v0.93.0

### Added

- Ported upstream Pi 0.82.0 bash session environment: the LLM-callable bash tool now receives `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL` (parent-env spoofing is stripped; disable per tool via `createBashTool(cwd, { exposeSessionEnvironment: false })`). See [Environment Variables](packages/coding-agent/docs/environment-variables.md).
- Ported upstream Pi 0.82.0 `bash_execution_update` session events: direct RPC `bash` commands stream output chunks correlated with the command `id`. See [RPC](packages/coding-agent/docs/rpc.md).
- Ported upstream Pi 0.81.1/0.82.0 summarization resilience: compaction and branch-summary calls now follow `retry` settings with exponential backoff (new `summarization_retry_scheduled` / `summarization_retry_attempt_start` / `summarization_retry_finished` session events, surfaced in TUI and RPC), run with prompt caching disabled, and use fresh routing session IDs. See [Compaction](packages/coding-agent/docs/compaction.md).
- Ported upstream Pi 0.82.0 abortable provider retries in `omk-ai`: SDK-level retries are replaced by `retryProviderRequest` with abortable backoff sleeps, retry-after caps now fail fast instead of clamping, and transient DNS/transport errors are classified retryable.
- Subagent capability enforcement: agent frontmatter may declare `skills`/`mcp`/`hooks` plus `enforceCapabilities: true` to spawn with `--no-skills` + resolved `--skill` paths; `enforceCapabilities` now correctly parses YAML booleans/numbers/strings (`parseEnforceFlag`), the skill catalog scan skips archived corpus trees (e.g. `system-prompts-leaks`) so real skill names resolve to their real paths, and the MCP allowlist is synced to the live configured server set. Includes deterministic OMK-native domain profiles for the capability router and 16 coercion unit tests (`examples/extensions/subagent/agents.test.ts`).

### Fixed

- Fixed persisted compaction envelope validation rejecting every session compacted two or more times: the writer attests the kept-window slice from the previous compaction's `firstKeptEntryId`, but reopen validation required the full parent branch, so any twice-compacted session crashed on open with `Invalid compaction envelope source`. Validation now accepts either exact form (tamper-evidence unchanged); regression tests in `test/session-file-compaction-window.test.ts`.
- Ported upstream Pi 0.82.0 clipboard fix: await `wl-copy` exit status and fall through to xclip/OSC 52 on failure instead of claiming success fire-and-forget.

Release notes live in [RELEASE_NOTES_v0.93.0.md](.github/RELEASE_NOTES_v0.93.0.md).

<!-- releases:end -->

## License

MIT
