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
