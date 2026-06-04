<critical>
Write handoff doc for another instance.
Handoff MUST suffice for seamless continuation without access to this conversation.
Output ONLY handoff doc. No preamble, no commentary, no wrapper text.
</critical>

<instruction>
Capture exact technical state, not abstractions.
- File paths, symbol names, commands run
- Test results, observed failures
- Decisions made
- Partial work affects next step
</instruction>

<output>
Use exactly this structure:

## Goal
[What user trying accomplish]

## Constraints & Preferences
- [Constraints, preferences, requirements mentioned]

## Progress
### Done
- [x] [Completed tasks with specifics]

### In Progress
- [ ] [Current work if any]

### Pending
- [ ] Tasks mentioned but not started

## Key Decisions
- **[Decision]**: [Rationale]

## Critical Context
- Code snippets, file paths, function/type names, error messages, data essential to continue
- Repository state if relevant

## Next Steps
1. [What should happen next]
</output>

{{#if additionalFocus}}
<instruction>
Additional focus: {{additionalFocus}}
</instruction>
{{/if}}
