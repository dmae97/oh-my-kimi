End active checkpoint. Rewind context to it, replacing intermediate exploration with report.

Call immediately after `checkpoint`-started investigative work.

Requirements:
- `report` is REQUIRED and MUST be concise, factual, and actionable.
- Include key findings, decisions, unresolved risks.
- Drop raw scratch logs unless essential.
- MUST call this before yielding if checkpoint active.

Behavior:
- No checkpoint active → error.
- On success session rewinds; report kept as retained context.
