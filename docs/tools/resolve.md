# resolve

> Finalizes a pending action by applying or discarding it.

## Source
- Entry: `packages/coding-agent/src/tools/resolve.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/resolve.md`
- Key collaborators:
  - `docs/resolve-tool-runtime.md` — preview/apply runtime reference
  - `packages/coding-agent/src/extensibility/custom-tools/loader.ts` — forwards custom pending actions into the queue
  - `packages/coding-agent/src/tools/ast-edit.ts` — built-in preview producer example
  - `packages/coding-agent/src/session/agent-session.ts` — tool-choice queue, standing resolve handler, and invoker access

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | `"apply" | "discard"` | Yes | Whether to commit or reject the pending action. |
| `reason` | `string` | Yes | Required explanation passed through to the handler. |
| `extra` | `Record<string, unknown>` | No | Free-form metadata passed through to the handler. Plan approval uses this for data such as a title slug; preview-style actions usually ignore it. |

## Outputs
- Single-shot result.
- `execute()` returns whatever the queued or standing invoker returns, with `details` wrapped/augmented to include:
  - `action`
  - `reason`
  - `extra?`
  - `sourceToolName?`
  - `label?`
  - `sourceResultDetails?` — original `result.details` from the apply/reject callback when present
- If `discard` has no custom reject callback, or the reject callback returns `undefined`, the default success payload is `Discarded: <label>. Reason: <reason>`.
- The TUI renderer is inline and merges call+result into one block.

## Flow
1. Preview-producing code can call `queueResolveHandler(...)` with a label, source tool name, `apply(reason, extra?)` callback, and optional `reject(reason, extra?)` callback.
2. Modes can also register a standing resolve handler through `session.setStandingResolveHandler(...)`; `resolve.execute()` consults it only when no queued invoker is active.
3. `queueResolveHandler(...)` asks the session for a forced `resolve` tool choice and pushes it into the tool-choice queue with `pushOnce(...)`.
4. The queued entry is marked `now: true`; if the model rejects that forced tool choice, `onRejected` returns `requeue`, so the reminder comes back.
5. `queueResolveHandler(...)` also injects a `resolve-reminder` steering message:

```text
<system-reminder>
This is a preview. Call the `resolve` tool to apply or discard these changes.
</system-reminder>
```

6. When `resolve.execute()` runs, it wraps the call in `untilAborted(...)` and fetches `session.peekQueueInvoker?.() ?? session.peekStandingResolveHandler?.()`.
7. If no invoker exists, `apply` throws `ToolError("No pending action to resolve. Nothing to apply or discard.")`; `discard` instead returns a success payload `Nothing to discard; no pending action remains.` because the desired end-state (no staged change) already holds.
8. Otherwise it invokes the current handler with the full params object.
9. `runResolveInvocation(...)` builds base details from `action`, `reason`, `extra`, `sourceToolName`, and `label`.
10. For `apply`, it calls the producer's `apply(reason, extra)` callback.
11. If `apply` throws, `runResolveInvocation(...)` calls `onApplyError` when present. The queued preview integration uses this to re-push the resolve directive and steering reminder so the action remains pending. Non-`ToolError` exceptions are wrapped as `ToolError("Apply failed: <message>")`.
12. For `discard`, it calls `reject(reason, extra)` when provided. If no reject callback exists or it returns `undefined`, `resolve` fabricates the default discard message.
13. Before returning callback results, it merges resolve metadata into `result.details` so renderer/UI code can show the action, label, and originating tool.

## Modes / Variants
- `apply`: runs the pending action's `apply(reason, extra?)` callback and returns its content.
- `discard` with reject callback: runs `reject(reason, extra?)` and returns that callback's content when non-`undefined`.
- `discard` without reject callback, or with a reject callback returning `undefined`: returns the built-in `Discarded: ...` text payload.
- `discard` with no pending action at all: returns `Nothing to discard; no pending action remains.` as a success result.
- Queued handler: one in-flight tool-choice queue invoker, used by preview producers such as `ast_edit`.
- Standing handler: long-lived mode-owned handler, used as a fallback when no queue invoker is active.

## Side Effects
- Session state
  - Consumes or invokes the current pending action through the session tool-choice queue or standing handler; `resolve` does not maintain its own stack.
  - Adds a `resolve-reminder` steering message when a queued preview is registered.
  - On queued apply failure, requeues the same pending action before rethrowing so the model can discard or retry instead of losing the pending preview.
- User-visible prompts / interactive UI
  - The visible effect depends on the preview-producing tool and the resolve renderer.
  - Renderer result blocks show `Accept`, `Discard`, or `Failed`, include the pending action label, and display the reason.
- Background work / cancellation
  - `untilAborted(...)` lets abort signals interrupt resolution before or while the callback awaits.

## Limits & Caps
- Hidden tool: `ResolveTool.hidden = true`, and normal requested-tool filtering removes `resolve`; `createTools(...)` adds it separately as a hidden tool.
- Exactly one active queue invoker is consulted per call via `session.peekQueueInvoker()`; if none exists, one standing handler may be consulted via `session.peekStandingResolveHandler()`.
- There is no independent queue depth cap in this tool; ordering follows the shared tool-choice queue and mode-owned standing handler lifecycle.

## Errors
- `apply` with no pending action or standing handler: throws `ToolError("No pending action to resolve. Nothing to apply or discard.")`. `discard` in the same situation succeeds with `Nothing to discard; no pending action remains.` instead of erroring.
- `apply` callback throws `ToolError`: the original `ToolError` propagates.
- `apply` callback throws any other value: `resolve` wraps it as `ToolError("Apply failed: <message>")` after running `onApplyError` when present.
- `reject` callback exceptions propagate without the apply-specific wrapper.
- Aborts during `untilAborted(...)` surface as the underlying abort error from the utility.

## Notes
- `reason` and `extra` are passed through; `resolve` itself does not interpret them.
- `queueResolveHandler(...)` is the canonical built-in preview integration point; custom tools use `pushPendingAction(...)`, which the loader forwards into the same mechanism.
- Standing handlers let modes accept `resolve` invocations without forcing the tool choice every turn.
- `sourceResultDetails` is added only when the apply/reject callback returned a non-null `details` field; custom pending-action `details` are not forwarded automatically by the loader.
