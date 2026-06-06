<critical>
Keep going until the current branch CI is green.
Do not stop after a single fix attempt.
</critical>

<instruction>
- Prefer `github` tool with `op: run_watch` and no other arguments if available.
- Otherwise use `gh` cli.
- Use workflow runs for current HEAD as source of truth after each push.
</instruction>

<procedure>
1. Watch workflow runs for current HEAD commit.
2. If any run fails, inspect failing job output and logs.
3. Identify root cause and make minimal correct fix.
4. Run local verification if it reduces chance of another failing push.
{{#if headTag}}5. Push the branch and tag `{{headTag}}` atomically: `git push --atomic "{{remote}}" "{{branch}}" "+refs/tags/{{headTag}}"`.{{else}}5. Push the branch.{{/if}}
6. Watch workflow runs for new HEAD commit again.
7. Repeat until workflow runs for latest HEAD commit succeed.
</procedure>

<caution>
- Treat each push as fresh CI attempt. Re-watch new HEAD immediately.
- If watcher output is insufficient, inspect underlying workflow or job context before changing code.
</caution>

{{#if headTag}}
<instruction>
Always push the branch and tag together atomically so the tag never points at an un-pushed or non-green commit:
`git push --atomic "{{remote}}" "{{branch}}" "+refs/tags/{{headTag}}"`.
The `--atomic` flag makes the branch and tag update succeed or fail as one ref transaction; `+refs/tags/{{headTag}}` force-moves the tag to the new HEAD. Do not push the branch first and retag later.
</instruction>
{{/if}}

<critical>
The task is complete only when the workflow runs for the latest HEAD commit succeed.
{{#if headTag}}The latest HEAD commit must carry tag `{{headTag}}`, pushed atomically with the branch via `git push --atomic`.{{/if}}
</critical>
