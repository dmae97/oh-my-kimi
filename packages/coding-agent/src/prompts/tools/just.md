Runs recipes from the project's justfile via the `just` command runner.

<instruction>
- Pass recipe name and args as a single string in `just`, e.g. `{just: "test"}` or `{just: "build --release"}`.
- Runs in the session's cwd. Output (stdout/stderr) and exit code are returned.
</instruction>

<recipes>
{{#each recipes}}
- `{{name}}{{#if paramSig}} {{paramSig}}{{/if}}`{{#if doc}} — {{doc}}{{/if}}
{{/each}}
</recipes>
