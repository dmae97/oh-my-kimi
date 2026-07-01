# User-Facing Packages

This page indexes README-only user-facing package CLIs and features that need root docs coverage beyond package-local READMEs/manifests.

## Root-docs policy

- **Include** root docs coverage for package-local CLIs, extension features, dashboards, and benchmark runners that users can run directly or through `omp`.
- **Exclude explicitly** when a package/crate is internal implementation only; point to the architecture doc that owns it.
- Package READMEs and manifests remain the source of truth for package-local setup and flags; root docs make the feature discoverable and link to exact source paths.
- Internal Rust crates remain covered by native architecture docs unless promoted as standalone user-facing commands or APIs. The contributor-facing map lives at [`native-crates.md`](./native-crates.md); today every `crates/*` entry is internal to `@oh-my-pi/pi-natives` and the embedded shell, so [`natives-architecture.md`](./natives-architecture.md) and the surrounding native docs own them.

## Package CLIs and features

### `packages/swarm-extension` — swarm orchestration

Sources: [`packages/swarm-extension/README.md`](../packages/swarm-extension/README.md), [`packages/swarm-extension/package.json`](../packages/swarm-extension/package.json), [`packages/swarm-extension/src/cli.ts`](../packages/swarm-extension/src/cli.ts), [`packages/swarm-extension/src/extension.ts`](../packages/swarm-extension/src/extension.ts).

- Package: `@oh-my-pi/swarm-extension`; bin: `omp-swarm`.
- Feature: multi-agent DAG orchestration from YAML swarms, supporting `pipeline`, `parallel`, and `sequential` modes.
- Standalone CLI: `omp-swarm path/to/swarm.yaml` runs until completion or process termination.
- TUI extension mode: add the package path to `extensions`, then use `/swarm run <file.yaml>`, `/swarm status <name>`, or `/swarm help`.
- Inputs: YAML under top-level `swarm` with `name`, `workspace`, `mode`, optional `target_count`/`model`, and `agents` with `role`, `task`, optional `model`, `waits_for`, and `reports_to`.
- Side effects/output: creates the workspace if needed and persists state/logs under `<workspace>/.swarm_<name>/`.
- Limits/errors: validates the YAML definition, dependency graph, and cycles before execution; standalone runs have no built-in timeout.

### `packages/terminal-bench` — Terminal-Bench 2 runner

Sources: [`packages/terminal-bench/README.md`](../packages/terminal-bench/README.md), [`packages/terminal-bench/package.json`](../packages/terminal-bench/package.json), [`packages/terminal-bench/src/runner.ts`](../packages/terminal-bench/src/runner.ts), [`packages/terminal-bench/agent/omp_local.py`](../packages/terminal-bench/agent/omp_local.py).

- Package: private `@oh-my-pi/terminal-bench`; bin: `tb2`.
- Feature: runs `harbor-framework/terminal-bench-2` against a local or published `omp` build with a live progress, spend, token, ETA, and pass/fail dashboard.
- CLI: `bun src/runner.ts [options] [-- <extra harbor args>]`; package bin exposes `tb2`.
- Modes: default `omp` agent, `oracle`/`nop`/any Harbor agent via `--agent`; local source packing by default, published npm install via `--install published`; `cleanup` command removes leftover Harbor Docker resources.
- Key inputs: `--model`, `--tasks`, `--concurrency`, `--attempts`, `--include`, `--exclude`, `--dataset`, `--thinking`, `--advisor-model`, gateway options, `--tarball`, `--no-build`, `--dry-run`, and passthrough Harbor args.
- Outputs: Harbor job directories plus `_bench/<jobName>/report.md`, `harbor.log`, and generated `models.yml` under `--jobs-dir`.
- Side effects/limits: requires Docker, Harbor, and usually the host auth gateway; local install packs `packages/coding-agent`; web search is off by default because it cannot authenticate through the gateway; Alpine/musl task images are unsupported by the native prebuilds.

### `packages/stats` — local usage dashboard

Sources: [`packages/stats/README.md`](../packages/stats/README.md), [`packages/stats/package.json`](../packages/stats/package.json), [`packages/coding-agent/src/cli/stats-cli.ts`](../packages/coding-agent/src/cli/stats-cli.ts).

- Package: `@oh-my-pi/omp-stats`; bin: `omp-stats`; main user path: `omp stats`.
- Feature: local observability dashboard for AI usage statistics from session JSONL logs.
- CLI modes: `omp stats` starts the dashboard server, opens `http://localhost:3847`, and keeps running; `omp stats --port <port>` changes the port; `omp stats --summary` prints a console summary; `omp stats --json` prints JSON and exits.
- Programmatic API: exports helpers such as `syncAllSessions()` and `getDashboardStats()` for embedding.
- Inputs/storage: reads `~/.omp/agent/sessions/`; stores aggregates in `~/.omp/stats.db`.
- Outputs: dashboard metrics and API endpoints including `/api/stats`, `/api/stats/models`, `/api/stats/folders`, `/api/stats/timeseries`, and `/api/sync`.
- Side effects/limits: syncs session files before output; long-running dashboard stops on `Ctrl+C` and closes the stats database.

### `packages/typescript-edit-benchmark` — TypeScript edit benchmark

Sources: [`packages/typescript-edit-benchmark/package.json`](../packages/typescript-edit-benchmark/package.json), [`packages/typescript-edit-benchmark/src/index.ts`](../packages/typescript-edit-benchmark/src/index.ts), [`packages/typescript-edit-benchmark/src/runner.ts`](../packages/typescript-edit-benchmark/src/runner.ts), [`packages/typescript-edit-benchmark/src/tasks.ts`](../packages/typescript-edit-benchmark/src/tasks.ts), [`packages/typescript-edit-benchmark/src/report.ts`](../packages/typescript-edit-benchmark/src/report.ts).

There is no package README at this path today; the manifest and CLI entrypoint help are the cited package-local sources.

- Package: private `@oh-my-pi/typescript-edit-benchmark`; bin: `typescript-edit-benchmark`.
- Feature: benchmark suite for evaluating coding-agent edit success on TypeScript source-code mutation fixtures.
- CLI: `bun run bench:edit [options]` in source help; package scripts also expose `bun run src/index.ts` through `start`.
- Key inputs: provider/model, thinking level, runs per task, timeout, task concurrency, task IDs, max tasks, fixture directory or `.tar.gz`, edit variant/fuzzy settings, guided mode, retry/turn limits, output path, report format, fixture validation, and required tool-call flags.
- Fixtures: each task directory contains `prompt.md`, `input/`, `expected/`, and `metadata.json`; bundled distribution can use `fixtures.tar.gz`.
- Outputs: markdown or JSON benchmark reports under `runs/` by default, with live progress and optional conversation dumps.
- Side effects/limits: creates the repository `runs/` directory, extracts fixture archives to temp space, and runs agent sessions against copied fixtures; `--check-fixtures` validates fixture structure and exits.
