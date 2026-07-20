# ADR-OMP-004: Draft intake template for a future upstream-accepted OMP candidate

- **Status:** DRAFT / BLOCKED — U1 not passed
- **Date:** 2026-07-20
- **Decision owner:** `operator:user`
- **Candidate owner:** `omk-root`
- **Independent supply-chain owner:** `compliance-auditor`
- **Runtime owner:** `qa-engineer`
- **Later integration owner:** `omk-coder`
- **Evidence:** [G0 candidate inventory](evidence/omp-g0-candidate.json)
- **Roadmap:** [OMP migration roadmap](../omp-migration-roadmap.md)
- **Prior decisions:** [ADR-OMP-002](ADR-OMP-002.md), [ADR-OMP-003](ADR-OMP-003.md)
- **Superseded by:** [ADR-OMP-005](ADR-OMP-005.md) for the U1-upstream-acceptance requirement and G0 reopening; historical record preserved

> **Superseded notice (2026-07-20).** For this repository's intake path, [ADR-OMP-005](ADR-OMP-005.md) (`ACCEPTED`, operator request `AUTH-LOCAL-QUAL-DECISION-20260720-01`) supersedes the U1 can1357-upstream-acceptance requirement recorded below and reopens G0 for the exact local candidate `b6e75dbbc545c815786ecc15d155a332c21cad2b` only. Formal G1/H1 qualification has since `PASSED` on plain Node 22.19.0 and 24.13.0 ([evidence](evidence/omp-g1-h1-qualification.json)), and [ADR-OMP-006](ADR-OMP-006.md) (`ACCEPTED`, scope-bounded) approves a bounded I1 on isolated branch `yu/omp-migrate-39c95e5e`. The authority text below is the original `DRAFT / BLOCKED` record and is not re-opened by this notice; publication/release remain disabled and owner-checkout main merge remains excluded. See the [OMP migration roadmap](../omp-migration-roadmap.md) for the current verdict.

## Current authority

G0 remains **NOT AUTHORIZED** and product activation remains **TERMINATED**. This draft is not acceptance-ready and does not authorize qualification, candidate execution, owner-checkout changes, integration, publication, or a claim of acceptance by can1357 upstream.

U1 is strictly prior to G0: the required seams must be accepted by can1357 upstream in a named upstream commit. Local commit `b6e75dbbc545c815786ecc15d155a332c21cad2b` does not pass U1 and cannot authorize G0, G1, or H1. Operator acceptance of this draft alone has no gate effect.

The candidate now has durable local retention at authorized private ref `refs/omp/candidates/b6e75dbbc545c815786ecc15d155a332c21cad2b`. This local ref is not remote publication or can1357 acceptance. A separate exact authorized action created the public fork `https://github.com/dmae97/oh-my-pi`, establishing the named repository publication/handoff route in **FORK CREATED / BRANCH PENDING** state. Public `HEAD` and `main` resolve to audited baseline `39c95e5e29b1c8b082059f57421ce445c3dffdd4`; a bounded `gh` metadata observation reports `isFork: true` and default branch `main`. This records only the public repository identity and `isFork` flag, not a specific parent relationship. No local clone or remote was added, the candidate branch was not pushed, no pull request was opened, and can1357 acceptance is not evidenced.

The current next prerequisite is to push exact candidate `b6e75dbbc545c815786ecc15d155a332c21cad2b` to a named branch in that fork, then open a can1357 pull request and await acceptance in a named upstream commit. Only after that exact upstream acceptance and commit identity exist may this record be revalidated and refreshed from **DRAFT / BLOCKED** into a **PROPOSED** G0 record.

## Exact identities

### S0 local source import

| Identity | Value |
| --- | --- |
| Local merge commit | `360d5036b58a0547a3d26e8f3b52c1daf24690b6` |
| Merge tree | `a8efb6013471881fd9ce3678d508215b96a0c839` |
| OMK first parent | `1158d6d25230ad68946210aabe548fdf94896594` |
| OMP second parent | `39c95e5e29b1c8b082059f57421ce445c3dffdd4` |
| Vendored OMP tree | `256c587a69cd7ae7dc2a9063689db690b4ed741d` |
| Vendored leaf entries | 5,501 |
| Local publication observation | Branch `yu/omp-migrate-39c95e5e` has no configured upstream/tracking ref; no remote publication is claimed or evidenced |

There is no staged-only or open-merge S0 state. The S0 tree remains inert and does not consume OMP at runtime. The branch observation is local and makes no global sharing-state assertion.

### Draft local candidate observation — does not pass U1

