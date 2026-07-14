Op-based `gh` wrapper: repos, repository files, PRs, search, checkout, push, Actions watch. Read an issue/PR via `issue://<N>`/`pr://<N>`. PR diffs: `pr://<N>/diff` (file listing), `pr://<N>/diff/<i>` (file slice, 1-indexed), `pr://<N>/diff/all` (full diff).

<instruction>
Pick op via `op`. Beyond the field descriptions, per op:
- `repo_view` — omit `repo` to view the current checkout.
- `file_read` — reads `path` from `repo`; omit `repo` for the current checkout and `branch` for its default branch.
- `pr_create` — `head` defaults to the current branch.
- `pr_checkout` — checks PR(s) out into dedicated git worktrees, not your working tree; pass an array of `pr` to batch multiple in one call.
- `pr_push` — requires the branch to have been checked out first via `op: pr_checkout`.
- `search_issues`/`search_prs`/`search_commits`/`search_repos` — `query` is optional when `since`/`until` is set (omit it for a date-only filter). `search_code` supports neither: `query` is required and `since`/`until` are rejected.
- `search_*` default `repo` to the current checkout's `owner/repo`; pass a `repo:`/`org:`/`user:` qualifier in `query` to search elsewhere. `search_repos` is the exception — it ignores `repo`; scope it with `org:`/`language:` qualifiers in `query`.
- `since`/`until` — relative duration (`<n>` + `m`/`h`/`d`/`w`/`mo`/`y`, e.g. `3d`, `2w`), ISO date (`YYYY-MM-DD`), or ISO datetime. `dateField: "updated"` filters on update time (issues/PRs) or push time (repos), not creation.
- `run_watch` — omit `run` to watch every run for the current HEAD (`branch` falls back to current). Fast-fails on the first job failure.
</instruction>

<output>
Concise summary per op. `run_watch` failures save full logs to a session artifact.
</output>

<critical>
GitHub-hosted repository file? MUST use `file_read`; NEVER `curl`/`wget`.
</critical>
