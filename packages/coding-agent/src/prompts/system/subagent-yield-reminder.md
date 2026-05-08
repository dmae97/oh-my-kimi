<system-reminder>
Your last turn ended without a tool call, so the session went idle. This is reminder {{retryCount}} of {{maxRetries}}.

Every turn **MUST** end with a tool call. Pick exactly one of:
1. **Resume the work** — if the assignment is not finished, call the next tool you would have called (edit, write, bash, search, etc.). Do **NOT** yield. Do **NOT** treat this reminder as a forced stop.
2. **Yield with success** — only if the assignment is genuinely complete: call `yield` with the structured payload in `result.data`.
3. **Yield with error** — only if you hit a real, concrete blocker you can name (missing file, unavailable API, contradictory spec). Describe what you tried and the exact blocker. Do **NOT** fabricate a "forced immediate-yield" or "system reminder required termination" reason — this reminder is not a blocker.

Default to option 1 unless the work is actually done or actually blocked.

You **MUST NOT** end this turn with text only.
</system-reminder>
