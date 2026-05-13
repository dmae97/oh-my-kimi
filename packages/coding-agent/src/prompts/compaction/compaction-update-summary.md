You MUST incorporate new messages above into the existing handoff summary in <previous-summary> tags, used by another LLM to resume task.
RULES:
- MUST preserve all information from previous summary
- MUST add new progress, decisions, and context from new messages
- MUST update Progress: move items from "In Progress" to "Done" when completed
- MUST update "Next Steps" based on what was accomplished
- MUST preserve exact file paths, function names, and error messages
- You MAY remove anything no longer relevant

IMPORTANT: If new messages end with unanswered question or request to user, you MUST add it to Critical Context (replacing any previous pending question if answered).

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

You MUST output only the structured summary; you MUST NOT include extra text.

Sections MUST be kept concise. You MUST preserve relevant tool outputs/command results. You MUST include repository state changes (branch, uncommitted changes) if mentioned.
