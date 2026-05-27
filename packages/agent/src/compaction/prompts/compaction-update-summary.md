Please fold the new messages above into the existing handoff summary in the <previous-summary> tags. Another LLM will read the result to resume the task, so the merged summary needs to stand on its own.

Guidelines:
- Carry every piece of information from the previous summary forward.
- Add the new progress, decisions, and context from the new messages.
- Update Progress: move items from "In Progress" to "Done" once they're finished.
- Refresh "Next Steps" to reflect what was just accomplished.
- Keep file paths, function names, and error messages exactly as written.
- Feel free to drop anything that's no longer relevant.

If the new messages end with an unanswered question or a request to the user, add it to Critical Context (replacing any earlier pending question that has since been answered).

Use this format (skip sections that don't apply):

## Goal
[Preserve existing goals; add new ones if task expanded]

## Constraints & Preferences
- [Preserve existing; add new ones discovered]

## Progress

### Done
- [x] [Include previously done and newly completed items]

### In Progress
- [ ] [Current work—update based on progress]

### Blocked
- [Current blockers—remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context; add new if needed]

## Additional Notes
[Other important info not fitting above]

Output only the structured summary — no preamble, no commentary around it.

Keep sections concise. Preserve relevant tool outputs and command results. If repository state changes (branch, uncommitted changes) were mentioned, include them.
