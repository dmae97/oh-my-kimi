[IMPORTANT: The user has invoked the "{{name}}" skill, indicating they want you to follow its instructions. The full skill content is loaded below.]

{{body}}

---

[Skill directory: {{baseDir}}]
Resolve any relative paths in this skill (e.g. `scripts/foo.js`, `templates/config.yaml`) against that directory using its absolute path: read referenced assets and templates, and run scripts with the terminal tool when the skill's instructions call for it.
{{#if userArgs}}
User: {{userArgs}}
{{/if}}