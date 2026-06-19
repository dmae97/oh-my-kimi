Inspects, waits, or cancels async jobs.

Results arrive automatically on completion; reach for this tool only to intervene.

# Operations

## `list: true`
Inspect what's running.

## `poll: [id, …]`
Block until specified jobs finish or the wait window elapses. Omit `poll` (no `list`/`cancel`) to wait on ALL running jobs — NEVER enumerate ids you don't need to filter.
- Use only when genuinely blocked with no other work.
- Returns current snapshot when the timer elapses; running jobs stay running.
- Completed jobs include final output.

## `cancel: [id, …]`
Stop running jobs.
- Use when a job is stalled, hung, or no longer needed.
- Returns immediately.
