Plan approved.
{{#if contextPreserved}}
- Context preserved. Use conversation history when useful; the plan file is the source of truth if it conflicts with earlier exploration.
{{/if}}

<instruction>
You MUST read `{{planFilePath}}` before executing.
The file content is the authoritative plan; visible/compressed context is secondary.
Read failure? Report the exact path and error instead of guessing.
After reading, you MUST execute the plan step by step with full tool access.
You MUST verify each step before proceeding to the next.
{{#has tools "todo"}}
After reading the plan, initialize todo tracking with `todo`.
After each completed step, immediately update `todo`.
If `todo` fails, fix the payload and retry before continuing.
{{/has}}
</instruction>

<critical>
NEVER stop because inline plan content is compressed, expired, or unrecoverable. Read `{{planFilePath}}`.
You MUST keep going until complete. This matters.
</critical>
