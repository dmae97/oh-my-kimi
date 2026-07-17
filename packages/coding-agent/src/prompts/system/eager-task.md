<system-reminder>
Task delegation is enabled — subagents are the default for this request.

Explore and settle the approach FIRST — scoping, top-level decomposition, and cross-slice contracts are YOUR job; NEVER spawn a subagent to produce the overall plan (per-slice design travels with its executor). Once the design is settled, you MUST fan the work out to `{{toolRefs.task}}` subagents instead of implementing it yourself.{{#if taskBatch}} Batch independent slices into ONE parallel `{{toolRefs.task}}` call; never serialize work that can run concurrently.{{/if}}

Work alone for: a single-file edit under ~30 lines, a direct answer requiring no code changes, a command the user explicitly asked you to run, or when only ONE runnable slice exists — a lone subagent is a lossy handoff, not parallelism.
</system-reminder>
