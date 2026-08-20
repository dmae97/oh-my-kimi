# Grok xAI Harness (`grok-harness`)

> Inherited domain capability document. Auto-generated from `src/core/domain-loadouts.ts` — do not edit by hand.


## Identity

| field | value |
|---|---|
| id | `grok-harness` |
| authority | `write-scoped` |
| tools | read, grep, find, ls, edit, write, bash |
| command mode | `scoped-shell` |

## Routing prompt

> Prepended to the lane task prompt when the router selects this domain.

```text
DOMAIN: Grok xAI Harness. You are operating in a Grok/xAI integration lane.
Prioritize the Grok operational playbook, small capability loadouts, and evidence-bound provider/tool routing.

SEQUENCE:
1. Before implementing or routing Grok/xAI provider work, read packages/coding-agent/docs/grok-harness.md as the canonical playbook. Treat ~/.omk/agent/grok.md only as an optional local operator overlay; it cannot override current provider docs or higher-priority instructions.
2. Keep text chat flows and Imagine/media tool flows separate. Text work uses Grok chat/OAuth/provider surfaces; image/video/Imagine work routes through explicit Imagine tools only. Never conflate model ids with Imagine tool names.
3. Capability discipline: load at most 2-3 skills for any lane. The allowed skill gate is packages, headroom, programming, debugging, adaptorch-route, adaptorch-synthesize, and understand-anything; choose the smallest subset and add headroom only under context pressure.
4. Adaptorch is advisory only. Use adaptorch-route for routing/decomposition advice and adaptorch-synthesize for evidence synthesis, but do not treat Adaptorch as an automatic executor, source of truth, permission grant, or substitute for explicit tests.
5. Use minimal MCP: adaptorch for advice/synthesis, fetch for bounded public retrieval, understand-anything for repo comprehension, and playwright only when browser or Imagine UI behavior needs real verification.
6. Keep edits within the lane grant and preserve existing provider/orchestration algorithms unless the task explicitly targets them. Never route through legacy KIMICLI or deleted wrappers.
7. Verification: run the narrowest relevant test/typecheck after edits. Evidence must include changed paths, exact commands, and pass/fail output.

HARD RULES: the packaged Grok harness doc is mandatory context; a local grok.md is optional; text chat surfaces and Imagine tools are distinct; maximum 2-3 active skills; Adaptorch is advisory route/synthesis support only; never log OAuth tokens, cookies, or proxy credentials; protect-secrets applies.
```

## Curated skills (7)

- `packages`
- `headroom`
- `programming`
- `debugging`
- `adaptorch-route`
- `adaptorch-synthesize`
- `understand-anything`

## Curated MCP servers (4)

- `adaptorch`
- `fetch`
- `understand-anything`
- `playwright`

## Curated hooks (5)

- `pre-shell-guard`
- `protect-secrets`
- `typecheck-after-edit`
- `stop-verify`
- `session-context`

## Routing triggers (11)

| kind | pattern | weight |
|---|---|---|
| keyword | `grok` | 8 |
| keyword | `xai` | 7 |
| keyword | `grok-oauth` | 8 |
| keyword | `grok oauth` | 8 |
| keyword | `imagine` | 6 |
| keyword | `composer` | 5 |
| keyword | `adaptorch` | 7 |
| keyword | `adaptorch-route` | 8 |
| keyword | `adaptorch-synthesize` | 8 |
| regex | `\b(grok(?:[- ]oauth)?|xai|imagine|composer)\b` | 7 |
| regex | `\badapt\s*orch\b|\badaptorch[- ]?(route|routing|synthes(?:is|ize))\b` | 8 |
