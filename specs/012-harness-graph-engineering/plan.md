# Implementation Plan: Harness Graph Engineering

**Spec**: `specs/012-harness-graph-engineering/spec.md`
**Status**: Active (Phases 1–7 shipped)
**Runtime root**: `/home/yu/omk`
**Scorecard**: `.omk/harness-graph/SCORECARD.md`

## Architecture

A build-time analysis suite (no runtime service) under `.omk/harness-graph/`. Stdlib + one
approved dep (`networkx`, already installed). Deterministic and re-runnable.

```
run.sh
 ├─ build-harness-graph.mjs    3-tier skill graph                       → harness-graph.json
 ├─ reconcile-catalog.mjs      inactive→disk-location + demand          → reconcile-plan.md
 ├─ graph_analyze.py           SPOF / Louvain / lift / redundancy       → graph-analysis.md|.json
 ├─ recommend-wiring.py        hybrid CF (jaccard·idf·lift)             → wiring-recommendations.*
 ├─ code_crosslink.py          agent→skill→script→dep                   → code-crosslink.*
 ├─ drift_loop.py              snapshot + diff vs previous              → drift-report.md
 ├─ orphan-triage.mjs          orphan-active prune-vs-wire (report)     → orphan-triage.md
 ├─ health_gate.py             fail-closed + debt-allowlist             → health-gate.md|.json
 ├─ dashboard.py               executive one-pager                      → dashboard.md
 ├─ test_harness_graph.py      synthetic unit tests (18)
 ├─ fix-agent-hygiene.mjs      trailing-punct backlog                   (--apply)
 └─ activate-roots.mjs         demanded skill dirs → settings.json      (--apply)
```

Session hook: `hooks/session-drift-audit.sh` (registered as `harness-graph` in `hooks.json`).

## Ground-truth sources (accuracy contract)

| node type | source of truth |
| --- | --- |
| skills | `skills-index.txt` ∪ `skills.json` ∪ enabled `settings.json.skills` ∪ on-disk SKILL.md frontmatter |
| hooks | `$OMK_HOME/extensions/*.sh` ∪ `hooks.json` (discovery empty → throw) |
| mcp | `$OMK_HOME/mcp.json` ∪ `agent/mcp.json` (empty → throw) |
| agents | `~/.omk/agent/agents/*.md` capability lines |

**Rule**: dead-link counts are "unresolved against the on-disk catalog", never a metric to
game by mutating the runtime catalog or hardcoding answer keys.

## Algorithm stack (phase 6–7)

| concern | algorithm |
| --- | --- |
| SPOF | `blast_radius + 3×sole_provider` (bipartite-aware; not DFS articulation) |
| concentration | top1/top3 hub share of agent→cap edges |
| communities | skill–skill projection (shared agents ≥2) + Louvain / greedy modularity |
| co-usage | association lift = \|A∩B\|·N / (\|A\|·\|B\|) |
| redundancy | agent-set Jaccard ≥ 0.7 |
| wiring recs | `Σ peer_jaccard · idf(skill) · lift_boost` |
| gate | allowlist caps; new/grown debt FAIL; known debt WARN |

## Safety

- Every settings.json / agent-file mutation backs up first (`*.bak-*` / `agents-backup-*.tgz`).
- Semantic edits log each change to `.omk/runs/harness-graph/`.
- Orphan-active pruning is report-only (no auto-delete).
- `protect-secrets` prune requires explicit `--targets` + operator confirm (allowlisted).

## Verification

```bash
bash .omk/harness-graph/run.sh                 # full pipeline + gate + tests
python3 .omk/harness-graph/test_harness_graph.py
node .omk/harness-graph/gen-evidence.mjs       # T001–T020
```

Expected healthy floor: `skillEdgesDead:0`, `skillEdgesInactive:0`, `malformedAgents:0`,
cycles:0, unit tests green. Health gate may WARN on allowlisted residual debt.

## Rollback

Restore from the timestamped backups (settings.json, agents tarball, harness SKILL.md).
