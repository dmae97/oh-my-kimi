# Implementation Plan: Harness Graph Engineering

**Spec**: `specs/012-harness-graph-engineering/spec.md`
**Status**: Active
**Runtime root**: `/home/yu/omk`

## Architecture

A build-time analysis suite (no runtime service) under `.omk/harness-graph/`. Stdlib + one
approved dep (`networkx`, already installed). Deterministic and re-runnable.

```
run.sh
 ├─ build-harness-graph.mjs   nodes/edges + 3-tier skill classification  → harness-graph.json
 ├─ reconcile-catalog.mjs     inactive→disk-location + demand            → reconcile-plan.md
 ├─ graph_analyze.py          networkx: reach/impact/SPOF/cycles/community→ graph-analysis.md
 ├─ drift_loop.py             snapshot + diff vs previous                → drift-report.md
 ├─ activate-roots.mjs        add demanded skill dirs to settings.json   (--apply, backs up)
 ├─ fix-agent-hygiene.mjs     trailing-punct + malformed backlog         (--apply, backs up)
 └─ normalize-capabilities.mjs dead/malformed capability repair          (--apply, backs up)
```

## Ground-truth sources (accuracy contract)

| node type | source of truth |
| --- | --- |
| skills | `skills-index.txt` ∪ `skills.json` ∪ enabled `settings.json.skills` ∪ on-disk SKILL.md frontmatter |
| hooks | `hooks.json` ∪ runtime hook set |
| mcp | `mcp.json.mcpServers` ∪ runtime-configured 23 |
| agents | `~/.omk/agent/agents/*.md` capability lines |

**Rule**: dead-link counts are "unresolved against the on-disk catalog", never a metric to
game by mutating the runtime catalog. Proxies are narrower than the runtime resolver.

## Data flow

Agent capability lines (`- Skills:/Hooks:/MCP:`) → edges. On-disk frontmatter names → skill
node identity (dir basename is unreliable: `gstack-benchmark/` → name `benchmark`).

## Safety

- Every settings.json / agent-file mutation backs up first (`*.bak-*` / `agents-backup-*.tgz`).
- Semantic edits (dead/malformed) log each change to `.omk/runs/harness-graph/`.
- Orphan-active pruning is report-only (no auto-delete).

## Verification

`bash .omk/harness-graph/run.sh` must end with `inactive:0`, `DEAD:0`, drift `alerts:0`
after hygiene. `node .omk/agent/... speckit-readiness` governance markers satisfied.

## Rollback

Restore from the timestamped backups (settings.json, agents tarball, harness SKILL.md).
