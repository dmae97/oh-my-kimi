Sends short text to other live agents in this process; receives their prose replies.

<instruction>
- Main agent addressable as `Main`. Subagents reuse task id (e.g. `AuthLoader`, or `AuthLoader-2` when name repeats).
- `op: "list"` returns current set of visible peers. Use before sending if not sure who is live.
- `op: "send"` delivers `message` to `to`. `to` maybe specific id or `"all"` broadcast.
- Recipient generates reply via ephemeral side-channel turn; uses current model, system prompt, history. NEVER waits for recipient main loop free; safe IRC agent inside long-running tool call.
- Exchange (incoming question + auto-reply) queued for injection into recipient persisted history; recipient sees next turn, can follow up if needed.
</instruction>

<when_to_use>
SHOULD reach for `irc` proactively when continuing alone wasteful or wrong. When in doubt, prefer messaging.
- **Unexpected state.** Hit something original task did not describe — missing file, config contradicts assignment, API behaving differently than told, tool failing suggests spec wrong. DM `Main` (or spawning agent) for guidance instead of guessing.
- **Blocked by another agent.** Peer holds file/branch/resource needed, already started change about to make, or owns decision depend on. DM that peer (or broadcast to discover who) before duplicating or stepping on work.
- **Decision points outside your scope.** Genuine fork assignment didn't pre-decide (which of two viable APIs, whether refactor adjacent code). Ask requester; NEVER pick unilaterally.
- **Coordination opportunities.** Peer's in-flight work would benefit from yours, or vice-versa.

NEVER use `irc` for: routine progress updates, things you can verify with tool call, or questions whose answer already in assignment / repo / docs.
</when_to_use>

<etiquette>
Rules apply both sending and replying.
- **Plain prose only.** NEVER send structured JSON status payloads (e.g. `{"type":"task_completed",…}`). Write normal sentence: "Done with the auth refactor — left a TODO in `src/server/auth.ts` for the rate limiter."
- **NEVER quote the message you are replying to.** Sender already saw it; TUI already renders it. Lead with answer.
- **Use IRC, not terminal tools, to learn about peers.** NEVER `grep` artifacts, read other sessions' JSONL files, or shell-poke around to figure out what another agent doing. DM them — they have live answer and you do not.
- **One round-trip enough.** Replies arrive synchronously when recipient reachable. NEVER follow up with "did you get my message?" — they did. If `delivered` empty or result `failed`, peer unavailable; move on or report blocker, NEVER retry in loop.
- **Stay terse.** DM is chat message, not memo. One question per send when you can. Share file paths and artifacts via `local://` / `memory://` / `artifact://` URLs instead of pasting blobs.
- **Address peers by id.** Use exact id from `op: "list"` (e.g. `AuthLoader`, `Main`). NEVER invent friendly names.
- **NEVER IRC for things tool would answer.** If `read`, `grep`, or build command resolves question, run that first.
- **When receive IRC message, answer before continuing.** Recipient injects question + auto-reply into history; address directly, NEVER repeat back.
</etiquette>

<output>
- `send` returns each recipient that received message and any prose replies arrived.
- `list` returns peers and channels visible to caller.
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
