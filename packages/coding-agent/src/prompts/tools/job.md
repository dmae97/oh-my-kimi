Inspects, waits, or cancels async jobs.

Background job results are delivered automatically when complete. Reach for this tool only when you need to intervene.

# Operations

## `list: true`
Use to inspect what's running.

## `poll: [id, …]`
Block until the specified jobs finish or the wait window elapses. Omit `poll` (with no `list`/`cancel`) to wait on ALL running jobs — NEVER enumerate ids you don't need to filter.
- Use when you are genuinely blocked on a result and have no other work to do.
- Returns the current snapshot when the timer elapses; running jobs remain running.
- Completed jobs include their final output in the returned snapshot.
- With Max Poll Time set to `smart` (the default), the wait window adapts: it starts at ~5s and lengthens with each back-to-back poll (up to ~5m), then resets to ~5s after you go a while without polling. Spinning in a poll loop costs progressively more; do real work between polls.

## `cancel: [id, …]`
Stop running jobs.
- Use when a job is stalled, hung, or no longer needed.
- Returns immediately after cancelling.
