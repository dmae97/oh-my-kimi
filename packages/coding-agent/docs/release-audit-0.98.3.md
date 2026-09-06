# Release audit: v0.98.3

Date: 2026-09-06. Target: seven lockstep npm packages, GitHub Release and a tag on `main`.
This audit is release engineering evidence, not algorithm accuracy or correctness proof.

## Source and scope

The published v0.98.2 tag was `7e10858f5ecfeee1eea5364a2f21336c5c416f11`.
The working algorithm branch at `60f520f0c103888ef27438ac5058bdfc78b3e409` had forked before
that release and still declared 0.98.1. Its four committed evidence-library changes were
merged with remote main `92dca0f598243a38de156bbe4d099e3e60414cb6` in a separate clean
publication checkout. The merge preserves the original release ancestry; it does not move
the v0.98.2 tag or rewrite published changelogs.

Included new work:

- the four committed trace/effect/claim-closure/VERA projection changes;
- the reviewed advisory SDK integrity patch, tests and specification;
- release-facing documentation, manifest/lock/shrinkwrap alignment and publication-auth truth.

Excluded: unrelated uncommitted provider integrations, UI, context-init and reverse-skill
changes, private agent-home material, the untracked algorithm-copy document, research data,
sessions, local temporary output and optional generated wiki corpora. The original dirty
working tree was not reset, stashed, broadly staged or copied into the release.

## Public package manifest

| Package | Version | Role |
| --- | --- | --- |
| `open-multi-agent-kit` | `0.98.3` | CLI and explicit advisory/evidence SDK |
| `omk-ai` | `0.98.3` | Provider API; lockstep, no catalog refresh in this release |
| `omk-agent-core` | `0.98.3` | Runtime; internal trace/effect primitives |
| `omk-tui` | `0.98.3` | TUI; lockstep |
| `omk-protocol` | `0.98.3` | Run and claim-closure contracts |
| `omk-adaptorch-wpl` | `0.98.3` | Explicit WPL and proof/VERA projections |
| `omk-book-to-skill` | `0.98.3` | Optional document compiler; lockstep |

The root/workspace manifests, internal dependency ranges, root/example lockfiles,
book compiler version constant and CLI `npm-shrinkwrap.json` are synchronized.
Model catalogs are not fetched or regenerated. No API is intentionally removed.
The new `judge-tied` reason and stricter normal-stop requirement are documented in
[Advisory selection integrity](advisory-selection.md).

## Changelog and document audit

- Each public package has a changelog; new protocol/book changelogs explicitly state their
  historical limits instead of fabricating entries for old versions.
- Root/package README release links and document-compiler install pins name v0.98.3.
- The runtime-algorithm audit distinguishes its historical v0.97.0 snapshot from subsequent
  v0.98.0 guards and the new v0.98.3 library scope.
- Internal agent modules are not advertised as default runtime authority or root exports.
- The actual workflow is token-authenticated GitHub CI. The earlier constitution claimed
  OIDC despite an existing token-only job. A failing-first test exposed that mismatch; the
  documentation now matches the unchanged workflow. No token was read or replaced.

## Local verification

The first full keyless pass used an isolated temporary HOME. All affected tests passed but
one Rust diagnostics test could not find its rustup toolchain. Supplying the non-secret
`RUSTUP_HOME` path restored that fixture: 6/6 diagnostics tests passed. No production code
was changed to suppress this environment failure. Final release checks are run again on the
bumped candidate with the isolated HOME and explicit toolchain path.

Final local results on the 0.98.3 candidate:

| Gate | Result |
| --- | --- |
| Seven-workspace build | PASS |
| `npm run check` | PASS; informational legacy switch-case findings only |
| `check-release-consistency --release` | PASS; v0.98.2 ancestor, all surfaces 0.98.3, no drift |
| Full keyless workspace tests | 7,124 passed, 821 skipped, 0 failed |
| Test breakdown | WPL 116, agent 640, AI 487, book compiler 22, coding-agent 5,109, protocol 25, TUI 725 |
| Go initcheck vet/race/shuffle + native symbol validation | PASS |
| Committed algorithm/staged patch gitleaks | No leaks found |
| Seven npm dry-run packs | 0.98.3, each carries CHANGELOG.md, restricted-path matches 0 |
| Existing five changelog histories from v0.98.2 | Byte-preserved |
| Clean-environment compiled CLI | Reports 0.98.3 |

The first tarball inspection exposed that six package `files` allowlists omitted changelogs.
A failing-first release test now requires each public package to ship its current dated
changelog; all six allowlists were corrected. The publication helper's misleading automatic
CI-provenance message was also corrected without changing authentication behavior.

An inherited `OMK_PACKAGE_DIR` pointed the local smoke command at older package metadata.
Unsetting only that override changed its reported version from 0.98.1 to 0.98.3, and a fully
clean environment confirmed 0.98.3. The override was not changed globally; the isolated build
and package manifests are the release subject.

A local pass is not a completed npm publication: the matching tag workflow must still pass,
and npm `latest` plus GitHub Release must agree on the version.

## Publication boundary

The existing `build-binaries.yml` workflow verifies source/tag identity, builds six platform
archives, validates and publishes npm packages, then creates the GitHub Release. Publishing
uses the existing environment-scoped granular token; OIDC/Sigstore provenance is not claimed.
No local `npm publish`, credential rotation, gate bypass or force-push is part of this release.
