# Harness Graph — standing drift audit

Graph-based control plane for the OMK harness (agents × skills × hooks × MCP). Replaces the
manual, prose-based Phase 7-5 audit in the `harness` skill with a deterministic, re-runnable
graph. Nodes = agents/skills/hooks/mcp; edges = agent→{skill,hook,mcp} declared in each agent's
`- Skills:/Hooks:/MCP:` capability lines.

**Spec-kit governed**: this work is specified under `specs/012-harness-graph-engineering/`
(spec.md + plan.md + tasks.md with DAG task metadata). Evidence per task lives in
`.omk/runs/harness-graph/T0xx.md`. Re-verify with `bash .omk/harness-graph/run.sh`.

## Scripts (stdlib + networkx, no heavy deps)

| script | what it does |
| --- | --- |
| `build-harness-graph.mjs` | Builds the graph, tiers every skill ref (active / inactive / dead), emits `out/harness-graph.json` + `harness-queries.json` + `harness-report.md`. |
| `reconcile-catalog.mjs` | P0: resolves where every *inactive* skill lives on disk and how many agents demand it → `out/reconcile-plan.md` (activation plan). |
| `activate-roots.mjs` | P0 fix: adds only the demanded skill dirs to `settings.json` (`--apply` backs up first). Idempotent. |
| `fix-agent-hygiene.mjs` | SAFE at-source fixer: strips trailing sentence punctuation from capability lines (`--apply` backs up first). Reports malformed/dead refs into `out/agent-hygiene-backlog.json`. |
| `graph_analyze.py` | **networkx structural layer**: reachability, blast radius, articulation points, cycles, skill communities, dead-cut list → `out/graph-analysis.md`. |
| `drift_loop.py` | **temporal layer**: snapshots each run, diffs vs previous, emits drift alerts → `out/drift-report.md`. |

### Structural queries

```bash
python3 .omk/harness-graph/graph_analyze.py --reach backend-architect  # everything an agent can pull in
python3 .omk/harness-graph/graph_analyze.py --impact filesystem        # blast radius if a node is removed
```

## Run

```bash
bash .omk/harness-graph/run.sh          # regenerate every report
node .omk/harness-graph/build-harness-graph.mjs
node .omk/harness-graph/reconcile-catalog.mjs
node .omk/harness-graph/fix-agent-hygiene.mjs           # dry-run
node .omk/harness-graph/fix-agent-hygiene.mjs --apply   # writes (backs up first)
```

## Accuracy model — why the tiers matter

A naive "does this skill exist in my index" check reported **317 dead skills**. That was wrong:
the index proxy was narrower than the on-disk universe and agent files ended capability lines
with a period (`..., ponytail.`). After tiering against the full on-disk catalog and stripping
trailing punctuation the honest numbers are **7 dead / 0 dead hooks / 0 dead mcp**, with the real
problem being **689 inactive edges** (skills present on disk but not in the active runtime
catalog). Ground-truth proxies (`skills-index.txt`, `mcp.json`) are narrower than what the runtime
resolves; treat dead-link counts as "unresolved against the on-disk catalog", never mutate the
runtime catalog to make a metric go green.

**Status:** the 689 inactive edges were resolved to **0** by `activate-roots.mjs` (224 demanded
skill dirs added to `settings.json`). Remaining honest debt: 0 dead skill refs + 0 malformed
agents + 434 orphan-active skills + **3 dead hooks (398 edges)**. Framework/MCP evaluation in
`FRAMEWORK-RESEARCH.md`.

## The green-metric trap (2026-08-01)

`hookEdgesDead: 0` was not a measurement. `build-harness-graph.mjs` held a literal
`RUNTIME_HOOKS` array, so whatever was typed into it became "valid" by definition. Its first
three entries — `pre-shell-guard`, `protect-secrets`, `stop-verify` — had no script in the live
install, hiding **398 agent→hook edges** behind a green zero. Freezing the answer key is the same
sin as mutating the catalog; it just fails in the other direction.

Five detectors were stacked on top of that one lie and every one of them failed open:

| # | layer | failure |
| --- | --- | --- |
| 1 | `build-harness-graph.mjs` | hardcoded `RUNTIME_HOOKS`/`RUNTIME_MCP` answer key |
| 2 | `drift_loop.py` | `dead_edge_delta` read `skillEdgesDead` only — printed `hookEdgesDead +398` in the delta table, alerted "no drift" |
| 3 | `graph_analyze.py` | `load()` dropped the `dead` node flag, so hook/MCP `dead_cut` was structurally always empty |
| 4 | `omk-runtime/index.ts` `runHook()` | executed from `OMK_HOOKS_DIR` (`~/.omk/runtime/.omk/hooks`, nonexistent) while discovery had already migrated to `~/.omk/extensions` → every guard returned `"unknown"`, and the caller only blocks on `"deny"` |
| 5 | `omk-runtime/index.ts` system prompt | hardcoded `"Safety hooks active in Pi: …"` with no check behind it |

Net effect: `protect-secrets` and `pre-shell-guard` intercepted **nothing** on any
bash/read/write/edit call, `session-context.sh` silently returned empty every session, and the
model was told the opposite. All five are fixed; hooks/MCP are now derived from the same sources
`omk-runtime` resolves at runtime, and discovery returning empty **throws** rather than reporting
100% dead.

**Rule:** any "valid" set must be derived from the runtime. If you cannot derive it, fail loudly —
never hardcode it, and never let a metric be printed without also being alerted on.

## Wire as a standing audit (optional)

Add to a `session_start` or `stop` hook to snapshot drift each session:

```bash
node .omk/harness-graph/build-harness-graph.mjs >/dev/null && \
  cp .omk/harness-graph/out/harness-report.md .omk/harness-graph/out/DRIFT-$(date +%F).md
```
