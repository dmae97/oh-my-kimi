Resume autoresearch on active session.

{{branch_status_line}}
{{#if has_resume_context}}

Additional context from user:

{{resume_context}}
{{/if}}

- Use active session context above as source of truth for goal, scope, constraints, run history.
- Check recent git history for context.
- Continue most promising unfinished direction.
- Keep iterating until interrupted or until iteration cap reached.
