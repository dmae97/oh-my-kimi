Run a recipe / script / target from the project's task runners.

<instruction>
- `op` is a single string: task name plus any args, e.g. `{op: "test"}` or `{op: "build --release"}`.
- In monorepos, package and Cargo target tasks are namespaced with `/`, e.g. `{op: "pkg-a/test"}` or `{op: "crate/bin/server"}`.
{{#if hasMultipleRunners}}- When the same task name exists in more than one runner, prefix with the runner id, e.g. `{op: "{{ambiguityExampleRunner}}:{{ambiguityExampleTask}}"}`. The available runner ids are: {{#each runners}}`{{id}}`{{#unless @last}}, {{/unless}}{{/each}}.
{{/if}}- Runs in the session's cwd. Output and exit code are returned in the same shape as `bash`.
</instruction>

{{#each runners}}
<runner id="{{id}}" label="{{label}}" command="{{commandPrefix}}">
{{#each tasks}}
- `{{name}}{{#if paramSig}} {{paramSig}}{{/if}}`{{#if doc}} — {{doc}}{{/if}}{{#if command}} (`{{command}}`{{#if cwd}} in `{{cwd}}`{{/if}}){{/if}}
{{/each}}
</runner>
{{/each}}
