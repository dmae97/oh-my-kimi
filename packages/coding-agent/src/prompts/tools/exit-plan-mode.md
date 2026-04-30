Submits a finalized implementation plan for user approval.

Write the plan to `local://PLAN.md` first, then call this with `title` (e.g. `WP_MIGRATION_PLAN`); on approval the file is renamed to `local://<title>.md` and full tool access is restored.
- Use only after planning implementation steps; not for pure research.
- **MUST NOT** call before the plan file exists.
- **MUST NOT** use `ask` to request plan approval — this tool does that.
