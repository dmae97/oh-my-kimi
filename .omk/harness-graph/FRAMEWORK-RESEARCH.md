# Framework & MCP research — graph loop advancement

_Research date 2026-08-01 · sources: GitHub API, npm registry, PyPI (live crawl)_

## Question

What frameworks/MCPs can advance the harness graph loop, and which should we adopt?

## Verdict

**The harness structural loop does NOT need a heavy graph framework.** At 1771 nodes / 2400
edges, in-memory `networkx` (already installed) is the right tool — a persistent graph DB adds
ops overhead with zero analytical benefit at this scale. The real advancement was the **temporal
drift layer** (`drift_loop.py`) and **structural queries** (`graph_analyze.py`), both now applied.

## What was evaluated

### Graph frameworks / stores

| option | verdict | why |
| --- | --- | --- |
| **networkx** | ✅ **applied** | already installed, in-memory, perfect at this scale. reachability / articulation / SCC / communities all live now |
| Kuzu (embedded Cypher) | ❌ skip | **project archived** (per PyPI note) — do not build on a dead project |
| Neo4j | ❌ overkill | server + JVM + ops for 1771 nodes is absurd |
| igraph / rustworkx | ❌ skip | faster than networkx but we are not scale-bound; no benefit |
| sqlite3 (stdlib) | 🟡 optional | already available if ad-hoc SQL is ever wanted; not needed yet |

### MCP servers (graph-shaped)

| server | stars / dl | category | fit for harness loop |
| --- | --- | --- | --- |
| **`memory`** (modelcontextprotocol) | configured | knowledge-graph memory | ✅ **already in mcp.json** — cross-session persistence is covered |
| DeusData/codebase-memory-mcp | 36.8k★ | code intelligence | code side, not harness; overlaps understand-anything + pi-lens |
| @sdsrs/code-graph | 22.7k/mo | AST code KG | code side; overlaps pi-lens review graph |
| mcp-knowledge-graph (@itseasy21) | 9.3k/mo | memory KG | duplicates the already-configured `memory` |
| MemoryMesh / MegaMemory / ArcRift | <1k★ | memory KG | immature; skip |

**None of the top graph MCPs target _harness structural analysis_** (agents×skills×hooks×MCP
drift). They are either code-intelligence or agent-memory servers. The harness loop is a
build-time analysis tool, not a runtime service — exposing it as an MCP server would be
over-engineering. If runtime graph queries are ever wanted, a thin stdio MCP wrapping
`graph_analyze.py` is a ~50-line addition, not a new dependency.

## What was applied (net new capability)

1. `graph_analyze.py` — networkx structural layer: reachability (`--reach AGENT`), blast radius
   (`--impact NODE`), articulation points, dependency cycles, skill communities, dead-cut list.
   - Found: `filesystem` MCP is a single point of failure for **121/282 agents**; wiring is acyclic.
2. `drift_loop.py` — temporal layer: snapshots each run, diffs vs previous, emits drift alerts
   (new dead links, inactive creep, catalog shrink). Turns the report into a self-monitoring loop.
3. Both wired into `run.sh`.

## Recommended (not applied — needs a decision)

- **codebase-memory-mcp** (36.8k★) ONLY if you want code-intelligence memory that persists across
  sessions and complements understand-anything. It is a code-side upgrade, not a harness-loop one.
- A session_start hook that runs `run.sh` and surfaces `drift-report.md` alerts (snippet in README).
