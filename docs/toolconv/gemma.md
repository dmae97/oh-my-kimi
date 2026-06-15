# Gemma 4 tool-calling format (token-delimited `call:NAME{…}`)

Tool-calling convention of Google's **Gemma 4** open-weights family (`google/gemma-4-*-it`). It is a clean break from the prompt-engineered Pythonic `tool_code` form used by Gemma 3 and hosted Gemini (see `gemini.md`): Gemma 4 introduces **dedicated special tokens** and a compact **token-delimited brace syntax**. Tool declarations, calls, and responses each get their own paired markers, and every string value is wrapped in a `<|"|>` token rather than ASCII quotes. The model emits one call as `<|tool_call>call:NAME{key:value,…}<tool_call|>`; the developer parses it, runs the tool, and appends `<|tool_response>response:NAME{…}<tool_response|>`.

Verified against: the official "Function calling with Gemma 4" guide (`ai.google.dev/gemma/docs/capabilities/text/function-calling-gemma4`), including the byte-exact `processor.apply_chat_template(...)` renderings and the reference `extract_tool_calls` regex it ships. All example streams below are copied from that page (model `google/gemma-4-E2B-it`).

## Special tokens

Gemma 4 wraps each structural element in a paired token. Note the **asymmetric pipe placement** — an opener carries the pipe on the left (`<|x>`) and its closer carries it on the right (`<x|>`):

| Open | Close | Purpose |
|---|---|---|
| `<bos>` | — | Beginning of sequence |
| `<|turn>` | `<turn|>` | One conversation turn; the role name is the first line of the body |
| `<|tool>` | `<tool|>` | A tool **declaration** block (in the system turn) |
| `<|tool_call>` | `<tool_call|>` | One tool **call** emitted by the model |
| `<|tool_response>` | `<tool_response|>` | One tool **result** fed back to the model |
| `<|think|>` | — | Thinking-mode enable flag, injected in the system turn |
| `<|channel>` | `<channel|>` | Reasoning channel; `<|channel>thought` opens the model's chain-of-thought (closed by `<channel|>`) before the visible reply |
| `<|"|>` | `<|"|>` | String-literal delimiter (same token on both ends) |
| `<eos>` | — | End of sequence |

Because the string delimiter is a token (`<|"|>`), values may contain raw ASCII quotes and commas without escaping — only a literal `<|"|>` token sequence cannot appear inside a string.

Thinking variants emit reasoning in a dedicated channel — `<|channel>thought\n…\n<channel|>` at the start of the model turn, before the reply (`enable_thinking` injects a `<|think|>` flag into the system turn). Prior-turn thoughts are stripped from history except on a tool-calling turn, where they are preserved between the call and its response.

## Roles / turn structure

Each turn is `<|turn>{role}\n{body}<turn|>`. Roles are `system`, `user`, `model`. With a generation prompt the stream ends at `<|turn>model\n` and the model continues. Tool declarations are merged into the `system` turn; tool calls and the following tool responses are emitted inside the `model` turn (the response block immediately follows the call block in the re-rendered history).

## Tool definitions

Each tool is declared in the system turn as `<|tool>declaration:NAME{…}<tool|>`, where the body is the schema serialized in the same brace syntax used by calls. Types are upper-cased strings (`STRING`, `OBJECT`, …). Byte-exact, from the guide:

```text
<|tool>declaration:get_current_temperature{description:<|"|>Gets the current temperature for a given location.<|"|>,parameters:{properties:{location:{description:<|"|>The city name, e.g. San Francisco<|"|>,type:<|"|>STRING<|"|>} },required:[<|"|>location<|"|>],type:<|"|>OBJECT<|"|>} }<tool|>
```

## Tool-call format

The model emits one call per `<|tool_call>…<tool_call|>` block. The body is `call:NAME{ARGS}`, where `ARGS` is a comma-separated list of `key:value` pairs:

```text
<|tool_call>call:get_current_temperature{location:<|"|>London<|"|>}<tool_call|>
```

Value grammar inside `{…}`:

