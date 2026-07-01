# manage_skill

> Create, update, or delete an isolated managed skill.

## Source
- Entry: `packages/coding-agent/src/tools/manage-skill.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/manage-skill.md`
- Managed-skill helper: `packages/coding-agent/src/autolearn/managed-skills.ts`
- Skill discovery: `packages/coding-agent/src/extensibility/skills.ts`

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `action` | `"create" \| "update" \| "delete"` | Yes | Managed-skill mutation. |
| `name` | `string` | Yes | Kebab-case managed skill name. |
| `description` | `string` | Create/update | One-line description used for skill discovery. |
| `body` | `string` | Create/update | Markdown body for `SKILL.md`; do not include frontmatter. |

## Outputs
- `delete`: `content[0].text = "Deleted managed skill \"<name>\"."`, `details = { action: "delete", name }`
- `create`: `content[0].text = "Created managed skill \"<name>\" (managed-skills/<name>/SKILL.md)."`, `details = { action: "create", name }`
- `update`: `content[0].text = "Updated managed skill \"<name>\" (managed-skills/<name>/SKILL.md)."`, `details = { action: "update", name }`
- Authored-skill shadowing on create returns `isError: true` with `details = { action: "create", name, shadowed: true }`.

## Flow
1. `ManageSkillTool.createIf(...)` exposes the tool only when `autolearn.enabled` is true.
2. Schema validation requires `description` and `body` for `create` / `update`; `delete` needs only `name`.
3. `delete` calls `deleteManagedSkill(name)` and returns.
4. `create` checks whether an authored skill already owns the sanitized name; if yes, it refuses because managed skills cannot override authored skills.
5. `create` / `update` call `writeManagedSkill(...)`, which sanitizes frontmatter, serializes same-name writes, and writes `SKILL.md` under the managed-skills root.

## Modes / Variants
- `create`: create a new managed skill; helper fails if it already exists.
- `update`: overwrite an existing managed skill body/frontmatter; helper fails if it does not exist.
- `delete`: remove an existing managed skill; helper fails if it does not exist.

## Side Effects
- Filesystem: writes or deletes files under `~/.omp/agent/managed-skills`.
- Network: none.
- Session state: only reads `autolearn.enabled` during tool creation.
- Background work: none.

## Limits & Caps
- Availability requires `autolearn.enabled`.
- Names must match lowercase letters, digits, and hyphens, 1–64 chars, starting with a letter or digit.
- Descriptions are sanitized to one line and stripped of prompt-breaking control chars, angle brackets, backticks, and repeated tildes.
- Final managed `SKILL.md` content is capped at `64_000` UTF-8 bytes.
- The managed-skills root and skill directory/file are checked to avoid symlink/hardlink escapes before write/update/delete.

## Errors
- Invalid names throw `Invalid skill name "<raw>"...`.
- Empty sanitized descriptions throw `Managed skill "<name>" needs a non-empty description.`
- Empty bodies throw `Managed skill "<name>" needs a non-empty body.`
- Oversized final files throw `Managed skill is <bytes> bytes; the limit is 64000.`
- Unsafe roots, symlinked directories/files, hard-linked files, missing update/delete targets, and existing create targets throw helper errors.

## Notes
- Managed skills are generated under `~/.omp/agent/managed-skills` and never edit user-authored skills.
- Do not include YAML frontmatter in `body`; `writeManagedSkill(...)` generates `name` and sanitized `description` frontmatter.
