# `/handoff` generation pipeline

This document describes how the coding-agent implements `/handoff` today: trigger path, generation prompt, completion capture, session switch, and context reinjection.

## Scope

Covers:

- Interactive `/handoff` command dispatch
- `AgentSession.handoff()` lifecycle and state transitions
- How handoff output is captured from assistant output
- How old/new sessions persist handoff data differently
- UI behavior for success, cancel, and failure

Does not cover:

- Generic tree navigation/branch internals
- Non-handoff session commands (`/new`, `/fork`, `/resume`)

## Implementation files

- [`../src/modes/controllers/input-controller.ts`](../packages/coding-agent/src/modes/controllers/input-controller.ts)
- [`../src/modes/controllers/command-controller.ts`](../packages/coding-agent/src/modes/controllers/command-controller.ts)
- [`../src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`../src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts)
- [`../src/extensibility/slash-commands.ts`](../packages/coding-agent/src/extensibility/slash-commands.ts)

## Trigger path

1. `/handoff` is declared in builtin slash command metadata (`slash-commands.ts`) with optional inline hint: `[focus instructions]`.
2. In interactive input handling (`InputController`), submit text matching `/handoff` or `/handoff ...` is intercepted before normal prompt submission.
3. The editor is cleared and `handleHandoffCommand(customInstructions?)` is called.
4. `CommandController.handleHandoffCommand` performs a preflight guard using current entries:
   - Counts `type === "message"` entries.
   - If `< 2`, it warns: `Nothing to hand off (no messages yet)` and returns.

The same minimum-content guard exists again inside `AgentSession.handoff()` and throws if violated. This duplicates safety at both UI and session layers.

## End-to-end lifecycle

### 1) Start handoff generation

`AgentSession.handoff(customInstructions?)`:

- Reads current branch entries (`sessionManager.getBranch()`)
- Validates minimum message count (`>= 2`)
- Creates `#handoffAbortController`
- Renders the fixed prompt template `prompts/system/handoff-document.md` with optional `additionalFocus`
- Appends `Additional focus: ...` if custom instructions are provided

Prompt is sent as an agent-authored developer message via:

```ts
await this.#promptAgentWithIdleRetry([
  {
    role: "developer",
    content: [{ type: "text", text: handoffPrompt }],
    attribution: "agent",
    timestamp: Date.now(),
  },
]);
```

Because handoff bypasses `prompt(...)`, normal slash/prompt-template expansion is not applied to this internal instruction payload.

### 2) Capture completion

Before sending prompt, `handoff()` subscribes to session events and waits for `agent_end`.

On `agent_end`, it extracts handoff text from agent state by scanning backward for the most recent `assistant` message, then concatenating all `content` blocks where `type === "text"` with `\n`.

Important extraction assumptions:

- Only text blocks are used; non-text content is ignored.
- It assumes the latest assistant message corresponds to handoff generation.
- It does not parse markdown sections or validate format compliance.
- If assistant output has no text blocks, handoff is treated as missing.

### 3) Cancellation checks

Cancellation throws `Error("Handoff cancelled")`; a completed generation with no extracted text returns `undefined`.

- no captured handoff text → returns `undefined`
- aborted handoff signal → throws `Error("Handoff cancelled")`

It always clears `#handoffAbortController` in `finally`.

### 4) New session creation

If text was captured and not aborted:

1. Flush current session writer (`sessionManager.flush()`)
2. Cancel async jobs (`#asyncJobManager?.cancelAll()`)
3. Start a brand-new session (`sessionManager.newSession()`)
4. Reset in-memory agent state (`agent.reset()`)
5. Rebind `agent.sessionId` to new session id
6. Clear queued context arrays (`#steeringMessages`, `#followUpMessages`, `#pendingNextTurnMessages`) and any scheduled hidden next-turn generation
7. Reset todo reminder counter
   `newSession()` creates a fresh header and empty entry list (leaf reset to `null`). In the handoff path, no `parentSession` is passed.

### 5) Handoff-context injection

The generated handoff document is wrapped and appended to the new session as a `custom_message` entry:

```text
<handoff-context>
...handoff text...
</handoff-context>

The above is a handoff document from a previous session. Use this context to continue the work seamlessly.
```

Insertion call:

```ts
this.sessionManager.appendCustomMessageEntry("handoff", handoffContent, true);
```

Semantics:

- `customType`: `"handoff"`
- `display`: `true` (visible in TUI rebuild)
- Entry type: `custom_message` (participates in LLM context)

