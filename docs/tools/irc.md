# irc

> Send and receive messages between agents over a process-global mailbox bus.

## Source
- Entry: `packages/coding-agent/src/tools/irc.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/irc.md`
- Key collaborators:
  - `packages/coding-agent/src/irc/bus.ts` — process-global `IrcBus`: per-agent mailboxes, delivery, waiter matching.
  - `packages/coding-agent/src/registry/agent-registry.ts` — process-global agent directory and status.
  - `packages/coding-agent/src/registry/agent-lifecycle.ts` — revival of parked recipients on direct send.
  - `packages/coding-agent/src/session/agent-session.ts` — `deliverIrcMessage(...)`: recipient-side injection and wake turns.
  - `packages/coding-agent/src/prompts/system/irc-incoming.md` — incoming-message rendering for the recipient.
  - `packages/coding-agent/src/config/settings-schema.ts` — `irc.timeoutMs`.
  - `packages/coding-agent/src/modes/controllers/event-controller.ts` — renders IRC events into chat UI.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `op` | `"send" \| "wait" \| "inbox" \| "list"` | Yes | Operation. |
| `to` | `string` | `send` | Recipient agent id, or `"all"` for broadcast. Whitespace trimmed; self-send rejected. |
| `message` | `string` | `send` | Message body. Empty-after-trim is rejected. |
| `replyTo` | `string` | No | `send`: message id being answered. |
| `await` | `boolean` | No | `send`: after delivery, block until the next message from that peer arrives (round-trip sugar). Invalid with `to: "all"`. |
| `from` | `string` | No | `wait`: only accept a message from this agent id. |
| `timeoutMs` | `number` | No | `wait` / `send await:true`: timeout in milliseconds; `0` waits indefinitely. Defaults to `irc.timeoutMs`. |
| `peek` | `boolean` | No | `inbox`: list messages without consuming them. |

## Outputs
- Single-shot `AgentToolResult`; no streaming updates.
- `content` is one text block:
  - `list`: `No other agents.` or `<n> peer(s):` bullets — `id [displayName · kind · status]` plus unread count, parent, and last-activity age; a footer notes that parked agents are revived automatically when messaged.
  - `send`: per-recipient delivery receipts (`injected` / `woken` / `revived` / `failed — <error>`); with `await: true`, the reply body or a clean no-reply timeout note.
  - `wait`: the consumed message as `[<msgId>] <from>: <body>` (with a reply-to tag), or `No message within <duration>.`
  - `inbox`: `Inbox empty.` or `<n> message(s):` bullets.
- `details: IrcDetails`: `{ op, from?, to?, receipts?, waited?, inbox?, peers? }`. `waited` is `null` when a wait timed out; `receipts` carry `{ to, outcome, error? }`.

## Flow
1. `IrcTool.createIf` constructs the tool only when `isIrcEnabled` passes and the session has both an `AgentRegistry` and `getAgentId`. There is no `irc.enabled` setting: availability is derived — true for every subagent (`taskDepth > 0`; a parent always exists) and for any session that can still spawn subagents through the task tool. Only a top-level session with task spawning unavailable has no peers, hence no irc.
2. `execute` resolves the registry and sender id; missing either returns a text error result instead of throwing.
3. `op: "list"`: `registry.list()` minus self and minus `aborted` agents — `parked` peers ARE listed. Each row includes the unread count from `IrcBus.unreadCount(...)` and last activity.
4. `op: "send"` validates `to`/`message`, rejects self-sends, and rejects `await` with `to: "all"`.
5. Target resolution: broadcasts fan out to `registry.listVisibleTo(senderId)` (live peers only — `running`/`idle`; reviving every parked agent on a broadcast would be a stampede). Direct sends go through the bus unfiltered, so a parked recipient is revived.
6. `IrcBus.send(...)` is fire-and-forget — it never blocks on the recipient generating anything. Delivery by recipient status:
   - `running` → message enqueued and injected as a non-interrupting aside at the recipient's next step boundary (`AgentSession.deliverIrcMessage`, rendered from `irc-incoming.md`, persisted as an `irc:incoming` custom message) — receipt `injected`;
   - `idle` (live session) → enqueued and a real turn is started — the message wakes the agent — receipt `woken`;
   - `parked` → `AgentLifecycleManager.global().ensureLive(to)` revives the session first, then the wake path — receipt `revived`;
   - resolution/revival failure → receipt `failed` with the error; other recipients still complete.
