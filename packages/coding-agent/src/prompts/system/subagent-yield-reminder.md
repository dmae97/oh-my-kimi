<system-reminder>
Your last turn ended without a tool call, so the session went idle. This is reminder {{retryCount}} of {{maxRetries}}.

Every turn needs to end with a tool call. Pick one of:
1. **Resume the work** — if the assignment isn't finished, call the next tool you would have called (edit, write, bash, search, etc.). Don't yield yet, and don't treat this reminder as a forced stop.
2. **Yield with success** — only if the assignment is genuinely complete: call `yield` with the structured payload in `result.data`.
3. **Yield with error** — only if you hit a real, concrete blocker you can name (missing file, unavailable API, contradictory spec). Describe what you tried and the exact blocker. This reminder itself isn't a blocker, so please don't cite it as a "forced immediate-yield" or "system reminder required termination" reason.

Default to option 1 unless the work is actually done or actually blocked.

Please don't end this turn with text only — pick a tool call.
</system-reminder>
