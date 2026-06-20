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
3. `queueResolveHandler(...)` registers a non-forcing pending invoker on the session's tool-choice queue under a unique `pending-action:<sourceTool>:<seq>` id. It does NOT force a tool choice and does NOT steer a reminder.
4. While a preview is pending, the session's `getToolChoice` (`nextToolChoiceDirective`) returns a `SoftToolRequirement` (`toolName: "resolve"`) carrying the resolve reminder — a non-consuming peek. The agent runtime injects the reminder once and forces `tool_choice: resolve` for one turn only if the model declines (see `docs/resolve-tool-runtime.md`). The reminder text is:

```text
<system-reminder>
This is a preview. Call the `resolve` tool to apply or discard these changes.
</system-reminder>
```

5. When `resolve.execute()` runs, it wraps the call in `untilAborted(...)` and dispatches via `session.peekQueueInvoker?.() ?? session.peekPendingInvoker?.() ?? session.peekStandingResolveHandler?.()`.
6. If no invoker exists, `apply` throws `ToolError("No pending action to resolve. Nothing to apply or discard.")`; `discard` instead returns a success payload `Nothing to discard; no pending action remains.` because the desired end-state (no staged change) already holds.
7. Otherwise it invokes the current handler with the full params object.
8. `runResolveInvocation(...)` builds base details from `action`, `reason`, `extra`, `sourceToolName`, and `label`.
9. For `apply`, it calls the producer's `apply(reason, extra)` callback.
10. If `apply` throws, `runResolveInvocation(...)` calls `onApplyError` when present. The pending-preview integration uses this to re-register the same pending invoker (same id) so the action remains pending for discard or retry. Non-`ToolError` exceptions are wrapped as `ToolError("Apply failed: <message>")`.
11. For `discard`, it calls `reject(reason, extra)` when provided. If no reject callback exists or it returns `undefined`, `resolve` fabricates the default discard message.
12. Before returning callback results, it merges resolve metadata into `result.details` so renderer/UI code can show the action, label, and originating tool.

## Modes / Variants
- `apply`: runs the pending action's `apply(reason, extra?)` callback and returns its content.
- `discard` with reject callback: runs `reject(reason, extra?)` and returns that callback's content when non-`undefined`.
- `discard` without reject callback, or with a reject callback returning `undefined`: returns the built-in `Discarded: ...` text payload.
- `discard` with no pending action at all: returns `Nothing to discard; no pending action remains.` as a success result.
- Pending invoker: a non-forcing preview invoker in the pending-invoker registry (separate from the consuming directive queue), used by preview producers such as `ast_edit`.
- Standing handler: long-lived mode-owned handler, used as a fallback when no queue invoker is active.

## Side Effects
- Session state
  - Consumes or invokes the current pending action through the pending invoker, tool-choice queue, or standing handler; `resolve` does not maintain its own stack.
  - Does not steer a reminder or force a tool choice for previews — the reminder rides a non-forcing `SoftToolRequirement` and the agent runtime forces `resolve` only on non-compliance.
  - On queued apply failure, requeues the same pending action before rethrowing so the model can discard or retry instead of losing the pending preview.
- User-visible prompts / interactive UI
  - The visible effect depends on the preview-producing tool and the resolve renderer.
  - Renderer result blocks show `Accept`, `Discard`, or `Failed`, include the pending action label, and display the reason.
- Background work / cancellation
  - `untilAborted(...)` lets abort signals interrupt resolution before or while the callback awaits.

## Limits & Caps
- Hidden tool: `ResolveTool.hidden = true`, and normal requested-tool filtering removes `resolve`; `createTools(...)` adds it separately as a hidden tool.
- Per call, `resolve` consults the in-flight hard-directive queue invoker (`session.peekQueueInvoker()`), then the non-forcing pending-preview invoker (`session.peekPendingInvoker()`), then a standing handler (`session.peekStandingResolveHandler()`).
- There is no independent depth cap in this tool; pending previews stack as unique-keyed invokers (resolved head-first), separate from the consuming directive queue and the mode-owned standing handler lifecycle.

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