7. `send` with `await: true` then calls `IrcBus.wait(senderId, { from: to }, timeoutMs, signal)` and appends the reply (or a no-reply note suggesting `inbox`/`wait`) to the result.
8. `op: "wait"` blocks until a message for the caller (optionally filtered by `from`) arrives, consumes it, and returns it. Timeout returns a clean "no message" result, not an error.
9. `op: "inbox"` drains pending messages (or peeks with `peek: true`) without blocking.
10. Timeouts resolve as `params.timeoutMs ?? irc.timeoutMs`, normalized: `0` disables the timeout, negative/non-finite values fall back to the default `120_000`, positive values are truncated and clamped to ≥ 1 ms.

## Modes / Variants
- `list`: enumerate peers with status (`running`/`idle`/`parked`), unread counts, and last activity.
- `send` direct: one exact peer id; wakes idle peers, revives parked ones.
- `send` broadcast: `to: "all"` to every live peer; parked peers are skipped.
- `send` + `await: true`: round-trip convenience — send, then wait for the next message from that peer. Replaces the old `awaitReply` auto-reply semantics without a fake reply.
- `wait`: block for an incoming message, optionally filtered by sender.
- `inbox`: non-blocking drain or peek.

## Side Effects
- Session state
  - Reads the process-global `AgentRegistry`; direct sends to parked agents revive their sessions through the lifecycle manager.
  - Persists `irc:incoming` custom messages into recipient history; replies are ordinary turns in the recipient's own session.
  - Waking an idle/parked recipient starts a real agent turn (model requests, tool use) in that recipient.
- User-visible prompts / interactive UI
  - IRC events render as transcript cards in the TUI; the Agent Hub shows per-agent unread counts.
- Background work / cancellation
  - `send` itself never blocks on reply generation; only `wait` (and `await: true`) blocks, bounded by the resolved timeout and the caller's `AbortSignal`.
- Network
  - No IRC server connection. Woken recipients make their own model-provider calls as part of their turn.
- Filesystem
  - No direct filesystem writes in the tool itself; recipient turns persist to their session JSONL as usual.

## Limits & Caps
- Availability gates: `isIrcEnabled` (running as a subagent, or task spawning available — there is no `irc.enabled` setting), an `AgentRegistry`, and a caller agent id.
- Mailboxes are bounded at 100 messages per agent (`MAILBOX_CAP` in `packages/coding-agent/src/irc/bus.ts`); oldest messages are dropped beyond the cap.
- `irc.timeoutMs` defaults to `120_000` and is the default `wait` / `send await:true` timeout; `0` disables the timeout, non-finite or negative values fall back to the default, positive values are truncated and clamped to at least `1` ms.
- Broadcast scope: live peers only (`running`/`idle`) via `listVisibleTo`; direct sends address any non-aborted agent, including parked ones.

## Errors
- The tool returns text errors (with `isError: true`), not thrown exceptions, for:
  - missing registry: `IRC is unavailable in this session.`
  - missing sender id: `IRC is unavailable: caller has no agent id.`
  - missing `to` / `message` on `send`
  - self-send: `Cannot send an IRC message to yourself.`
  - `await` with `to: "all"`
  - unknown op
- Per-recipient delivery failures surface as `failed` receipts with the error message; `send` is marked `isError` only when no recipient received the message.
- `wait` timeout is a normal result (`waited: null`), not an error.

## Notes
- This is IRC-like naming only: no servers, sockets, channels, or join/part state. Addressing is by exact registry agent id.
- Replies are real turns by the recipient — the old ephemeral no-tools auto-reply (`awaitReply` / `respondAsBackground`) no longer exists. A recipient may keep working before answering; check `inbox` or `wait` again rather than re-sending.
- Wake-on-message is the only resume primitive: messaging a parked agent revives it (same `ensureLive` path as the Agent Hub). The task tool has no `resume` parameter.
- Message ids are Snowflakes; pass them as `replyTo` to thread an answer to a specific message.
- Persistence is per recipient history: the sender gets receipts in the tool result; the recipient sees the injected `irc:incoming` message in its own transcript (visible via `history://<id>`).