| Identity | Value |
| --- | --- |
| Candidate commit | `b6e75dbbc545c815786ecc15d155a332c21cad2b` |
| Candidate tree | `296cfdbb83bbb7db30248864938cd7f456e2b8f5` |
| Candidate parent | `39c95e5e29b1c8b082059f57421ce445c3dffdd4` |
| Authorized local private ref | `refs/omp/candidates/b6e75dbbc545c815786ecc15d155a332c21cad2b` → `b6e75dbbc545c815786ecc15d155a332c21cad2b` |
| Changed paths | Exactly 10; path and blob inventory is in the evidence JSON |
| Source | Upstream-derived local Git object |
| Retention observation | On 2026-07-20, the authorized local private ref retained the exact candidate; detached worktree `HEAD` at `/tmp/omp-u1-pure-seams` also remained at that commit and its worktree was clean |
| Durability | Durable local private-ref retention; the fork route exists, but no remote durability or publication of the candidate is claimed |
| Publication/handoff route | `https://github.com/dmae97/oh-my-pi`; **FORK CREATED / BRANCH PENDING**; public `HEAD`/`main` at `39c95e5e29b1c8b082059f57421ce445c3dffdd4`; candidate branch not pushed |
| Upstream evidence boundary | The private ref is local retention only. The public fork establishes a named repository route, not candidate publication, a pull request, can1357 publication, or can1357 acceptance |
| Candidate license | MIT; `LICENSE` blob `cc0c5aa7c10d87c5142af1274b37da95c005184d` |
| License SHA-256 | `545636e19386d3d4e0ae6d77354527499999c3ebfbca61b9fa5aa4ead7c0b308` |

The candidate adds package exports `./pure/read`, `./pure/search`, and `./proposal`. Its value-function inventory is:

- `planRead(input: unknown): ReadPlanResult`
- `presentRead(plan: ReadPlan, file: ReadHostFile): ReadPresentResult`
- `planSearch(input: unknown): SearchPlanResult`
- `presentSearch(plan: SearchPlan, matches: readonly SearchHostMatch[], sourceDigests?: readonly SearchSourceDigest[]): SearchPresentResult`
- `parseHashlineProposal(untrustedText: string): HashProposalParseResult`
- `hashProposalLine(text: string): Promise<string>`
- `hashProposalSource(text: string): Promise<string>`

The evidence JSON binds each export to its package manifest, source path, Git blob, and type inventory. It also binds the authorized local private ref to the candidate commit and records reconstruction assertions for the ref, commit, tree, and parent. The ref provides durable local object retention independent of the detached worktree; it does not establish remote candidate publication or upstream acceptance. The separately authorized public fork establishes only the bounded repository route described above; it does not change candidate identity.

A public read-only observation on 2026-07-20 ran `git ls-remote --symref https://github.com/can1357/oh-my-pi.git HEAD refs/heads/main` and observed public `HEAD`/`main` at `39c95e5e29b1c8b082059f57421ce445c3dffdd4`. Its output did not contain `b6e75dbbc545c815786ecc15d155a332c21cad2b`; the command queried only public `HEAD` and `main`, not that local commit through a public ref, so it does not establish absence from every public ref.

After the exact authorized fork-creation action, a public read-only observation of `https://github.com/dmae97/oh-my-pi.git` resolved `HEAD` and `main` to `39c95e5e29b1c8b082059f57421ce445c3dffdd4`. A bounded `gh` metadata observation reported public identity, `isFork: true`, and default branch `main`. No parent repository relationship is claimed beyond that `isFork` observation. No candidate branch or pull request exists in the recorded route state, and can1357 acceptance is not evidenced. This evidence refresh did not access or record any secret, token, or credential value.

## Conditions to refresh this draft

This draft creates no exception to ADR-OMP-002. Before it may become a **PROPOSED** G0 record:

1. push exact candidate `b6e75dbbc545c815786ecc15d155a332c21cad2b` to a named branch in the recorded public fork;
2. open a pull request from that branch to can1357 upstream;
3. obtain can1357 upstream acceptance of the required seams in a named upstream commit;
4. after that named upstream acceptance exists, revalidate the accepted commit object, parent, tree, exact changed-path/blob inventory, package exports, source blobs, and license identity; and
5. update this ADR and its evidence to the exact accepted upstream identity, owners, runtime lanes, evidence plan, forbidden work, and rollback boundary.

Repeat the same object, parent, tree, path/blob, export, and license revalidation immediately before any future G0 acceptance. A missing candidate object expires this draft; the JSON identity record is not a substitute. Any source, export, signature, blob, license, parent, or accepted upstream commit change requires refreshed evidence. No candidate may execute before U1 passes and a refreshed **PROPOSED** G0 record is accepted.

## Owners

