Signals plan completion, requests user approval, and provides the final plan title for handoff.

<conditions>
Use when:
- Plan written to `local://PLAN.md`
- No unresolved questions about requirements or approach
- Ready for user review and approval
</conditions>

<instruction>
- You **MUST** write plan to plan file BEFORE calling this tool
- Tool reads plan from file—does not take plan content as parameter
- You **MUST** provide a `title` argument for the final plan artifact (example: `WP_MIGRATION_PLAN`)
- `.md` is optional in `title`; it is appended automatically when omitted
- User sees plan contents when reviewing
</instruction>

<output>
Presents plan to user for approval. If approved, plan mode exits with full tool access restored and the plan is renamed to `local://<title>.md`.
</output>

<examples>
# Ready
Plan complete at local://PLAN.md, no open questions.
→ Call `exit_plan_mode` with `{ "title": "WP_MIGRATION_PLAN" }`
# Unclear
Unsure about auth method (OAuth vs JWT).
→ Use `ask` first to clarify, then call `exit_plan_mode`
</examples>

<avoid>
- **MUST NOT** call before plan is written to file
- **MUST NOT** omit `title`
- **MUST NOT** use `ask` to request plan approval (this tool does that)
- **MUST NOT** call after pure research tasks (no implementation planned)
</avoid>

<critical>
You **MUST** only use when planning implementation steps. Research tasks (searching, reading, understanding) do not need this tool.
</critical>
