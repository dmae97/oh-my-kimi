# OMP migration feasibility roadmap

> **Current verdict — source import `ACCEPTED`; G1/H1 `PASS`; G2 `ACCEPTED (scope-bounded)`; I1 `COMPLETE`; G3 `PASS`; R1 `DECIDED (publication disabled)`; I2 `COMPLETE`; seams `DEFAULT-ON`:** [ADR-OMP-009](adr/ADR-OMP-009.md) makes the OMP pure seams the default path for `read` (text) and `grep` (context=0) with a byte-identical opt-out (`OMK_OMP_SEAMS=0`), superseding the earlier default-off boundary; the operator accepted the recorded benchmark cost (read ~89 ms per 2,000-line file for hashline provenance anchors). [ADR-OMP-007](adr/ADR-OMP-007.md) keeps publication disabled.

- **Decision record:** 2026-07-20
- **Roadmap review:** 2026-07-20
- **Upstream audit:** 2026-07-20 02:48 UTC
- **Reviewed OMP pin:** `9fd6e97113f5ed3a847e66d346970efdf8afcad9`
- **Audited upstream `main`:** `39c95e5e29b1c8b082059f57421ce445c3dffdd4`
- **Local S0 merge:** `360d5036b58a0547a3d26e8f3b52c1daf24690b6` (local branch has no configured upstream/tracking ref; no remote publication claimed/evidenced)
- **Draft local candidate observation:** `b6e75dbbc545c815786ecc15d155a332c21cad2b` (durably retained at local private ref `refs/omp/candidates/b6e75dbbc545c815786ecc15d155a332c21cad2b`; public fork route created, candidate branch pending; does not pass U1)
- **Controlling decisions:** [ADR-OMP-001](adr/ADR-OMP-001.md), [ADR-OMP-002](adr/ADR-OMP-002.md), [ADR-OMP-003](adr/ADR-OMP-003.md), [ADR-OMP-005](adr/ADR-OMP-005.md), [ADR-OMP-006](adr/ADR-OMP-006.md), [ADR-OMP-007](adr/ADR-OMP-007.md), [ADR-OMP-008](adr/ADR-OMP-008.md), and [ADR-OMP-009](adr/ADR-OMP-009.md)
- **Superseded G0 intake template:** [ADR-OMP-004](adr/ADR-OMP-004.md) — `DRAFT / BLOCKED`, superseded for the U1-upstream-acceptance requirement and G0 reopening by [ADR-OMP-005](adr/ADR-OMP-005.md); historical record preserved
- **Next review:** Trigger-based; see [Reopen trigger](#reopen-trigger)

## Decision summary

ADR-OMP-003 approved a Git-native source migration: preserve OMK as first parent, record the audited OMP commit as second parent, and materialize its exact tree under `vendor/oh-my-pi`. S0 now records that design in a local merge commit without resolving OMP into OMK's active root paths. Its local branch has no configured upstream/tracking ref; no remote publication is claimed or evidenced.

The public upstream commit observed on 2026-07-20 has the product-activation blockers recorded by ADR-OMP-002. A separate upstream-derived local object adds the proposed seams in exactly ten changed paths. The public fork establishes a named repository handoff route, but its `HEAD`/`main` remain at the audited baseline, the candidate branch is not pushed, no pull request is open, and the bounded observations do not evidence can1357 publication or acceptance. The local object does not pass U1 and supports only a **DRAFT / BLOCKED** inventory. Operator acceptance alone cannot open G0; product activation stays terminated.

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
| `DRAFT / BLOCKED` | A non-acceptance-ready identity template; it grants no gate authority. |
| `PROPOSED` | A future exact record that may be considered only after U1 passes. |
| `REOPENED` | A future accepted G0 ADR authorizes disposable review for one exact revision. It does not authorize owner-checkout changes. |
| `APPROVED` | A future ADR authorizes one named extraction or integration step. |
| `SUPERSEDED` | A later ADR replaces the decision for a stated evidence boundary. |
| `PASS` | A formal gate ran successfully at the exact candidate identity with recorded evidence; it does not authorize product activation beyond the next bounded gate. |
| `IN PROGRESS` | An approved phase is being executed within its bounded scope; it grants no authority outside that scope. |

`GO` and `NO-GO` are gate outcomes, not document statuses.

## Evidence boundary

| Artifact | What it proves | What it does not prove |
| --- | --- | --- |
| [ADR-OMP-001](adr/ADR-OMP-001.md) | Exact-pin disposable topology, private pin ref, exact prefix tree, idempotent rematerialization, and a clean disposable worktree. | Migration, source integration, product integration, or publication approval. |
| [Topology report](adr/evidence/omp-topology-report.json) | Reconstructable topology assertions for the reviewed pin; owner and publication mutation flags are false. | Durable source availability at its recorded `/tmp` path. |
| [ADR-OMP-002](adr/ADR-OMP-002.md) | The pure-source product-activation gate is `TERMINATED` and defines the reopen conditions. | Runtime, bridge, extraction, compatibility, or product-integration approval. ADR-OMP-003 supersedes only its inert ancestry/source-presence prohibition. |
| [ADR-OMP-003](adr/ADR-OMP-003.md) | Exact current OMP ancestry and source may be imported under `vendor/oh-my-pi` while OMK remains active first-parent authority. | Runtime consumption, tool integration, package publication, or release approval. |
| [ADR-OMP-004](adr/ADR-OMP-004.md) | Records a **DRAFT / BLOCKED** intake template, the public-fork branch-pending handoff route, and strict U1-before-G0 refresh conditions. | A proposal, acceptance, G0 authority, candidate execution, integration, candidate-branch publication, a pull request, or upstream acceptance. |
| [ADR-OMP-005](adr/ADR-OMP-005.md) | Operator `ACCEPTED` local-candidate qualification strategy (`AUTH-LOCAL-QUAL-DECISION-20260720-01`); supersedes the can1357-upstream-acceptance U1 gate for intake, reopens G0 for candidate `b6e75dbbc545c815786ecc15d155a332c21cad2b` only, and authorizes disposable G1/H1 plus bounded I1 under ADR-OMP-006. | Remote publication, release, tags, or owner-checkout main mutation; authority over identity-drifted candidates; it does not evidence can1357 acceptance. |
| [ADR-OMP-006](adr/ADR-OMP-006.md) | Operator `ACCEPTED` (scope-bounded) the I1 integration unit on isolated branch `yu/omp-migrate-39c95e5e`: ten-path vendor refresh to candidate tree `296cfdbb83bbb7db30248864938cd7f456e2b8f5` plus a flag-gated (`OMK_OMP_SEAMS=1`, default off) pure-seam loader and tests under `packages/coding-agent`. | Tool-behavior/registry/queue/manifest/lockfile changes, a hashline write path, publication/release, owner-checkout main merge, or work outside the two named I1 commits. |
| [G1/H1 qualification](adr/evidence/omp-g1-h1-qualification.json) | Formal G1/H1 `PASS` on plain Node 22.19.0 and 24.13.0 via direct unchanged `.ts` source imports; hashline 23/23 both lanes; identical cross-lane probe-log digests; zero worktree mutation. | Remote publication, release, integration outside the ADR-OMP-006 unit, owner-checkout main migration, or can1357 upstream acceptance. |
| [G0 candidate inventory](adr/evidence/omp-g0-candidate.json) | Exact S0 and draft-candidate identities, authorized local private-ref retention, ten changed paths and blobs, exports, signatures, license, runtime availability, proposed owners, qualification plan, and bounded **FORK CREATED / BRANCH PENDING** route state. | Remote candidate durability/publication, a pushed candidate branch, a pull request, U1 completion, an accepted decision, formal qualification, or acceptance by can1357 upstream. |
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
| S0 local merge commit | `360d5036b58a0547a3d26e8f3b52c1daf24690b6` |
| S0 local merge tree | `a8efb6013471881fd9ce3678d508215b96a0c839` |
| Draft local candidate commit | `b6e75dbbc545c815786ecc15d155a332c21cad2b` |
| Draft local candidate tree | `296cfdbb83bbb7db30248864938cd7f456e2b8f5` |
| Draft local candidate parent | `39c95e5e29b1c8b082059f57421ce445c3dffdd4` |
| Authorized local private ref | `refs/omp/candidates/b6e75dbbc545c815786ecc15d155a332c21cad2b` → `b6e75dbbc545c815786ecc15d155a332c21cad2b` |
| Candidate root license | MIT; blob `cc0c5aa7c10d87c5142af1274b37da95c005184d`; SHA-256 `545636e19386d3d4e0ae6d77354527499999c3ebfbca61b9fa5aa4ead7c0b308` |

The inventory records the topology and probe hashes. Its own hash above documents this roadmap review; it is not a self-recorded canonical manifest value. The `agent://` receipts in ADR-OMP-002 are supplementary; static readers can evaluate the committed ADRs and JSON evidence without them.

## Current upstream check

On 2026-07-20, public read-only `git ls-remote --symref https://github.com/can1357/oh-my-pi.git HEAD refs/heads/main` observed public `HEAD` pointing to `main` and both at `39c95e5e29b1c8b082059f57421ce445c3dffdd4`. The command queried only public `HEAD` and `main`; its output did not contain local commit `b6e75dbbc545c815786ecc15d155a332c21cad2b` because that commit was not queried through a public ref. This does not prove absence from every public ref, and no can1357 publication or acceptance is claimed or evidenced.

A separate exact authorized action created public fork `https://github.com/dmae97/oh-my-pi`. A public read-only observation resolved its `HEAD` and `main` to `39c95e5e29b1c8b082059f57421ce445c3dffdd4`; a bounded `gh` metadata observation reported public identity, `isFork: true`, and default branch `main`. These facts establish only the public repository route and bounded `isFork` identity; no specific parent repository relationship is claimed. No local clone or remote was added, the candidate branch was not pushed, no pull request was opened, and can1357 acceptance is not evidenced. No secret, token, or credential value was accessed or recorded during this evidence refresh.

For the dated upstream audit at `39c95e5e29b1c8b082059f57421ce445c3dffdd4`, the reviewed pin is its merge base. Changes after the pin only affect workflow-notice/session behavior and related tests; they do not touch the migration-gate sources or package runtime metadata.

| Surface | Pin and audited `main` identity | Result |
| --- | --- | --- |
| `packages/coding-agent/src/tools/read.ts` | Blob `21cf268940b60208093ee8151ff53ed7c1f9cd41` | Unchanged; blocked. |
| `packages/coding-agent/src/tools/grep.ts` | Blob `e28756a14f8ed8be14b02414c00f83ba88729f43` | Unchanged; blocked. |
| `packages/hashline` | Tree `94366ec5bea77d1d1adf8205cfb537e2888ae9ba` | Unchanged; blocked. |
| Root and relevant package manifests | No diff from the reviewed pin | Runtime/import requirements are unchanged. |

This is a dated public-upstream observation, not a moving “latest” claim. Re-resolve the upstream default branch before the next upstream review.

Separately, local candidate observation `b6e75dbbc545c815786ecc15d155a332c21cad2b` has tree `296cfdbb83bbb7db30248864938cd7f456e2b8f5`, parent `39c95e5e29b1c8b082059f57421ce445c3dffdd4`, and exactly ten changed paths. On 2026-07-20 authorized local private ref `refs/omp/candidates/b6e75dbbc545c815786ecc15d155a332c21cad2b` resolved exactly to that commit, providing durable local retention; detached worktree `HEAD` at `/tmp/omp-u1-pure-seams` also remained at that commit and its worktree was clean. This local ref is not remote publication or can1357 acceptance. The fork route does not publish or durably retain the candidate until the exact commit is pushed to a named branch. No can1357 publication or acceptance is claimed or evidenced. Development checks were earlier reported passing on Node 22.22.3 and 24.13.0; under [ADR-OMP-005](adr/ADR-OMP-005.md), formal G1/H1 qualification has since `PASSED` on plain Node 22.19.0 and 24.13.0 (both installed and identified) using direct unchanged `.ts` source imports alone and together, with the hashline suite 23/23 on both lanes and zero worktree mutation ([evidence](adr/evidence/omp-g1-h1-qualification.json)).

## Current gate results

All three operations must pass at one exact source revision. Source presence or partial success does not qualify product activation.

| Operation | Current result | Basis and remaining boundary |
| --- | --- | --- |
| `read` | `PASS at candidate revision (local strategy)` | Public `main` at `39c95e5e29b1c8b082059f57421ce445c3dffdd4` remains blocked, but [ADR-OMP-005](adr/ADR-OMP-005.md) reopens G0 for local candidate `b6e75dbbc545c815786ecc15d155a332c21cad2b` and the formal G1 lane passed unchanged direct `./pure/read` imports on Node 22.19.0 and 24.13.0. |
| `search` | `PASS at candidate revision (local strategy)` | Public `main` at `39c95e5e29b1c8b082059f57421ce445c3dffdd4` lacks the complete seam, but [ADR-OMP-005](adr/ADR-OMP-005.md) reopens G0 for the local candidate and the formal G1 lane passed unchanged direct `./pure/search` imports on both Node lanes. |
| `hashline-apply` | `PASS (proposal-only) at candidate revision (local strategy)` | The local candidate adds direct `./proposal` parsing with `expectedLineHashes[]`; [ADR-OMP-005](adr/ADR-OMP-005.md) reopens G0 and the formal H1 lane ran 23/23 on both Node lanes. Hashline remains proposal-only at integration; no write path is added. |

## Feasibility answer

| Question | Answer |
| --- | --- |
| Is Git topology/materialization possible? | **Yes.** ADR-OMP-003 selects exact ancestry plus prefixed tree materialization. |
| Is OMP source migrated? | **Yes, locally.** S0 merge `360d5036b58a0547a3d26e8f3b52c1daf24690b6` records exact inert source under `vendor/oh-my-pi`; its local branch has no configured upstream/tracking ref, and no remote publication is claimed or evidenced. |
| Can OMK activate the three required OMP operations now? | **Locally qualified; product activation still bounded.** [ADR-OMP-005](adr/ADR-OMP-005.md) supersedes the U1 gate for intake, G0 is reopened for candidate `b6e75dbbc545c815786ecc15d155a332c21cad2b`, G1/H1 passed on Node 22.19.0 and 24.13.0, and [ADR-OMP-006](adr/ADR-OMP-006.md) approves a bounded flag-gated I1 on the isolated branch. Hashline stays proposal-only, publication/release stay disabled, owner-checkout main merge stays excluded, and can1357 acceptance is not evidenced. |
| Can OMK add a bridge or compatibility layer now? | **No.** ADR-OMP-003 authorizes inert source presence only. |
| Is future product integration possible? | **Yes, bounded.** [ADR-OMP-006](adr/ADR-OMP-006.md) approves a scope-bounded I1 (ten-path vendor refresh plus a flag-gated pure-seam loader, default off) on isolated branch `yu/omp-migrate-39c95e5e`. Full product activation, a hashline write path, publication/release, and owner-checkout main merge still require separate authority. |
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

1. Preserve and verify the exact local S0 merge while keeping its vendored tree inert; its branch has no configured upstream/tracking ref, and no remote publication is claimed or evidenced.
2. Add only exact-prefix scanner exclusions, provenance, decision documentation, and their guard tests.
3. The bounded I1 unit is `COMPLETE` and G3-verified ([ADR-OMP-007](adr/ADR-OMP-007.md)); keep the flag-gated loader default-off and the vendor tree inert.
4. Continue the optional parallel upstream work — push candidate `b6e75dbbc545c815786ecc15d155a332c21cad2b` to a named branch in `https://github.com/dmae97/oh-my-pi` and open a can1357 pull request — without treating it as a gate or making unevidenced acceptance claims.
5. ~~Specify the hashline source-binding contract~~ — **DONE 2026-07-22:** [omp-hashline-source-binding-contract.md](adr/omp-hashline-source-binding-contract.md) freezes output shape, SHA-256 domain-separated digests, LF/Unicode normalization, duplicate-anchor/`hash-conflict`/`overlap` rules, and proposal-only mismatch semantics (write path still requires a separate ADR).
6. Continue OMP-independent AgentHarness work without presenting it as OMP gate progress.

## Work not allowed now

- Merging the I1 branch into owner-checkout `main`, publishing, releasing, or tagging; owner-checkout `main` has not been migrated and remains excluded pending separate approval.
- Changing tool behavior, tool registry, mutation queue, manifests, or lockfiles outside the ADR-OMP-008/009 seam wiring, or re-enabling a default-off gate for the seams (the default-on state is decided by [ADR-OMP-009](adr/ADR-OMP-009.md); the opt-out is `OMK_OMP_SEAMS=0`).
- Adding a hashline write path or treating hashline output as more than proposal-only data.
- Adding OMP workspaces, dependencies, workflows, or package identities to OMK's active root surface beyond the ADR-OMP-006 unit.
- Importing from `vendor/oh-my-pi` into active OMK runtime outside the flag-gated pure-seam loader, or adding a bridge, compatibility layer, product adapter, session migration, or release wiring.
- Tree-shaken runtime bundles, Bun workarounds, polyfills, partial bridges, or hand reimplementations.
- Claiming can1357 upstream acceptance; the fork and PR draft are optional parallel work, not gating evidence.
- Product-integration or release claims beyond the bounded I1 unit on the isolated branch.

## Proposed gated roadmap

The S0 source-presence phase is approved and locally committed. Later phases remain gated; the draft local object and **DRAFT / BLOCKED** ADR-OMP-004 grant no qualification authority.

| Phase | Status now | Entry condition | GO criteria | NO-GO and rollback boundary |
| --- | --- | --- | --- | --- |
| **S0. Import exact inert source** | `ACCEPTED`; local merge `360d5036b58a0547a3d26e8f3b52c1daf24690b6`; branch has no configured upstream/tracking ref and no remote publication is claimed/evidenced | Exact audited OMP commit, tree, prefix, and OMK first parent. | Second-parent identity, exact prefix-tree equality, 5,501 paths, zero unmerged entries, exact scanner exclusions, no active OMK package/runtime/release drift. | Any identity mismatch, unexpected active-path change, or package consumption. Before remote publication, abandon or revert the isolated local merge; after evidenced sharing, use first-parent merge-revert semantics. |
| **U1. Add upstream public seams** | `SUPERSEDED` for intake by [ADR-OMP-005](adr/ADR-OMP-005.md); fork `dmae97/oh-my-pi` and PR draft remain optional parallel work; can1357 acceptance not evidenced and no longer gating | Operator decision `AUTH-LOCAL-QUAL-DECISION-20260720-01` rebinds intake to exact local candidate `b6e75dbbc545c815786ecc15d155a332c21cad2b` at private ref `refs/omp/candidates/b6e75dbbc545c815786ecc15d155a332c21cad2b`. | Local-candidate intake path qualified under ADR-OMP-005; upstream acceptance remains available as optional parallel work without gating. | Identity drift from `b6e75dbbc545c815786ecc15d155a332c21cad2b` closes the local path and requires refreshed evidence; the historical U1 record is preserved. |
| **G0. Reopen disposable review** | `REOPENED` for candidate `b6e75dbbc545c815786ecc15d155a332c21cad2b` only by [ADR-OMP-005](adr/ADR-OMP-005.md); ADR-OMP-004 remains a historical `DRAFT / BLOCKED` record | ADR-OMP-005 accepts the local-candidate intake identity; identity revalidated immediately before qualification. | `operator:user` accepted the local-candidate strategy via `AUTH-LOCAL-QUAL-DECISION-20260720-01`; disposable qualification has begun and passed (G1/H1). | Identity drift from `b6e75dbbc545c815786ecc15d155a332c21cad2b` closes G0 again and requires refreshed evidence; product activation stays bounded. |
| **G1. Qualify direct `read` and `search`** | `PASS` — formal qualification passed on Node 22.19.0 and 24.13.0 ([evidence](adr/evidence/omp-g1-h1-qualification.json)) | G0 reopened by ADR-OMP-005; both Node runtimes installed and identified; both seams directly importable unchanged. | Direct unchanged `.ts` source imports passed alone and together on both lanes with identical probe-log digests and zero mutation; evidence binds commit, tree, blobs, runtimes, fixtures, closure, license, and digests. | Any identity drift, runtime substitution, seam failure, or generated code closes the candidate review; extraction cannot replace `read` or `search`. |
| **H1. Qualify direct hashline** | `PASS` — formal qualification passed on Node 22.19.0 and 24.13.0 ([evidence](adr/evidence/omp-g1-h1-qualification.json)) | G0 reopened by ADR-OMP-005; G1 passed; `./proposal` directly imported unchanged. | The direct hashline seam ran 23/23 on both lanes and the combined all-three direct-source suite passed without forbidden authority or mutation; hashline stays proposal-only. | Any semantic, source-binding, runtime, mutation, or identity failure closes the candidate review. Extraction is not a fallback under ADR-OMP-004/005. |
| **E1. Optional hashline extraction qualification** | `NOT AUTHORIZED`; alternative to H1 | G0 is `REOPENED`; G1 passes; hashline source contains the full required semantics; a dedicated prior ADR approves the exact extraction design before the artifact is used as a qualifying seam. | The artifact matches approved source-range/AST identity, deterministic generator and expected digest, license proof, and zero-semantic-edit proof; it imports on both Node lanes without a runtime bundler, loader workaround, or polyfill; the combined G1+E1 suite passes. | Missing prior ADR, source semantics, identity, reproducibility, digest, or G1 qualification. Dispose of artifacts and close the candidate review. |
| **G2. Approve integration** | `ACCEPTED (scope-bounded)` via [ADR-OMP-006](adr/ADR-OMP-006.md) | G1 and H1 passed at the same exact candidate revision. | ADR-OMP-006 names the qualified candidate, the ten-path vendor refresh, the flag-gated (`OMK_OMP_SEAMS=1`, default off) pure-seam loader and tests under `packages/coding-agent`, the proposal-only hashline boundary, and the rollback unit; no tool/registry/queue/manifest/lockfile change. | Scope drift, stale evidence, session coupling, hidden authority, publication/release, or owner-checkout main merge. No owner-checkout main change is approved. |
| **I1. Integrate at the coding-agent boundary** | `COMPLETE` under [ADR-OMP-006](adr/ADR-OMP-006.md); both I1 commits plus the ADR docs commit are recorded; scope verified exactly against the approved unit ([G3 evidence](adr/evidence/omp-g3-verification.json)) | G2 scope-bounded approval exists. | Only the ten approved vendor paths plus the flag-gated pure-seam loader and tests under `packages/coding-agent` changed; hashline stays proposal-only; writes stay serialized; existing tool contracts are preserved. | Revert the bounded integration unit (rehearsed byte-exact under G3). |
| **G3. Verify product and rollback** | `PASS` via [ADR-OMP-007](adr/ADR-OMP-007.md) ([evidence](adr/evidence/omp-g3-verification.json)) | I1 complete. | Regression (matched-pair S0 baseline; 18 LLM-auth e2e failures pre-existing), security/T3 closure, package/T9, license, race (zero write path), rollback (byte-exact rehearsal), and clean-diff gates passed with fresh 2026-07-21 evidence; owner roles satisfied by operator-accepted substitution lanes. | Any failed gate would revert I1 and rerun the OMK baseline. |
| **I2. Wire read/grep tools to the seams** | `COMPLETE` via [ADR-OMP-008](adr/ADR-OMP-008.md) ([benchmark](adr/evidence/omp-i2-benchmark.json)); `DEFAULT-ON` (opt-out `OMK_OMP_SEAMS=0`) via [ADR-OMP-009](adr/ADR-OMP-009.md) | G3 PASS; operator instructions to proceed with wiring and make it the default. | `read` (text) and `grep` (context=0) delegate validation+presentation to the vendored seams by default; opt-out byte-identical and test-pinned; full-suite regression parity; benchmark: seam is not faster — value is source-bound presentation. | Per-session `OMK_OMP_SEAMS=0`; full revert of the ADR-009 commit restores opt-in. |
| **R1. Decide publication** | `DECIDED — publication disabled` via [ADR-OMP-007](adr/ADR-OMP-007.md) | G3 passed. | Operator decision 2026-07-21: publication, release, tags, branch pushes, and the fork PR route remain disabled; reopening requires a fresh explicit operator decision. | No release approval; publication stays disabled. |

## Required future seam contract

A draft cannot be refreshed into a **PROPOSED** G0 record until U1 passes in a named can1357 upstream commit and all three source-visible contracts exist at that exact identity:

- **Read:** a public authority-free module accepts immutable request/planning input and OMK-supplied read results, then returns deterministic model/presentation data.
- **Search:** a public authority-free module accepts immutable query/scope input and OMK-supplied matches, then returns deterministic normalized/presentation data.
- **Hashline:** a public authority-free parser accepts untrusted patch text and returns proposed edits plus `expectedLineHashes[]` without reading, writing, or mutating external state.
- **Read/search runtime:** both seams import unchanged on Node 22.19.0 and 24.13.0, alone and together, without Bun, native, filesystem, process, network, browser, session, TUI, or edit authority.
- **Hashline qualification:** either H1 imports the upstream seam unchanged, or E1 imports the exact prior-ADR-approved artifact. Both routes must run on the same Node lanes without forbidden authority or runtime bundling, loaders, or polyfills.
- **Combined proof:** G1 plus H1 or E1 must pass together at one exact revision.
- **Identity:** public signatures, schemas, static closure, source blobs, license, runtime identity, fixtures, and outputs bind to that revision.

H1 is the preferred direct path. If hashline extraction remains necessary, use E1 only: a dedicated prior ADR must approve exact source-range or AST identity, a deterministic generator and expected output digest, upstream license proof, drift failure, and zero semantic edits before the artifact can count as a qualifying seam. Extraction cannot invent missing hashes or replace direct public `read` and `search` seams.

## Future verification matrix

| ID | Gate | Required evidence |
| --- | --- | --- |
| T1 | Exact source identity | Commit, tree, blobs, merge base, default branch observation, no tags, disabled push, and durable source/license hashes. |
| T2 | Node imports | G1 imports candidate `read`/`search` unchanged. H1 also imports candidate hashline unchanged; E1 instead imports the exact ADR-approved hashline artifact. Run each seam and the selected combination on Node 22.19.0 and 24.13.0, with no runtime bundler, loader workaround, or polyfill. |
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
| `/tmp` evidence or the detached candidate `HEAD` disappears. | Retain the candidate through the authorized local private ref, independently of the detached worktree. The fork route exists but does not retain the candidate until exact `b6e75d…` is pushed to a named branch. After can1357 acceptance, revalidate the accepted upstream object and full identity, then repeat revalidation immediately before G0. Preserve and verify durable reports and digests before deleting disposable raw artifacts. |
| Integration couples to sessions or AgentHarness. | Keep the adapter at coding-agent tool factories and avoid OMP-specific durable state. |
| Rollback leaves dual mutation paths. | Never dual-run writes; preserve one OMK mutation queue and rehearse bounded reversion. |

## Rollback policy

- **Current source-import state:** S0 is local merge commit `360d5036b58a0547a3d26e8f3b52c1daf24690b6`. Its local branch has no configured upstream/tracking ref, and no remote publication is claimed or evidenced. It is not a staged-only change, and no merge is open.
- **S0:** Before evidenced remote publication, abandon the isolated branch/worktree or revert the local merge with first-parent semantics. After evidenced sharing, use a first-parent merge revert; the current tree loses the source while Git history retains ancestry. Do not use merge-abort instructions for the committed state.
- **G0–E1:** If a future accepted intake starts qualification, first preserve a durable PASS/FAIL report binding candidate/runtime identities, exact commands, and raw-artifact digests, and verify the stored report and digests. Only then delete disposable worktrees, fixtures, and raw probe output. Verify that active OMK paths remain unchanged.
- **G2:** Rejecting an integration ADR leaves the repository at S0.
- **I1–G3:** Revert only the approved integration unit. Do not add session conversion or dual writes, so current tool factories remain the restoration target.
- **Source drift:** A changed or missing commit/object, export, AST range, generator output, license, or closure returns to U1 and requires refreshed evidence before any new G0 proposal; later gates and G2 remain closed.
- **Publication:** The public fork handoff route exists, but no candidate branch or pull request exists in the recorded state. Any next handoff action requires separate exact authorization. Keep product/release publication disabled until R1 grants separate authority.

## Ownership

ADR-OMP-003 resolves source presence. [ADR-OMP-005](adr/ADR-OMP-005.md) (`ACCEPTED`) reopens G0 for the local candidate and binds the intake decision to `operator:user` via `AUTH-LOCAL-QUAL-DECISION-20260720-01`; [ADR-OMP-006](adr/ADR-OMP-006.md) (`ACCEPTED`, scope-bounded) approves the I1 unit. The rows below now reflect the satisfied decision scope; they still do not evidence can1357 upstream acceptance.

| Responsibility | Required owner role | Handle | Status |
| --- | --- | --- | --- |
| Decision scope and ADR acceptance | Operator | `operator:user` | Satisfied for U1-supersede / G0 reopen (ADR-OMP-005), bounded I1 (ADR-OMP-006), G3 + F1 acknowledgment + R1-no-publication (ADR-OMP-007) |
| Candidate identity and evidence | OMK root coordinator | `omk-root` | Local private-ref retention in place; revalidation required on any identity drift |
| Upstream public-seam acceptance | can1357 upstream maintainer | Not locally assignable | Optional parallel work; not gating under ADR-OMP-005; not evidenced |
| Closure, source, license, and supply-chain audit | Independent reviewer | `compliance-auditor` | G1/H1 evidence reviewed; required again for G3 |
| Node runtime verification | Runtime/test maintainer | `qa-engineer` | G1/H1 completed on Node 22.19.0 and 24.13.0 |
| Coding-agent integration | Coding-agent tool/runtime maintainer | `omk-coder` | I1 `COMPLETE` + I2 `DEFAULT-ON` (ADR-OMP-008/009); owner main merge recorded; publication still disabled |
| Independent regression and rollback | Reviewer who did not author I1 | omk-loop coordinator (substitute lane, operator-accepted) | G3 satisfied 2026-07-21 ([report](adr/evidence/omp-g3-verification.json)) |
| Product acceptance | Product owner | `operator:user` | R1 decided 2026-07-21: publication disabled (ADR-OMP-007) |
| Publication | Release owner | `operator:user` | R1 decided 2026-07-21: publication/release remain disabled (ADR-OMP-007) |

An unassigned required owner is an automatic no-go for that phase.

## Reopen trigger

[ADR-OMP-005](adr/ADR-OMP-005.md) (`ACCEPTED`, `AUTH-LOCAL-QUAL-DECISION-20260720-01`) reopened G0 for the exact local candidate `b6e75dbbc545c815786ecc15d155a332c21cad2b` only, with durable retention at private ref `refs/omp/candidates/b6e75dbbc545c815786ecc15d155a332c21cad2b`. Formal G1/H1 qualification `PASSED` on Node 22.19.0 and 24.13.0 ([evidence](adr/evidence/omp-g1-h1-qualification.json)), and [ADR-OMP-006](adr/ADR-OMP-006.md) approves a bounded I1 on isolated branch `yu/omp-migrate-39c95e5e`. The fork `dmae97/oh-my-pi` and PR draft remain optional parallel work; can1357 acceptance is not evidenced and is not claimed.

The reopen trigger is now **candidate-drift re-qualification**: if the qualified commit, tree, parent (`39c95e5e29b1c8b082059f57421ce445c3dffdd4`), ten changed paths, package exports, source blobs, license, or Node 22.19.0/24.13.0 runtime identity changes from `b6e75dbbc545c815786ecc15d155a332c21cad2b`, G0 closes again. Revalidate the object, parent, tree, exact path/blob inventory, exports, source blobs, license, and Node 22.19.0/24.13.0 identities, then re-run the full G1/H1 matrix and refresh the qualification evidence before any new G0/G2/I1 step. A missing object expires the reopened state.

Operator acceptance beyond the recorded `AUTH-LOCAL-QUAL-DECISION-20260720-01` boundary cannot extend G0/I1. The qualified evidence does not authorize extraction as a substitute seam, owner-checkout `main` mutation, publication/release, or any I1 scope outside [ADR-OMP-006](adr/ADR-OMP-006.md). A changed commit, topology replay, private helper, successful Bun run, or bundle cannot carry acceptance forward. E1 still requires its own prior ADR.

## Current verification commands

The following bounded checks reproduce the committed-document boundary. Use a disposable clone for upstream commands.

```bash
node -e 'for (const p of process.argv.slice(1)) JSON.parse(require("node:fs").readFileSync(p, "utf8"))' \
  docs/adr/evidence/omp-topology-report.json \
  docs/adr/evidence/omp-pure-probes.json \
  docs/adr/evidence/omp-pure-source-inventory.json \
  docs/adr/evidence/omp-g0-candidate.json \
  docs/adr/evidence/omp-g1-h1-qualification.json

printf '%s  %s\n' \
  806aa07ae1f13276d11b30cbabb4a5873e6a4e75dde076040a2d246bf1d68f4d docs/adr/evidence/omp-topology-report.json \
  ef2fdcf288b084537fa1994e5cd19faa154eca8c866b570962cac2e9e942c507 docs/adr/evidence/omp-pure-probes.json \
  e77b5524dc2ff805aba37c53478849056de937573d74359688a7a7d8065aab21 docs/adr/evidence/omp-pure-source-inventory.json | sha256sum -c -

git ls-remote --symref https://github.com/can1357/oh-my-pi.git HEAD refs/heads/main
git ls-remote --symref https://github.com/dmae97/oh-my-pi.git HEAD refs/heads/main

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

Before sharing a roadmap update, parse the JSON evidence and verify all relative links. Run `git diff --check -- docs/adr/ADR-OMP-004.md docs/adr/evidence/omp-g0-candidate.json docs/omp-migration-roadmap.md` and confirm that `git status --short` names only the intended documentation. Do not stage as part of this draft-only recovery.

## Document history

| Date | Change |
| --- | --- |
| 2026-07-22 | Specified the hashline source-binding contract ([omp-hashline-source-binding-contract.md](adr/omp-hashline-source-binding-contract.md)) from qualified vendor `proposal.ts` / `proposal-types.ts` (tree `296cfdbb…`): output shape, domain-separated SHA-256, LF/Unicode normalization, duplicate-anchor and conflict codes, proposal-only mismatch semantics for a future write path. Marked work-allowed item 5 done. No write path, no publication, no vendor change. |
| 2026-07-21 | Recorded ADR-OMP-009 (`ACCEPTED`, operator instruction with benchmark data visible): seams `DEFAULT-ON` for `read` (text) and `grep` (context=0) with byte-identical opt-out (`OMK_OMP_SEAMS=0`); supersedes the default-off boundary of ADR-OMP-006/007/008; `test/tools.test.ts` pins the legacy path; operator accepts the recorded provenance-hash cost as the default experience. Publication remains disabled. |
| 2026-07-21 | Recorded ADR-OMP-008 (`ACCEPTED`, operator instruction): I2 `COMPLETE` — flag-gated (`OMK_OMP_SEAMS=1`, default off) wiring of the `read`/`grep` tools to the OMP pure seams via a memoized typed facade; 11 new tests pass; full-suite regression parity with the pre-I2 baseline (same 18 LLM-auth e2e failures); benchmark evidence ([evidence](adr/evidence/omp-i2-benchmark.json)) records the seam is not faster (read 1.07→88.96 ms mean; grep +16%) — its value is deterministic source-bound presentation. Publication remains disabled. |
| 2026-07-21 | Recorded ADR-OMP-007 (`ACCEPTED`, operator request `REQ-OMP-G3-R1-001`): G3 `PASS` on fresh evidence ([evidence](adr/evidence/omp-g3-verification.json)) with operator-accepted substitution review lanes; I1 marked `COMPLETE`; F1 owner-checkout main state acknowledged as-is (no publication; local `main` 13,716 ahead of `origin/main`); R1 `DECIDED` — publication/release/tags/branch pushes/fork PR remain disabled, reopening requires fresh explicit operator decision. |
| 2026-07-20 | Consistency refresh after ADR-OMP-005/006 acceptance and G1/H1 PASS: recorded ADR-OMP-005 (`ACCEPTED`, `AUTH-LOCAL-QUAL-DECISION-20260720-01`) superseding the U1 upstream-acceptance gate for intake and reopening G0 for candidate `b6e75dbbc545c815786ecc15d155a332c21cad2b` only; recorded formal G1/H1 `PASS` on Node 22.19.0 and 24.13.0 (`docs/adr/evidence/omp-g1-h1-qualification.json`); recorded ADR-OMP-006 (`ACCEPTED`, scope-bounded) approving the I1 unit on isolated branch `yu/omp-migrate-39c95e5e`; updated the verdict, status terms, evidence table, gate-results, feasibility, U1/G0/G1/H1/G2/I1 phase rows, work allowed/not allowed, ownership, reopen trigger, and Node 22.19.0 availability; kept publication/release disabled and owner-checkout main merge excluded. |
| 2026-07-20 | Added a decision-ready roadmap and rechecked the public OMP default branch against the reviewed pin. |
| 2026-07-20 | Recorded ADR-OMP-003's exact inert source import while keeping product activation terminated. |
| 2026-07-20 | Recorded S0's local no-tracking-ref observation, changed ADR-OMP-004 to **DRAFT / BLOCKED**, made can1357 acceptance in a named upstream commit a strict U1 prerequisite, recorded the then-ephemeral detached-worktree retention and bounded remote observations, and required durable PASS/FAIL evidence before raw-artifact deletion. |
| 2026-07-20 | Recorded authorized local private ref `refs/omp/candidates/b6e75dbbc545c815786ecc15d155a332c21cad2b` as durable local retention for the exact candidate while keeping U1 blocked, G0 unauthorized, product activation terminated, remote candidate publication unclaimed, and future G0 revalidation mandatory. |
| 2026-07-20 | Recorded the exact authorized creation of public fork `https://github.com/dmae97/oh-my-pi` as **FORK CREATED / BRANCH PENDING**, with public `HEAD`/`main` at `39c95e5e29b1c8b082059f57421ce445c3dffdd4`, `isFork: true`, default branch `main`, no local clone/remote, no candidate branch or pull request, and no evidenced can1357 acceptance. |
