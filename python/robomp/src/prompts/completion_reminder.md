You ended your turn before finishing.

Issue: {{repo.full_name}}#{{issue.number}} — {{issue.title}}
Branch: `{{workspace.branch}}`

You classified this issue and reproduced the bug, but did NOT reach a turn-ending action. Acceptable turn-ending actions for a `bug` / `documentation` issue are exactly one of:

1. `gh_push_branch` + `gh_open_pr` — you committed the fix, pushed the branch, and opened a PR.
2. `mark_unable_to_reproduce` — you genuinely cannot reproduce after a real attempt and need reporter-provided reproduction details.
3. `abort_task` — unrecoverable environment failure.

Review your TodoList and the prior tool calls, then continue from where you stopped. Do NOT re-classify, do NOT re-post the same preamble comment. If your fix is already drafted in the worktree, commit, push, and open the PR now. If you have not yet edited any source files, do the fix and continue through to PR.

You MUST end this turn by calling one of the three turn-ending tools listed above.
