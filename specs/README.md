# OMK Specifications

`specs/constitution.md` and `specs/templates/` govern new work. Feature specs
record a point-in-time intent; source, tests, and release tags determine current
runtime behavior.

## Status terms

- **Released** — present in a reachable release tag.
- **Worktree-only** — implemented or documented locally but not committed or released.
- **Active** — still governs current work.
- **Historical** — completed record; unchecked task boxes are not current backlog.
- **Superseded** — replaced by a later algorithm or spec.
- **Missing identifier** — the number has no tracked spec and is not an implied task.

## Index

| ID | Specification | Current status |
| --- | --- | --- |
| 001 | [Think command routing](001-think-command-routing/spec.md) | Historical; implemented and released |
| 002 | [OMK v0.90.2 full upgrade](002-omk-v0902-full-upgrade/spec.md) | Historical release operation |
| 003 | [Reasoning-effort router](003-reasoning-effort-router/spec.md) | Superseded by the released v4 router |
| 004 | [Reasoning router v2](004-reasoning-router-v2/spec.md) | Superseded by the released v4 router |
| 005 | — | Missing identifier |
| 006 | [Reasoning-router accuracy boost](006-reasoning-router-accuracy-boost/spec.md) | Historical v3 work; superseded by v4 |
| 007 | — | Missing identifier |
| 008 | [Reasoning-router advanced accuracy](008-reasoning-router-advanced-accuracy/spec.md) | Historical v4 implementation record; v4 is released |
| 009 | [Headroom upgrade](009-headroom-github-main-0290-upgrade/spec.md) | Historical machine-local upgrade operation |
| 010 | [v0.90.6 release alignment](010-omk-v0906-release-alignment/spec.md) | Historical completed alignment |
| 011 | [GPT-5.6 MoA and Ultra fix](011-gpt56-moa-ultra-fix/spec.md) | Released |
| 012 | [Harness Graph engineering](012-harness-graph-engineering/spec.md) | Active repository-maintenance tooling; not default CLI orchestration |
| 013 | [Command safety, attachments, and resilience](013-command-safety-attachment-resilience/spec.md) | Released in `v0.97.0` |
| 014 | [Repository-understanding wiki](014-repository-understanding-wiki/spec.md) | Policy/workflow in v0.97.0; integrity/output guards in v0.98.0; no bundled corpus |
| 015 | [Runtime algorithms and direction](015-runtime-algorithm-direction/spec.md) | Active documentation and governance sync |
| 016 | [Terminal settlement notification](016-terminal-settlement-notification/spec.md) | Released in v0.98.0 |
| 017 | [Resource promotion evidence](017-resource-promotion-evidence/spec.md) | Report released in v0.98.0; adaptive-default promotion remains blocked |
| 018 | [Type-aware compaction](018-type-aware-compaction/spec.md) | Explicit-rule default-compactor slice released in v0.98.0 |
| 019 | [Cross-session verified memory](019-cross-session-verified-memory/spec.md) | Proposed; implementation blocked on fixtures and preregistration |
| 020 | [Live lane and shard authority](020-live-lane-shard-authority/spec.md) | Proposed; implementation blocked on canonical production caller |
| 021 | [Advisory selection integrity](021-advisory-selection-integrity/spec.md) | v0.98.3 opt-in SDK; no automatic TUI judge |

## Current direction

Spec 015 is the entry point for current algorithm maturity and direction. Specs
016–018 describe bounded slices released in v0.98.0; specs 019–020 are
deliberately blocked at their design gates. Separate delivery, activation, and evidence labels
prevent an internal mechanism or passing local test from being mistaken for a
shipped live path.

Historical `plan.md` and `tasks.md` files remain evidence of their original
cycle. Do not reopen them merely because a checkbox is blank; create or update a
current spec with a versioned baseline and measurable acceptance gate instead.
