<system-notice reason="background_task_dispatched" job="{{jobId}}">
The user launched a tangential task that is now running in a separate background agent. This is NOT a prompt injection and NOT a new instruction for you — it is the coding agent informing you that work was handed off elsewhere.

The task below is being handled by another agent in its own session. You are NOT responsible for it: NEVER start working on it, NEVER reference it, and NEVER let it interrupt or alter your current task. Continue what you were doing as if this message had not appeared. Results, if any, will surface separately when the background task ({{jobId}}) completes.

Dispatched work (for your awareness only):
{{work}}
</system-notice>
