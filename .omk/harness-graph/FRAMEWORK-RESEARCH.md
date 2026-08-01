# Framework & MCP research — graph loop advancement

_Research date 2026-08-01 · updated after Phases 6–7 · sources: GitHub API, npm registry, PyPI_

## Question

What frameworks/MCPs can advance the harness graph loop, and which should we adopt?

## Verdict

**The harness structural loop does NOT need a heavy graph framework.** At ~1766 nodes / 2274
edges, in-memory `networkx` (already installed) is the right tool — a persistent graph DB adds
ops overhead with zero analytical benefit at this scale.

Shipped advancement path:

1. **Accuracy contract** — runtime-derived catalogs; empty discovery throws (no hardcoded answer keys).
2. **Temporal drift** — `drift_loop.py` snapshots + alerts (including hook/MCP dead edges).
3. **Bipartite SPOF** — capability criticality + sole-provider + concentration (Phase 6).
4. **Fail-closed gate** — `health_gate.py` + `debt-allowlist.json` (Phase 6).
5. **Algorithm upgrade** — projection Louvain, lift rules, hybrid CF recommender (Phase 7).

## What was evaluated

### Graph frameworks / stores

| option | verdict | why |
| --- | --- | --- |
| **networkx** | ✅ **applied** | already installed; reach / impact / SCC / Louvain / modularity all live |
| Kuzu (embedded Cypher) | ❌ skip | **project archived** — do not build on a dead project |
| Neo4j | ❌ overkill | server + JVM + ops for <2k nodes is absurd |
| igraph / rustworkx | ❌ skip | faster, but we are not scale-bound |
| sqlite3 (stdlib) | 🟡 optional | fine for ad-hoc SQL later; not needed |

### MCP servers (graph-shaped)

| server | fit for harness loop |
| --- | --- |
| **`memory`** (already configured) | cross-session agent memory — covered |
| codebase-memory-mcp / code-graph / mcp-knowledge-graph | code-intelligence or memory KG — **not** harness structural analysis; overlaps understand-anything + pi-lens |

None of the top graph MCPs target agents×skills×hooks×MCP drift. The harness loop is a
build-time tool. A thin stdio MCP wrapping `graph_analyze.py` remains a ~50-line option if
runtime queries are ever wanted — not adopted.

## What is applied now

| module | capability |
| --- | --- |
| `graph_analyze.py` | reach, impact, bipartite SPOF, concentration, Louvain communities, lift rules, redundancy, dead-cut |
| `recommend-wiring.py` | hybrid CF = jaccard · idf · lift_boost; global high-lift bundles |
| `health_gate.py` | fail-closed CI/session gate + allowlisted residual debt |
| `dashboard.py` | one-page executive summary |
| `drift_loop.py` | temporal delta including hook/MCP edges |
| `code_crosslink.py` | agent→skill→script→dep supply chain |
| `test_harness_graph.py` | 18 synthetic unit tests (no live `~/.omk` dependency) |

Live signal (post Phase 7): 12 communities, top lift ≈35 (`empathy-map↔interview-script`),
17 near-duplicate skill pairs, health **WARN** on allowlisted `protect-secrets` + model drift.

## Still not applied (needs a decision)

- Restore or permanently retire `protect-secrets` / `pre-shell-guard` **runtime scripts** (separate from inventory; scripts absent under `~/.omk/extensions`).
- Thin MCP wrapper for `graph_analyze.py --reach/--impact` if interactive agents need it.
- codebase-memory-mcp only if you want code-side memory beyond understand-anything.
