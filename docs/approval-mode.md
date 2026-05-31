# Tool approval mode

Tool approval has two independent inputs:

1. **Tool declaration** — every tool may declare an `approval` tier:
   - `read`: reads data or updates UI-only session metadata.
   - `write`: mutates workspace/session state but does not execute arbitrary code.
   - `exec`: executes code, shells out, drives a browser, spawns agents, or performs similarly broad actions.
2. **User policy** — `tools.approval.<toolName>: allow | deny | prompt` overrides the mode for that tool unless a non-yolo safety override forces a prompt.

Tools without an `approval` declaration are treated as `exec`. This is the safe default for MCP and unknown custom tools.

## Modes

Configure with `tools.approvalMode`:

| Mode             | Auto-approves           | Prompts for     |
| ---------------- | ----------------------- | --------------- |
| `always-ask`     | `read`                  | `write`, `exec` |
| `write`          | `read`, `write`         | `exec`          |
| `yolo` (default) | `read`, `write`, `exec` | none            |

`--auto-approve` and `--yolo` force `tools.approvalMode: yolo` for the session.

## User overrides

`tools.approval` is honored in every mode:

```yaml
tools:
  approvalMode: write
  approval:
    bash: prompt
    read: allow
    mcp__filesystem__delete: deny
```

Resolution per tool call:

1. Compute the tool's approval decision from `tool.approval(args)`; omitted means `exec`.
2. Normalize `tools.approval.<tool>` if present; invalid values are ignored.
3. In `yolo` mode, the user policy is used when present; otherwise the call is allowed. Safety `override` reasons do not force a prompt in `yolo`.
4. In non-yolo modes, if the tool sets `override: true`, `deny` is blocked and all other cases prompt, even if user policy says `allow`.
5. Otherwise, a valid user policy wins.
6. Otherwise, the active mode auto-approves or prompts by tier.

## Safety overrides

A tool can force a prompt with object-form approval:

```ts
approval: { tier: "exec", override: true, reason: "Critical pattern detected" }
```

`bash` uses this for critical destructive patterns such as `rm -rf /`, fork bombs, remote-fetch-then-execute, writes to `/etc/passwd`, and host shutdown commands. These surface as `reason` in the approval prompt, but in `yolo` mode they are auto-approved unless a user policy for the tool is set to `prompt` or `deny`.

## Per-tool prompt details

Tools can add approval-prompt body lines with `formatApprovalDetails(args)`. The standard prompt includes:

- `Allow tool: <name>`
- `Origin: MCP server tool` for unannotated `mcp__...` tools
- `Reason: <reason>` when the tool decision supplies one
- tool-specific details such as command, path, code, browser action, or subagent assignment

## Defining approval on tools

Built-in and custom tools share the same shape:

```ts
export type ToolTier = "read" | "write" | "exec";
export type ToolApprovalDecision = ToolTier | { tier: ToolTier; reason?: string; override?: boolean };
export type ToolApproval = ToolApprovalDecision | ((args: unknown) => ToolApprovalDecision);

approval?: ToolApproval;
formatApprovalDetails?: (args: unknown) => string | string[] | undefined;
```

Examples:

```ts
approval: "read";

approval: (args) => (LSP_READONLY_ACTIONS.has(args.action) ? "read" : "write");

approval: (args) =>
  isCritical(args.command)
    ? { tier: "exec", override: true, reason: "Critical pattern detected" }
    : "exec";
```

## Subagents

Subagents run headless with `tools.approvalMode: yolo` so they do not stall waiting for UI. The parent `task` approval is the authorization boundary. User `tools.approval.<tool>` settings continue to control whether a tool is allowed, prompted, or blocked.
