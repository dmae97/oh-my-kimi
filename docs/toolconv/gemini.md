# Gemini Pythonic tool-calling format (`tool_code` / `default_api`)

Tool-calling convention of Google's hosted **Gemini** models (current generation, incl. `gemini-3.5-flash` / `*-pro` / `*-preview`) and the **Gemma 3** open-weights family. Both drive tool use **entirely through prompt engineering** — there are **no dedicated special tokens**. The model emits each invocation as **Python source**: a call `default_api.<function_name>(<kwargs>)`, conventionally wrapped in `print(...)` and placed inside a fenced ```` ```tool_code ```` block; it reads results back from a ```` ```tool_outputs ```` block. Because the mechanism is plain text the model was post-trained to produce, the exact same syntax periodically leaks into ordinary output (surfaced by Vertex/AI-Studio as `finish_reason = MALFORMED_FUNCTION_CALL`) — that leak is the clearest public evidence of the format.

Verified against: the official Gemma 3 function-calling guide (`ai.google.dev/gemma/docs/capabilities/function-calling` — the two recommended prompts, one Pythonic and one JSON), Simon Willison's transcription of those two prompts, Philipp Schmid's Gemma 3 walkthrough (`philschmid.de/gemma-function-calling`), and the reverse-engineered hosted-Gemini form recovered from `MALFORMED_FUNCTION_CALL` reports: `google/adk-go#492` (`Malformed function call: print(default_api.`), `google-gemini/cookbook#929` (`executableCode` part = `print(default_api.get_complaint_number_tool(consumer_number_or_mobile_number='2001234567'))`), `firebase/genkit#2628` (the ```` ```tool_code ```` markdown wrapper), and the Google AI dev-forum thread "Gemini 2 flash returns raw markdown instead of function call" (71964).

## "Special" tokens

**None.** Nothing here is a control token in the tokenizer's special-token table — every marker below BPE-splits into ordinary text and survives a `skip_special_tokens=True` decode. This is the defining property of the convention and the reason it both (a) works across hosted Gemini and open Gemma without tokenizer support and (b) leaks. The functional markers are:

| Marker (verbatim) | Role |
|---|---|
| ` ```tool_code ` | Opens a fenced block whose body is Python the app must execute. Closed by a bare ` ``` `. |
| ` ```tool_outputs ` | Opens a fenced block carrying the executed results back to the model. Closed by a bare ` ``` `. |
| `default_api` | Synthetic module namespace the hosted stack bundles un-namespaced tools into. Calls read `default_api.<name>(...)`. |
| `print(...)` | Conventional wrapper around the call in the hosted-Gemini form (the model is trained to "print" the call). Semantically irrelevant — the runtime parses the call, it does not execute Python. |

There is **no** per-call id on the wire and **no** in-band reasoning marker — Gemini reasoning travels out of band as API "thought signatures", never as `<think>`-style text.

## Roles / turn structure

The Pythonic payload is independent of the envelope, and the envelope differs by deployment:

- **Hosted Gemini** uses the normal `contents[]` turn structure (`role: "user" | "model"`); the `tool_code` block appears inside a `model` turn's text, and `tool_outputs` is supplied as the next turn.
- **Gemma 3** (open weights) uses the Gemma chat template (`<start_of_turn>user … <end_of_turn>` / `<start_of_turn>model`); the tool prompt is prepended to the first user turn and the blocks live inside model/user turns.

This document specifies the **payload** (the two fenced blocks + the Python call form); the surrounding turn tokens belong to whichever template hosts it.

## Tool definitions

Tools are advertised in the prompt as a JSON-Schema catalog. Gemma 3's official guide ships **two** interchangeable system-prompt templates that differ only in how the model is told to answer:

1. **Pythonic** (the one this spec targets):
   > You have access to functions. If you decide to invoke any of the function(s), you MUST put it in the format of `[func_name1(params_name1=params_value1, params_name2=params_value2...), func_name2(params)]`
   > You SHOULD NOT include any other text in the response if you call a function

2. **JSON** (the sibling convention — see `qwen3.md` for the closely related Hermes shape):
   > … you MUST put it in the format of `{"name": function name, "parameters": dictionary of argument name and its value}`

Hosted Gemini wraps the same idea in markdown fences and the `default_api` namespace. The function signatures themselves are passed as OpenAI-style tool JSON (`{"type":"function","function":{name,description,parameters}}`).

## Tool-call format

One call is a Python call expression. The hosted-Gemini canonical form is a `print()` of a `default_api` method, fenced:

````text
```tool_code
print(default_api.get_current_temperature(location="London", unit="celsius"))
```
````

All of the following are accepted equivalents seen in the wild and across Gemma/Gemini variants; a robust parser normalizes them to `{name, arguments}`:

- `print(default_api.NAME(KWARGS))` — hosted Gemini canonical.
- `default_api.NAME(KWARGS)` — `print`/namespace are optional sugar.
- `NAME(KWARGS)` — bare call (Gemma 3 Pythonic prompt).
- `result = NAME(KWARGS)` — assignment form (Gemma 3 docs use `result = convert(...)`).

Argument values are **Python literals**, not JSON:

| Python literal | Example | Decoded |
|---|---|---|
| string | `'London'` or `"London"` | `"London"` |
| int / float | `42`, `3.14` | `42`, `3.14` |
| bool | `True` / `False` | `true` / `false` |
| null | `None` | `null` |
| list | `["a", "b"]` | `["a","b"]` |
| dict | `{"k": 1}` | `{"k":1}` |

Strings use Python escaping (`\n`, `\t`, `\\`, `\'`, `\"`); hosted Gemini emits single quotes (`location='London'`), Gemma examples use double quotes — both are valid. Arguments are keyword form (`name=value`); positional arguments are not used because the runtime maps to a named schema.

## Multiple / parallel tool calls

Two encodings exist, both inside a single `tool_code` block:

- **Gemma 3 Pythonic prompt** — a Python **list** of call expressions:
  ````text
  ```tool_code
  [get_current_temperature(location="London"), get_temperature_date(location="London", date="2024-10-01")]
  ```
  ````
- **Hosted Gemini** — one `print(default_api...)` **statement per line**:
  ````text
  ```tool_code
  print(default_api.get_current_temperature(location="London"))
  print(default_api.get_temperature_date(location="London", date="2024-10-01"))
  ```
  ````

Either way the calls are returned in source order; the application executes them and returns one result per call in the same order.

## Tool-result format

Executed results are returned to the model in a ```` ```tool_outputs ```` block. Gemma 3 docs use assignment-style values (`result = 92.3`); for opaque tool output the block simply carries the returned text/JSON:

````text
```tool_outputs
{"temperature": 26.1, "location": "London", "unit": "celsius"}
```
````

The model then continues with either a natural-language answer or another `tool_code` block.

## End-to-end example

````text
<user>
What's the temperature in London?

<model>
```tool_code
print(default_api.get_current_temperature(location="London", unit="celsius"))
```

<user>
```tool_outputs
{"temperature": 11.4, "location": "London", "unit": "celsius"}
```

<model>
It's currently 11.4°C in London.
````

## OpenAI-compatible / native API mapping

- Hosted Gemini's native API normally returns a structured `functionCall` part (`{name, args}`); for Gemini 3 each carries an `id` that must be echoed in the matching `functionResponse`, plus a `thoughtSignature` that must be preserved. The Pythonic text form is what you get when the structured path *fails* (`finish_reason = MALFORMED_FUNCTION_CALL`) or when tool use is driven purely by prompt (Gemma, or Gemini via the code-execution `executableCode` part).
- When parsed out of an OpenAI-compatible shim, each recovered call becomes `tool_calls[i] = {id (server-minted), type:"function", function:{name, arguments:<JSON string>}}` — the Python kwargs are re-serialized to a JSON string at that boundary.
- Feed results back as the deployment's tool/`functionResponse` turn (hosted) or a `tool_outputs` block in the next user turn (prompt-driven).

## Parsing notes & gotchas

- **Python, not JSON.** `True`/`False`/`None` (not `true`/`false`/`null`), single-quoted strings, and trailing commas are all legal. A JSON parser will reject valid calls; decode Python literals.
- **Strip the wrapper.** Normalize away `print(...)`, a `default_api.` (or any `module.`) prefix, and an `LHS =` assignment before reading the call name. `print` is never a tool name.
- **Skip string contents when scanning.** A call like `search(pattern="foo(")` contains a `(` inside a string; a naive `\w+\(` scan mis-detects `foo` as a callee. Track string state and only treat top-level `(` as a call opener.
- **Fence ambiguity.** The body terminates at the first bare ` ``` `; a string argument literally containing ` ``` ` will truncate the block early (rare, accepted limitation).
- **It leaks.** Because nothing is a special token, the format appears verbatim in normal responses when the model "decides" to call a tool but the structured decoder misfires. Production code reading raw text should detect ` ```tool_code ` and parse it; production code on the structured API should retry on `MALFORMED_FUNCTION_CALL`.
- **Variant divergence.** Gemma **4** abandoned this Pythonic form for a token-delimited brace syntax (`<|tool_call>call:NAME{…}<tool_call|>`) — a different convention documented in `gemma.md`. This spec covers hosted Gemini and Gemma 3.

## Sources

- Gemma 3 function calling (two recommended prompts): https://ai.google.dev/gemma/docs/capabilities/function-calling
- Simon Willison, "Function calling with Gemma": https://simonwillison.net/2025/Mar/26/function-calling-with-gemma/
- Philipp Schmid, "Google Gemma 3 Function Calling Example": https://www.philschmid.de/gemma-function-calling
- Gemini 3 thought signatures + functionCall ids: https://ai.google.dev/gemini-api/docs/gemini-3
- `default_api` / `tool_code` leak evidence: https://github.com/google/adk-go/issues/492 · https://github.com/google-gemini/cookbook/issues/929 · https://github.com/firebase/genkit/issues/2628 · https://discuss.ai.google.dev/t/gemini-2-flash-api-returns-raw-markdown-instead-of-function-call/71964
