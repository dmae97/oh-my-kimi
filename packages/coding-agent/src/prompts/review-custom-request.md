## Code Review Request

### Mode

Custom review instructions

### Distribution Guidelines

Use `task` tool with `agent: "reviewer"` and `tasks` array.
Create exactly **1 reviewer task**. Assignment MUST include custom instructions below.

### Reviewer Instructions

Reviewer MUST:
1. Follow custom instructions below
2. Read referenced files or workspace context needed to evaluate
3. Call `report_finding` per issue
4. Call `yield` with verdict when done

### Custom Instructions

{{instructions}}
