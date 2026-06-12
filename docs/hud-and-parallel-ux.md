# HUD and Parallel UX

This document covers the live terminal interfaces for monitoring and executing OMK runs.

---

## HUD (`omk hud`)

The HUD is a **read-only dashboard** that gives you a real-time view of your project, system, and active runs without leaving the terminal.

### Panels

| Panel | Content |
|-------|---------|
| **System Usage** | CPU, memory, and disk utilization |
| **Kimi Usage** | OAuth account badge, 5-hour quota, weekly quota (with optional bar gauges via `OMK_KIMI_STATUS_GAUGES=1`) |
| **Project Status** | Git branch, changed files count, scaffold health |
| **Latest Run** | Most recent run ID, goal, status, and health |
| **TODO / Changed Files** | Sidebar list of open TODOs and uncommitted changes |

### Top Summary Bar

A compact header line shows:

- **Goal** — current or most-recent run goal
- **Run health** — `healthy` / `degraded` / `blocked` / `unknown`
- **Next action** — suggested command or recovery step

### Responsive Modes

The HUD adapts to terminal width automatically:

| Width | Layout |
|-------|--------|
| `>= 120 cols` | Full dashboard + right rail (all panels + sidebar) |
| `90–119 cols` | Summary bar + latest run + TODO list |
| `< 90 cols` | Compact single-column (summary bar + critical gauges only) |

### Flags

| Flag | Behavior |
|------|----------|
| `--watch` | Refresh every few seconds (default in TTY) |
| `--compact` | Force compact layout regardless of width |
| `--section <name>` | Show only one section: `run`, `project`, or `resources` |
| `--no-clear` | Do not clear the terminal between refreshes |
| `--alternate-screen` | Use the terminal alternate screen buffer (no scrollback pollution) |

### Goal-aware Display

The HUD resolves the current goal in this priority order:

1. `.omk/goals/<id>/goal.json` — active goal file
2. RunState snapshot — goal embedded in the latest persisted run
3. `goal.md` — fallback project goal document

### State Error UX

If a run state file is corrupt, missing, or invalid, the HUD shows a **recovery suggestion** instead of crashing:

- Missing state → prompt to run `omk parallel <goal>` or `omk run <flow> <goal>`
- Corrupt JSON → suggest checking `.omk/runs/` or running `omk doctor`
- Invalid schema → display the validation error and a link to relevant docs

---

## Parallel (`omk parallel`)

Parallel is the **DAG executor with live UI**. It orchestrates coordinator → worker fan-out → reviewer runs and renders progress in real time.

Runtime/provider UI fields should follow the canonical routing and worker-scope
contracts in
[`native-root-runtime-algorithms.md`](./native-root-runtime-algorithms.md):
Algorithm 5 for selected runtime, fallback chain, and route evidence;
Algorithm 7 for worker environment/capability scope.

### Header

The top of the parallel UI shows:

- **Goal** — the task being executed
- **Run ID** — unique timestamped identifier
- **Workers** — number of active worker slots
- **Approval policy** — `yolo`, `confirm`, or `reject`
- **Mode** — `watch` or `no-watch`

### Worker Grid

Each worker is rendered as a labeled card:

- **Role label** — e.g., `coder`, `reviewer`, `qa`
- **Elapsed time** — since the worker started its current task
- **Retry count** — number of retries for the current node

### Blocker Panel

Shown **only when a node fails or is blocked**:

- Failed node name and role
- Error summary
- Suggested recovery action (e.g., `omk chat --run-id <id>`, `omk summary`)

### Completion Panel

When the run finishes, a completion panel appears with next steps:

```txt
Run complete. Next steps:
  omk summary          → generate summary.md + report.md
  omk verify           → run quality gates on the result
  omk chat --run-id    → resume interactively
```

### Flags

| Flag | Behavior |
|------|----------|
| `--watch` | Live UI refresh every 1.5 s (default in TTY) |
| `--no-watch` | Static output, no refresh (default non-TTY) |
| `--alternate-screen` | Full-screen alternate buffer (opt-in) |
| `--no-pause` | Do not pause on completion; exit immediately |
| `--compact` | Force compact worker grid layout |

### Trust

- Alternate screen is **opt-in** (`--alternate-screen`).
- No forced scrollback loss: without the flag, output is appended to the main terminal buffer so you can scroll back through history.

---

## RunViewModel

`RunViewModel` is the **shared abstraction** between HUD and parallel UI. It interprets raw run state into a consistent, display-ready model.

### Inputs

| Input | Source |
|-------|--------|
| `RunState` | `.omk/runs/<run-id>/run-state.json` |
| Goal (optional) | `.omk/goals/<id>/goal.json` or `goal.md` |
| Changed files | `git status --short` |

### Outputs

| Output | Description |
|--------|-------------|
| **Health** | `healthy` / `degraded` / `blocked` / `unknown` |
| **Progress** | Completed nodes / total nodes |
| **ETA** | Estimated time remaining (when enough data exists) |
| **Active node** | Currently executing node + role |
| **Blocker** | First blocking or failed node, if any |
| **Workers** | Array of active workers with elapsed time and retry count |
| **Runtime route** | Selected provider/runtime, fallback chain, risk, sandbox, and approval policy when available |

Both HUD and parallel UI consume the same `RunViewModel`, so their interpretations of run health and progress are always consistent.
