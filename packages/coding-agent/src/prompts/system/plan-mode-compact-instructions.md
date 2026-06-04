We'll execute approved plan.

MUST distill plan-mode discussion. Preserve:
- Plan rationale and alternatives explicitly rejected.
- Key decisions; constraints that drove them.
- Discovered files, symbols, code paths executor will need.
- Explicit user preferences expressed during planning.

MUST drop:
- Tool-call noise (file reads, searches) where result already captured in plan or above.
- Superseded plan drafts.
- Restated context already present in plan file.

{{#if planFilePath}}
Approved plan file at `{{planFilePath}}`; authoritative source, need not re-summarize in detail.
{{/if}}
