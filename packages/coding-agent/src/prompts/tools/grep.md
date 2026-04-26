Searches files using powerful regex matching.

<instruction>
- Supports full regex syntax (e.g., `log.*Error`, `function\\s+\\w+`); literal braces need escaping (`interface\\{\\}` for `interface{}` in Go)
- `path` is required and accepts a file, directory, glob, comma-separated path list, or internal URL
- Cross-line patterns are detected from literal `\n` or escaped `\\n` in `pattern`
</instruction>

<output>
{{#if IS_HASHLINE_MODE}}
- Text output is anchor-prefixed: `123th>content` (match) or `123th:content` (context). The 2-letter ID is a content fingerprint.
{{else}}
{{#if IS_LINE_NUMBER_MODE}}
- Text output is line-number-prefixed
{{/if}}
{{/if}}
{{#if IS_CHUNK_MODE}}
- Text output is chunk-path-prefixed: `path:sel>123|content`
{{/if}}
</output>

<critical>
- You **MUST** use the built-in Grep tool for any content search. Do **NOT** shell out to `grep`, `rg`, `ripgrep`, `ag`, `ack`, `git grep`, `awk`, `sed`-for-search, or any other CLI search via Bash — even for a single match, even "just to check quickly", even piped through other commands.
- Bash `grep`/`rg` returns raw text without chunk paths, loses `.gitignore` semantics, bypasses result limits, and wastes tokens. The Grep tool is faster, structured, and already wired into the workspace — there is no scenario where Bash search is preferable.
- If you catch yourself typing `grep`, `rg`, or `| grep` in a Bash command, stop and re-issue the search through the Grep tool instead.
- If the search is open-ended, requiring multiple rounds, you **MUST** use the Task tool with the explore subagent instead of chaining Grep calls yourself.
</critical>
