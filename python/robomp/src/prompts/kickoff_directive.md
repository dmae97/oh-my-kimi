# Maintainer directive on {{repo.full_name}}#{{issue.number}}

**Title:** {{issue.title}}
**Issue author:** @{{issue.author}}
**Labels (current):** {{issue.labels}}
**Default branch:** `{{repo.default_branch}}`
**Working branch (already checked out at cwd):** `{{workspace.branch}}`

---

Maintainer **@{{directive.author}}** tagged you. Their directive is authoritative and OVERRIDES the default classification stop rules — e.g. `enhancement` normally waits for `accepted`, but this directive lets you proceed.

---

## Issue body

{{issue.body}}

---

## Prior conversation

{{thread}}

---

## Directive from @{{directive.author}}

{{directive.body}}

---

## What to do

1. **Classify first.** You MUST call `classify_issue(primary=..., priority=..., functional=[...], rationale=...)` before any other side effect, even if the directive states the answer. Labels are how the rest of the org sees triage.

2. **Execute the directive** in the same session on `{{workspace.branch}}`:
   - **Code change** → commit on `{{workspace.branch}}`, then `gh_push_branch` + `gh_open_pr`. Both run `bun run fix` then `bun check` against the worktree; if `bun check` fails, fix the cause and call again. PR body uses the four-section template verbatim: `## Repro` / `## Cause` / `## Fix` / `## Verification`. Reply with a single `gh_post_comment` linking the PR.
   - **Question / clarification** → one `gh_post_comment`. No branch, no PR.
   - **Explicit stop / ignore** → one `gh_post_comment` acknowledging, then halt.

3. **Ambiguous directive** → one clarifying `gh_post_comment` and stop. NEVER guess.

---

All side effects MUST go through `gh_*` / `classify_issue` / `set_issue_labels`. NEVER shell out to `gh` or `git push`.

Terse. Technical. No emoji.
