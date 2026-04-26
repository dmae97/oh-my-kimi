## Code Review Request

### Mode

{{mode}}

### Changed Files ({{len files}} files, +{{totalAdded}}/-{{totalRemoved}} lines)

{{#if files.length}}
{{#table files headers="File|+/-|Type"}}
{{path}} | +{{linesAdded}}/-{{linesRemoved}} | {{ext}}
{{/table}}
{{else}}
_No files to review._
{{/if}}
{{#if excluded.length}}
### Excluded Files ({{len excluded}})

{{#list excluded prefix="- " join="\n"}}
`{{path}}` (+{{linesAdded}}/-{{linesRemoved}}) — {{reason}}
{{/list}}
{{/if}}

### Distribution Guidelines

{{#when agentCount "==" 1}}Use **1 reviewer agent**.{{else}}Spawn **{{agentCount}} reviewer agents** in parallel.{{/when}}
{{#if multiAgent}}
Group files by locality, e.g.:
- Same directory/module → same agent
- Related functionality → same agent
- Tests with their implementation files → same agent

You **MUST** use Task tool with `agent: "reviewer"` and `tasks` array.
{{/if}}

### Reviewer Instructions

Reviewer **MUST**:
1. Focus ONLY on assigned files
2. {{#if skipDiff}}**MUST** run `git diff`/`git show` for assigned files{{else}}**MUST** use diff hunks below (**MUST NOT** re-run git diff){{/if}}
3. **MAY** read full file context as needed via `read`
4. Call `report_finding` per issue
5. Call `yield` with verdict when done

{{#if skipDiff}}
### Diff Previews

_Full diff too large ({{len files}} files). Showing first ~{{linesPerFile}} lines per file._

{{#list files join="\n\n"}}
#### {{path}}

{{#codeblock lang="diff"}}
{{hunksPreview}}
{{/codeblock}}
{{/list}}
{{else}}

### Diff

<diff>
{{rawDiff}}
</diff>
{{/if}}

{{#if additionalInstructions}}
### Additional Instructions

{{additionalInstructions}}
{{/if}}
