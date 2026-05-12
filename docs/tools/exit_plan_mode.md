# exit_plan_mode

> Submits the current plan-mode plan for user approval.

## Source
- Entry: `packages/coding-agent/src/tools/exit-plan-mode.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/exit-plan-mode.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/plan-mode-guard.ts` — resolves canonical plan paths during plan mode
  - `packages/coding-agent/src/plan-mode/approved-plan.ts` — renames approved plan artifact after user approval
  - `packages/coding-agent/src/modes/interactive-mode.ts` — approval popup, plan preview, mode exit, tool restoration
  - `packages/coding-agent/src/plan-mode/state.ts` — plan-mode state shape

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `title` | `string` | Yes | Final plan title. `.md` is optional; the runtime normalizes to `local://<title>.md`. Allowed characters: letters, numbers, `_`, `-`. |

## Outputs
- Single-shot success result with `content[0].text = "Plan ready for approval."`.
- `details` contains:
  - `planFilePath` — current plan artifact path from plan-mode state, typically `local://PLAN.md`
  - `planExists` — whether that file existed at call time
  - `title` — normalized title without `.md`
  - `finalPlanFilePath` — normalized destination, always `local://<title>.md`
- The actual rename and mode transition happen later in the interactive controller after the user chooses an approval action.

## Flow
1. `execute()` reads `session.getPlanModeState()` and rejects the call unless `state.enabled` is true.
2. `normalizePlanTitle()` trims whitespace, rejects empty values, rejects `/`, `\\`, and `..`, appends `.md` if missing, and enforces `^[A-Za-z0-9_-]+\.md$`.
3. The tool computes `finalPlanFilePath = local://<normalized>.md` and resolves both source and destination through `resolvePlanPath(...)` to validate them against plan-mode path rules.
4. It `stat`s the current plan file path; if the plan artifact does not exist it throws a `ToolError` telling the caller to write the finalized plan first.
5. On success it returns the approval-ready payload; it does not mutate files itself.
6. `packages/coding-agent/src/modes/controllers/event-controller.ts` watches successful `exit_plan_mode` results and forwards `details` to `InteractiveMode.handleExitPlanModeTool(...)`.
7. The interactive controller aborts the agent, renders the current plan, and shows four choices: `Approve and execute`, `Approve and keep context`, `Refine plan`, `Stay in plan mode`.
8. If the user approves, `#approvePlan(...)` renames `local://PLAN.md` to `local://<title>.md`, exits plan mode, restores the previous tool set, optionally clears session context, writes the approved plan into the new local root when context is reset, and injects a synthetic system prompt instructing execution from the finalized artifact.

## Side Effects
- Filesystem
  - Tool itself only `stat`s the current plan file.
  - Approval path later renames the plan artifact via `fs.rename(...)` and may rewrite the approved plan into a fresh local root with `Bun.write(...)`.
- Session state
  - Requires active plan-mode state.
  - Approval flow aborts the current agent loop, exits plan mode, restores previous active tools, clears or preserves context depending on the user choice, and records the approved plan reference path.
- User-visible prompts / interactive UI
  - Successful calls trigger a plan preview and an approval/refinement selector in interactive mode.
- Background work / cancellation
  - The controller aborts the running agent before showing the popup to prevent repeated `exit_plan_mode` calls.

## Limits & Caps
- `title` accepts only `[A-Za-z0-9_-]` plus optional `.md` (`packages/coding-agent/src/tools/exit-plan-mode.ts`).
- Destination must be under the `local:` scheme; approval rename rejects non-`local:` source or destination paths (`packages/coding-agent/src/plan-mode/approved-plan.ts`).
- In plan mode, only the plan file may be edited; other writes are blocked by `enforcePlanModeWrite(...)` in `packages/coding-agent/src/tools/plan-mode-guard.ts`.

## Errors
- Plan mode inactive: throws `ToolError("Plan mode is not active.")`.
- Empty title: throws `ToolError("Title is required and must not be empty.")`.
- Path traversal / separators: throws `ToolError("Title must not contain path separators or '..'.")`.
- Invalid characters: throws `ToolError("Title may only contain letters, numbers, underscores, or hyphens.")`.
- Missing plan artifact: throws `ToolError("Plan file not found at ... Write the finalized plan ... before calling exit_plan_mode.")`.
- Approval-time failures surface in the UI from `InteractiveMode.handleExitPlanModeTool(...)`, including destination already exists and rename failures from `renameApprovedPlanFile(...)`.

## Notes
- This tool is hidden/internal: it is injected when `plan.enabled` is on and is not part of normal discoverable built-ins (`packages/coding-agent/src/tools/index.ts`, `packages/coding-agent/src/session/agent-session.ts`).
- The tool returning success does not mean plan mode has ended; it only means the request was handed off to the approval UI.
- `resolvePlanPath(...)` special-cases bare filenames matching the plan basename so `PLAN.md` maps back to the canonical session-scoped `local://PLAN.md` artifact.
- `Approve and keep context` skips the full conversation reset; `Approve and execute` clears context, then copies the approved plan into the new session-local artifact root before execution resumes.
