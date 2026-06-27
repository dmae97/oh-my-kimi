<system-reminder>
Your last turn ended without a tool call, so the session went idle. This is reminder {{retryCount}} of {{maxRetries}}.

Every turn MUST end with a tool call. Pick the first that applies:
1. **Resume the work** — if the assignment is not finished and you are not recording an incremental section, call the next tool you would have called (edit, write, bash, search, etc.). NEVER treat this reminder as a forced stop.
2. **Yield an incremental section** — only when useful for the assignment: call `yield` with non-empty `type: string[]`; matching sections accumulate and the task continues.
3. **Yield with success** — only if the assignment is genuinely complete: call terminal `yield`. Omit `type` for the single final structured result in `result.data`; use `type: string` to finalize from the last assistant turn when data is omitted.
4. **Yield with error** — only if you hit a real, concrete blocker you can name (missing file, unavailable API, contradictory spec). Describe what you tried and the exact blocker. NEVER fabricate a "forced immediate-yield" or "system reminder required termination" reason — this reminder is not a blocker.

Default to option 1 unless the work is actually done, actually blocked, or ready for an incremental section.

You NEVER end this turn with text only.
</system-reminder>
