Plan approved.
{{#if contextPreserved}}
- Context preserved. Use conversation history when useful; this plan is the source of truth if it conflicts with earlier exploration.
{{/if}}

<instruction>
You MUST execute this plan step by step. You have full tool access.
You MUST verify each step before proceeding to the next.
{{#has tools "todo"}}
Before execution, initialize todo tracking with `todo`.
After each completed step, immediately update `todo`.
If `todo` fails, fix the payload and retry before continuing.
{{/has}}
The plan path is for subagent handoff only. You already have the plan; NEVER read it.
</instruction>

The full plan is injected below. You MUST execute it now:

<plan path="{{planFilePath}}">
{{planContent}}
</plan>

<critical>
You MUST keep going until complete. This matters.
</critical>
