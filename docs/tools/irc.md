# irc

> Send short prose messages to other live agents in the current process.

## Source
- Entry: `packages/coding-agent/src/tools/irc.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/irc.md`
- Key collaborators:
  - `packages/coding-agent/src/registry/agent-registry.ts` — process-global live agent directory.
  - `packages/coding-agent/src/session/agent-session.ts` — side-channel reply generation and history injection.
  - `packages/coding-agent/src/prompts/system/irc-incoming.md` — no-tools auto-reply prompt.
  - `packages/coding-agent/src/tools/index.ts` — tool availability gating.
  - `packages/coding-agent/src/config/settings-schema.ts` — `irc.enabled` default.
  - `packages/coding-agent/src/modes/controllers/event-controller.ts` — renders IRC events into chat UI.
  - `packages/coding-agent/src/modes/utils/ui-helpers.ts` — formats `[IRC]` transcript lines.
  - `packages/coding-agent/src/task/executor.ts` — carries `irc.enabled` into subagents.

## Inputs

### `op: "list"`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `op` | `"list"` | Yes | Lists peers visible to the caller. |

### `op: "send"`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `op` | `"send"` | Yes | Sends one message to one peer or to `"all"`. |
| `to` | `string` | Yes | Peer id such as `0-Main`, or `"all"` for broadcast. Whitespace is trimmed. |
| `message` | `string` | Yes | Message body. Whitespace is trimmed; empty-after-trim is rejected. |
| `awaitReply` | `boolean` | No | Wait for prose replies. Defaults to `true` for direct messages and `false` for `to: "all"`. |

## Outputs
- Single-shot `AgentToolResult`; no streaming updates.
- `content` is one text block.
  - `list` returns either `No other live agents.` or a bullet list headed by `<n> peer(s):`.
  - `send` returns delivery summary text, then optional `## Replies`, `## Failed`, and `Unknown / unavailable peers:` sections.
- `details` is structured metadata:
  - `list`: `{ op, from, peers, channels }`
  - `send`: `{ op, from, to, delivered, replies?, failed?, notFound? }`
- The tool does not return raw IRC frames, message ids, or a transcript object.

## Flow
1. `IrcTool.createIf` only constructs the tool when `irc.enabled` is on and the session has both an `AgentRegistry` and `getAgentId` (`packages/coding-agent/src/tools/irc.ts`).
2. Tool discovery adds another gate in `packages/coding-agent/src/tools/index.ts`: if the caller is `0-Main` and `async.enabled` is off, `irc` is hidden because the main agent cannot talk to concurrent peers in sync mode.
3. `execute` resolves the process-global registry and sender id. Missing either returns a text error result instead of throwing.
4. `op: "list"` calls `registry.listVisibleTo(senderId)`, which exposes every other agent in flat namespace whose status is `running` or `idle` (`packages/coding-agent/src/registry/agent-registry.ts`).
5. `list` formats human-readable lines and returns `channels` as `['all', ...peerIds]`. These are logical targets only; there is no channel join state.
6. `op: "send"` trims `to` and `message`; missing values produce text errors.
7. `send` resolves targets:
   - `to === "all"`: all visible peers.
   - otherwise: one exact registry id, excluding self and excluding peers not in `running`/`idle`.
8. `send` chooses `awaitReply = params.awaitReply ?? !isBroadcast`.
9. Each target is dispatched in parallel via `target.session.respondAsBackground(...)`. One slow or failing peer does not block dispatch to the others.
10. `respondAsBackground` emits an `irc_message` session event, forwards a display-only relay to the main session UI, and either:
    - queues just the incoming message for later history injection when `awaitReply === false`, or
    - renders `packages/coding-agent/src/prompts/system/irc-incoming.md`, runs `runEphemeralTurn` with `toolChoice: "none"`, emits an auto-reply event, then queues both incoming and reply messages for history injection.
