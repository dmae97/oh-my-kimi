## Format guide

A call is one `<invoke>` element whose `<parameter>` children carry its arguments:

```text
<invoke name="fn"><parameter name="arg">value</parameter></invoke>
```

Emit consecutive `<invoke>…</invoke>` blocks for multiple calls; you MAY wrap them in `<tool_calls>…</tool_calls>`. Each call's result arrives as a response block:

```text
<tool_response>
verbatim tool result
</tool_response>
```

## Rules

- `name` MUST match a listed function.
- String values are literal text (no JSON quotes or escaping); non-string values are JSON. Add `string="false"` to a parameter only to force JSON parsing of a value the schema treats as a string.
- Read each `<tool_response>` in call order. NEVER emit `<tool_response>` yourself.
- After emitting your tool calls, YOU MUST EMIT THE STOP SEQUENCE AND HALT.
