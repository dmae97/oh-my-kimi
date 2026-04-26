Manages background jobs: poll to wait for completion, cancel to stop running jobs.

You **MUST** use the `job` tool (in a loop, if necessary) instead of manually reading in a loop or issuing sleep commands.

Pass `poll` to wait for one or more background jobs to finalize. If the timeout elapses before any job changes state, it returns the current snapshot (still-running jobs and any already-completed deliveries) without erroring — call `job` again to keep waiting. Calling with no `poll` and no `cancel` waits on every running background job.

You **MUST NOT** poll the same job repeatedly without evidence of progress. Between calls, inspect `read jobs://<id>` to confirm new output or activity. If a job is stalled, has hung, or is producing nothing useful, cancel it via `cancel` and try a different approach instead of waiting indefinitely.

Pass `cancel` to stop one or more running background jobs (started via async tool execution or bash auto-backgrounding). You **SHOULD** cancel jobs that are no longer needed or stuck. You **MAY** inspect jobs first with `read jobs://` or `read jobs://<job-id>`.

`poll` and `cancel` may be combined in a single call: cancellations apply first, then polling waits on the remaining ids. When only `cancel` is provided the call returns immediately without waiting.
