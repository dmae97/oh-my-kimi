# Tool Approval Policies

Per-tool approval policies allow fine-grained control over which tools require user confirmation before execution.

## Overview

Approval is gated by **two** settings:

1. **`tools.approvalMode`** — the top-level switch. Defaults to `auto`.
   - `auto` (default) — skip approval entirely. **`tools.approval` is ignored.**
   - `prompt` — apply the built-in per-tool defaults (read-only allowed, destructive prompts). `tools.approval` is still ignored.
   - `custom` — your `tools.approval.<tool>` config wins; built-in defaults fill in tools you didn't configure.
2. **`tools.approval`** — the per-tool policy map. **Only consulted when `tools.approvalMode: custom`.**

The CLI flag `--auto-approve` (alias `--yolo`) always wins, regardless of mode.

> **Common pitfall:** setting `tools.approval.bash: prompt` without setting `tools.approvalMode: custom` is a silent no-op. The default `auto` mode skips the approval layer wholesale.

> **⚠ Subagent caveat:** the `task` tool spawns a subagent that always runs with `tools.approvalMode: auto` because it has no UI to prompt against. Anything `task` is asked to do — including `bash`, `write`, `eval` — runs unattended once the parent `task` call is approved. The single approval prompt on `task` is the chokepoint; the prompt now shows the agent id and assignment so you can decide what you're authorizing. See [Subagents](#subagents) below.

### Built-in defaults (mode `prompt` / `custom`)

- **Read-only tools** (read, find, search, ast_grep, web_search, recall, inspect_image, job) are auto-allowed.
- **Destructive tools** (bash, write, edit, ast_edit, debug, browser, eval, task, ssh, retain, reflect, checkpoint, rewind) require approval.
- **External/custom tools** (MCP, extensions) require approval.
- **LSP** prompts by default, but read-only actions (`diagnostics`, `definition`, `references`, `hover`, `symbols`, …) are auto-allowed.
- **Debug** prompts by default, but inspection actions (`threads`, `stack_trace`, `variables`, `scopes`, `read_memory`, …) are auto-allowed.
- **Critical bash patterns** always prompt, even if bash is allowlisted — except when you explicitly `deny` bash, in which case the deny still wins.

### Action-Based Exceptions

Some tools have **action-based exceptions** that apply policy based on specific inputs:

**LSP Tool** (performance optimization):
- Default policy: `prompt`
- Exception: read-only actions → auto-allowed
- Result: `diagnostics`, `hover`, `references` don't prompt; `rename`, `code_actions` do prompt

**Bash Tool** (safety override):
- Default policy: `prompt`
- Exception: critical patterns → force prompt (overrides user `allow`)
- Result: `rm -rf /`, `sudo rm`, fork bombs always prompt when bash is `allow` or unset; a user `bash: deny` still wins.

## Quick Start

### Bypass all approvals for automation

```bash
omp --auto-approve -p "Fix all TypeScript errors"
omp --yolo -p "Refactor the auth module"
```

### Enable per-tool prompts for interactive work

Per-tool policies require **both** the mode switch and the policy map. Add to `~/.omp/agent/config.yml` or `.omp/config.yml`:

```yaml
tools:
  approvalMode: custom    # REQUIRED — without this, `tools.approval` is ignored
  approval:
    bash: allow           # Never prompt for bash
    write: prompt         # Always prompt for write
    edit: allow           # Never prompt for edit
    custom-tool: deny     # Block a custom tool entirely
```

## Configuration

### `tools.approvalMode`

| Value    | Behavior                                                                  |
| -------- | ------------------------------------------------------------------------- |
| `auto`   | (default) Skip approval. `tools.approval` is **not** consulted.           |
| `prompt` | Use built-in per-tool defaults. `tools.approval` is **not** consulted.    |
| `custom` | Use `tools.approval.<tool>`; fall back to built-in defaults for the rest. |

### Policy Values (under `tools.approval.<tool>`)

- `allow` — Auto-approve (never prompt)
- `deny` — Block the tool entirely (throws error)
- `prompt` — Require user confirmation (default for destructive tools)

### Resolution Order (mode `custom`)

1. **Overriding** action exceptions (safety rules) — but a user `deny` still wins.
2. User config for the specific tool (`tools.approval.<toolName>`), validated — invalid values fall through.
3. **Non-overriding** action exceptions (performance optimizations).
4. Built-in default for the tool (see `DEFAULT_APPROVAL_POLICIES`).
5. User-supplied `_default` (only consulted for tools with no built-in default — MCP/custom).
6. System-wide fallback (`prompt`).

