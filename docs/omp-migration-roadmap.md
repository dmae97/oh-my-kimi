# OMP migration feasibility roadmap

> **Current verdict — source import `ACCEPTED`; product activation `TERMINATED`:** ADR-OMP-003 authorizes exact OMP ancestry and inert source presence at `vendor/oh-my-pi`. The imported source is not wired into OMK. The required `read`, `search`, and `hashline-apply` seams still fail the conjunctive runtime gate.

- **Decision record:** 2026-07-20
- **Roadmap review:** 2026-07-20
- **Upstream audit:** 2026-07-20 02:48 UTC
- **Reviewed OMP pin:** `9fd6e97113f5ed3a847e66d346970efdf8afcad9`
- **Audited upstream `main`:** `39c95e5e29b1c8b082059f57421ce445c3dffdd4`
- **Controlling decisions:** [ADR-OMP-001](adr/ADR-OMP-001.md), [ADR-OMP-002](adr/ADR-OMP-002.md), and [ADR-OMP-003](adr/ADR-OMP-003.md)
- **Next review:** Trigger-based; see [Reopen trigger](#reopen-trigger)

## Decision summary

ADR-OMP-003 approves a Git-native source migration: preserve OMK as first parent, record the audited OMP commit as second parent, and materialize its exact tree under `vendor/oh-my-pi`. This imports source and provenance without resolving OMP into OMK's active root paths.

The audited upstream commit does not remove the product-activation blockers. Its `read`, `search`, and `packages/hashline` gate sources are unchanged from the rejected pin. Keep the imported tree inert until a new exact OMP revision passes every runtime gate and a later ADR approves product integration.

## Scope

This roadmap covers the migration gate already defined by the OMP ADRs:

1. a pure `read` planning/presentation seam;
2. a pure `search` planning/presentation seam; and
3. pure hashline parsing that returns proposed edits and `expectedLineHashes[]` without reading or mutating files.

ADR-OMP-003 separately authorizes exact source presence. It does not claim that a full OMP runtime, TUI, session, or tool-stack migration has been assessed. Those broader integrations remain unauthorized.

## Status terms

| Term | Meaning |
| --- | --- |
| `RECORDED` | Evidence exists for a bounded observation; it grants no integration authority. |
| `SOURCE PRESENT` | Exact upstream source and ancestry are imported under an inert prefix; no runtime consumes them. |
| `TERMINATED` | The current conjunctive product-activation gate ended with a no-go decision. |
| `NOT AUTHORIZED` | A downstream phase must not start under the current ADRs. |
| `REOPENED` | A future intake ADR authorizes disposable review for one exact revision. It does not authorize owner-checkout changes. |
| `APPROVED` | A future ADR authorizes one named extraction or integration step. |
| `SUPERSEDED` | A later ADR replaces the decision for a stated evidence boundary. |

`GO` and `NO-GO` are gate outcomes, not document statuses.

## Evidence boundary

| Artifact | What it proves | What it does not prove |
| --- | --- | --- |
| [ADR-OMP-001](adr/ADR-OMP-001.md) | Exact-pin disposable topology, private pin ref, exact prefix tree, idempotent rematerialization, and a clean disposable worktree. | Migration, source integration, product integration, or publication approval. |
| [Topology report](adr/evidence/omp-topology-report.json) | Reconstructable topology assertions for the reviewed pin; owner and publication mutation flags are false. | Durable source availability at its recorded `/tmp` path. |
| [ADR-OMP-002](adr/ADR-OMP-002.md) | The pure-source product-activation gate is `TERMINATED` and defines the reopen conditions. | Runtime, bridge, extraction, compatibility, or product-integration approval. ADR-OMP-003 supersedes only its inert ancestry/source-presence prohibition. |
| [ADR-OMP-003](adr/ADR-OMP-003.md) | Exact current OMP ancestry and source may be imported under `vendor/oh-my-pi` while OMK remains active first-parent authority. | Runtime consumption, tool integration, package publication, or release approval. |
| [Pure probe report](adr/evidence/omp-pure-probes.json) | Bun source parsing succeeded, raw Node v22.22.3 import failed, and a Bun-built tree-shaken bundle ran under Node. | An approved unchanged Node source seam. The bundle is evidence only. |
| [Pure-source inventory](adr/evidence/omp-pure-source-inventory.json) | Closure audits, authority matrices, source blobs, and the all-three board verdict. | Approval to use private helpers or substitute equivalent behavior. |

Recorded identities:

| Identity | Value |
| --- | --- |
| Reviewed pin | `9fd6e97113f5ed3a847e66d346970efdf8afcad9` |
| Pin tree | `df1f9a55e2e65cb0f5d29287ab1393bb0abd026a` |
| Recorded OMK/OMP merge base | `15d5120b6a5dc757355b99d20d8d1885143d0865` |
| Topology report SHA-256 | `806aa07ae1f13276d11b30cbabb4a5873e6a4e75dde076040a2d246bf1d68f4d` |
| Pure probe report SHA-256 | `ef2fdcf288b084537fa1994e5cd19faa154eca8c866b570962cac2e9e942c507` |
| Pure-source inventory SHA-256 | `e77b5524dc2ff805aba37c53478849056de937573d74359688a7a7d8065aab21` |

The inventory records the topology and probe hashes. Its own hash above documents this roadmap review; it is not a self-recorded canonical manifest value. The `agent://` receipts in ADR-OMP-002 are supplementary; static readers can evaluate the committed ADRs and JSON evidence without them.

## Current upstream check

The 2026-07-20 audit resolved the public default branch to OMP `main` commit `39c95e5e29b1c8b082059f57421ce445c3dffdd4`. The reviewed pin is its merge base. Changes after the pin only affect workflow-notice/session behavior and related tests; they do not touch the migration-gate sources or package runtime metadata.

| Surface | Pin and audited `main` identity | Result |
| --- | --- | --- |
| `packages/coding-agent/src/tools/read.ts` | Blob `21cf268940b60208093ee8151ff53ed7c1f9cd41` | Unchanged; blocked. |
| `packages/coding-agent/src/tools/grep.ts` | Blob `e28756a14f8ed8be14b02414c00f83ba88729f43` | Unchanged; blocked. |
| `packages/hashline` | Tree `94366ec5bea77d1d1adf8205cfb537e2888ae9ba` | Unchanged; blocked. |
| Root and relevant package manifests | No diff from the reviewed pin | Runtime/import requirements are unchanged. |

This is a dated observation, not a moving “latest” claim. Re-resolve the upstream default branch before the next review.

## Current gate results

All three operations must pass at one exact source revision. Source presence or partial success does not qualify product activation.

| Operation | Current result | Decisive blocker |
| --- | --- | --- |
| `read` | `TERMINATED` | The public runtime surface remains a `ToolSession`-bound tool and TUI renderer. Candidate planner/formatter helpers remain private or incomplete, and the import closure carries Bun, filesystem, native, network, session, process, TUI, or edit authority. |
| `search` | `TERMINATED` | Exported pure leaves remain formatting fragments, not a complete immutable query/scope plus OMK-supplied-results seam. The complete runtime closure remains authority-bearing. |
| `hashline-apply` | `TERMINATED` | Parsed anchors still contain line numbers only; `expectedLineHashes[]` is absent. Raw Node v22.22.3 source import still fails, and the static closure still reaches `Bun.hash.xxHash32`. The successful tree-shaken bundle remains unapproved extraction. |

## Feasibility answer

| Question | Answer |
| --- | --- |
| Is Git topology/materialization possible? | **Yes.** ADR-OMP-003 selects exact ancestry plus prefixed tree materialization. |
| Is OMP source migrated? | **Yes, when the staged merge is committed:** exact source under `vendor/oh-my-pi`, with no active runtime wiring. |
| Can OMK activate the three required OMP operations now? | **No.** The contracts and Node closure still fail ADR-OMP-002. |
| Can OMK add a bridge or compatibility layer now? | **No.** ADR-OMP-003 authorizes inert source presence only. |
| Is future product integration possible? | **Conditionally.** A new exact OMP revision must add the required public pure seams, pass the all-three proof, and receive prior ADR approval. |
| Has a full OMP runtime migration been proven feasible? | **No.** It is outside the recorded proof and remains unauthorized. |

## Strategy

Use two separate layers: **exact inert source import now; upstream seam first before selective product integration**.

| Option | Current disposition | Rationale |
| --- | --- | --- |
| Exact ancestry plus `vendor/oh-my-pi` tree | **Selected by ADR-OMP-003** | Preserves OMK behavior while importing one machine-checkable OMP tree and its provenance. |
| Direct root merge with 217 conflict paths | Rejected | It mixes incompatible product, package, lockfile, workflow, and release surfaces without a semantic oracle. |
| Add public pure seams upstream, then requalify | **Recommended activation path** | Fixes the missing contracts at their source and minimizes active OMK maintenance and supply-chain scope. |
| Selective source-bound extraction | `NOT AUTHORIZED`; separate conditional branch | Consider only for future hashline source that already contains the required semantics but lacks a directly consumable Node package shape. The E1 branch below requires a dedicated prior ADR and reproducibility proof before the artifact can qualify. |
| Bridge, polyfill, partial bridge, or hand substitute | Excluded | ADR-OMP-002 continues to prohibit these activation paths. |
| Clean-room feature parity | Separate policy decision | This is not OMP source integration and requires a superseding ADR. |

Do not put AgentHarness migration on the OMP critical path. Current OMK tool factories and `ToolDefinition`/`AgentTool` composition already provide the narrow future integration boundary; AgentHarness lifecycle, hook, and durability work can continue independently.

## Work allowed now

1. Import the exact audited OMP commit and tree under the ADR-OMP-003 prefix while preserving OMK as first parent.
2. Add only exact-prefix scanner exclusions, provenance, decision documentation, and their guard tests.
3. Propose and implement the three public pure seams upstream.
4. Specify the hashline source-binding contract: output shape, hash algorithm, line-ending and Unicode normalization, duplicate-anchor behavior, and mismatch semantics.
5. Prepare disposable product-activation probes and assign runtime, integration, review, and release owners.
6. Continue OMP-independent AgentHarness work without presenting it as OMP gate progress.

## Work not allowed now

- Adding OMP workspaces, dependencies, lockfiles, workflows, or package identities to OMK's active root surface.
- Importing from `vendor/oh-my-pi`, registering OMP tools, or adding a bridge, compatibility layer, product adapter, feature flag, session migration, or release wiring.
- Tree-shaken runtime bundles, Bun workarounds, polyfills, partial bridges, or hand reimplementations.
- Product-integration or release claims based on source presence, topology, or probe observations.

## Proposed gated roadmap

The S0 source-presence phase is approved by ADR-OMP-003. Later phases describe the still-gated product-activation flow.

| Phase | Status now | Entry condition | GO criteria | NO-GO and rollback boundary |
| --- | --- | --- | --- | --- |
| **S0. Import exact inert source** | `ACCEPTED` by ADR-OMP-003 | Exact audited OMP commit, tree, prefix, and OMK first parent. | Second-parent identity, exact prefix-tree equality, 5,501 paths, zero unmerged entries, exact scanner exclusions, no active OMK package/runtime/release drift. | Any identity mismatch, unexpected active-path change, package consumption, or failed rollback boundary. Abort the isolated merge. |
| **U1. Add upstream public seams** | External work may start | Upstream accepts the required data-only APIs. | `read`, `search`, and hashline APIs are public, complete, source-bound, immutable-input, and contain the required semantics. | Private fragments, extraction-time semantics, or effect authority remain. Revise upstream; OMK stays unchanged. |
| **G0. Reopen disposable review** | `NOT AUTHORIZED` until an intake ADR passes | One exact OMP revision contains all required source-visible semantics and a reproducible candidate evidence package. | An intake ADR names the revision, scope, owners, Node lanes, evidence plan, and authorizes disposable requalification only. Status becomes `REOPENED`; owner-checkout integration remains prohibited. | Candidate existence without an intake ADR. Remain `TERMINATED`; do not start qualification. |
| **G1. Qualify direct `read` and `search`** | `NOT AUTHORIZED` until G0 is `REOPENED` | G0 passes and both seams have directly importable Node source/package exports. | Disposable direct-source probes pass for both seams on Node 22.19.0 and the current supported Node lane, unchanged and without forbidden authority. Evidence binds the commit, tree, blobs, runtimes, fixtures, closure, license, and digests. | Either seam fails or needs generated code. Close the candidate review as `TERMINATED`; extraction cannot replace `read` or `search`. |
| **H1. Qualify direct hashline** | `NOT AUTHORIZED`; preferred hashline branch | G0 is `REOPENED`, G1 passes, and hashline has a directly importable Node source/package export. | The direct hashline seam passes on both Node lanes and the combined all-three direct-source suite passes without forbidden authority. | Missing semantics closes the candidate review. If only package shape blocks direct import, use E1 after its dedicated prior ADR. |
| **E1. Optional hashline extraction qualification** | `NOT AUTHORIZED`; alternative to H1 | G0 is `REOPENED`; G1 passes; hashline source contains the full required semantics; a dedicated prior ADR approves the exact extraction design before the artifact is used as a qualifying seam. | The artifact matches approved source-range/AST identity, deterministic generator and expected digest, license proof, and zero-semantic-edit proof; it imports on both Node lanes without a runtime bundler, loader workaround, or polyfill; the combined G1+E1 suite passes. | Missing prior ADR, source semantics, identity, reproducibility, digest, or G1 qualification. Dispose of artifacts and close the candidate review. |
| **G2. Approve integration** | `NOT AUTHORIZED` | G1 passes and either H1 or E1 passes at the same exact revision. | A new ADR names the qualified revision and strategy, source/license identity, allowed OMK paths, owners, tests, rollback, and release boundary. | Missing approval or unresolved provenance, closure, or semantic issue. No owner-checkout change. |
| **I1. Integrate at the coding-agent boundary** | `NOT AUTHORIZED` | G2 explicitly approves integration. | Only approved coding-agent paths change; effects stay in OMK; hashline remains proposal-only until source validation; writes remain serialized; existing tool contracts are preserved or explicitly migrated. | Scope drift, stale evidence, session coupling, hidden authority, or failed source validation. Revert the bounded integration unit. |
| **G3. Verify product and rollback** | `NOT AUTHORIZED` | I1 is complete in an isolated worktree. | Regression, security, package, license, race, rollback, and clean-diff gates pass with fresh evidence. | Any failed gate. Revert I1 and rerun the OMK baseline. |
| **R1. Decide publication** | `NOT AUTHORIZED` | G3 passes. | A separate release decision names artifacts, acceptance, publication authority, and rollback or forward-fix policy. | No explicit release approval. Keep publication disabled. |

## Required future seam contract

A candidate does not enter G0 until all three source-visible contracts exist:

- **Read:** a public authority-free module accepts immutable request/planning input and OMK-supplied read results, then returns deterministic model/presentation data.
- **Search:** a public authority-free module accepts immutable query/scope input and OMK-supplied matches, then returns deterministic normalized/presentation data.
- **Hashline:** a public authority-free parser accepts untrusted patch text and returns proposed edits plus `expectedLineHashes[]` without reading, writing, or mutating external state.
- **Read/search runtime:** both seams import unchanged on Node `>=22.19`, alone and together, without Bun, native, filesystem, process, network, browser, session, TUI, or edit authority.
- **Hashline qualification:** either H1 imports the upstream seam unchanged, or E1 imports the exact prior-ADR-approved artifact. Both routes must run on the same Node lanes without forbidden authority or runtime bundling, loaders, or polyfills.
- **Combined proof:** G1 plus H1 or E1 must pass together at one exact revision.
- **Identity:** public signatures, schemas, static closure, source blobs, license, runtime identity, fixtures, and outputs bind to that revision.

H1 is the preferred direct path. If hashline extraction remains necessary, use E1 only: a dedicated prior ADR must approve exact source-range or AST identity, a deterministic generator and expected output digest, upstream license proof, drift failure, and zero semantic edits before the artifact can count as a qualifying seam. Extraction cannot invent missing hashes or replace direct public `read` and `search` seams.

## Future verification matrix

| ID | Gate | Required evidence |
| --- | --- | --- |
| T1 | Exact source identity | Commit, tree, blobs, merge base, default branch observation, no tags, disabled push, and durable source/license hashes. |
| T2 | Node imports | G1 imports upstream `read`/`search` unchanged. H1 also imports upstream hashline unchanged; E1 instead imports the exact ADR-approved hashline artifact. Run each seam and the selected combination on Node 22.19.0 and the current supported Node version, with no runtime bundler, loader workaround, or polyfill. |
| T3 | Authority closure | Static and dynamic closure plus runtime traps prove no Bun, native, filesystem, process, network, browser, session, TUI, or edit authority. |
| T4 | Pure determinism | Frozen immutable inputs, repeated identical outputs, no reads/writes/global mutation, and complete public schemas. |
| T5 | Untrusted hashline input | Golden and fuzz cases for malformed/large input, Unicode, CRLF/LF, duplicate or overlapping anchors, path strings, stale hashes, and resource bounds; zero mutation. |
| T6 | E1 extraction only | Prior ADR identity, exact source/AST mapping, deterministic generator, expected and observed output digest, license proof, zero semantic edits, and fail-closed drift detection. |
| T7 | Coding-agent regression | Read, grep, edit, renderer, registry, extension, cancellation, and file-mutation-queue tests; preserve existing behavior unless G2 approves a change. |
| T8 | Source-binding integration | Read/search result to proposal, intervening file change, mismatch rejection, same-file/symlink races, aborts, zero writes on mismatch, and one write on success. |
| T9 | Package and supply chain | Pinned dependency/source integrity, packed artifact and notice inspection, sandboxed execution, and no content telemetry. |
| T10 | Rollback and release | Bounded commit-revert rehearsal, clean baseline restoration, fresh post-rollback tests, and separate release approval. |

Run AgentHarness-specific tests only if integration changes generic tool or harness contracts. Do not expand the migration to make those tests relevant.

## Risks and controls

| Risk | Control |
| --- | --- |
| Topology success is mistaken for migration approval. | Keep topology and pure-source gates separate; call topology a prerequisite only. |
| Mixed-authority imports expand OMK's trust boundary. | Require complete public authority-free modules and audit their full static closure. |
| A bundle is mistaken for unchanged Node-compatible source. | Test direct source imports; treat generated bundles as extraction proposals requiring prior approval. |
| Hashline output cannot bind edits to reviewed source. | Make `expectedLineHashes[]` and mismatch behavior hard assertions. |
| Evidence drifts when the OMP revision changes. | Re-run every gate for each exact revision; never carry a GO result forward. |
| `/tmp` evidence disappears. | Commit reports, hashes, source identities, fixtures, and reconstruction commands; never rely on an ephemeral path. |
| Integration couples to sessions or AgentHarness. | Keep the adapter at coding-agent tool factories and avoid OMP-specific durable state. |
| Rollback leaves dual mutation paths. | Never dual-run writes; preserve one OMK mutation queue and rehearse bounded reversion. |

## Rollback policy

- **Current source-import state:** The exact source tree and bounded support delta are staged only in an isolated no-commit merge worktree.
- **S0:** Before commit, abort or delete only the isolated worktree and branch. After a shared merge, revert with first-parent semantics; the current tree loses the source while Git history retains ancestry.
- **G0–E1:** Delete only disposable qualification artifacts and probe output. Verify that active OMK paths remain unchanged.
- **G2:** Rejecting an ADR leaves the repository at S0.
- **I1–G3:** Revert only the approved integration unit. Do not add session conversion or dual writes, so current tool factories remain the restoration target.
- **Source drift:** A changed commit, export, AST range, generator output, license, or closure returns to G1 and H1 or E1, then requires a fresh G2 decision.
- **Publication:** Keep publication disabled until R1 grants separate authority.

## Ownership

ADR-OMP-003 resolves source-presence scope only. Assign named owners before reopening product activation.

| Responsibility | Required owner | Required before |
| --- | --- | --- |
| Decision scope and ADR | OMK architecture maintainer | Reopen intake |
| OMP public seams | OMP upstream maintainer | U1 completion |
| Closure, source, and license audit | Independent OMK security/supply-chain reviewer | G1 and H1/E1 completion |
| Node runtime verification | Runtime/test maintainer | G1 and H1/E1 completion |
| Coding-agent integration | Coding-agent tool/runtime maintainer | I1 |
| Independent regression and rollback | Reviewer who did not author I1 | G3 |
| Product acceptance | Product owner | R1 |
| Publication | Release owner | R1 |

An unassigned required owner is an automatic no-go for that phase.

## Reopen trigger

Review again only when one exact OMP revision includes reproducible evidence that all three minimum operations can satisfy ADR-OMP-002. At minimum, the candidate must include public source-bound `read` and `search` seams that can run unchanged on Node `>=22.19`, hashline `expectedLineHashes[]`, and either a directly importable hashline seam or the complete E1 prior-approval package. Every selected runtime path must exclude forbidden authority.

That evidence permits proposing the G0 intake ADR only. It does not start qualification, authorize extraction, or permit runtime/product changes. A new commit, topology replay, private helper, successful Bun run, or tree-shaken bundle alone does not trigger reopening. A hashline extraction proposal enters E1 only after G0 and the dedicated prior extraction ADR pass.

## Current verification commands

The following bounded checks reproduce the committed-document boundary. Use a disposable clone for upstream commands.

```bash
node -e 'for (const p of process.argv.slice(1)) JSON.parse(require("node:fs").readFileSync(p, "utf8"))' \
  docs/adr/evidence/omp-topology-report.json \
  docs/adr/evidence/omp-pure-probes.json \
  docs/adr/evidence/omp-pure-source-inventory.json

printf '%s  %s\n' \
  806aa07ae1f13276d11b30cbabb4a5873e6a4e75dde076040a2d246bf1d68f4d docs/adr/evidence/omp-topology-report.json \
  ef2fdcf288b084537fa1994e5cd19faa154eca8c866b570962cac2e9e942c507 docs/adr/evidence/omp-pure-probes.json \
  e77b5524dc2ff805aba37c53478849056de937573d74359688a7a7d8065aab21 docs/adr/evidence/omp-pure-source-inventory.json | sha256sum -c -

git ls-remote --symref https://github.com/can1357/oh-my-pi.git HEAD

# In a disposable full-history OMP clone:
PIN=9fd6e97113f5ed3a847e66d346970efdf8afcad9
HEAD=39c95e5e29b1c8b082059f57421ce445c3dffdd4
git merge-base "$PIN" "$HEAD"
git diff --quiet "$PIN" "$HEAD" -- \
  packages/coding-agent/src/tools/read.ts \
  packages/coding-agent/src/tools/grep.ts \
  packages/hashline \
  package.json bun.lock \
  packages/coding-agent/package.json \
  packages/hashline/package.json
```

Before merging a roadmap update, parse the JSON evidence and verify all relative links. After adding a new roadmap file to the index, run both `git diff --cached --check -- docs/omp-migration-roadmap.md` and `git diff --check -- docs/omp-migration-roadmap.md`; this checks staged content and later unstaged edits. Confirm that `git status --short` contains no unintended files.

## Document history

| Date | Change |
| --- | --- |
| 2026-07-20 | Added a decision-ready roadmap and rechecked the public OMP default branch against the reviewed pin. |
| 2026-07-20 | Recorded ADR-OMP-003's exact inert source import while keeping product activation terminated. |
