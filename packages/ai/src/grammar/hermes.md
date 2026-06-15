## Format guide

Emit each call as a `<tool_call>` block wrapping a single-line JSON object with `name` and `arguments`:

```text
<tool_call>
{"name":"function_name","arguments":{"arg":"value"}}
</tool_call>
```

Results arrive later as `<tool_response>` blocks:

```text
<tool_response>
verbatim tool result
</tool_response>
```

## Rules

- `name` MUST match a listed function; `arguments` is a JSON object, never a stringified JSON.
- Emit multiple calls as consecutive `<tool_call>` blocks; keep any prose outside them.
- Read each `<tool_response>` in call order. NEVER emit `<tool_response>` yourself.
- After emitting your tool calls, YOU MUST EMIT THE STOP SEQUENCE AND HALT.
