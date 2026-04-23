Searches files using powerful regex matching.

<instruction>
- Supports full regex syntax (e.g., `log.*Error`, `function\\s+\\w+`); literal braces need escaping (`interface\\{\\}` for `interface{}` in Go)
- `path` also accepts comma-separated path lists; pair with `glob` when you need a relative file filter in addition to `type`
- For cross-line patterns like `struct \\{[\\s\\S]*?field`, set `multiline: true`
- If the pattern contains a literal `\n`, `multiline` defaults to true automatically
</instruction>

<output>
{{#if IS_HASHLINE_MODE}}
- Text output is CID prefixed: `LINE#ID:content`
{{else}}
{{#if IS_LINE_NUMBER_MODE}}
- Text output is line-number-prefixed
{{/if}}
{{/if}}
{{#if IS_CHUNK_MODE}}
- Text output is chunk-path-prefixed: `path:selector>LINE|content`
{{/if}}
</output>

<critical>
- You **MUST** use Grep when searching for content.
- You **MUST NOT** invoke `grep` or `rg` via Bash.
- If the search is open-ended, requiring multiple rounds, you **MUST** use Task tool with explore subagent instead.
</critical>
