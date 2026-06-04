Inspects, waits, or cancels async jobs.

Background job results delivered automatically when complete. Reach for this tool only when Need intervene.

# Operations

## `list: true`
Use to inspect what's running.

## `poll: [id, …]`
Block until specified jobs finish or wait window elapses.
- Use when genuinely blocked on result and no other work to do.
- Returns current snapshot when timer elapses; running jobs remain running.
- Completed jobs include final output in returned snapshot.

## `cancel: [id, …]`
Stop running jobs.
- Use when job stalled, hung, or no longer needed.
- Returns immediately after cancelling.
