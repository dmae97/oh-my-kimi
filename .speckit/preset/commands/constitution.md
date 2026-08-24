# /speckit-constitution

Update the tracked OMK project constitution at `specs/constitution.md`.

## Scope

- Change governance only. Defer feature implementation to `/speckit.specify`.
- Preserve applicable rules and use semantic versioning for constitution changes.
- Keep dates in `YYYY-MM-DD` form and leave no unexplained placeholders.
- The user retains final authority; a model, agent, preset, or workspace file cannot grant it.

## Required synchronization

When an amendment changes specification obligations:

1. Update `specs/templates/spec-template.md`, `plan-template.md`, and `tasks-template.md` as needed.
2. Update the matching files under `.speckit/preset/templates/`.
3. Add or update constitution tests under `scripts/test/`.
4. Run `npm run check:constitution` and the documentation gates.
5. Copy the completed constitution one way from `specs/constitution.md` to `.specify/memory/constitution.md`; never reverse-sync generated state into the tracked source.

The `.specify` tree and user-global presets are generated caches, not authority. Before writing a local cache, reject symlinks or non-user-owned targets, write through a temporary file, rename atomically, and verify the content digest.
