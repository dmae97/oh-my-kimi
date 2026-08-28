---
description: "Repository-understanding local wiki (OpenWiki): versioned generated corpus, quota-tolerant CI refresh, and fail-closed evidence-integrity gate"
---

# Feature Specification: Repository-Understanding Local Wiki (OpenWiki)

**Feature Branch**: `014-repository-understanding-wiki`
**Created**: 2026-08-25
**Status**: Released (policy/workflow only); Worktree-only corpus/gate hardening; release blocked by the security gates below
**Constitution**: [specs/constitution.md](../constitution.md) (governs evidence separation, fail-closed gates)
**Input**: User description: "omk wiki가 디폴트인데 현재 문제가 있다고 들었습니다 문제를 진단하고 해결 및 고도화 부탁드립니다" + re-verification pass
**OMK Preset**: `omk`

## Problem

v0.97.0 declared the local wiki a default but three defects made it hollow:

1. `.gitignore` carried `/openwiki/`, so the generated corpus could never be
   committed. The scheduled workflow's PR step (`add-paths: openwiki`) silently
   added nothing on every run, and the README pointed fresh sessions at
   `openwiki/overview.md`, which had never existed.
2. The default provider/model (`gemini-3.5-flash-lite`) has a free-tier limit of
   ~15 requests/minute while the generator's agent loop bursts past it. With the
   default retry count (3) the run aborted mid-pass (`status: interrupted`) and
   nothing documented resumability.
3. Nothing validated generated content. A verification pass found 19 invented
   identifiers in frontmatter `symbols:` fields, prose, and Mermaid labels —
   fabricated evidence anchors in the exact field whose purpose is pinning
   claims to code.

## Goal

Make the repository-understanding stack real by default: a versioned generated
wiki whose freshness is mechanically checkable, a CI refresh that survives free-
tier quota aborts through retries plus resumability, and a fail-closed
integrity gate that rejects broken links, stale state, and hallucinated
evidence anchors before any of it reaches a PR or `main`.

## Current security blockers

1. **Closed (2026-08-28).** `status: "interrupted"` now fails unless
   `openwiki/.manual-review.json` binds a review to the exact corpus digest.
   The record is anchored to a content digest rather than a commit, so an
   approved corpus survives later commits (code movement downgrades to a
   staleness warning) while any edit to the corpus invalidates the review.
2. **Closed (2026-08-28).** Each frontmatter `symbols:` entry must bind to one
   of that page's own `source_paths:` as a whole identifier; a symbol that only
   names a declared path is accepted, since that is already an exact path
   binding. Global substring presence is gone.
3. **Closed (2026-08-28).** The artifact and pull-request steps carry `openwiki`
   and nothing else. `AGENTS.md`, `CLAUDE.md`, and the workflow file are no
   longer produced, uploaded, or added to a PR by this workflow; their OpenWiki
   managed blocks become human-maintained text.
4. **Closed (2026-08-28).** `scripts/check-openwiki-output.mjs` runs twice: in
   the generating job before upload, and again in the publishing job before the
   PR. It rejects any changed path outside `openwiki/` and scans the admitted
   corpus for credential shapes and operator-private paths, reporting file and
   label without ever echoing the match.

### Why the gate runs twice

The publishing job holds `contents: write` and `pull-requests: write`, which the
generating job does not, and the artifact crosses a job boundary to reach it. It
is re-checked as untrusted input rather than trusted because an earlier job
approved it.

The threat this closes is concrete: the generator is a model writing into a
checkout it also reads. While the workflow carried `AGENTS.md`, `CLAUDE.md`, and
its own file, repository content could reach the rules agents follow, or the CI
job itself. Both allowlists are now `openwiki` alone, and
`scripts/test/openwiki-workflow.test.mjs` fails the build if either widens
again — verified by re-adding `AGENTS.md` and observing the failure.

### Corpus removal (2026-08-28)

Closing blockers 1 and 2 immediately condemned the corpus they were written
against. Run against the 15 untracked pages the hardened gate reported:

- 8 frontmatter symbols bound to no declared source path — `AgentLoop` (the real
  export is the function `agentLoop`), `getModel`, `DeepWall`,
  `loadExtensions`, `createExtensionRuntime`, and `main`.
- 45 references to `@omk/*` package names that this repository does not publish;
  the real names are `open-multi-agent-kit`, `omk-agent-core`, `omk-ai`,
  `omk-tui`, `omk-protocol`, `omk-adaptorch-wpl`, `omk-book-to-skill`. Every
  "minimal validation command" in the routing table therefore failed
  (`npm error No workspaces found: --workspace=@omk/coding-agent`).
- This README's `Scope -> Route -> Verify -> Replay` loop restated as a strict
  engine state machine, with a state diagram and four numbered stages. The loop
  is real as the product's documented framing; the corpus promoted it to an
  implemented execution engine, which the source does not contain.

This reproduces the original diagnosis in Problem 3 and confirms why global
substring matching was insufficient: those identifiers all occur *somewhere* in
the repository. The corpus was removed rather than hand-patched, because
hand-editing generated pages is overwritten by the next generator run.

