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
skill dirs added to `settings.json`). Remaining honest debt: 7 dead skill refs + 45 malformed
agents + 439 orphan-active skills. Framework/MCP evaluation in `FRAMEWORK-RESEARCH.md`.

## Wire as a standing audit (optional)

Add to a `session_start` or `stop` hook to snapshot drift each session:

```bash
node .omk/harness-graph/build-harness-graph.mjs >/dev/null && \
  cp .omk/harness-graph/out/harness-report.md .omk/harness-graph/out/DRIFT-$(date +%F).md
```
