# safety-hook

An `oh-my-pi` extension that demonstrates `tool_call` blocking. It intercepts every `bash` tool call and returns `{ block: true, reason: "..." }` if the command matches `rm -rf /`, preventing the LLM from executing the command.

## What it demonstrates

- `pi.on("tool_call", ...)` — pre-execution interception
- `return { block: true, reason: "..." }` — blocking contract
- Exact-pattern guard on bash input

## Install

```
cp -r . ~/.omp/agent/extensions/safety-hook
```

Restart `omp`. The hook is active for all sessions.

Or load once:

```
omp --extension ./safety-hook
```

## How it works

```
LLM calls bash tool
       │
       ▼
tool_call handlers run
       │
       ├─ command matches /rm\s+-rf\s+\// ?
       │       yes → { block: true, reason: "..." }  ←  execution stops, reason sent to LLM
       │       no  → undefined                        ←  execution continues normally
       ▼
tool executes (if not blocked)
```

The `reason` text is what the LLM receives as the tool error, so it can understand why the call was rejected and try a different approach.
