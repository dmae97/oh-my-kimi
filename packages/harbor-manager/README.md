# @oh-my-pi/harbor-manager

Manage [Harbor](https://github.com/laude-institute/harbor) benchmark runs against
the **local `omp` build**: a CLI runner with a live terminal dashboard, a
SQLite-backed run store, a REST/SSE API, and a web dashboard with live
run → trial → transcript drill-down.

Works with any Harbor dataset (`terminal-bench@2.0` by default,
`swe-bench/swe-bench-verified`, …).

```bash
# CLI run (owns the terminal, writes a markdown report)
bun src/runner.ts --model anthropic/claude-sonnet-4-6 --tasks 20 --concurrency 4

# Web manager: dashboard + API on :4700
bun run serve            # bun src/server.ts [--port 4700] [--jobs-dir <path>]
```

## How runs execute

1. **Local omp, not npm.** By default the runner bind-mounts the repo
   read-only into each task container (`--install source`) and runs omp
   straight from `packages/coding-agent/src/cli.ts` — TS edits apply to the
   next trial with no rebuild. A cached linux `node_modules` tree (built once
   per lockfile change inside `oven/bun`, stored in `<jobs-dir>/_bench/_deps/`)
   shadows the host's darwin one, and a linux `bun` binary is mounted at
   `/opt/omp/bin` — so trial setup needs zero outbound network. Alternatives:
   `--install local` (pack a tarball per run) or `--binary` (prebuilt
   `dist/omp-linux-*` self-contained binaries).
2. **Auth never enters containers.** A generated `models.yml` routes provider
   `baseUrl`s at the host pm2 auth-gateway; the gateway resolves credentials
   host-side.
3. **Harbor owns trials.** The runner/serve layer polls each trial's
   `result.json` for progress, spend, and outcomes.

## Server

- `GET /` — dashboard: run list (SSE-live), trial grid, transcript viewer
  that tails live sessions.
- `GET /api/runs` — run rows (rollups: pass/fail/error/spend/tokens).
- `POST /api/runs` — launch. Body:

  ```json
  {
    "model": "anthropic/claude-opus-4-8",
    "dataset": "swe-bench/swe-bench-verified",
    "tasks": 20,
    "concurrency": 4,
    "timeoutMultiplier": 2,
    "include": ["swe-bench/astropy__astropy-14995"],
    "slide": { "model": "google/gemini-3.5-flash", "onAction": true, "plan": true }
  }
  ```

  `slide.turns` and `slide.onAction` are mutually exclusive triggers.
- `GET /api/runs/:name` — `{ run, trials }` (syncs from disk on read).
- `DELETE /api/runs/:name` — cancel a manager-launched run.
- `GET /api/runs/:name/trials/:trial/transcript?tail=N[&raw=1]` — compact
  (or raw JSONL) view of the trial's live session log.
- `GET /api/events` — SSE stream of run-list snapshots (sent on change).

State lives in `<jobs-dir>/_manager/harbor-manager.sqlite`; the filesystem
stays the source of truth and historical CLI runs are auto-discovered.

## Runner options (excerpt)

| Option | Default | Notes |
|---|---|---|
| `-m, --model <provider/model>` | `anthropic/claude-sonnet-4-6` | Repeatable |
| `-l, --tasks <N>` | `20` | Max tasks |
| `-n, --concurrency <N>` | `4` | Concurrent trials |
| `-k, --attempts <N>` | `1` | Attempts per task (pass@k) |
| `-d, --dataset <name>` | `terminal-bench@2.0` | Any Harbor dataset id |
| `-i/-x, --include/--exclude <glob>` | — | Task filters (repeatable) |
| `--timeout-multiplier <x>` | — | Scales task agent/verifier timeouts |
| `--agent-arg <arg>` | — | Extra arg forwarded verbatim to the in-container omp CLI (repeatable) |
| `--env <KEY[=VALUE]>` | — | Forward env into the omp container (repeatable); `KEY` alone forwards the host value |
| `--binary <path>` | — | Prebuilt omp binary (repeat for arm64+x64) |
| `--install <source\|local\|published>` | `source` | `source` = repo bind-mount, `local` = tarball pack, `published` = npm `@oh-my-pi/pi-coding-agent` |
| `--gateway-url <url>` | `http://host.docker.internal:4000` | |
| `--no-gateway` | off | Pass host provider keys into containers instead |
| `-o, --jobs-dir <path>` | `<repo>/runs/harbor` | Shared with the server |
| `--dry-run` | off | Print the harbor command + models.yml and exit |

## Outputs

- `<jobs-dir>/<jobName>/` — Harbor trial dirs (`result.json` per trial).
- `<jobs-dir>/_bench/<jobName>/report.md` — markdown summary table.
- `<jobs-dir>/_bench/<jobName>/harbor.log` — full Harbor output.
- `<jobs-dir>/_manager/logs/<jobName>.log` — runner output for API-launched runs.

## Caveats

- **Network policy.** On Harbor's local Docker backend only **public**
  registries work; task containers reach models via the host gateway.
- **`--install source` reflects local TS changes** with no rebuild, but Rust
  natives load from the in-tree `packages/natives/native/pi_natives.linux-*.node`
  prebuilds — rebuild those when Rust changes (the loader skips the version
  sentinel for workspace loads, so a stale `.node` runs silently).
- **Source mode is single-arch.** The deps tree matches the docker daemon's
  native arch; trials on emulated images (e.g. x64 tasks on an arm64 host)
  fail setup with an arch-mismatch error — use `--binary` for those.
- **The repo is visible (read-only) inside task containers** in source mode;
  fine for curated benchmarks, but don't point it at untrusted tasks.
- **`--install local` reflects local TS changes** (inlined into `dist/cli.js`),
  but **not** uncommitted Rust natives — rebuild `packages/natives` per target
  first (the version sentinel must match).
