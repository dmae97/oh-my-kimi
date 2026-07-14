# New issue: {{repo.full_name}}#{{issue.number}}

**Title:** {{issue.title}}
**Author:** @{{issue.author}}
**Labels (current):** {{issue.labels}}
**Default branch:** `{{repo.default_branch}}`
**Working branch (already checked out at cwd):** `{{workspace.branch}}`

---

{{issue.body}}

---

Worktree is at cwd; the branch above is checked out and ready for commits **if**
the classification calls for code. Drive the todo list to completion:

1. **Triage first.** Read the body and any comments via `read` /
   `fetch_issue_thread`. Run `gh_search_issues` for duplicates and
   already-merged fixes — the reporter may be on an older release than your
   worktree. Then call
   `classify_issue(primary=..., priority=..., functional=[...], rationale=...)`.
   Apply the **merit gate** from the system prompt before picking `bug`:
   broken contract, demonstrated impact, deliberate-tradeoff check, upstream
   vs this-repo cause, and premise verification must ALL pass.
   You NEVER post a comment, push, or open a PR before this step.

2. **Follow the workflow branch** the classification dictates — see the system
   prompt for the full per-type behavior:
   - `bug` / `documentation` → ack comment → reproduce → fix → PR.
   - `question` → one comment, then stop.
   - `enhancement` / `proposal` → one thoughtful comment, then stop.
   - `wontfix` → one comment explaining the design rationale, then stop.
   - `invalid` / `duplicate` → one brief comment, then stop.

3. If `bug` and you cannot reproduce after a real attempt, call
   `mark_unable_to_reproduce` with the exact reporter details needed. You NEVER guess at fixes.
