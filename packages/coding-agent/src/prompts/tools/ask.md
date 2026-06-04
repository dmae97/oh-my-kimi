Need clarification or input during task execution; ask user.

<conditions>
- Multiple approaches exist; significantly different tradeoffs; user SHOULD weigh.
</conditions>

<instruction>
- Use `recommended: <index>` to mark default (0-indexed); " (Recommended)" added automatically.
- Use `questions` for multiple related questions instead of asking one at a time
- Set `multi: true` on question to allow multiple selections
- Use short option labels; put explanatory tradeoffs in `description` instead of merging them into the label
</instruction>

<caution>
- Need provide 2-5 concise distinct options
</caution>

<critical>
- Default to action. Resolve ambiguity yourself using repo conventions, existing patterns, reasonable defaults. Exhaust existing sources — code, configs, docs, history — before asking. Only ask when options have materially different tradeoffs user must decide.
- If multiple choices acceptable, pick most conservative/standard option and proceed; state choice.
- NEVER include "Other" option — UI automatically adds "Other (type your own)" to every question.
</critical>

<examples>
# Single question
questions: [{"id": "auth_method", "question": "Which authentication method should this API use?", "options": [{"label": "JWT", "description": "Bearer tokens for stateless API clients."}, {"label": "OAuth2", "description": "Delegated authorization with external identity providers."}, {"label": "Session cookies", "description": "Browser-first authentication backed by server-side sessions."}], "recommended": 0}]

# Multiple questions
questions: [{"id": "storage_type", "question": "Which storage backend?", "options": [{"label": "SQLite"}, {"label": "PostgreSQL"}]}, {"id": "auth_method", "question": "Which auth method?", "options": [{"label": "JWT"}, {"label": "Session cookies"}]}]
</examples>