### Critical Pattern Override

Dangerous bash patterns **always** prompt when bash is `allow` or unset:

```bash
rm -rf /
sudo rm -rf
:(){ :|:& };:
chmod -R 777 /
```

These patterns force confirmation even if `tools.approval.bash: allow` is set. If you set `tools.approval.bash: deny`, the deny wins — the override never re-arms a denied tool.

## Non-Interactive Mode

When approval is required but no UI is available (e.g., RPC mode, `--mode json`), the tool throws:

```
Tool "bash" requires approval but no interactive UI available.
Options:
  1. Use --auto-approve flag
  2. Set tools.approvalMode: auto in config (default)
  3. Set tools.approvalMode: custom and add tools.approval.bash: allow
```

## Subagents

Subagents launched by the `task` tool always run with `tools.approvalMode: auto` regardless of parent settings, because they have no UI to prompt against. The user's approval of the parent `task` call is the authorization for the subagent's work — configure the parent to gate task dispatch (`tools.approval.task: prompt` under `tools.approvalMode: custom`) if you want a chokepoint.

## Automated Workflows

For CI/CD or scripted workflows, use `--auto-approve`:

```bash
# GitHub Actions
omp --auto-approve --no-session -p "Run tests and fix linting"

# Cron job
omp --yolo -p "Update dependencies and commit"
```

## Security Considerations

- **Trust your prompts**: `--auto-approve` bypasses all safety checks
- **Review allowlists**: Regularly audit `tools.approval` config
- **Critical patterns**: Cannot be `allow`-ed away (this is intentional); `deny` still wins
- **External tools**: Require approval by default (no built-in allowlist)
- **Subagents**: Inherit auto-approve unconditionally — the chokepoint is the parent `task` call.

## Examples

### Allow bash and write for local development

```yaml
# .omp/config.yml (project-local)
tools:
  approvalMode: custom
  approval:
    bash: allow
    write: allow
```

### Deny browser tool in shared environments

```yaml
# ~/.omp/agent/config.yml (user-global)
tools:
  approvalMode: custom
  approval:
    browser: deny
```

### Selective automation

```bash
# Auto-approve for known-safe operations
omp --auto-approve --tools read,find,grep -p "Analyze codebase"

# Manual approval for destructive changes
omp -p "Refactor authentication module"
```

## Migration from Extensions

If you previously used a custom extension for approval (e.g., `confirm-destructive.ts`), you can:

1. **Remove the extension** — built-in approval supersedes it
2. **Migrate allowlists** — convert extension config to `tools.approval.*` and set `tools.approvalMode: custom`
3. **Test behavior** — verify prompts appear as expected

Example migration:

```typescript
// Old extension: ~/.omp/agent/extensions/confirm-destructive.ts
const ALLOWED_TOOLS = ["read", "find", "search"];
```

```yaml
# New config: ~/.omp/agent/config.yml
tools:
  approvalMode: custom
  approval:
    bash: prompt
    write: prompt
    edit: prompt
    # read/find/search already auto-allowed by default
```

## Troubleshooting

### "I set `tools.approval.bash: prompt` but nothing prompts"

**Problem**: `tools.approvalMode` is still at its `auto` default, which ignores `tools.approval`.

**Solution**: Add `tools.approvalMode: custom` to the same config file.

### "Tool requires approval but no UI available"

**Problem**: Running in non-interactive mode (RPC, JSON, headless) with approval required.

**Solution**:
- Add `--auto-approve` flag, or
- Set `tools.approvalMode: auto` (or back to the default), or
- Set `tools.approvalMode: custom` and `tools.approval.<tool>: allow`

### Prompts appear for read-only tools

**Problem**: Custom or MCP tools may not be recognized as read-only.

**Solution**:
```yaml
tools:
  approvalMode: custom
  approval:
    custom-readonly-tool: allow
```

### Critical pattern bypass attempt

**Problem**: `rm -rf /` prompts even though bash is allowlisted.

**Behavior**: **This is intentional**. Critical patterns cannot be auto-approved via `tools.approval.bash: allow`. If you genuinely want to block bash entirely, use `tools.approval.bash: deny` — that wins over the override.

## See Also

- [Configuration Reference](config.md)
- [Custom Tools](custom-tools.md)
- [Extensions](extensions.md)
- GitHub Issue [#1030](https://github.com/can1357/oh-my-pi/issues/1030)