### 6) Rebuild active agent context

After injection:

1. `buildDisplaySessionContext()` resolves message list for current leaf
2. `agent.replaceMessages(sessionContext.messages)` makes the injected handoff message active context
3. Todo phases are synchronized from the new branch
4. Method returns `{ document: handoffText, savedPath? }`

At this point, the active LLM context in the new session contains the injected handoff message, not the old transcript.

## Persistence model: old session vs new session

### Old session

During generation, normal message persistence remains active. The assistant handoff response is persisted as a regular `message` entry on `message_end`.

Result: the original session contains the visible generated handoff as part of historical transcript.

### New session

After session reset, handoff is persisted as `custom_message` with `customType: "handoff"`.

`buildSessionContext()` converts this entry into a runtime custom/user-context message via `createCustomMessage(...)`, so it is included in future prompts from the new session.

## Controller/UI behavior

`CommandController.handleHandoffCommand` behavior:

- Calls `await session.handoff(customInstructions)`
- If result is `undefined`: `showError("Handoff cancelled")`
- On success:
  - `rebuildChatFromMessages()` (loads new session context, including injected handoff)
  - invalidates status line and editor top border
  - reloads todos
  - appends success chat line: `New session started with handoff context`
- On exception:
  - if message is `"Handoff cancelled"` or error name is `AbortError`: `showError("Handoff cancelled")`
  - otherwise: `showError("Handoff failed: <message>")`
- Requests render at end

## Cancellation semantics (current behavior)

### Session-level cancellation primitive

`AgentSession` exposes:

- `abortHandoff()` → aborts `#handoffAbortController`
- `isGeneratingHandoff` → true while controller exists

When this abort path is used, the handoff completion waiter resolves as cancelled, `agent.abort()` is called, and `handoff()` throws `Error("Handoff cancelled")`; command controller maps it to cancellation UI.

### Interactive `/handoff` path

The editor does not install a dedicated Escape handler that calls `abortHandoff()` for `/handoff`, but `InputController` treats `session.isGeneratingHandoff` as a busy state.

Practical impact:

- There is session-level cancellation support, but no handoff-specific keybinding hook in the `/handoff` command path.
- User interruption may still occur through broader agent abort paths, but that is not the same explicit cancellation channel used by `abortHandoff()`.

## Aborted vs failed handoff

Current UI classification:

- **Aborted/cancelled**
  - `abortHandoff()` path triggers `"Handoff cancelled"`, or
  - thrown `AbortError`
  - UI shows `Handoff cancelled`

- **Failed**
  - any other thrown error from `handoff()` / prompt pipeline (model/API validation errors, runtime exceptions, etc.)
  - UI shows `Handoff failed: ...`

Additional nuance: if generation completes but no text is extracted, `handoff()` returns `undefined` and controller currently reports **cancelled**, not **failed**.

## Short-session and minimum-content guardrails

Two guards prevent low-signal handoffs:

- UI layer (`handleHandoffCommand`): warns and returns early for `< 2` message entries
- Session layer (`handoff()`): throws the same condition as an error

This avoids creating a new session with empty/near-empty handoff context.

## State transition summary

High-level state flow:

1. Interactive slash command intercepted
2. Preflight message-count guard
3. `#handoffAbortController` created (`isGeneratingHandoff = true`)
4. Internal developer handoff prompt submitted (visible in chat as normal assistant generation)
5. On `agent_end`, last assistant text extracted
6. If missing text → return `undefined`; if aborted → cancellation error path
7. If present:
   - flush old session
   - cancel async jobs
   - create new empty session
   - reset runtime queues/counters
   - append `custom_message(handoff)`
   - optionally save an auto-triggered handoff document under the session artifacts directory when `compaction.handoffSaveToDisk` is enabled
8. Controller rebuilds chat UI and announces success
9. `#handoffAbortController` cleared (`isGeneratingHandoff = false`)

## Known assumptions and limitations

- Handoff extraction is heuristic: "last assistant text blocks"; no structural validation.
- No hard check that generated markdown follows requested section format.
- Missing extracted text is reported as cancellation in controller UX.
- `/handoff` interactive flow currently lacks a dedicated Escape→`abortHandoff()` binding, though the session reports handoff as a busy state.
- New session lineage metadata (`parentSession`) is not set by this path.
- Auto-triggered handoffs can write a timestamped `handoff-*.md` artifact when `compaction.handoffSaveToDisk` is enabled; write failure is logged and does not fail the handoff.
