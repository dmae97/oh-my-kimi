---
description: "Implementation plan for GPT-5.6 MoA and Codex ultra repair"
---

# Implementation Plan: GPT-5.6 MoA and Ultra Fix

**Branch**: `main` | **Date**: 2026-07-11 | **Spec**: [spec.md](spec.md)
**OMK Preset**: `omk`

## Summary

Use the existing `openai-codex-responses` API as the only transport. Correct GPT-5.6 Codex
thinking metadata so OMK `max`/`ultra` serialize as backend-valid `xhigh`. Add one virtual model,
`gpt-5.6-moa`, whose handler fans out to concrete Sol and Terra streams, drains both privately,
and streams a bounded Sol synthesis through the existing tool-capable agent loop. This avoids a new
provider, auth path, dependency, registry, or agent-loop protocol.

## Runtime Inventory

- **Harness**: not present
- **MCP Scope**: none for implementation
- **Skills**: debugging, programming, ponytail
- **Authority**: root session owns only the expected paths in spec.md; concurrent session paths remain untouched.

## Agent Routing

| Phase | Primary Role | Secondary Roles | Evidence Gate |
|---|---|---|---|
| Runtime diagnosis | tester | explorer | command-pass |
| Design | architect | reviewer | summary-present |
| Red tests | coder | tester | command-fail (expected) |
| Core | coder | reviewer | command-pass |
| Integration | qa | reviewer | command-pass |

## Design Decisions

1. **Virtual model, not provider**: preserves `openai-codex` OAuth lookup and existing transport.
2. **Three calls**: Sol adviser + Terra adviser in parallel, then Sol synthesis. Two calls cannot
   synthesize two independent free-form answers without making one adviser also the judge.
3. **Isolated advisers, tool-capable synthesis**: advisers strip tools and flatten historical calls/results
   into inert context. Synthesis keeps the active tool contract/history and forwards tool events through the existing loop; payload overrides stay suppressed.
4. **Strict failure policy**: one adviser error aborts its sibling and prevents synthesis; caller abort
   takes precedence and user-facing errors do not expose upstream details.
5. **Usage**: sum terminal-reported adviser+synthesis token components, costs, and `totalTokens`
   across all three calls, including failed/capped terminals when upstream reports usage.
6. **Bounded synthesis**: each adviser contributes exactly at most 24k characters; because the
   Codex backend rejects `max_output_tokens`, individual adviser streams abort at 64k generated
   characters and every synthesis delta/partial/terminal is truncated before publication, then ends
   with `length` at 128k. Both paths drain through the concrete terminal after abort. The virtual model advertises a 300k context
   window to reserve room beneath the concrete 372k limit.
7. **Public diagnostics**: composite events omit concrete transport diagnostics and expose stable errors.
8. **Endpoint preservation**: concrete models inherit the active virtual model's base URL and headers.
9. **Effort**: OMK labels `max`/`ultra` remain selectable, but concrete Codex GPT-5.6 requests map
   to the observed maximum enum `xhigh`; MoA supplies the delegation semantics of `ultra`.
10. **Session cleanup**: child IDs use `<parent>:moa:<role>` so parent cleanup closes cached sockets,
    clears idle timers, and removes fallback/debug state for the entire MoA family.
11. **Ultra subagents**: context-sensitive tool timeout resolution disables the outer timer, while the
    extension skips count/concurrency/budget/attempt cutoffs. Explicit abort and subprocess errors remain active.

## Complexity Check

| Concern | Decision | Rationale |
|---|---|---|
| New dependencies | none | existing stream/model primitives suffice |
| Breaking changes | no | new model plus correction of invalid provider metadata |
| Parallel tasks | 2 adviser calls | independent, read-only inference branches |
| MCP/secret exposure | none | auth flows through existing option, never into artifacts |

## Failure Modes

- Adviser stream not drained → queued event memory growth; drain both async iterables.
- Recursive virtual dispatch → concrete calls use Sol/Terra IDs only.
- Adviser tool escalation → adviser contexts remain tool-free; only synthesis receives the caller-declared tools, and `onPayload` remains suppressed for all three requests.
- Abort after one branch → an internal controller aborts the sibling; caller signal reaches all calls.
- Endpoint drift → Sol/Terra clones preserve the active model's endpoint and headers.
- Oversized synthesis → streaming abort caps, exact adviser text cap, and virtual context reserve.
- Child session leak → parent-family cleanup removes role-isolated WebSocket resources and state.
- Ultra resource pressure → unbounded execution is explicit, documented, and limited to the selected `ultra` tier; caller abort remains available.
