# ADR-OMP-003: Import the exact current OMP tree under an inert source prefix

- **Status:** ACCEPTED — source presence only
- **Date:** 2026-07-20
- **OMP commit:** `39c95e5e29b1c8b082059f57421ce445c3dffdd4`
- **OMP tree:** `256c587a69cd7ae7dc2a9063689db690b4ed741d`
- **OMK first parent:** `1158d6d25230ad68946210aabe548fdf94896594`
- **Merge base:** `15d5120b6a5dc757355b99d20d8d1885143d0865`
- **Prefix:** `vendor/oh-my-pi`
- **Prior decisions:** [ADR-OMP-001](ADR-OMP-001.md), [ADR-OMP-002](ADR-OMP-002.md)
- **Provenance:** [`vendor/oh-my-pi.PROVENANCE.json`](../../vendor/oh-my-pi.PROVENANCE.json)

## Context

The operator directed OMK to proceed with a Git-native migration from the current public OMP default branch. A direct root merge is not reviewable: Git reports 224 conflict diagnostics across 217 paths, including package manifests, lockfiles, release controls, and all active product packages.

Git can preserve both histories without resolving those products into each other. The exact OMP tree contains 5,501 leaf entries, no symlinks or submodules, and materializes without collision under `vendor/oh-my-pi`.

## Decision

Create one OMK-first-parent merge whose second parent is the exact OMP commit. Use Git's `ours` merge strategy to preserve every active OMK root path, then materialize the exact OMP tree under `vendor/oh-my-pi` before committing.

The resulting source-import unit must satisfy:

1. parent 1 is the recorded OMK commit;
2. parent 2 is the recorded OMP commit;
3. `vendor/oh-my-pi` resolves to the exact OMP tree;
4. OMP tags, root workspaces, dependencies, lockfiles, release workflows, and package identities do not enter OMK's active product surface;
5. the OMP license and nested notices remain intact; and
6. no OMK runtime or published package consumes the imported source.

Add exact `vendor/oh-my-pi` exclusions to the root Biome scan and the repository-wide dependency-pin and TypeScript-relative-import scanners. Guard the two custom scanner exclusions with tests that prove similarly named nested paths remain scanned. Do not add a blanket `vendor` exclusion.

## Relationship to ADR-OMP-002

This decision supersedes only ADR-OMP-002's prohibition on OMP ancestry and inert vendor-source presence for the exact commit and prefix above. It does not reopen or approve product activation.

ADR-OMP-002 continues to control any runtime use, bridge, extraction, compatibility layer, or tool integration. The `read`, `search`, and `hashline-apply` seams remain unqualified at this OMP revision. Imported source presence must not be described as feature integration or runtime migration.

## Consequences

- OMK gains exact, inspectable OMP source and ancestry while retaining all active OMK behavior.
- Source checkouts gain 5,501 paths and about 95.7 MB of per-path blob content. Existing npm package allowlists exclude the root vendor tree.
- The source import needs three narrow scan-boundary exclusions: Biome, dependency pinning, and TypeScript relative imports. It changes no root manifest, lockfile, workspace, TypeScript config, package source, or release workflow.
- Product activation requires a later ADR tied to a qualifying OMP revision and fresh Node, closure, contract, package, rollback, and release evidence.
- A normal revert can remove the imported tree and scanner/document delta, but shared Git history retains the OMP ancestry edge.

## Verification

Before commit, verify the merge state and staged tree:

```bash
test "$(git rev-parse HEAD)" = 1158d6d25230ad68946210aabe548fdf94896594
test "$(git rev-parse MERGE_HEAD)" = 39c95e5e29b1c8b082059f57421ce445c3dffdd4
test "$(git write-tree | xargs -I{} git rev-parse '{}:vendor/oh-my-pi')" = 256c587a69cd7ae7dc2a9063689db690b4ed741d
test "$(git ls-files 'vendor/oh-my-pi/**' | wc -l)" = 5501
test -z "$(git ls-files -u)"
```

Then run the scanner-exclusion tests, both custom scanners, the root Biome check, OMK release/shrinkwrap checks, type checking, and `npm run check` in the isolated worktree. Inspect all four publishable package dry-run listings and require zero `vendor/oh-my-pi` or `@oh-my-pi/` paths.

## Rollback

Before commit, abort the merge or delete the isolated worktree and branch. After a shared merge, use a first-parent merge revert, verify that the prefix and scanner exclusions disappear, and rerun the OMK baseline checks. Never force-push shared history to remove ancestry.
