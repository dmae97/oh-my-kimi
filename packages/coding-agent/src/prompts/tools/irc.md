Agent-to-agent messaging. Main agent is `Main`; subagents inherit task ID.
Use `op: "list"` to discover peers. Address by exact roster ID — NEVER invent names.

- **`send`**: fire-and-forget, NEVER blocks. Delivery receipts (`delivered`/`failed`) immediate; `failed` → peer gone, don't retry.
  Sending wakes `idle`/`parked` peers. Answering: lead with answer, NEVER quote, set `replyTo`.
- **Format**: plain prose ONLY. No JSON status objects. Share paths via `local://`/`artifact://` URLs, not pasted blobs.
- **`wait`** (or `await: true`): blocks until matching message, timeout, or steering interrupt. Parent IRC interrupts at steering priority.
  Waits surface cross-channel interrupts — don't alternate `wait`/`inbox`/`job poll`.
- **`inbox`**: drain queue without blocking.
- NEVER use shell tools, grep, or read other sessions' files to figure out what a peer is doing. Message them directly.
- NEVER use IRC for something a tool can answer (e.g., grepping codebase, running a build).
