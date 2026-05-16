# Repository Guidelines

## Project Overview

`roboomp` is a self-hosted GitHub triage-and-fix bot that drives [`omp --mode rpc`](https://github.com/can1357/oh-my-pi) as a subprocess. On every issue opened in an allowlisted repository it classifies the issue, applies labels, then branches into one of: reproduce → fix → PR (`bug` / `documentation`), single-comment answer (`question`), single thoughtful comment (`enhancement` / `proposal`), or brief comment (`invalid` / `duplicate`). Follow-up comments and PR review comments resume the same omp session so the agent keeps its prior reasoning. If the orchestrator restarts mid-task, the dispatcher resumes the same session via `omp --continue` from the per-issue `session_dir`, so an interrupted task re-enters its prior reasoning instead of restarting from scratch. The orchestrator runs as a single FastAPI process inside Docker with SQLite-backed durable event state.

## Architecture & Data Flow

Webhook → durable queue → async dispatcher → per-issue git worktree → omp RPC subprocess + host tools.

1. `POST /webhook/github` — HMAC-SHA256 verified against `GITHUB_WEBHOOK_SECRET` (`server.py` + `github_events.verify_signature`). Bad signature returns `401`.
2. `github_events.route()` decides one of `triage_issue` / `handle_comment` / `handle_pr_conversation` / `handle_review` / `cleanup_workspace` / `skip`. Bot-authored events (`*[bot]`, `user.type == "Bot"`, configured `bot_login`) and non-allowlisted repos are dropped here.
3. `db.record_event()` inserts the event with `INSERT OR IGNORE` on `X-GitHub-Delivery` (dedup). Endpoint returns `202`.
4. `queue.WorkerPool._dispatch_loop` atomically claims `state='queued'` rows under `BEGIN IMMEDIATE`, guarded by an in-process `_inflight` set keyed by `(owner, repo, number)` to serialize per-issue work. Cap: `ROBOMP_MAX_CONCURRENCY` (default 8).
5. `sandbox.SandboxManager.ensure_workspace()` produces a worktree at `/data/workspaces/<owner>__<repo>__<n>/repo` on a deterministic branch `farm/<8hex>/<slug>`, backed by a shared `--filter=blob:none` clone pool. Credentialed remote URL and git identity are reset every time.
6. `tasks.*` dispatchers build `TaskInputs` and call `worker.run_task()` which spawns `omp --mode rpc` with `cwd=worktree`, persistent `session_dir`, and a randomly-picked model from `ROBOMP_MODEL` (CSV pool). When `<session_dir>/*.jsonl` already exists the worker passes `--continue`, so both follow-up events and crash-restarted events resume the same session.
7. Inside the subprocess the agent uses **built-in omp tools** (read/edit/write/bash/lsp, scoped to the worktree) and **host tools** from `host_tools.py` (the only surface allowed to mutate GitHub or write audit rows).
8. Success → event `state='done'`. Exception → `state='failed'` with a credential-redacted traceback in `events.last_error`. The `_inflight` slot is released either way.

## Key Directories

- `src/robomp/` — package (see "Important Files").
- `src/robomp/prompts/` — Mustache-style `{{var}}` templates loaded by `persona.py` via `@cache` and `importlib.resources`. Shipped as package data (`pyproject.toml` `package-data`).
- `tests/` — pytest suite. `test_worker_smoke.py` is gated on `ROBOMP_INTEGRATION=1`.
- `data/` — runtime state (sqlite + WAL, `workspaces/`, `logs/`). Never committed.
- `/work/pi/Dockerfile` — produces `oh-my-pi/artifacts:dev` (pi-natives `.node` + omp-rpc wheel). Built once per pi-source change via `bun run pi-artifacts`; roboomp's runtime image consumes it via `COPY --from=`.

## Development Commands

Task runner is now `bun` against the root `package.json` (workspaces = `["web"]`). `just` is gone; every recipe lives in the root `scripts` block. Local venv (no docker): `bun run install:py` runs `pip install -e '.[dev]'`. From there:

```
bun run test                # pytest -x tests/
bun run test:file <PATH>    # single file
bun run test:integration    # ROBOMP_INTEGRATION=1, requires omp on PATH
bun run serve               # python -m robomp serve on the host
```

Docker inner loop:

```
bun run build               # pi-artifacts (if pi changed) + docker compose build
bun run dev                 # build + up -d + follow logs
bun run up / down / restart / logs / sh
bun run rebuild             # docker compose build --no-cache
```

Frontend (Vite + SolidJS, in `web/`):

```
bun run web:dev             # vite dev server with proxy to :8080
bun run web:build           # produce src/robomp/static/ bundle
bun run web:typecheck       # tsc --noEmit
```

In-container CLI (`robomp` console script → `robomp.cli:main`):

```
bun run triage owner/repo#N   # full pipeline against a live issue
bun run replay <delivery_id>  # re-enqueue a stored webhook
bun run issue-status          # tabular dump of issues table
bun run cleanup owner/repo#N  # force workspace removal + state=abandoned
```

HTTP/sqlite inspection: `bun run healthz`, `bun run readyz`, `bun run events [N]`, `bun run issues [N]`, `bun run sqlite`, `bun run sql "<SQL>"`, `bun run tool-calls owner/repo#N`, `bun run stuck`. Webhook smoke: `bun run ping`. Danger: `bun run wipe-workspaces`, `bun run nuke-data`, `bun run reset`.

Lint + format: TypeScript via Biome (config in `biome.json`), Python via Ruff (config in `pyproject.toml`). `bun run lint` checks both; `bun run fix` rewrites both. `bun run lint:ts` / `bun run lint:py` / `bun run fix:ts` / `bun run fix:py` scope to one language. `bun run typecheck` runs `tsc --noEmit` against `web/`. Run before committing non-trivial changes; CI is not yet wired up.

## Code Conventions & Common Patterns

- **Python ≥3.11**, container is 3.12-slim. `from __future__ import annotations` is the norm; type hints are mandatory on public functions.
- **Records**: prefer `@dataclass(slots=True, frozen=True)` for immutable value types (see `github_client.IssueInfo`, `sandbox.Workspace`, `db.EventRow`).
- **Async style**: FastAPI handlers and `queue.WorkerPool` are async. `worker.run_task` is **synchronous** and runs in a worker thread because `omp-rpc` is blocking — keep it that way; don't try to async it. CLI commands wrap with `asyncio.run`.
- **Config**: `pydantic-settings` `Settings` in `config.py` with `ROBOMP_*` env prefix (e.g. `ROBOMP_MAX_CONCURRENCY`, `ROBOMP_REPO_ALLOWLIST`). Access only via `get_settings()` (`@cache` singleton). Tests must call `reset_settings_cache()` after mutating env.
- **Dependency injection**: pass `Settings`, `Database`, `GitHubClient`, `SandboxManager` explicitly into `create_app()`, `WorkerPool`, and `ToolBindings`. No module-level globals other than the singleton accessors (`get_settings`, `get_database`).
- **State**: SQLite (`db.Database`) is the source of truth for `events`, `issues`, `tool_calls`. Thread-safe via an internal `_lock`; `BEGIN IMMEDIATE` for claim contention. In-memory state is only the `_inflight` set in `WorkerPool`.
- **Error handling**: custom exception types (`GitHubError` with `retry_after`, `GitCommandError`, `InvalidIssueRef`, `RpcCommandError`). `sandbox.redact_credentials()` strips `user:pass@` from any URL before it lands in logs, audit rows, or exception messages. **Never** include credentialed URLs in error strings.
- **Logging**: structured JSON via `logging_config.JsonFormatter`. Use `logger.info("event", extra={...})`; do not collide with `_RESERVED` keys. Configure once via `configure_logging()`.
- **Host tools** (`host_tools.py`): every tool is built from a per-task `ToolBindings` closure and audits through `_audit()` into `tool_calls`. Audit only ever sees agent-supplied args, never internal credentials. New tools follow the same pattern: validate args → call `GitHubClient` / `SandboxManager` → return structured dict → audit.
- **Naming**: snake_case for everything Python; module names singular nouns; test files `test_<module>.py`; test functions `test_<action>_<condition>`.
- **Prompts**: edit `src/robomp/prompts/*.md`. Variables use `{{path.to.field}}`; resolution is `persona._lookup`. The package install includes them as data files — adding a new prompt requires no other registration.

## Important Files

- `src/robomp/server.py` — FastAPI app, `/webhook/github`, `/healthz`, `/readyz`, `/events`, `/issues`, manual triage/replay endpoints, dashboard at `/`.
- `src/robomp/queue.py` — `WorkerPool` dispatcher and `_inflight` serialization.
- `src/robomp/tasks.py` — the five task entry points the dispatcher calls.
- `src/robomp/worker.py` — synchronous omp RPC driver, prompt assembly via `persona`.
- `src/robomp/host_tools.py` — agent's GitHub surface; tool list: `classify_issue`, `set_issue_labels`, `gh_post_comment`, `repro_record`, `gh_push_branch`, `gh_open_pr`, `gh_request_review`, `mark_unable_to_reproduce`, `abort_task`, `fetch_issue_thread`.
- `src/robomp/sandbox.py` — clone pool + worktree lifecycle, `GitCommandError`, credential redaction.
- `src/robomp/github_client.py` — typed httpx client; parses webhook payloads into `IssueInfo` / `CommentInfo` / `PullRequestInfo`.
- `src/robomp/github_events.py` — routing and HMAC verification.
- `src/robomp/db.py` — sqlite schema and DAOs (`record_event`, `claim_next_event`, `upsert_issue`, `log_tool_call`).
- `src/robomp/config.py` — `Settings` model and `get_settings()`.
- `src/robomp/cli.py` — Click CLI (`serve`, `triage`, `replay`, `status`, `cleanup`).
- `src/robomp/dashboard.py` — single-page HTML dashboard served from `/`.
- `pyproject.toml` — packaging + pytest config (`asyncio_mode = "auto"`, `testpaths = ["tests"]`).
- `Dockerfile` — slim runtime; consumes `oh-my-pi/artifacts:dev` (built from `/work/pi/Dockerfile`) for `pi_natives.linux-*.node` + `omp_rpc-*.whl`. Tini entrypoint, exposes `8080`, `VOLUME /data`.
- `docker-compose.yml` — `build.args.PI_ARTIFACTS_IMAGE`, mounts `$PI_ROOT:/work/pi:ro`, `./data:/data`, `~/.omp/agent/models.yml:ro`, `extra_hosts: llm-gateway.internal:host-gateway`.
- `entrypoint.sh` — validates `PI_ROOT`, creates `/data/{workspaces,logs}` + build caches.
- `.env.example` — authoritative list of required runtime env vars.
- `README.md` — full architecture + operational reference. Authoritative for end-to-end flow, host-tool spec, security posture, and configuration reference.

## Runtime/Tooling Preferences

- **Python**: 3.11+ source target, 3.12 in container. Setuptools src layout (`pyproject.toml` `[tool.setuptools] package-dir = { "" = "src" }`).
- **Package manager**: `pip` only. No poetry / uv / pdm files; don't introduce one.
- **Task runner**: `bun` (root `package.json` `scripts`). Always reach for an existing `bun run` recipe before invoking `docker compose` or `pytest` directly.
- **Container runtime**: Docker Compose v2. The image embeds Bun 1.3.14 + a rustup launcher and exposes `omp` via a `/usr/local/bin/omp` shim; `ROBOMP_OMP_COMMAND=omp` should not need changing.
- **Required env** (set in `.env`, see `.env.example`): `GITHUB_WEBHOOK_SECRET`, `ROBOMP_BOT_LOGIN`, `ROBOMP_GIT_AUTHOR_NAME`, `ROBOMP_GIT_AUTHOR_EMAIL`, `ROBOMP_REPO_ALLOWLIST`, plus model knobs (`ROBOMP_MODEL`, `ROBOMP_THINKING`, optional `ROBOMP_PROVIDER`) and rate-limit / concurrency / timeout overrides. **GitHub auth is mode-exclusive**: either set `ROBOMP_GH_PROXY_URL` + `ROBOMP_GH_PROXY_HMAC_KEY` (gh-proxy mode; PAT lives only in the sidecar container — the bundled compose default), or set `GITHUB_TOKEN` directly (single-process PAT mode). `Settings._validate_proxy_or_pat` rejects a `.env` that sets both.
- **PI_ROOT resolution**: build (`bun run pi-artifacts`) and `bun run up` route through `scripts/with-pi-root.sh`, which picks `$PI_ROOT` → `/work/pi` → an auto-cloned cache at `./.cache/oh-my-pi`. Override with `ROBOMP_PI_REPO_URL` / `ROBOMP_PI_REF` / `ROBOMP_PI_CACHE_DIR` / `ROBOMP_PI_AUTO_UPDATE=1`. Inside the container the path is always `/work/pi`; compose mounts whatever the wrapper resolves on the host. Build invalidation stays bounded: Python-only edits in roboomp never trigger a natives recompile.
- **Forbidden**: no docker-in-docker, no extra service containers, no new background workers outside `WorkerPool`. The container itself is the isolation boundary; per-issue isolation is the git worktree.

## Testing & QA

- **Framework**: `pytest` with `asyncio_mode = "auto"` (`pyproject.toml`). HTTP mocking with `httpx.MockTransport`; `respx` is available but only `MockTransport` is used in-tree — match that style.
- **Fixtures** (`tests/conftest.py`):
  - `env` — `monkeypatch`-sets all required `ROBOMP_*` env vars and calls `reset_settings_cache()` before/after.
  - `settings` — invokes `ensure_paths()` for sqlite/workspace dirs.
  - `db` — isolated `tmp_path/test.sqlite` `Database`; tests must `database.close()` in teardown when bypassing this.
- **Isolation rules**: any test mutating env via `monkeypatch.setenv` MUST also call `reset_settings_cache()` to invalidate the `@cache`d `get_settings()`.
- **Async tests**: `test_github_client.py` and `test_host_tools.py` spin custom event loops in background threads to bridge sync-style tests with async client code. Prefer `pytest-asyncio` `auto` mode (`async def test_*`) for new tests; only fall back to the loop helpers if matching the surrounding file's style.
- **Mocking**: never patch internals; inject test doubles via `httpx.MockTransport` for HTTP and via the `db` / `tmp_path` fixtures for storage. Sandbox tests use a real local bare repo as the upstream.
- **Integration**: `tests/test_worker_smoke.py` is gated by `ROBOMP_INTEGRATION=1` (uses `pytestmark.skipif`) and needs `omp` on `PATH`. Don't enable it in default `bun run test`.
- **Coverage expectation**: ~80 unit tests currently. New code with a control-flow branch needs a test covering it; new host tools need at minimum a happy path + one validation-failure path mirroring `test_host_tools.py`. Test logical behavior (assertions on observable effects in DB / HTTP requests), not literal strings or default config values.
