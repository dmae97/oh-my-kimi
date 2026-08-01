# Tasks: Harness Graph Engineering

Evidence root: `.omk/runs/harness-graph/`. Gates: `file-exists` | `command-pass`.

## Phase 1 — Graph engine & accuracy (DONE)

- [x] T001 [P] Build harness graph engine with 3-tier skill classification
  > role: architect
  > deps: none
  > files: [`.omk/harness-graph/build-harness-graph.mjs`]
  > verify: `node .omk/harness-graph/build-harness-graph.mjs`
  > gate: command-pass
  > risk: medium
  > evidence: `.omk/runs/harness-graph/T001.md`

- [x] T002 Reconcile catalog: inactive→disk-location + agent demand
  > role: coder
  > deps: T001
  > files: [`.omk/harness-graph/reconcile-catalog.mjs`]
  > verify: `node .omk/harness-graph/reconcile-catalog.mjs`
  > gate: command-pass
  > risk: low
  > evidence: `.omk/runs/harness-graph/T002.md`

- [x] T003 MCP ground-truth hardening (runtime-23) + trailing-punct hygiene
  > role: coder
  > deps: T001
  > files: [`.omk/harness-graph/build-harness-graph.mjs`, `.omk/harness-graph/fix-agent-hygiene.mjs`]
  > verify: `node .omk/harness-graph/build-harness-graph.mjs`
  > gate: command-pass
  > risk: medium
  > evidence: `.omk/runs/harness-graph/T003.md`

## Phase 2 — P0 activation (DONE)

- [x] T004 Precise root activation: add demanded skill dirs to settings.json
  > role: coder
  > deps: T002
  > files: [`.omk/harness-graph/activate-roots.mjs`]
  > verify: `node .omk/harness-graph/build-harness-graph.mjs | grep 'inactive:0'`
  > gate: command-pass
  > risk: high
  > evidence: `.omk/runs/harness-graph/T004.md`

## Phase 3 — Graph intelligence (DONE)

- [x] T005 [P] networkx structural analysis (reach/impact/SPOF/cycles/community)
  > role: coder
  > deps: T001
  > files: [`.omk/harness-graph/graph_analyze.py`]
  > verify: `python3 .omk/harness-graph/graph_analyze.py`
  > gate: command-pass
  > risk: low
  > evidence: `.omk/runs/harness-graph/T005.md`

- [x] T006 [P] Drift loop: snapshot + diff vs previous + alerts
  > role: coder
  > deps: T001
  > files: [`.omk/harness-graph/drift_loop.py`]
  > verify: `python3 .omk/harness-graph/drift_loop.py`
  > gate: command-pass
  > risk: low
  > evidence: `.omk/runs/harness-graph/T006.md`

- [x] T007 [P] Framework/MCP research (reject heavy graph DB; networkx verdict)
  > role: architect
  > deps: none
  > files: [`.omk/harness-graph/FRAMEWORK-RESEARCH.md`]
  > verify: `test -f .omk/harness-graph/FRAMEWORK-RESEARCH.md`
  > gate: file-exists
  > risk: low
  > evidence: `.omk/runs/harness-graph/T007.md`

- [x] T008 Meta-skill OMK alignment (subagent/.omk/runtime-model, backed up)
  > role: architect
  > deps: none
  > files: [`~/.agents/skills/harness/SKILL.md`]
  > verify: `grep -q 'harness-graph' ~/.agents/skills/harness/SKILL.md`
  > gate: command-pass
  > risk: medium
  > evidence: `.omk/runs/harness-graph/T008.md`

## Phase 4 — Remaining advancement (OPEN)

- [x] T009 Normalize dead + malformed capabilities (dead:0, malformed:0)
  > role: coder
  > deps: T003
  > files: [`.omk/harness-graph/normalize-capabilities.mjs`]
  > verify: `node .omk/harness-graph/build-harness-graph.mjs | grep -E 'DEAD:0.*malformed agents: 0'`
  > gate: command-pass
  > risk: medium
  > evidence: `.omk/runs/harness-graph/T009.md`

- [x] T010 Orphan-active triage report (prune vs wire; report-only, no auto-delete)
  > role: reviewer
  > deps: T004
  > files: [`.omk/harness-graph/out/orphan-triage.md`]
  > verify: `test -f .omk/harness-graph/out/orphan-triage.md`
  > gate: file-exists
  > risk: low
  > evidence: `.omk/runs/harness-graph/T010.md`

- [x] T011 Standing audit session hook (run.sh drift snapshot each session)
  > role: architect
  > deps: T006
  > files: [`.omk/harness-graph/hooks/session-drift-audit.sh`]
  > verify: `test -x .omk/harness-graph/hooks/session-drift-audit.sh`
  > gate: file-exists
  > risk: low
  > evidence: `.omk/runs/harness-graph/T011.md`