The gate now treats an absent corpus as a reported warning rather than a
failure. A worktree-only corpus is in no commit, so failing on its absence made
every commit depend on untracked scratch output — and a corpus that does not
exist cannot mislead a reader.

## Architecture (working-tree target)

The current corpus and checker are untracked; this layout becomes versioned only
after Requirement 1 lands in the Git index.

```text
AGENTS.md / CLAUDE.md managed blocks   ← agent entry contract (optional JIT context)
openwiki/                              ← worktree-only generated pages + .last-update.json
  ├── quickstart.md                    ← navigation hub referenced by root README
  ├── architecture/ packages/ …        ← per-area pages with evidence frontmatter
  └── .last-update.json                ← { gitHead, status } staleness anchor
.github/workflows/openwiki-update.yml  ← worktree workflow; output allowlist/scans pending
scripts/check-openwiki.mjs             ← partial checker; fail-closed target pending
```

Source and tests stay authoritative; every layer above is advisory and gated.

## Agent-Oriented Requirements

### Requirement 1 - Versioned wiki corpus (Priority: P1)

**Evidence Gate**: file-exists + command-pass

**What**: Remove `/openwiki/` from `.gitignore`; commit generated pages and the
`.last-update.json` staleness anchor. Operator-local scratch inside the wiki is
ignored per-operator via `.git/info/exclude`.

**Verify**: `git ls-files openwiki | grep -c .` ≥ 15 after first commit.

**Acceptance**:
1. Fresh clones contain `openwiki/quickstart.md`
2. Workflow PRs can include `openwiki/` changes (no ignore shadowing)

### Requirement 2 - Fail-closed integrity gate (Priority: P1)

**Agent**: coder
**Skills**: programming, review-work
**Evidence Gate**: command-pass (positive + negative)

**What**: `scripts/check-openwiki.mjs` validates internal links, stale markers,
entry pages, and update state. Every `interrupted` state fails unless a
manual-review record binds the exact corpus digest. Frontmatter symbols and
security-sensitive prose claims bind to declared source paths or spans; global
substring presence is insufficient. Wire the completed gate into `npm run check`
and between generation and PR creation.

**Verify**: `node scripts/check-openwiki.mjs` — plus negative probes: inject an
unresolved link and an invented symbol; both must exit 1 with a precise message.

**Acceptance**:
1. Positive run exits 0 listing page count
2. Fabricated or wrong-path symbol evidence fails the gate
3. Interrupted state without an exact manual-review receipt fails
4. Gate failure blocks artifact upload and the PR step (fail closed)

### Requirement 3 - Quota-tolerant refresh (Priority: P2)

**Evidence Gate**: command-pass

**What**: Workflow sets `OPENWIKI_PROVIDER_RETRY_ATTEMPTS=8`; reruns resume from
`.last-update.json`. A concurrency group prevents overlapping runs and
`timeout-minutes: 45` bounds them. Generated artifacts allowlist `openwiki/**`
only; generated authority/workflow files are rejected. Secret, private-path, and
authority-file scans run before upload and again before PR creation. Missing
`GEMINI_API_KEY` fails fast with remediation text.

**Verify**: `node -e "YAML parse"` of the workflow + secret-guard step present.

**Acceptance**:
1. Two overlapping dispatches serialize on one concurrency group
2. Free-tier 429s degrade to retried passes, not lost work
3. Artifacts outside `openwiki/**`, including `AGENTS.md`, `CLAUDE.md`, and workflows, fail before upload
4. Secret/private-path scans gate both upload and PR creation

### Requirement 4 - Mechanical staleness protocol (Priority: P2)

**Evidence Gate**: file-exists + command-pass

**What**: Trust signal is `openwiki/.last-update.json` plus corpus digest and
optional manual-review receipt. Fresh + `complete` is eligible for use; stale +
`complete` is refresh-pending advisory. Every `interrupted` state fails unless
a valid review receipt binds that exact digest. Document and enforce this rule.

**Verify**: `node scripts/check-openwiki.mjs` with a doctored `gitHead` exits 1.

**Acceptance**:
1. Agents can decide whether to trust the wiki without reading every page
2. No silent acceptance of interrupted generations, fresh or stale
3. A manual override is attributable and digest-bound, never a warning-only branch

### Requirement 5 - Verified initial corpus (Priority: P3)

**Evidence Gate**: command-pass

**What**: 15 pages materialized against HEAD covering the `_skeleton.md` plan
(quickstart, architecture overview, eight package pages, extensions, harness),
with every frontmatter symbol replaced by a code-verified identifier during the
re-verification pass.

**Verify**: identifier sweep — backticked PascalCase tokens and Mermaid labels
resolve against `packages/` + `scripts/`.

**Acceptance**:
1. Zero unresolved symbols across the corpus
2. All Mermaid diagrams use valid arrow syntax

## Non-Goals

- Replacing source docs: the wiki is advisory context, never authoritative.
- Provider cost guarantees: paid tiers are an operator choice; free-tier runs
  rely on retries plus resumability.
- Auto-merge: generated updates always travel through a human-reviewed PR.
