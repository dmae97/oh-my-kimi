# External Multi-Agent Stack → OMK Migration Guide

> Generic migration path from any external multi-agent orchestration stack (e.g., gstack, custom frameworks) to OMK.
> OMK v1.1.18+ with externalized skill presets.

## Why Migrate to OMK

| Feature | External Stack | OMK |
|---------|---------------|-----|
| DAG scheduling | Limited or none | Native DAG with evidence gates |
| Skill assignment | Hard-coded | Runtime JSON presets + rules |
| Worktree isolation | Manual | Automatic per-run isolation |
| Decision trace | None | Built-in audit trail |
| Provider routing | Single | Multi-provider with fallback |
| MCP integration | Ad-hoc | First-class project-scoped MCP |

## Phase 1: Inventory

### 1.1 List your current agents/roles

```bash
# In your old stack, list all roles
omk explore --list-roles > old-roles.json
```

Map each role to OMK's 15 built-in roles:
- `explorer`, `researcher`, `planner`, `architect`, `coder`
- `reviewer`, `security`, `qa`, `tester`, `integrator`
- `aggregator`, `interviewer`, `vision-debugger`, `ontology`, `coordinator`

### 1.2 Extract skill/tool/MCP assignments

For each role, document:
- Skills (reusable knowledge packs)
- MCP servers (external tool interfaces)
- Hooks (pre/post execution scripts)
- Tools (allowed tool categories)

## Phase 2: Convert to OMK Presets

### 2.1 Create `src/config/skill-presets.json`

```json
{
  "version": "1.0.0",
  "presets": {
    "your-old-role": {
      "skills": ["your-skill-1", "your-skill-2"],
      "mcpServers": ["your-mcp"],
      "tools": ["search", "read"],
      "hooks": ["your-hook.sh"]
    }
  }
}
```

Validation rules (enforced at runtime):
- All arrays must contain only strings
- No undefined values allowed
- Schema mismatch → automatic fallback to built-in defaults

### 2.2 Add custom SKILL_RULES (optional)

Edit `src/orchestration/skill-assigner.ts` to add intent-detection rules:

```typescript
{
  id: "your-custom-rule",
  match: (node, intent) => intent === "coding" && /your-keyword/.test(node.name),
  assign: { skills: ["your-skill"] },
  priority: 80,
  rationale: "Your custom detection logic"
}
```

## Phase 3: Hook Migration

### 3.1 Convert pre-execution guards

Old stack:
```bash
#!/bin/bash
# old-pre-hook.sh
echo "Running pre-check..."
```

OMK:
```bash
#!/bin/bash
# .omk/hooks/pre-shell-guard.sh
# Automatically injected by skill-assigner for coder/reviewer/security roles
set -euo pipefail
echo "[OMK] Pre-shell guard active"
```

### 3.2 Register hooks in presets

```json
{
  "coder": {
    "hooks": ["protect-secrets.sh", "pre-shell-guard.sh", "post-format.sh"]
  }
}
```

## Phase 4: Runtime Verification

### 4.1 Test preset loading

```typescript
import { loadRoleDefaults } from "./orchestration/skill-assigner.js";

const defaults = await loadRoleDefaults();
console.log("Loaded presets:", Object.keys(defaults));
```

### 4.2 Force reload without restart

```typescript
await loadRoleDefaults(true); // force = true
```

### 4.3 Verify decision traces

```bash
omk trace --component skill-assigner --run-id <run-id>
```

## Phase 5: Memory-Injection Safety

OMK's skill-assigner includes automatic schema validation:

```typescript
function validatePresets(data: unknown): boolean {
  // Rejects:
  // - Non-object root
  // - Non-string version
  // - Non-array skills/mcpServers/tools/hooks
  // - Non-string array elements
  // Falls back to hard-coded ROLE_DEFAULTS_FALLBACK on any error
}
```

**Best practices:**
1. Never trust external JSON → always validate
2. Use fallback defaults for production safety
3. Version your preset files
4. Audit decision traces after rule changes

## Appendix: Full Role Mapping

| Old Role | OMK Role | Default Preset |
|----------|----------|---------------|
| Code Writer | `coder` | 8 skills, 3 hooks |
| Code Reviewer | `reviewer` | 6 skills, 2 hooks |
| Test Engineer | `tester` | 4 skills, 2 hooks |
| DevOps | `integrator` | 3 skills, 3 hooks |
| Architect | `architect` | 4 skills, 1 hook |
| Researcher | `researcher` | 4 skills, 1 hook |
| Explorer | `explorer` | 3 skills, 1 hook |
| Security Auditor | `security` | 4 skills, 3 hooks |
| QA Engineer | `qa` | 5 skills, 2 hooks |
| Team Lead | `coordinator` | (add custom preset) |

## See Also

- `src/config/skill-presets.json` — editable runtime presets
- `src/orchestration/skill-assigner.ts` — assignment engine with validation
- `src/evidence/decision-trace.ts` — audit trail for all assignments
