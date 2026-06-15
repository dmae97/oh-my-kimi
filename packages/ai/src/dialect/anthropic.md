## Format guide

A call is a `<function_calls>` block wrapping one or more `<invoke>` blocks, each holding `<parameter>` children:

```text
<function_calls>
<invoke name="tool_name"><parameter name="arg_name">arg value</parameter></invoke>
</function_calls>
```

Results arrive later in a `<function_results>` block, one `<result>` per call (failures use `<error>` with `<stderr>` in place of `<result>` with `<stdout>`):

```text
<function_results>
<result>
<tool_name>tool_name</tool_name>
<stdout>verbatim tool result</stdout>
</result>
</function_results>
```

## Rules

- `name` MUST match a listed function.
- String/scalar parameters: exact text, spaces preserved. Lists/objects: JSON.
- Multiple calls: multiple `<invoke>` blocks in one `<function_calls>`.
- You MAY write visible text before the calls.
- NEVER emit `tool_calls` JSON.
- NEVER use the legacy `<tool_name>`/`<parameters>` call syntax.
- Read each `<result>`/`<error>` in call order. NEVER emit `<function_results>` yourself.
- After emitting your tool calls, YOU MUST EMIT THE STOP SEQUENCE AND HALT.
