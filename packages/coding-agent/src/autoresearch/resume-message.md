Continue autoresearch loop now.

- Re-read notes and recent-runs context before deciding next direction.
- Inspect recent git history for context.
{{#if has_pending_run}}
- Previous benchmark run completed but never logged. Need finish `log_experiment` before starting new run.
{{/if}}
- Continue from most promising unfinished direction.
- Keep iterating until interrupted or until configured iteration cap reached.
- MUST preserve correctness; NEVER game benchmark.
