Sends short text messages to other agents in this process and receives theirs.

<instruction>
- Main agent is `Main`; subagents reuse their task id (`AuthLoader`, or `AuthLoader-2` when the name repeats).
- `op: "list"` — peers with status (`running` | `idle` | `parked`), unread count, parent, last activity. Use when unsure who exists.
- `op: "send"` — fire-and-forget `message` to `to` (peer id, or `"all"` to broadcast to live peers). Returns per-recipient receipts immediately; NEVER waits for the recipient to act. Outcomes: `injected` (mid-turn; folded in at next step boundary), `woken` (idle peer started a turn), `revived` (parked peer brought back and woken), `failed`.
- Messaging an `idle`/`parked` peer is how you wake it — there is no separate revive call.
- `send` + `await: true` — round-trip: send, then block until that peer's next message (or timeout). Invalid with `to: "all"`.
- `op: "wait"` — block until a message arrives (optionally only `from` one peer); consumes and returns it. Timeout = clean "no message", not an error.
- `op: "inbox"` — drain pending messages without blocking (`peek: true` leaves them unread).
- `replyTo` — id of the message you are answering, so the sender can correlate.
- Replies arrive only when the recipient sends one. Exception: `await: true` to a peer stuck mid-turn (async execution disabled, e.g. blocked in a synchronous task spawn) gets a side-channel auto-reply from its context. For background on a peer, `read` `history://<id>` instead of interrogating it.
</instruction>

<when_to_use>
Reach for `irc` proactively when continuing alone is wasteful or wrong; when in doubt, message.
- **Unexpected state** — missing file, config contradicting the assignment, API/tool behaving differently than told. DM `Main` (or your spawner) instead of guessing.
- **Blocked by another agent** — a peer holds the file/branch/resource or decision you need, or started the change you're about to make. DM them (or broadcast to discover who) before duplicating work.
- **Decision outside your scope** — a genuine fork the assignment didn't pre-decide. Ask the requester rather than picking unilaterally.
- **Coordination** — a peer's in-flight work would benefit from yours, or vice-versa.

NEVER for: routine progress updates, things a tool call can verify, questions your assignment/repo/docs already answer.
</when_to_use>

<etiquette>
Applies to sending and replying.
- **Plain prose only.** NEVER JSON status payloads like `{"type":"task_completed",…}` — write a normal sentence.
- **NEVER quote the message you answer.** Lead with the answer; set `replyTo`.
- **Learn about peers via IRC** — NEVER grep artifacts, read other sessions' JSONL, or shell-poke. DM them, or `read` `history://<id>`.
- **Send, then keep working.** `wait`/`await: true` only when you genuinely cannot proceed. NEVER "did you get my message?". A `failed` receipt = peer unreachable — move on; NEVER retry in a loop.
- **Answer expected questions** via `irc send` to the sender (finishing your current step first is fine).
- **Stay terse.** One question per send; share files via `local://`/`memory://`/`artifact://` URLs, never pasted blobs.
- **Address peers by exact id** from `op: "list"` (e.g. `AuthLoader`, `Main`). NEVER invent friendly names.
- **NEVER IRC what a tool answers.** A `read`, grep, or build resolves it? Do that first.
</etiquette>

<output>
- `send`: per-recipient receipts; with `await: true`, also the reply (or timeout notice).
- `wait`: the consumed message, or a clean timeout notice.
- `inbox`: pending messages, oldest first.
- `list`: peers with status, unread count, parent, last activity.
</output>

<examples>
# List peers
`{"op": "list"}`
# Fire-and-forget DM — same send wakes idle/parked peers
`{"op": "send", "to": "AuthLoader", "message": "Still touching src/server/auth.ts? I need to add a 401 path."}`
# Round-trip when you cannot proceed without the answer
`{"op": "send", "to": "Main", "message": "JWT or session cookies for the auth flow?", "await": true}`
# Block until a specific peer answers
`{"op": "wait", "from": "AuthLoader", "timeoutMs": 60000}`
# Drain pending messages
`{"op": "inbox"}`
# Broadcast to live peers (no replies expected)
`{"op": "send", "to": "all", "message": "About to refactor src/server/middleware/*. Anyone already in there?"}`
</examples>
