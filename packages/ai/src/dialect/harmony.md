## Format guide

Each function call is one assistant message on the `commentary` channel addressed to the function, emitted as text:

```text
<|start|>assistant<|channel|>commentary to=functions.function_name<|message|>{"arg":"value"}<|call|>
```

Put private reasoning in an `analysis` message:

```text
<|start|>assistant<|channel|>analysis<|message|>private reasoning<|end|>
```

Tool results arrive as messages authored by the function, addressed back to the assistant:

```text
<|start|>functions.function_name to=assistant<|channel|>commentary<|message|>verbatim tool result<|end|>
```

## Rules

- Recipient is `functions.` + a listed function name.
- Body is one JSON object matching the schema; omit optional arguments you are not setting.
- Multiple calls = consecutive call messages.
- An optional visible preamble is a `commentary` message ending `<|end|>`.
- NEVER put tool calls in `analysis`.
- NEVER wrap calls in Markdown/code fences.
- Read each tool-result message in call order. NEVER emit tool-result messages yourself.
- After emitting your tool calls, YOU MUST EMIT THE STOP SEQUENCE AND HALT.
