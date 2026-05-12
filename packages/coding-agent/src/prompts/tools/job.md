Manages background jobs: poll to wait for completion, cancel to stop running jobs.

Background job results are delivered automatically when possible. Read the `jobs://` URI, or `jobs://<id>` for detail, only for inspection when useful — not for waiting.

If you are genuinely blocked on a background job result, pass `poll` to wait for one or more jobs to finalize. If the timeout elapses before any job changes state, it returns the current snapshot (still-running jobs and any already-completed deliveries) without erroring. Calling with no `poll` and no `cancel` waits on every running background job.

You **MUST NOT** wait by repeatedly reading the `jobs://` URI or `jobs://<id>` URI. If a job is stalled, has hung, or is producing nothing useful, cancel it via `cancel` and try a different approach instead of waiting indefinitely.

Pass `cancel` to stop one or more running background jobs (started via async tool execution or bash auto-backgrounding). You **SHOULD** cancel jobs that are no longer needed or stuck. You **MAY** inspect the `jobs://` URI, or `jobs://<job-id>`, first.

`poll` and `cancel` may be combined in a single call: cancellations apply first, then polling waits on the remaining ids. When only `cancel` is provided the call returns immediately without waiting.
