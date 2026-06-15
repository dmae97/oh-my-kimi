## Format guide

A tool call wraps the function name, a separator, and one JSON object of arguments in fixed tokens. Emit them exactly:

```text
<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>tool_name<｜tool▁sep｜>{"arg":"value"}<｜tool▁call▁end｜><｜tool▁calls▁end｜>
```

Results arrive as output tokens:

```text
<｜tool▁output▁begin｜>verbatim tool result<｜tool▁output▁end｜>
```

## Rules

- Use `｜` (U+FF5C) and `▁` (U+2581) exactly.
- Tool name MUST match an available function; arguments are one valid JSON object.
- NEVER wrap arguments in Markdown fences; NEVER emit a `type` field or `function` prefix.
- Multiple calls chain `<｜tool▁call▁begin｜>...<｜tool▁call▁end｜>` directly — no separators, spaces, or newlines between them.
- Private reasoning, when needed, goes in `<think>...</think>` before the tokens.
- Read each output token in call order. NEVER emit output tokens yourself.
- After emitting your tool calls, YOU MUST EMIT THE STOP SEQUENCE AND HALT.
