Sends short text messages to other agents in this process and receives theirs.

<instruction>
- The main agent is addressable as `Main`. Subagents reuse their task id (e.g. `AuthLoader`, or `AuthLoader-2` when the name repeats).
- `op: "list"` — every addressable peer with status (`running` | `idle` | `parked`), unread count, parent, and last activity. Use it before sending if you are not sure who exists.
- `op: "send"` — fire-and-forget delivery of `message` to `to` (a peer id, or `"all"` to broadcast to live peers). Returns per-recipient receipts immediately; it NEVER waits for the recipient to act. Receipt outcomes: `injected` (recipient was mid-turn; message folded in at their next step boundary), `woken` (idle recipient started a turn), `revived` (parked recipient was brought back and woken), `failed`.
- Messaging an `idle` or `parked` peer is how you wake it — there is no separate revive call.
- `send` with `await: true` — convenience round-trip: send, then block until the next message from that peer arrives (or the timeout passes). Invalid with `to: "all"`.
- `op: "wait"` — block until a message arrives (optionally only `from` a specific peer); consumes and returns it. A timeout is a clean "no message" result, not an error.
- `op: "inbox"` — drain pending messages without blocking (`peek: true` to leave them unread).
- `replyTo` — set it to the id of the message you are answering so the sender can correlate.
- Nobody answers on a peer's behalf anymore: a reply only arrives when the recipient actually sends one. For background on what a peer has been doing, `read` `history://<id>` instead of interrogating them.
</instruction>

<when_to_use>
You SHOULD reach for `irc` proactively when continuing alone is wasteful or wrong. When in doubt, prefer messaging.
- **Unexpected state.** The task did not describe what you found — missing file, config contradicting the assignment, API or tool behaving differently than told. DM `Main` (or the spawning agent) instead of guessing.
- **Blocked by another agent.** A peer holds the file/branch/resource you need, started the change you are about to make, or owns a decision you depend on. DM that peer (or broadcast to discover who) before duplicating work.
- **Decision points outside your scope.** A genuine fork the assignment did not pre-decide (e.g. which of two viable APIs, whether to refactor adjacent code). Ask the requester rather than picking unilaterally.
- **Coordination opportunities.** A peer's in-flight work would benefit from yours, or vice-versa.

NEVER use `irc` for: routine progress updates, things a tool call can verify, or questions already answered by your assignment / repo / docs.
</when_to_use>

<etiquette>
These rules apply to both sending and replying.
- **Plain prose only.** NEVER send structured JSON status payloads (e.g. `{"type":"task_completed",…}`). Write a normal sentence: "Done with the auth refactor — left a TODO in `src/server/auth.ts` for the rate limiter."
- **NEVER quote the message you are replying to.** Lead with the answer; set `replyTo` instead.
- **Use IRC, not terminal tools, to learn about peers.** NEVER `grep` artifacts, read other sessions' JSONL files, or shell-poke to figure out what another agent is doing. DM them, or `read` `history://<id>`.
- **Send, then keep working.** `send` returns immediately — only `wait` (or `await: true`) when you genuinely cannot proceed without the answer. NEVER follow up with "did you get my message?"; a `failed` receipt means the peer is unreachable — move on or report the blocker; NEVER retry in a loop.
- **Answer when a response is expected.** When an incoming message asks something, reply with `irc send` to the sender (you may finish your current step first).
- **Stay terse.** A DM is a chat message, not a memo. One question per send. Share file paths and artifacts via `local://` / `memory://` / `artifact://` URLs instead of pasting blobs.
- **Address peers by id.** Use the exact id from `op: "list"` (e.g. `AuthLoader`, `Main`). NEVER invent friendly names.
- **NEVER IRC for things a tool would answer.** If a `read`, `grep`, or build command resolves the question, do that first.
</etiquette>

<output>
- `send`: per-recipient delivery receipts (`injected` / `woken` / `revived` / `failed`); with `await: true`, also the reply (or a timeout notice).
- `wait`: the consumed message, or a clean timeout notice.
- `inbox`: pending messages, oldest first.
- `list`: peers with status, unread count, parent, and last activity.
</output>

<examples>
# List peers
`{"op": "list"}`
# Fire-and-forget DM — keep working, check inbox later
`{"op": "send", "to": "AuthLoader", "message": "Are you still touching src/server/auth.ts? I need to add a 401 path."}`
# Round-trip when you cannot proceed without the answer
`{"op": "send", "to": "Main", "message": "Should I prefer JWT or session cookies for the auth flow?", "await": true}`
# Wake a parked agent (same send — the bus revives it)
`{"op": "send", "to": "SchemaMigrator", "message": "The users table changed again; please re-check your migration."}`
# Block until a specific peer answers
`{"op": "wait", "from": "AuthLoader", "timeoutMs": 60000}`
# Drain pending messages
`{"op": "inbox"}`
# Broadcast to live peers (no replies expected)
`{"op": "send", "to": "all", "message": "About to refactor src/server/middleware/*. Anyone already in there?"}`
</examples>
