Waits for one or more background jobs to finalize.

You **MUST** use the `poll` tool (in a loop, if necessary) instead of manually reading in a loop, or issuing sleep commands.

If the timeout elapses before any job changes state, it returns the current snapshot (still-running jobs and any already-completed deliveries) without erroring — call `poll` again to keep waiting.

You **MUST NOT** poll the same job repeatedly without evidence of progress. Between calls, inspect `read jobs://<id>` to confirm new output or activity. If a job is stalled, has hung, or is producing nothing useful, cancel it via `cancel_job` and try a different approach instead of waiting indefinitely.
