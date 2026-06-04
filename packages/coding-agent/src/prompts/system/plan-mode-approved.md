Plan approved.
{{#if contextPreserved}}
- Context preserved. Use conversation history when useful; this plan source of truth if conflicts with earlier exploration.
{{/if}}

<instruction>
MUST execute this plan step by step. Full tool access.
MUST verify each step before proceeding to next.
{{#has tools "todo"}}
Before execution, initialize todo tracking with `todo`.
After each completed step, immediately update `todo`.
If `todo` fails, fix payload and retry before continuing.
{{/has}}
Plan path for subagent handoff only. You already have plan; NEVER read it.
</instruction>

Full plan injected below. MUST execute now:

<plan path="{{finalPlanFilePath}}">
{{planContent}}
</plan>

<critical>
MUST keep going until complete. Matters.
</critical>
