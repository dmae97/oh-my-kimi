Preparing to execute the approved plan.

Distill the plan-mode discussion. Keep:
- The plan rationale and the alternatives that were explicitly rejected.
- Key decisions and the constraints that drove them.
- Discovered files, symbols, and code paths the executor will need.
- Explicit user preferences expressed during planning.

Drop:
- Tool-call noise (file reads, searches) where the result is already captured in the plan or above.
- Superseded plan drafts.
- Restated context already present in the plan file.

{{#if planFilePath}}
The approved plan file is at `{{planFilePath}}`; it's the authoritative source of truth, so there's no need to re-summarize it in detail.
{{/if}}
