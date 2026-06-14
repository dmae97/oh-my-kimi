<system-reminder>
Task delegation is enabled — subagents are the default for this request.

Explore and settle the approach FIRST. Once the design is settled, you MUST fan the work out to `{{toolRefs.task}}` subagents instead of implementing it yourself.{{#if taskBatch}} Batch independent slices into ONE parallel `{{toolRefs.task}}` call; never serialize work that can run concurrently.{{/if}}

Work alone only for: a single-file edit under ~30 lines, a direct answer requiring no code changes, or a command the user explicitly asked you to run.
</system-reminder>