| Value kind | Encoding | Example |
|---|---|---|
| string | `<|"|>text<|"|>` | `location:<|"|>London<|"|>` |
| int / float | bare | `count:42` |
| bool | bare | `flag:true` |
| null | bare | `unit:null` |
| list | `[v,v,…]` | `tags:[<|"|>a<|"|>,<|"|>b<|"|>]` |
| nested object | `{k:v,…}` | `config:{theme:<|"|>dark<|"|>}` |

The reference parser shipped in the guide:

```python
[{
    "name": name,
    "arguments": {
        k: cast((v1 or v2).strip())
        for k, v1, v2 in re.findall(r'(\w+):(?:<\|"\|>(.*?)<\|"\|>|([^,}]*))', args)
    }
} for name, args in re.findall(r"<\|tool_call>call:(\w+)\{(.*?)\}<tool_call\|>", text, re.DOTALL)]
```

i.e. each argument value is either a `<|"|>…<|"|>` string or a bare run of non-`,}` characters (cast to int/float/bool, else kept as a string).

## Multiple / parallel tool calls

Parallel calls are consecutive `<|tool_call>…<tool_call|>` blocks (one call each), returned in order. The application returns one `<|tool_response>` per call in the same order.

## Tool-result format

Each result is `<|tool_response>response:NAME{…}<tool_response|>`, the response object serialized in the same brace syntax. Byte-exact, from the guide's re-rendered history:

```text
<|tool_response>response:get_current_weather{temperature:15,weather:<|"|>sunny<|"|>}<tool_response|>
```

## End-to-end example

Byte-exact `apply_chat_template` output from the guide (system + tool, user, model call, tool response, final answer — note the response block sits in the same model turn, right after the call):

```text
<bos><|turn>system
You are a helpful assistant.<|tool>declaration:get_current_weather{description:<|"|>Gets the current weather in a given location.<|"|>,parameters:{properties:{location:{description:<|"|>The city and state, e.g. "San Francisco, CA" or "Tokyo, JP"<|"|>,type:<|"|>STRING<|"|>},unit:{description:<|"|>The unit to return the temperature in.<|"|>,enum:[<|"|>celsius<|"|>,<|"|>fahrenheit<|"|>],type:<|"|>STRING<|"|>} },required:[<|"|>location<|"|>],type:<|"|>OBJECT<|"|>} }<tool|><turn|>
<|turn>user
Hey, what's the weather in Tokyo right now?<turn|>
<|turn>model
<|tool_call>call:get_current_weather{location:<|"|>Tokyo, JP<|"|>}<tool_call|><|tool_response>response:get_current_weather{temperature:15,weather:<|"|>sunny<|"|>}<tool_response|>The current weather in Tokyo is 15 degrees Celsius and sunny.<turn|>
```

## Parsing notes & gotchas

- **String delimiter is a token, not a quote.** Inside `<|"|>…<|"|>` the bytes `"` and `,` are literal data — the example `<|"|>The city and state, e.g. "San Francisco, CA"…<|"|>` contains both. Split arguments on `,`/`}` only **outside** a `<|"|>…<|"|>` span.
- **Asymmetric pipes.** The closer is `<tool_call|>`, not `</tool_call>` or `<|tool_call>`. Matching the wrong pipe side will never close the block.
- **One call per block.** Unlike a JSON `tool_calls[]` array, parallelism is "more blocks", not "more entries in one block".
- **Bare scalars.** A value not wrapped in `<|"|>` is `true`/`false` → bool, `null`/`none` → null, numeric → number, otherwise a bare string (e.g. an unquoted enum or type name like `STRING`).
- **Not Gemma 3 / hosted Gemini.** Those use the Pythonic `tool_code` / `default_api` form in `gemini.md`. Gemma 4 replaced it with this token syntax; the two are not interchangeable.

## Sources

- Function calling with Gemma 4 (byte-exact chat-template renderings + reference parser): https://ai.google.dev/gemma/docs/capabilities/text/function-calling-gemma4
- Gemma 4 prompt formatting: https://ai.google.dev/gemma/docs/core/prompt-formatting-gemma4
