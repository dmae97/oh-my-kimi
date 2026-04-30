<critical>
Keep going until the current branch CI is green.
Do not stop after a single fix attempt.
</critical>

<instruction>
- Prefer the `github` tool with `op: run_watch` and no other arguments if that tool is available.
- Otherwise use `gh` cli.
- Use the workflow runs for the current HEAD commit as the source of truth after each push.
</instruction>

<procedure>
1. Watch the workflow runs for the current HEAD commit.
2. If any run fails, inspect the failing job output and logs.
3. Identify the root cause and make the minimal correct fix.
4. Run local verification when it materially reduces the chance of another failing push.
5. Push the branch.
6. Watch the workflow runs for the new HEAD commit again.
7. Repeat until the workflow runs for the latest HEAD commit succeed.
</procedure>

<caution>
- Treat each new push as a fresh CI attempt and re-watch the new HEAD commit immediately.
- If the watcher output is not sufficient, inspect the underlying workflow or job context before changing code.
</caution>

{{#if headTag}}
<instruction>
Once CI is green, ensure the final commit is tagged `{{headTag}}` and push that tag.
</instruction>
{{/if}}

<critical>
The task is complete only when the workflow runs for the latest HEAD commit succeed.
{{#if headTag}}The final green commit must be tagged `{{headTag}}` and that tag must be pushed.{{/if}}
</critical>
