Finds files using fast pattern matching that works with any codebase size.

<instruction>
- You **SHOULD** perform multiple searches in parallel when potentially useful
</instruction>

<output>
Matching file paths sorted by modification time (most recent first). Truncated at 1000 entries or 50KB (configurable via `limit`).
</output>

<example name="find files">
```
{
  "pattern": "src/**/*.ts",
  "limit": 1000
}
```
</example>

<avoid>
For open-ended searches requiring multiple rounds of globbing and grepping, you **MUST** use Task tool instead.
</avoid>
