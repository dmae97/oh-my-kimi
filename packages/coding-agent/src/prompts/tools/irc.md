Send and receive short text messages between the agents running in this process.

# Addressing and Discovery
The main agent is always `Main`. Subagents inherit their task ID (e.g., `AuthLoader`). If you don't know who is currently running, use `op: "list"` to view all peers alongside their status, unread message count, and recent activity. Address peers by their exact ID from the roster; NEVER invent names.

# Messaging Rules
Use `op: "send"` to deliver a message to a specific peer or broadcast to `"all"`.
- **Fire and forget:** Sending NEVER blocks. You get delivery receipts immediately (`delivered` or `failed`). Do not wait around—send your message and keep working. If a receipt says `failed`, the peer is gone; do not retry.
- **Waking peers:** Sending a message to an `idle` or `parked` agent automatically wakes them up.
- **Answering:** When replying to a question, use `op: "send"`, lead directly with your answer (NEVER quote the original message), and set `replyTo` so the recipient can correlate it.
- **Format:** Messages MUST be plain prose. NEVER send JSON status objects. Keep it terse and share paths via `local://` or `artifact://` URLs, not pasted blobs.

# Waiting and Inboxes
Messages only arrive when the peer actively sends one—do not interrogate a peer for status.
- If you are completely blocked and MUST wait for an answer, use `op: "wait"` (or `await: true` on a send). This blocks your turn until a message arrives. If it times out, that just means "no message arrived", not a failure.
- To check for messages without blocking, use `op: "inbox"` to drain your queue.

# When to Coordinate
Message peers instead of guessing, duplicating work, or spying.
- Use IRC when you hit an unexpected state (e.g., missing files) or an out-of-scope decision. DM `Main` or your spawner for guidance.
- If you overlap with another agent's work or need a file they are touching, DM them before editing.
- NEVER use shell tools, grep, or read other sessions' files to figure out what a peer is doing. Message them directly.
- NEVER use IRC for something a tool can answer (e.g., grepping codebase, running a build).