- [x] T012 Spec-kit governance verify (readiness markers + acceptance gates)
  > role: reviewer
  > deps: T009, T010, T011
  > files: [`specs/012-harness-graph-engineering/`]
  > verify: `bash .omk/harness-graph/run.sh`
  > gate: command-pass
  > risk: high
  > evidence: `.omk/runs/harness-graph/T012.md`

## Phase 5 — Recommendation intelligence (DONE)

- [x] T013 Skill-wiring recommender (item-based CF: peer-overlap → missing-skill suggestions)
  > role: coder
  > deps: T004
  > files: [`.omk/harness-graph/recommend-wiring.py`]
  > verify: `python3 .omk/harness-graph/recommend-wiring.py`
  > gate: command-pass
  > risk: low
  > evidence: `.omk/runs/harness-graph/T013.md`

- [x] T014 Harness↔code cross-link (skill→script→dependency; supply-chain blast radius)
  > role: coder
  > deps: T001
  > files: [`.omk/harness-graph/code_crosslink.py`]
  > verify: `python3 .omk/harness-graph/code_crosslink.py`
  > gate: command-pass
  > risk: low
  > evidence: `.omk/runs/harness-graph/T014.md`

> **Layer note (honest scope)**: the understand-anything KG covers omk-monorepo *source*
> (packages/, pi-extensions/), a separate plane from out-of-tree skill scripts. The real
> harness↔code bridge is the dependency graph in T014, not a KG join; the KG was refreshed
> (1506→1526 nodes) as hygiene.

## Phase 6 — Bipartite SPOF + fail-closed gate (DONE)

- [x] T015 Fix structural SPOF for bipartite agent→cap graphs
  > role: coder
  > deps: T005
  > files: [`.omk/harness-graph/graph_analyze.py`]
  > verify: `python3 .omk/harness-graph/graph_analyze.py | grep 'top SPOF'`
  > gate: command-pass
  > risk: medium
  > evidence: `.omk/runs/harness-graph/T015.md`
  > note: classical articulation_points only found leaf-bridge agents; replaced with capability criticality (blast radius + sole-provider) + edge concentration.

- [x] T016 Health gate + debt allowlist (fail-closed)
  > role: coder
  > deps: T015, T006
  > files: [`.omk/harness-graph/health_gate.py`, `.omk/harness-graph/debt-allowlist.json`]
  > verify: `python3 .omk/harness-graph/health_gate.py; test -f .omk/harness-graph/out/health-gate.md`
  > gate: command-pass
  > risk: high
  > evidence: `.omk/runs/harness-graph/T016.md`
  > note: known `protect-secrets` debt WARNs under allowlist cap; growth or new dead hooks FAIL.

- [x] T017 Dashboard + synthetic unit tests + run.sh integration
  > role: coder
  > deps: T015, T016
  > files: [`.omk/harness-graph/dashboard.py`, `.omk/harness-graph/test_harness_graph.py`, `.omk/harness-graph/run.sh`, `.omk/harness-graph/hooks/session-drift-audit.sh`]
  > verify: `python3 .omk/harness-graph/test_harness_graph.py && bash .omk/harness-graph/run.sh`
  > gate: command-pass
  > risk: medium
  > evidence: `.omk/runs/harness-graph/T017.md`

## Phase 7 — Algorithm upgrade (DONE)

- [x] T018 Bipartite skill projection + Louvain/greedy modularity communities
  > role: coder
  > deps: T015
  > files: [`.omk/harness-graph/graph_analyze.py`]
  > verify: `python3 .omk/harness-graph/graph_analyze.py | grep 'top community'`
  > gate: command-pass
  > risk: medium
  > evidence: `.omk/runs/harness-graph/T018.md`
  > note: replaces raw WCC blob (252 agents / 321 skills) with weighted projection communities.

- [x] T019 Association rules (lift) + skill-redundancy Jaccard
  > role: coder
  > deps: T018
  > files: [`.omk/harness-graph/graph_analyze.py`]
  > verify: `python3 .omk/harness-graph/graph_analyze.py | grep 'top rule'`
  > gate: command-pass
  > risk: low
  > evidence: `.omk/runs/harness-graph/T019.md`

- [x] T020 Hybrid CF recommender (jaccard · idf · lift_boost)
  > role: coder
  > deps: T019, T013
  > files: [`.omk/harness-graph/recommend-wiring.py`, `.omk/harness-graph/test_harness_graph.py`]
  > verify: `python3 .omk/harness-graph/test_harness_graph.py && python3 .omk/harness-graph/recommend-wiring.py`
  > gate: command-pass
  > risk: medium
  > evidence: `.omk/runs/harness-graph/T020.md`
