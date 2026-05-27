## Code Review Request

### Mode

Custom review instructions

### Distribution Guidelines

Use the `task` tool with `agent: "reviewer"` and a `tasks` array.
Create exactly **1 reviewer task**. Its assignment must include the custom instructions below.

### Reviewer Instructions

Reviewer MUST:
1. Follow the custom instructions below
2. Read the referenced files or workspace context needed to evaluate them
3. Call `report_finding` per issue
4. Call `yield` with verdict when done

### Custom Instructions

{{instructions}}
