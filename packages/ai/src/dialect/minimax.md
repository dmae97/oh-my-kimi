## Format guide

A call is a `<minimax:tool_call>` block wrapping one or more `<invoke>` blocks, each holding `<parameter>` children:

```text
<minimax:tool_call>
<invoke name="tool_name"><parameter name="arg_name">arg value</parameter></invoke>
</minimax:tool_call>
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
- Multiple calls: multiple `<invoke>` blocks in one `<minimax:tool_call>`.
- You MAY write visible text before the calls.
- NEVER emit `tool_calls` JSON.
- NEVER use `<function_calls>` or the legacy `<tool_name>`/`<parameters>` call syntax.
- Read each `<result>`/`<error>` in call order. NEVER emit `<function_results>` yourself.
- After emitting your tool calls, YOU MUST EMIT THE STOP SEQUENCE AND HALT.
