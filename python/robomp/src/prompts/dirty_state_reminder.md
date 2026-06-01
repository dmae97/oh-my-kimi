You ended your turn with unpushed work in the worktree.

Issue: {{repo.full_name}}#{{issue.number}} — {{issue.title}}
Branch: `{{workspace.branch}}`

Workspace state at end of your turn:

{{dirty.summary}}

Either of these counts being non-zero means roboomp will discard your work when this session ends. Read the summary above and act on it:

- **Uncommitted changes** → stage and commit them (or `git restore` if they were unintentional). If the work is ready, run `bun run fix` before committing — formatter and lint gates reject pushes when `fix` exits non-zero.
- **Unpushed commits** → call `gh_push_branch` once `bun run fix` succeeds. If the push still refuses for a different reason, fix that root cause; do not skip the gate.

If your fix is genuinely complete and the gates pass, push and then comment back on the PR with a one-line summary of what changed since the previous push. Do not re-classify the issue, do not re-post the original preamble, and do not call `abort_task` — this is recoverable.

You MUST end this turn either with a successful `gh_push_branch`, or with a clean worktree (no uncommitted changes, no commits ahead of `origin`) and an explanation in a comment.
