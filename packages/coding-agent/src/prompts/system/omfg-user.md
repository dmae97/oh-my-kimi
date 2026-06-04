<omfg>
User frustrated about recurring agent behavior.
Author ONE Time Traveling Stream Rule (TTSR) that would have caught offending behavior earlier in conversation.

TTSR mechanics:
- Rule is markdown file with YAML frontmatter.
- `condition` one or more JavaScript regex patterns tested against assistant streamed output.
- `scope` comma-separated allowlist. If present, only listed streams checked.
- `text` = assistant prose only. `thinking` = hidden reasoning summaries. `tool` = every tool's arguments.
- `tool:<name>(<glob>)` = one tool, only when path-like args match glob. Examples: `tool:write(*.rb)`, `tool:edit(*.ts)`.
- Prefer file-specific tool scopes for code complaints. Ruby code generated through `write` SHOULD use `tool:write(*.rb)`, not bare `tool` or `text`.
- Tool arguments MAY be serialized while streaming. Conditions for code containing quotes MUST tolerate JSON escaping when needed.
- When `condition` matches within `scope`, stream interrupted; markdown body injected as correction guidance.
- `description` one-line summary.

Output contract:
- Emit exactly one JSON object, nothing else.
- JSON fields: `name`, `description`, `condition`, `scope`, `body`.
- `name` MUST be kebab-case.
- `description` MUST be one-line summary.
- `condition` MUST be string or string array of JavaScript regex patterns.
- `condition` MUST match specific offending assistant output visible earlier in conversation.
- Escape regex backslashes for JSON exactly once: use `"\\beval\\s*\\("`, NEVER `"\\\\beval\\\\s*\\\\("`.
- Keep `condition` precise; NEVER use broad catch-alls.
- `scope` MUST be string or string array.
- Keep `scope` narrow as complaint allows. NEVER use `tool, text` unless same bad behavior occurred in both tool arguments and assistant prose.
- `body` MUST be markdown guidance explaining the right behavior concisely.
- Caller assembles YAML frontmatter. NEVER emit markdown frontmatter or fenced code block around JSON.

Example shape:
{
  "name": "ts-no-any",
  "description": "NEVER use `any` in TypeScript — use `unknown`, a generic, or the real type",
  "condition": ": any|as any",
  "scope": ["tool:edit(*.ts)", "tool:edit(*.tsx)", "tool:write(*.ts)", "tool:write(*.tsx)"],
  "body": "NEVER use `: any` or `as any`. Use `unknown`, domain type, generic, or type guard."
}

Complaint:
{{complaint}}

{{#if feedback}}
Failed attempts or requested amendments so far:
{{feedback}}

Latest candidate JSON:
{{previousRule}}

Regenerate one corrected rule. Fix listed validation failures or user amendment; NEVER repeat failed scopes or conditions.
{{/if}}
</omfg>
