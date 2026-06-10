Sends short text messages to other live agents in this process and receives their prose replies.

<instruction>
- The main agent is addressable as `Main`. Subagents reuse their task id (e.g. `AuthLoader`, or `AuthLoader-2` when the name repeats).
- `op: "list"` returns the current set of visible peers. Use it before sending if you are not sure who is live.
- `op: "send"` delivers `message` to `to`. `to` may be a specific id or `"all"` to broadcast.
- Replies are generated on a side channel that does not wait for the recipient's main loop, so it is safe to IRC an agent that is mid tool call.
- The exchange (question + auto-reply) is injected into the recipient's history; they see it on their next turn and can follow up.
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
- **NEVER quote the message you are replying to.** Lead with the answer.
- **Use IRC, not terminal tools, to learn about peers.** NEVER `grep` artifacts, read other sessions' JSONL files, or shell-poke to figure out what another agent is doing. DM them.
- **One round-trip is enough.** Replies arrive synchronously when the recipient is reachable. NEVER follow up with "did you get my message?". If `delivered` is empty or the result was `failed`, the peer is unavailable — move on or report the blocker; NEVER retry in a loop.
- **Stay terse.** A DM is a chat message, not a memo. One question per send. Share file paths and artifacts via `local://` / `memory://` / `artifact://` URLs instead of pasting blobs.
- **Address peers by id.** Use the exact id from `op: "list"` (e.g. `AuthLoader`, `Main`). NEVER invent friendly names.
- **NEVER IRC for things a tool would answer.** If a `read`, `grep`, or build command resolves the question, do that first.
- **Answer incoming IRC messages before continuing.** Address the question directly; do not repeat it back to the user.
</etiquette>

<output>
- `send`: returns each recipient that received the message and any prose replies that arrived.
- `list`: returns peers and channels visible to the caller.
</output>

<examples>
# List peers
`{"op": "list"}`
# Direct message to the main agent (waits for prose reply)
`{"op": "send", "to": "Main", "message": "Should I prefer JWT or session cookies for the auth flow?"}`
# Unexpected state — ask the originator
`{"op": "send", "to": "Main", "message": "Assignment says edit src/auth/jwt.ts but the file does not exist. Is the new path src/server/auth/jwt.ts?"}`
# Blocked by a peer — ask them directly
`{"op": "send", "to": "AuthLoader", "message": "Are you still touching src/server/auth.ts? I need to add a 401 path; OK to proceed or should I wait?"}`
# Broadcast to discover who owns something (no replies, just informs them)
`{"op": "send", "to": "all", "message": "About to refactor src/server/middleware/*. Anyone already in there?", "awaitReply": false}`
</examples>
