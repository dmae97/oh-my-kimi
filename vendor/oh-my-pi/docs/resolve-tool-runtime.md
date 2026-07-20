# Resolution devices runtime

Pending previews and plan approval no longer use a `resolve` tool. They finalize through three plain-text writes handled by `packages/coding-agent/src/tools/resolve.ts`:

- `/xdev/resolve` — apply the pending staged preview; body = reason text
- `/xdev/reject` — discard the pending staged preview; body = reason text
- `/xdev/propose` — submit the plan for approval while plan mode is active; body = the plan slug/title (`<slug>` for `local://<slug>-plan.md`)

## Preview flows

Preview producers call `queueResolveHandler(...)` with `apply(reason)` and optional `reject(reason)` callbacks. That registers a non-forcing pending invoker in `ToolChoiceQueue`.

While a preview is pending, `AgentSession.nextToolChoiceDirective()` returns a soft requirement:

- `toolName: "write"`
- `satisfies: isPreviewResolutionToolCall`
- reminder from `resolve-device-reminder.md`

So the model can comply by writing to `/xdev/resolve` or `/xdev/reject`; a write to any other path is still a detour and gets skipped/escalated.

Dispatch path:

- `dispatchResolutionDevice(session, "resolve" | "reject", text)`
- `peekQueueInvoker() ?? peekPendingInvoker()`
- `runResolveInvocation(...)`

`reject` with no pending action succeeds (`Nothing to reject; no pending action remains.`). `resolve` with no pending action throws.

## Plan approval

Plan mode installs a separate proposal handler through `setPlanProposalHandler(...)`.

- `InteractiveMode` uses it to hand `PlanApprovalDetails` to the plan-review UI.
- ACP mode uses it to run elicitation/approval and emit mode updates.
- PlanYolo uses it to auto-approve and switch to the execution target.

Dispatch path:

- `dispatchResolutionDevice(session, "propose", title)`
- `peekPlanProposalHandler()`

`/xdev/propose` is only valid while plan mode is active.

## Why `write` is guaranteed

Because previews and plan approval now ride `write`, the harness keeps `write` available whenever it is needed:

- `createTools(...)` auto-appends `write` when a `deferrable` tool is active (e.g. `ast_edit`)
- `createAgentSession(...)` keeps `write` registered when a deferrable tool exists or plan mode is enabled

## Custom tools

Custom tools still stage previews through `pushPendingAction(...)`; the loader forwards them into `queueResolveHandler(...)`. Nothing about the custom-tool API changes except the model-facing finalization step: the follow-up is now a plain-text write to `/xdev/resolve` or `/xdev/reject`, not a `resolve` tool call.
