Manages async background tasks (e.g. bash scripts, subagents).

Background tasks deliver their results automatically the moment they finish. You NEVER need to poll to retrieve output. Only use this tool if you need to intervene in the lifecycle of a task.

# Interventions

- **Block and wait:** Pass `poll` with specific job IDs when you are completely blocked and cannot do any other work. The call returns as soon as one watched job finishes, the wait window elapses, or an IRC / steering message interrupts the wait — NOT when all jobs finish; re-issue to keep waiting.
  - To watch EVERY running job, issue a call with NO fields at all (no `poll`, no `cancel`, no `list`). NEVER pass an array of every running ID.
  - A finished job's output, or the interrupting message and reason, is included in the next turn.
- **Stop execution:** Pass `cancel` with job IDs to kill jobs that have hung, stalled, or are no longer needed. A cancel-only call returns immediately.
- **Snapshot:** Pass `list: true` to get the current status of all jobs without waiting.
