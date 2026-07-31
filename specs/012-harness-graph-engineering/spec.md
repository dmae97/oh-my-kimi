---
description: "Harness Graph Engineering — graph-based control plane for the OMK agent harness"
---

# Feature Specification: Harness Graph Engineering

**Feature Branch**: `012-harness-graph-engineering`
**Created**: 2026-08-01
**Status**: Active
**Constitution**: [specs/constitution.md](../constitution.md) (governs bounded autonomy, evidence separation)
**Input**: User description: "하네스를 그래프엔지니어링으로 전환 — 스킬/에이전트/훅/MCP를 노드·엣지 그래프로 계측하고 드리프트를 자동 감사, 남은 고도화 + spec-kit 거버넌스"
**OMK Preset**: `omk` (DAG-optimized, parallel-agent ready)

## Problem

At 282 agents × 828 discovered skills × 13 hooks × 23 MCP servers, the harness is a
~1000-node graph managed as flat files and prose (`harness` skill Phase 7-5). Manual
duplicate/drift review is O(n²) and infeasible. Skill→agent wiring, dead links, catalog
activation gaps, and model-config drift are invisible without a graph.

## Goal

A deterministic, re-runnable graph control plane that treats the harness itself as
nodes/edges, computes dead/inactive/orphan/hub/collision/model-drift, resolves catalog
activation, and self-monitors drift over time. Governed by spec-kit.

## Agent-Oriented Requirements

### Requirement 1 - Graph inventory engine with tiered accuracy (Priority: P1)

**Agent**: architect / coder
**Skills**: programming, ast-grep, review-work
**MCP**: filesystem
**Evidence Gate**: file-exists + command-pass
**Risk**: medium

**What**: Build agents×skills×hooks×MCP graph from live config; tier every skill ref as
active / inactive / dead against the on-disk catalog (never a stale index proxy).
**Verify**: `node .omk/harness-graph/build-harness-graph.mjs`

**Acceptance**:

1. `out/harness-graph.json` (nodes+edges) and `out/harness-queries.json` exist.
2. Dead-link counts are computed against the full on-disk catalog, not skills-index alone.
3. Trailing-punctuation and namespace-split false positives are eliminated.

### Requirement 2 - P0 catalog reconciliation & activation (Priority: P1)

**Agent**: coder
**Skills**: programming, ponytail
**MCP**: filesystem
**Evidence Gate**: command-pass
**Risk**: high

**What**: Resolve every inactive skill's on-disk location + agent demand; activate ONLY
demanded skill dirs in settings.json (no whole-root flooding). Back up before mutation.
**Verify**: `node .omk/harness-graph/build-harness-graph.mjs` reports `inactive:0`

**Acceptance**:

1. `activate-roots.mjs --apply` backs up settings.json and is idempotent.
2. Inactive skill edges drop from 689 to 0.
3. No garbage skills activated (only agent-demanded dirs).

### Requirement 3 - Structural + temporal graph intelligence (Priority: P2)

**Agent**: coder
**Skills**: programming, python-patterns
**MCP**: filesystem
**Evidence Gate**: command-pass
**Risk**: low

**What**: networkx layer (reachability, blast radius, articulation SPOF, cycles,
communities) + drift loop (snapshot/diff/alert across runs).
**Verify**: `python3 .omk/harness-graph/graph_analyze.py && python3 .omk/harness-graph/drift_loop.py`

**Acceptance**:

1. `graph_analyze.py --impact filesystem` reports the agent blast radius.
2. Dependency cycles report is 0 (acyclic wiring).
3. `drift_loop.py` records a baseline and emits alerts on subsequent drift.

### Requirement 4 - Harness hygiene: dead + malformed capability normalization (Priority: P2)

**Agent**: coder / reviewer
**Skills**: programming, remove-ai-slops, review-work
**MCP**: filesystem
**Evidence Gate**: command-pass
**Risk**: medium

**What**: Remove/repair the 7 dead skill refs (subpath typos, hallucinated names) and the
45 malformed capability entries (prose instead of skill ids); tag skill-less agents tool-only.
**Verify**: `node .omk/harness-graph/build-harness-graph.mjs` reports `DEAD:0`, `malformed agents:0`

**Acceptance**:

1. Agent files backed up before edit.
2. Dead skill edges → 0; malformed agents → 0.
3. Every removal/repair logged to an evidence file.

### Requirement 5 - Standing audit + meta-skill alignment (Priority: P2)

**Agent**: architect
**Skills**: docs-update-docs, gstack
**MCP**: filesystem
**Evidence Gate**: file-exists
**Risk**: low

**What**: Wire `run.sh` into a session hook for standing drift audit; align the `harness`
meta-skill to OMK runtime (subagent, .omk paths, runtime model — not hardcoded opus).
**Verify**: `test -f .omk/harness-graph/hooks/session-drift-audit.sh`

**Acceptance**:

1. Session hook snapshots drift each session and surfaces alerts.
2. `harness/SKILL.md` no longer hardcodes a single model or `.claude`-only paths.
3. README documents the full suite.

## Out of Scope

- Mutating the pre-existing `001-011` specs or the red-team/scientific governance specs.
- Heavy graph DB (Neo4j/Kuzu) — rejected in `FRAMEWORK-RESEARCH.md` (over-engineering / archived).
- Auto-deleting orphan-active skills (intent decision; triage report only).
