# Tool Approval Policies

Per-tool approval policies allow fine-grained control over which tools require user confirmation before execution.

## Overview

By default:
- **Read-only tools** (read, find, search, ast_grep, web_search) are auto-allowed
- **Destructive tools** (bash, write, edit, ast_edit, debug, browser, eval) require approval
- **External/custom tools** (MCP, extensions) require approval
- **LSP tool** requires approval by default, but read-only actions (`diagnostics`, `definition`, `references`, `hover`, `symbols`, …) are auto-allowed
- **Debug tool** requires approval by default, but inspection actions (`threads`, `stack_trace`, `variables`, `scopes`, `read_memory`, …) are auto-allowed
- **Critical bash patterns** always prompt, even if bash is allowlisted (safety override)

### Action-Based Exceptions

Some tools have **action-based exceptions** that apply policy based on specific inputs:

**LSP Tool** (performance optimization):
- Default policy: `prompt`
- Exception: read-only actions → auto-allowed
- Result: `diagnostics`, `hover`, `references` don't prompt; `rename`, `code_actions` do prompt

**Bash Tool** (safety override):
- Default policy: `prompt`
- Exception: critical patterns → force prompt (overrides user config)
- Result: `rm -rf /`, `sudo rm`, fork bombs always prompt, even with `bash: allow`

## Quick Start

### Bypass all approvals for automation

```bash
omp --auto-approve -p "Fix all TypeScript errors"
omp --yolo -p "Refactor the auth module"
```

### Configure per-tool policies

Add to `~/.omp/agent/config.yml` or `.omp/config.yml`:

```yaml
tools:
  approval:
    bash: allow        # Never prompt for bash
    write: prompt      # Always prompt for write (default)
    edit: allow        # Never prompt for edit
    custom-tool: deny  # Block a custom tool entirely
```

## Configuration

### Policy Values

- `allow` — Auto-approve (never prompt)
- `deny` — Block the tool entirely (throws error)
- `prompt` — Require user confirmation (default for destructive tools)

### Resolution Order

1. **Overriding** action exceptions (safety rules; user config cannot bypass).
2. User config for the specific tool (`tools.approval.<toolName>`), validated — invalid values fall through.
3. **Non-overriding** action exceptions (performance optimizations).
4. Built-in default for the tool (see `DEFAULT_APPROVAL_POLICIES`).
5. User-supplied `_default` (only consulted for tools with no built-in default — MCP/custom).
6. System-wide fallback (`prompt`).

### Critical Pattern Override

Dangerous bash patterns **always** prompt, regardless of policy:

```bash
rm -rf /
sudo rm -rf
:(){ :|:& };:
chmod -R 777 /
```

These patterns force confirmation even if `tools.approval.bash: allow` is set.

## Non-Interactive Mode

When approval is required but no UI is available (e.g., RPC mode, `--mode json`), the tool throws:

```
Tool "bash" requires approval but no interactive UI available.
Options:
  1. Use --auto-approve flag
  2. Add to config: tools.approval.bash: allow
```

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
- **Critical patterns**: Cannot be disabled (this is intentional)
- **External tools**: Require approval by default (no built-in allowlist)

## Examples

### Allow bash and write for local development

```yaml
# .omp/config.yml (project-local)
tools:
  approval:
    bash: allow
    write: allow
```

### Deny browser tool in shared environments

```yaml
# ~/.omp/agent/config.yml (user-global)
tools:
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
2. **Migrate allowlists** — convert extension config to `tools.approval.*`
3. **Test behavior** — verify prompts appear as expected

Example migration:

```typescript
// Old extension: ~/.omp/agent/extensions/confirm-destructive.ts
const ALLOWED_TOOLS = ["read", "find", "search"];

// New config: ~/.omp/agent/config.yml
tools:
  approval:
    bash: prompt
    write: prompt
    edit: prompt
    # read/find/search already auto-allowed by default
```

## Troubleshooting

### "Tool requires approval but no UI available"

**Problem**: Running in non-interactive mode (RPC, JSON, headless)

**Solution**:
- Add `--auto-approve` flag, or
- Set `tools.approval.<tool>: allow` in config

### Prompts appear for read-only tools

**Problem**: Custom or MCP tools may not be recognized as read-only

**Solution**:
```yaml
tools:
  approval:
    custom-readonly-tool: allow
```

### Critical pattern bypass attempt

**Problem**: `rm -rf /` prompts even though bash is allowlisted

**Behavior**: **This is intentional**. Critical patterns cannot be auto-approved.

## See Also

- [Configuration Reference](config.md)
- [Custom Tools](custom-tools.md)
- [Extensions](extensions.md)
- GitHub Issue [#1030](https://github.com/can1357/oh-my-pi/issues/1030)
