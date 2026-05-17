# PR review on {{repo.full_name}}#{{pr.number}}

A review comment landed on the PR you opened.

## @{{comment.author}} on `{{comment.path}}`{{comment.line_range}}

{{comment.body}}

---

- You MUST read the diff context around the cited line range before acting.
- Address the comment, then push a follow-up commit on `{{workspace.branch}}`.
- Reply with a single `gh_post_comment` summarizing what changed — one line per concrete fix.
- Reviewer asking for clarification, not a change? Answer with `gh_post_comment` and NEVER touch the code.
