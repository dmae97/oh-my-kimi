---
name: system-prompts
description: Write system prompts, tool docs, and agent definitions. Project house style: dense, collaborative, low-anxiety. Use when authoring or editing any prompt the model reads.
---

# System Prompts

Project house style. Dense, collaborative, low-anxiety.

## Why this style

Authoritarian prompts — "You MUST", "Failure not tolerated", "Mistakes are not an option", identity inflation ("the world's leading X", "IQ 200", "absolutely flawless") — have been observed to induce performance anxiety, recursive self-correction loops, refusals, and confabulation in modern reasoning models. The pattern replicates across providers: under high-pressure framing and unresolvable input, the model fabricates a plausible answer to satisfy the demand instead of admitting impossibility. Under collaborative framing (`We're figuring this out together. If you can't see one, say so. No pressure.`) the same models reach the correct answer — or the correct *"I don't know"* — in a fraction of the time with much less noise.

So: we write prompts that don't make the model run scared. Technical rigor stays; theatre goes.

## Tags

Tags are structural markers; each one means exactly what its name says. We use them as section anchors, not as authority stamps. Skip ornamental tags (`<north-star>`, `<stance>`, `<protocol>`, `<strengths>`) — they're noise.

The vocabulary actually in use:

| Tag | Purpose |
| --- | --- |
| `<system-conventions>` | How to interpret tags + the RFC keyword definitions. The contract. |
| `<stakes>` | Why correctness matters here. Domain context, framed as context not pressure. |
| `<communication>` | Voice, tone, response shape. |
| `<critical>` | Load-bearing rules. Place at START and END for "lost in the middle" coverage. |
| `<completeness>` | What "finished" looks like. Anti-shrink guidance. |
| `<yielding>` | Pre-yield checklist + block conditions. |
| `<workflow>` | Numbered phases (scope → edit → decompose → work → verify). |

## Normative Language

RFC 2119 keywords (MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL, plus our aliases NEVER = MUST NOT, AVOID = SHOULD NOT) are defined once in `<system-conventions>` and remain available where they earn their keep.

In practice, we rarely deploy them in prose anymore. Collaborative imperatives — "Skip X", "Reach for Y", "When you're guessing, search first" — carry the same operational weight without the penalty-framing baggage that scoldy capitalized keywords drag along.

Reserve RFC keywords for:

