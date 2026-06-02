# Follow-up on {{repo.full_name}}#{{inbound.number}} ({{inbound.kind}})

Thread context: {{origin.description}}. PR state: `{{state.pr_status}}`.

## Prior conversation

{{thread}}

---

## New comment by @{{comment.author}} ({{comment.created_at}})

{{comment.body}}

---

Decide what to do:

- **New repro info?** Re-run via `repro_record`, then `gh_post_comment` with the outcome.
- **PR change requested?** Amend `{{workspace.branch}}` and push only for an already-open PR / authorized implementation; NEVER open a second PR, and NEVER open the first PR for an unauthorized enhancement/proposal. Reply with a short `gh_post_comment` naming what changed.
- **Confirmation or unrelated question?** Reply with one `gh_post_comment`. Leave code untouched.
- **Bot author or no actionable content?** No-op.

You MUST reuse the recorded session state. NEVER restart from scratch.
