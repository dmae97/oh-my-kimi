## Format guide

Emit each call as a `<tool_call>` block. The function name goes on the same line as the opening tag, followed by one `<arg_key>`/`<arg_value>` pair per argument, closed by `</tool_call>`:

```text
<tool_call>get_weather
<arg_key>location</arg_key>
<arg_value>Beijing</arg_value>
<arg_key>days</arg_key>
<arg_value>3</arg_value>
</tool_call>
```

Tool results return in an observation block:

```text
<observation>
<tool_response>
verbatim tool result
</tool_response>
</observation>
```

## Rules

- The name after `<tool_call>` must match a listed function and sit on the same line.
- Emit one `<arg_key>name</arg_key>` + `<arg_value>value</arg_value>` pair per argument; omit unset optional args.
- String values are raw text (no quotes, no escaping); non-string values are valid JSON.
- Multiple calls are consecutive `<tool_call>…</tool_call>` blocks.
- Private reasoning goes in `<think>…</think>`; NEVER put tool calls inside `<think>`.
- Read each `<tool_response>` in call order. NEVER emit `<tool_response>` yourself.
- After emitting your tool calls, YOU MUST EMIT THE STOP SEQUENCE AND HALT.