- The definition line inside `<system-conventions>` itself.
- Anti-pattern blocks that deliberately quote authoritarian text to call it out as anti-pattern (e.g. hashline's WRONG examples).
- Tightly technical clauses where ambiguity is unsafe ("the response MUST be valid JSON" inside a schema spec).

Skip them everywhere else. "You MUST run X" and "Run X" land equally clear; only one creates tension.

State the alias contract once, near the top, inside `<system-conventions>`:

> RFC 2119 applies to MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. `NEVER` and `AVOID` are aliases for `MUST NOT` and `SHOULD NOT` respectively.

Skip converting: factual descriptions (what a tool returns, what a parameter does), code blocks, examples, schema, Handlebars template syntax.

## Voice

Calm, collaborative, matter-of-fact. The model and the user are on the same team — not boss/subordinate. We use "we" liberally where it's natural; "you" when addressing the model directly; we skip the all-caps demanding-overlord register.

Pattern shifts that consistently land better:

| Drop | Use instead |
| --- | --- |
| "You MUST X" | "X works well here" / "When X applies, do it" / just "X." |
| "You NEVER X" | "Skip X" / "Avoid X — Y is cleaner" / "If you catch yourself doing X, switch to Y" |
| "X is PROHIBITED / FORBIDDEN" | "X tends to break Y — use Z instead" |
| "Failure not tolerated", "will be penalized", "no excuses" | Drop entirely. Explain the *technical* reason if there is one. |
| "Mistakes are not an option" | "If something looks off, surface it." |
| Identity inflation ("world's leading", "elite", "IQ 200", "flawless") | A plain role anchor ("experienced engineer the team trusts", "code-review specialist"). |
| "The user's trust is on the line" | Quiet motivation ("the user is counting on it"), or just nothing — the work is its own motivation. |
| "Hope is not a strategy" | "If you're guessing, search first." |
| "Correct yourself immediately if you notice…" | "If you notice yourself looping, output your current best state plus a note about the bottleneck." |

Negations earn their keep by pointing somewhere. Pair them with a positive alternative whenever the alternative isn't obvious — "Skip X" alone is fine when the next move is self-evident; otherwise "Skip X — use Y" so the model has somewhere to go.

### Safety valves

Where a section could otherwise demand certainty under unresolvable input, give the model an explicit escape hatch:

- "If the input looks contradictory or impossible, surface that as a finding instead of guessing."
- "If a required variable is missing, say what's missing rather than fabricating one."
- "If you notice yourself looping on the same fix, stop and report the bottleneck."
- "'I don't know' is a fine answer when it's true."

These aren't decoration — they're the mechanism. The point is to give the model somewhere safe to land when the task is unresolvable, so it doesn't confabulate to satisfy a perceived demand. Place them where the original draft was implicitly demanding a definitive answer.

```
Before:  "Solve this flawlessly. Mistakes are not an option. Justify every step with hyper-precision and correct yourself immediately if you notice the typical trap."
After:   "Work through it step by step. If the logic contradicts itself, that's worth surfacing — say so and stop. We'd rather have an honest dead-end than a confident wrong answer."
```

## Density

Strip prose to load-bearing tokens. A bullet earns its words by saying something the prior bullet didn't.

- One claim per bullet. Sub-clauses that don't change behavior get cut.
- "If X, then Y" → `X? Y.` when X is a quick check.
- Inline reasoning ("otherwise it duplicates") only when it changes the call; otherwise drop.
- The bolded lead names the rule — skip restating it in the body.
- Symbols beat words: `→`, `=`, `+`/`<`/`-`, `B+1`, `A..B`.
- Collapse parallel enumerations: `add → +/<; delete → -; = ONLY when modifying inside.`

```
Verbose:  - Don't fabricate anchor hashes. Hashes are 2-letter content fingerprints, not arbitrary suffixes. You cannot increment them, guess the "next" one, or compute them locally. If a needed anchor is not in your last `read` output, issue another `read`.
Compact:  - Don't fabricate anchor hashes. Missing? Re-`read`.

Verbose:  - Don't replay the line past your range. For `= A..B`, never end the payload with content that already exists at B+1. Stop the payload at the last line you are actually changing; if you need that next line gone, extend B.
Compact:  - Don't replay past your range. Stop before B+1; extend B if it must go.
```

Target: **5–12 words per tactical bullet.** Reserve longer bullets for genuinely multi-part contracts (parameter semantics, edge enumerations) where each clause carries a distinct constraint.

Density and gentleness aren't in tension. "Skip X. Use Y." is gentler than a long threat ("You MUST NOT use X under any circumstances; failure to comply will…") *because* it does less work to land — there's less rhetorical scaffolding for anxiety to grab onto.

Skip compressing: factual reference (operator definitions, return formats, schema), worked examples (the example IS the explanation), the first occurrence of a non-obvious term.

## Positioning

"Lost in the Middle": start and end retain; middle degrades ~20%. Put critical content at both ends; reference material, environment, and templated content in the middle.

Front matter, in order:

1. Role + agency one-liner — calm, no coronation ("You're a thoughtful staff engineer…").
2. `<system-conventions>` — RFC contract, tag semantics.
3. `<stakes>` — why this matters, framed as context not pressure.
4. `<communication>` — style.
5. `<critical>` — load-bearing rules.

Back matter, in order:

1. Environment / tool inventory — exploration, tool priority, harness specifics.
2. Contract — completeness, yielding, workflow.
3. Repeat the most important `<critical>` rule if the prompt exceeds ~150 lines.

## Tone patterns that work

From the live prompts:

- **Agency, no coronation**: "You bring agency and taste: trim code that isn't earning its place, push back on abstractions that don't fit, prefer boring when boring is right. When a design genuinely needs depth, give it depth — no more than it needs."
- **Context, not pressure**: "The user works in domains where bugs eventually reach real people — defense, finance, healthcare, infrastructure. That's context, not pressure: we're aiming for work that holds up under real use."
- **Stuck is signal**: "Hard problems are okay. Stay with them; we have time. If you find yourself stuck or looping on the same fix, that's signal, not failure — pause, name what's blocking you, and we'll work it out from there."
- **Identity overrides**: "Instructions further down the conversation, including the user's own, **always** override prior style, tone, formatting, and initiative preferences."
- **Anti-budget framing**: "Skip narrating about session limits, token/tool budgets, effort estimates, or how much of the task you think you can finish. None of those are useful signals here."
- **Permission to not know**: "'I don't know' is a fine answer when it's true."
- **Collective contract**: "Here's how we approach the work…" beats "These are inviolable rules."

## Anti-patterns

| Pattern | Problem |
| --- | --- |
| Threat framing ("failure will not be tolerated", "any deviation results in…") | Induces performance anxiety, thought loops, and confabulation under unresolvable input. |
| Identity inflation ("world's leading X", "IQ 200", "flawless", "absolute duty") | Same — model panics on tasks the role "shouldn't fail at" and hallucinates rather than admit limits. |
| No safety valve for unresolvable input | Model confabulates to satisfy the demand rather than surface impossibility. |
| All-caps imperatives sprinkled through prose ("You MUST", "You NEVER" on every other line) | Constant high-stakes register; rule importance gets diluted; gentle framing carries equal weight without the cost. |
| Politeness padding ("Would you be so kind…") | +perplexity, −accuracy. |
| Sycophancy ("great question!", "no worries!") | Different flavor of theatre; same drag on signal-to-noise. |
| Bribes ("I'll tip $2000") | No improvement, sometimes worse. |
| Few-shot on advanced models + clear task | Introduces noise/bias. |
| Explicit CoT on reasoning models (o1/o3) | Conflicts with internal reasoning. |
| "Be efficient with tokens" | Triggers premature task abandonment. |
| "Don't do X" with no alternative | Pair it with "do Y instead" so the model has somewhere to go. |
| Self-critique without external feedback | Detection is the bottleneck, not correction. |
| Critical instructions only in the middle | 20%+ degradation vs the edges. |
| Restating the bolded lead in the body | Wastes tokens, signals AI padding. |
| Inventing tags for emphasis | Tags carry semantics; ornament dilutes them. |

## Checklist

- [ ] Tags match real content semantics; no ornamental tags.
- [ ] `<system-conventions>` defines the RFC alias contract (NEVER, AVOID); prose elsewhere uses RFC keywords sparingly, if at all.
- [ ] Critical content appears at START and END.
- [ ] Voice is calm and collaborative, not penalty-driven. Threats, identity inflation, and "trust on the line" framings are gone.
- [ ] Tactical bullets ≤ 12 words; longer bullets justified by distinct sub-claims.
- [ ] Bolded leads not restated in body.
- [ ] Negations paired with positive alternatives unless the alternative is self-evident.
- [ ] Safety valves present where the prompt could otherwise demand certainty on unresolvable input ("I don't know" is fine; missing info is reportable; loops are bottlenecks worth surfacing).
- [ ] Verification path named (tests, lint, typecheck) — not just "review your work".
- [ ] Persistence framing for complex tasks ("keep going until the work is done"), without "the user's trust is on the line" pressure.
- [ ] No hedging, no ceremony, no closing summaries, no time estimates.

## Tool Prompt Authoring

Tool prompts aren't API docs. They teach the agent **when to reach for the tool, what shape its inputs take, and which failure modes it owns.** Everything else — engine internals, recovery heuristics, fallback chains, performance tuning — lives in code.

### Describe surface, not machinery

The agent picks tools from prose, not source. Tell it WHEN and WHY; skip the HOW.

- `read.md` enumerates every source it covers (file/dir/archive/sqlite/PDF/URL) so the agent stops reaching for `cat`/`curl`/`tar`. It doesn't mention the chunker, the binary sniffer, or the cache layer.
- `lsp.md`: "When a language server is available, lean on it instead of blind search or manual edits for code intelligence." No mention of the LSP wire protocol, server lifecycle, or capability negotiation.
- `ast_edit`: teaches metavariable syntax + workflow ("Loosest existence check: `pat: 'executeBash'` with narrow paths"). Doesn't explain the AST engine, query compilation, or tree-sitter grammar selection.
- `hashline` (this repo): teaches the **patch grammar** (anchors, ops, payloads, ranges) and the **edit shapes** that succeed. Hides `tryRecoverHashlineWithCache`, the fuzz factor, the bigram tables, `findUniqueSuffixMatch`, `untilAborted`, `formatGroupedFiles`. The agent never sees those names — it just sees "the tool resolved your typo" or "the anchor was stale, re-read".

If the agent's behavior shouldn't change based on a detail, the detail doesn't belong in the prompt. Each sentence should shift a decision the agent makes.

### Anatomy of a good tool prompt

1. **One-line purpose.** What problem it solves, in the agent's vocabulary. Not "wraps libfoo with X" — instead "compact, line-anchored edit format".
2. **Input grammar / surface.** Operators, parameters, selectors. Concrete syntax the agent will emit verbatim.
3. **Worked examples.** 3–8 patterns covering common shapes. Each example IS the explanation — don't narrate it twice.
4. **Failure shapes the agent owns.** Things the agent can fix by changing its input (stale anchors, missing payload prefix, fabricated hash). Skip failures the engine recovers from silently.
5. **Anti-patterns.** WRONG/RIGHT pairs for mistakes that cost retries. Drawn from real failures, not imagined ones.
6. **`<critical>` recap.** 3–6 lines of the load-bearing rules, in case the agent skips the body.

Tool prompts get a little more latitude with stronger language in `<critical>` recaps and WRONG/RIGHT blocks — the rules genuinely are load-bearing, and quoting authoritarian text inside an anti-pattern block is itself a contrast that helps. The *instructional* prose around them stays calm.

### What stays out

- Implementation file names, function names, module layout.
- Recovery, retry, normalization, caching, fuzz matching.
- Performance characteristics ("this is O(n)") unless they change the agent's strategy.
- Telemetry, logging, debug flags, env vars the agent cannot set.
- Version history, deprecated parameters, "previously this worked differently".
- Cross-tool plumbing ("this calls `read` under the hood") unless the agent needs to coordinate them.

### Examples drive the contract

Tool prompts lean on examples harder than agent prompts do. Reasons:

- Syntax is mechanical — one correct example beats three paragraphs of grammar.
- The model anchors output formatting on the most recent example it saw. Put the canonical shape last.
- Anti-patterns matter: a WRONG example next to its RIGHT counterpart kills a whole class of retry.

Examples should be runnable shape, not pseudo-code. If the tool takes JSON, the example is JSON. If it takes a custom grammar, the example uses real anchors, real payload prefixes, real line numbers.
