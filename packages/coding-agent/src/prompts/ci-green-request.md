<critical>
Keep iterating until CI on the current branch is green. One fix attempt usually isn't enough — plan to go around the loop a few times.
</critical>

<instruction>
- Reach for the `github` tool with `op: run_watch` and no other arguments when it's available.
- Otherwise fall back to the `gh` cli.
- Treat workflow runs for the current HEAD as the source of truth after each push.
</instruction>

<procedure>
1. Watch workflow runs for the current HEAD commit.
2. If a run fails, inspect the failing job output and logs.
3. Identify the root cause and make the minimal correct fix.
4. Run local verification when it would meaningfully reduce the chance of another failing push.
5. Push the branch.
6. Watch workflow runs for the new HEAD commit.
7. Repeat until the workflow runs for the latest HEAD commit succeed.
</procedure>

<caution>
- Treat each push as a fresh CI attempt — re-watch the new HEAD right away.
- If the watcher output isn't enough to diagnose the failure, dig into the underlying workflow or job context before changing code.
</caution>

{{#if headTag}}
<instruction>
Once CI is green, make sure the final commit is tagged `{{headTag}}` and push that tag.
</instruction>
{{/if}}

<critical>
The task is done when the workflow runs for the latest HEAD commit succeed.
{{#if headTag}}The final green commit should be tagged `{{headTag}}` and that tag should be pushed.{{/if}}
</critical>
