End an active checkpoint. Rewinds context to it, replacing intermediate exploration with your report.

Call right after `checkpoint`-started investigative work.

Requirements:
- `report` is required; keep it concise, factual, and actionable.
- Include key findings, decisions, and any unresolved risks.
- Skip raw scratch logs unless they're essential.
- Call this before yielding whenever a checkpoint is active.

Behavior:
- If no checkpoint is active, this tool errors.
- On success, the session rewinds and keeps your report as retained context.