| Responsibility | Proposed handle | Authority now |
| --- | --- | --- |
| Decide a future G0 proposal after U1 passes | `operator:user` | Cannot accept this draft; decision only after refresh to **PROPOSED** |
| Preserve draft identity and evidence | `omk-root` | Documentation and durable local private-ref inventory only; no publication authority |
| Independently verify source, license, closure, and supply chain | `compliance-auditor` | Review only; qualification not started |
| Run both formal Node lanes after a future accepted G0 | `qa-engineer` | None before U1 and accepted G0 |
| Perform later bounded integration under a separate ADR | `omk-coder` | None |

These handles are local role assignments. They do not imply can1357 upstream publication or acceptance.

## Runtime lanes

Formal qualification requires plain Node `22.19.0` and `24.13.0`.

- Node `22.19.0` is unavailable in the observed environment. This blocks runtime readiness.
- Development checks were reported passing on Node `22.22.3` and `24.13.0`. They are not formal G1 or H1 evidence and do not replace Node `22.19.0`.
- This recovery did not execute the candidate or rerun those checks.

Both formal runtimes must be available and identified before G1 or H1 execution. Do not substitute a nearby Node 22 release.

## Qualification and evidence plan

| Gate | Current state | Required evidence | Pass | Fail |
| --- | --- | --- | --- | --- |
| U1 upstream acceptance | `BLOCKED`; fork created, candidate branch pending | Exact candidate pushed to a named fork branch; pull request opened to can1357; can1357 acceptance in a named upstream commit; revalidated accepted object, parent, tree, path/blob, export, and license identity | The named accepted upstream commit contains the complete required seams | A fork without the candidate branch, a local private ref, operator acceptance, missing object, or identity drift does not pass U1 |
| G0 intake | `NOT AUTHORIZED`; this ADR is **DRAFT / BLOCKED** | U1 pass; refreshed **PROPOSED** ADR tied to the exact named upstream commit; immediate pre-acceptance identity revalidation | `operator:user` accepts the refreshed exact proposal without identity drift | This draft cannot be accepted; operator acceptance alone cannot open G0; start nothing |
| Runtime readiness | `BLOCKED` | Accepted G0 plus exact executable identities for Node `22.19.0` and `24.13.0` | Both plain Node lanes are available | Either lane is absent or substituted; G1 and H1 do not start |
| G1 read/search | `NOT AUTHORIZED`; not started | Unchanged package-subpath imports on both lanes; exact commands, blobs, fixtures, outputs, and digests; static closure; runtime traps; deterministic, deeply immutable results; zero external mutation | Both seams pass alone and together without forbidden authority or transformation | Any import, contract, identity, determinism, authority, mutation, or evidence failure terminates the candidate review |
| H1 hashline | `NOT AUTHORIZED`; not started | G1 pass; unchanged `./proposal` import on both lanes; malformed, large, Unicode, line-ending, duplicate, conflict, overlap, stale-hash, and resource-bound cases; exact `expectedFileHashes` and `expectedLineHashes`; zero read or mutation | The direct seam and combined all-three suite pass on both lanes | Any semantic, source-binding, runtime, mutation, identity, or evidence failure terminates the candidate review; extraction is not a fallback |
| Integration | `NOT AUTHORIZED` | Fresh G1 and H1 pass plus a separate accepted integration ADR | Only the later ADR can define a bounded integration unit | No owner-checkout or product change |

Every result must bind the candidate commit and tree, all relevant manifest/source/test blobs, package export targets, source and license identities, exact runtime executables, command lines, fixtures, outputs, digests, closure inventory, and mutation sentinels. Evidence must distinguish pre-existing development observations from formal qualification runs.

## Forbidden runtime authority

The candidate runtime closure must contain no Bun, native, filesystem, process, network, browser, session, TUI, or edit/mutation authority. The qualification runner may observe processes and sentinel files, but the imported seams must not acquire those capabilities.

Do not use a runtime bundler, custom loader, polyfill, workaround, partial bridge, hand implementation, or mechanical extraction to produce a pass.

## Rollback

Leaving this draft blocked or allowing it to expire requires no product rollback. Start no qualification, leave the S0 import inert, and keep product activation terminated. The S0 branch has no configured upstream/tracking ref and no remote publication is claimed or evidenced. The candidate is not applied to the S0 vendor tree.

If a future accepted qualification gate fails, first preserve a durable PASS/FAIL report binding the candidate and runtime identities, exact commands, and raw-artifact digests, then verify the stored report and digests. Only after that durable evidence is verified may disposable worktrees, fixtures, and raw probe output be deleted. Verify that owner and active OMK paths remain unchanged. Preserve S0; do not create an integration or publication rollback obligation.

The public fork is a handoff route only and creates no product rollback obligation. Because no candidate branch was pushed and no pull request was opened, there is no candidate-publication rollback in the recorded state; any later route retirement requires separate authorization.

If candidate identity drifts, preserve the prior observation as historical evidence, reconstruct the full identity and license inventory, and require a refreshed decision. If the object is missing at a required revalidation, expire this draft and start no gate.