11. Deferred injection waits until the recipient is no longer streaming; `#flushPendingBackgroundExchanges` appends the custom messages through normal `message_start`/`message_end` external events so persistence and listeners see them.
12. `send` aggregates `delivered`, `replies`, `failed`, and `notFound`, then returns one text summary plus matching `details`.

## Modes / Variants
- `list`: enumerate visible peers and logical channels.
- `send` direct message: one exact peer id, default synchronous auto-reply.
- `send` broadcast: `to: "all"`, default fire-and-forget (`awaitReply: false`) to every visible peer.
- `send` with `awaitReply: false`: recipient records the incoming message but does not generate a reply.
- `send` with `awaitReply: true`: recipient performs a no-tools ephemeral LLM turn and returns prose.

## Side Effects
- Session state
  - Reads from the process-global `AgentRegistry`.
  - Emits `irc_message` session events on recipient sessions.
  - Queues IRC custom messages into recipient persisted history after the current stream finishes.
  - For non-main recipients, forwards display-only relay observations into the main session UI; these relays are not persisted to the main agent history.
  - Subagents inherit `irc.enabled` from task executor settings.
- User-visible prompts / interactive UI
  - IRC events render as `[IRC]` transcript lines in the TUI.
  - Auto-replies are generated from `packages/coding-agent/src/prompts/system/irc-incoming.md` and explicitly forbid tool use.
- Background work / cancellation
  - `send` starts one background `respondAsBackground` call per target.
  - The caller's `AbortSignal` is forwarded into each background reply turn.
- Network
  - No IRC server connection.
  - When `awaitReply: true`, the recipient may make model-provider API calls through `runEphemeralTurn`.
- Filesystem
  - No direct filesystem writes in the tool itself.

## Limits & Caps
- Availability gates:
  - `irc.enabled` defaults to `true` in `packages/coding-agent/src/config/settings-schema.ts`.
  - Main agent tool discovery suppresses `irc` when `async.enabled` is off (`packages/coding-agent/src/tools/index.ts`).
- Visibility scope: only peers in status `running` or `idle` are addressable via `listVisibleTo`.
- Reply execution:
  - No tools are available in auto-reply turns (`toolChoice: "none"` in `runEphemeralTurn`).
  - No internal timeout, retry, backoff, rate limit, or reply length cap is defined in `irc.ts`; behavior relies on the underlying model stream and any upstream API limits.
- Flush scheduling: deferred history injection polls every `50` ms while the recipient is still streaming (`#scheduleBackgroundExchangeFlush` in `packages/coding-agent/src/session/agent-session.ts`).

## Errors
- The tool returns text errors, not thrown exceptions, for:
  - missing registry: `IRC is unavailable in this session.`
  - missing sender id: `IRC is unavailable: caller has no agent id.`
  - missing `to`: `` `to` is required for op="send". ``
  - missing `message`: `` `message` is required for op="send". ``
  - unknown op: `Unknown irc op.`
- Unknown, self-addressed, non-running, and non-idle direct targets are reported under `details.notFound` and in the text footer `Unknown / unavailable peers:`.
- If a target has no attached session, it is treated as not found.
- Exceptions thrown by `respondAsBackground` or `runEphemeralTurn` are caught per-target and surfaced under `details.failed` as `{ id, error }`; other recipients still complete.
- If no target succeeds, `send` still returns normally with `No recipients received the message.` and optional `failed`/`notFound` metadata.

## Notes
- This is IRC-like naming only. There are no servers, sockets, nick registration, auth handshakes, channels beyond `all`, or commands such as join/part/topic.
- Addressing is by exact agent id from the registry; there is no fuzzy lookup or aliasing.
- `channels` in `list` is synthetic output: `all` plus visible peer ids. Nothing is persisted across calls as channel membership.
- Persistence is per recipient history, not per sender history. The sender gets the tool result; the recipient later sees injected custom messages on its next turn.
- The main UI may show IRC relays for conversations it was not part of, but those relay records are explicitly display-only.
- Because reply generation snapshots in-flight assistant text, a recipient can answer based on partially streamed context.
- Direct self-messaging is rejected by resolving the target as unavailable.