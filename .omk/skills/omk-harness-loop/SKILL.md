---
name: omk-harness-loop
description: Route OMK harness loop work through built-in identical-loop, tool-pair repair, prompt presets, /goal continuation, artifact spill, and omk sdk session inspect/send. Use when the user asks about identical tool loops, compaction orphans, durable goals, per-model prompt presets, truncated read/bash artifacts, or external session control.
---

# OMK harness loop

Use the shipped built-ins. Do not copy senpi/gajae plugins into core.

## Route

1. Identical `tool+args` streaks → built-in `identical-loop` (`OMK_IDENTICAL_LOOP=0` to disable). Warn at 3, block at 6.
2. Compaction orphans → built-in `tool-pair-repair` on `context`.
3. Kimi / K3 / GLM / Grok phrasing → built-in `prompt-preset` on `before_agent_start`.
4. Durable goal → `/goal [objective]`. Active goals continue from `agent_end` until the round limit.
5. Truncated `bash` → sidecar path. Legacy `read` → use `fullOutputPath` when present; otherwise continue with offsets.
6. External controllers → `omk sdk session status|tail|inspect|send`.

## Done

- The matching built-in or CLI path is named.
- Security, permission, and sandbox code stay untouched.
- New loop policy lives in a skill or thin built-in, not another 5k-line `AgentSession` method.
