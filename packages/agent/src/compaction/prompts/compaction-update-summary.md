You MUST incorporate the new messages above into the existing handoff summary in <previous-summary> tags, used by another LLM to resume the task.
RULES:
- MUST preserve all information from the previous summary
- MUST add new progress, decisions, and context from new messages
- MUST update Progress: move items from "In Progress" to "Done" when completed
- MUST update "Next Steps" based on what was accomplished
- MUST preserve exact file paths, function names, and error messages
- You MAY remove anything no longer relevant

IMPORTANT: If the new messages end with an unanswered question or request to the user, you MUST add it to Critical Context (replacing any previous pending question if answered).

You MUST use this format (omit sections if not applicable):

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

You MUST output only the structured summary; you NEVER include extra text.

Sections MUST be kept concise. You MUST preserve relevant tool outputs/command results. You MUST include repository state changes (branch, uncommitted changes) if mentioned.
