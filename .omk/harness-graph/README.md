# Harness Graph — standing drift audit

Graph-based control plane for the OMK harness (agents × skills × hooks × MCP). Replaces the
manual, prose-based Phase 7-5 audit in the `harness` skill with a deterministic, re-runnable
graph. Nodes = agents/skills/hooks/mcp; edges = agent→{skill,hook,mcp} declared in each agent's
`- Skills:/Hooks:/MCP:` capability lines.

**Spec-kit governed**: `specs/012-harness-graph-engineering/`.
Evidence: `.omk/runs/harness-graph/`. **Scorecard: [`SCORECARD.md`](SCORECARD.md) (96/100)**.
Re-verify with `bash .omk/harness-graph/run.sh`.

Primary reads after a run: **`out/dashboard.md`** → `health-gate.md` → `wiring-patch.md` → `graph-analysis.md`.

## Scripts (stdlib + networkx)

| script | what it does |
| --- | --- |
| `build-harness-graph.mjs` | Builds the graph, tiers every skill ref (active / inactive / dead), emits `out/harness-graph.json` + `harness-queries.json` + `harness-report.md`. |
| `graph_analyze.py` | **Bipartite structural layer**: SPOF criticality, sole-provider, concentration, Louvain communities on skill projection, lift association rules, redundancy Jaccard, dead-cut → `out/graph-analysis.md` + `.json`. |
| `health_gate.py` | **Fail-closed gate** over queries + analysis + `debt-allowlist.json`. Exit 1 on new/grown debt; known debt WARNs. → `out/health-gate.md`. |
| `dashboard.py` | One-page executive summary over all artifacts → `out/dashboard.md`. |
| `drift_loop.py` | Temporal layer: snapshots each run, diffs vs previous, emits drift alerts → `out/drift-report.md`. |
| `recommend-wiring.py` | **Hybrid CF**: `Σ peer_jaccard · idf(skill) · lift_boost` + global lift bundles (report-only). |
| `code_crosslink.py` | agent→skill→script→dependency supply-chain bridge. |
| `reconcile-catalog.mjs` / `activate-roots.mjs` | P0 inactive→activate demanded skill dirs. |
| `fix-agent-hygiene.mjs` / `prune-retired-hooks.mjs` | At-source capability cleaners (backup + `--apply`). |
| `orphan-triage.mjs` | Orphan-active prune-vs-wire review (never auto-deletes). |
| `test_harness_graph.py` | Synthetic-fixture unit tests (no live `~/.omk` dependency). |
| `debt-allowlist.json` | Known debt the gate may WARN on. Remove only when fixed. |
| `SCORECARD.md` | Weighted 100-point evaluation of the whole harness-graph system. |
| `compact-skills-index.mjs` | Rebuild skills-index as agent∪settings∪skills.json (kills false orphans). |
| `apply-wiring-patch.py` | Review-only half-bundle + CF patch list (never auto-edits). |
| `test_properties.py` | Lift/IDF/Jaccard property invariants. |

### Structural queries

```bash
python3 .omk/harness-graph/graph_analyze.py --reach backend-architect
python3 .omk/harness-graph/graph_analyze.py --impact filesystem
python3 .omk/harness-graph/health_gate.py          # exit 1 on FAIL
python3 .omk/harness-graph/test_harness_graph.py   # unit tests
```

## Run

```bash
bash .omk/harness-graph/run.sh            # full pipeline + health gate + tests
bash .omk/harness-graph/run.sh --no-gate  # reports only (always exit 0 from gate)
bash .omk/harness-graph/run.sh --fix     # also apply hygiene + activate-roots
```

## Accuracy model — why the tiers matter

A naive "does this skill exist in my index" check reported **317 dead skills**. That was wrong:
the index proxy was narrower than the on-disk universe and agent files ended capability lines
with a period (`..., ponytail.`). After tiering against the full on-disk catalog and stripping
trailing punctuation the honest numbers landed at **0 dead skills / 0 malformed**, with the real
problems being inactive edges (resolved) and retired-hook references.

**Rule:** any "valid" set must be derived from the runtime. If you cannot derive it, fail loudly —
never hardcode it, and never let a metric be printed without also being alerted on.

## The green-metric trap (2026-08-01)

`hookEdgesDead: 0` was not a measurement. `build-harness-graph.mjs` held a literal
`RUNTIME_HOOKS` array, so whatever was typed into it became "valid" by definition. Five detectors
stacked on that lie and every one failed open (hardcoded answer key, drift ignoring hook deltas,
`graph_analyze` dropping the `dead` flag, runtime hook path mismatch, hardcoded "Safety hooks
active" prompt). All five are fixed; discovery returning empty **throws**.

## Bipartite SPOF fix (2026-08-01, phase 6)

`nx.articulation_points` on the undirected skeleton of an agent→capability digraph only finds
**leaf-bridge agents** (agents that alone own private skills). Shared hubs like `filesystem`
(129 agents) or `protect-secrets` (209) are never articulations because every agent still has
other edges. The structural layer now ranks **capability criticality** =

```text
score = agent_blast_radius + 3 × sole_provider_agent_count
```

plus edge-concentration (top1/top3 hub share). Classical articulations are kept as
"leaf-bridge agents" for merge/dedup, not as SPOF.

## Algorithm upgrade (2026-08-01, phase 7)

Three detectors that used to lie or collapse:

| layer | old failure | new algorithm |
| --- | --- | --- |
| communities | raw WCC on agent+skill → one 252-agent blob | weighted skill–skill projection (edge = shared agents ≥2) + Louvain / greedy modularity |
| co-usage | hub pairs dominate by raw count | association **lift** = \|A∩B\|·N / (\|A\|·\|B\|); lift≥2, support≥4 |
| recommender | plain Σ peer Jaccard (hub skills win) | `score = Σ sim · idf(s) · lift_boost(owned→s)` |

Also emits skill-redundancy pairs (agent-set Jaccard ≥ 0.7) as merge/dedup candidates.
Live signal after upgrade: **12 communities**, top rule `empathy-map ↔ interview-script` lift≈35,
17 near-duplicate skill pairs.

## Health gate + debt allowlist

| class | gate behavior |
| --- | --- |
| new dead skill / MCP / unlisted hook | **FAIL** |
| allowlisted dead hook within `max_edges` | **WARN** |
| allowlisted dead hook grown past cap | **FAIL** |
| inactive skill edges / malformed agents / cycles | **FAIL** |
| MCP top1 concentration above soft cap | **WARN** |
| model drift across config surfaces | **WARN** |

`protect-secrets` (209 edges) is allowlisted under an explicit hold — documentation cleanup, not
a live security change (Pi resolves hooks from disk). Raise `max_edges` only with evidence; never
to silence a regression.

## Wire as a standing audit

```bash
node .omk/harness-graph/register-hook.mjs --apply   # session_start
# or manually:
node .omk/harness-graph/build-harness-graph.mjs >/dev/null && \
  python3 .omk/harness-graph/health_gate.py
```
