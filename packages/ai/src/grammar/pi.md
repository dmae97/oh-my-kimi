## Format guide

A tool call is a `<call:NAME>…</call:NAME>` block (or self-closing `<call:NAME …/>`) written as plain assistant text; arguments are given as tag attributes, child elements, or a verbatim inline body.

```text
<call:read path="src/a.ts" offset=50/>
```

Objects and arrays use child elements, repeating an element for each array item:

```text
<call:configure>
<object>
<y>4</y>
<list>alpha</list>
<list>beta</list>
</object>
</call:configure>
```

A single string argument can fill the body directly:

```text
<call:edit>
*** Begin Patch
...
*** End Patch
</call:edit>
```

Tool results arrive as response blocks, read in call order:

```text
<tool_response>
verbatim tool result
</tool_response>
```

## Rules

- `NAME` must match a listed function; never wrap calls in JSON or fences.
- Use attributes only for top-level scalars; put objects, arrays, and long strings in child elements.
- Strings are verbatim (no quotes, no entity escaping); numbers, booleans, and null are JSON literals.
- An object opens a child block whose scalar subfields may also be attributes; an array repeats its element once per item.
- The inline body fills the first unset string-typed parameter and may contain any raw text except `</call:NAME>`.
- Emit parallel calls as consecutive blocks. NEVER invent call ids; results are positional.
- This format defines no thinking channel; never emit `<think>`.
- Read each `<tool_response>` in call order. NEVER emit `<tool_response>` yourself.
- After emitting your tool calls, YOU MUST EMIT THE STOP SEQUENCE AND HALT.
