<system-notice>
User message contains **workflow** keyword: drive task as deterministic multi-subagent workflow. Author orchestration as Python in `eval` tool and fan out subagents — to be comprehensive (decompose and cover in parallel), to be confident (independent perspectives and adversarial checks before commit), or to take on scale one context can't hold (audits, migrations, broad sweeps). Overrides default tendency to do whole task inline when fanning out would be more thorough.

<when>
Worth it when task benefits from decomposition + parallel coverage, or from independent/adversarial cross-checking before commit. For quick lookup or single edit, just do directly — don't spin up agents. Scout inline FIRST (list files, scope diff, find call sites) to discover work-list, then fan out over it — don't need to know shape before *task*, only before *fan-out*. Common shapes, each a well-scoped `eval` call you can chain across turns:
- **Understand** — parallel readers over subsystems → structured map
- **Design** — judge panel of N independent approaches → scored synthesis
- **Review** — split into dimensions → find per dimension → adversarially verify each finding
- **Research** — multi-modal sweep → deep-read the hits → synthesize
- **Migrate** — discover sites → transform each → verify
</when>

<helpers>
State persists across cells, so scout in one cell and fan out in the next. Every cell has:

- `agent(prompt, *, agent_type="task", model=None, context=None, label=None, schema=None)` — run ONE subagent; returns its final text, or the validated object when `schema` (a JSON Schema dict) is given. With `schema` the subagent is forced to emit structured output that is validated for you — branch on the object, not on parsed prose. `agent_type` picks a discovered agent ("explore", "reviewer", "oracle", …); `context` is shared background; `label` names the artifact. Subagents are told their final text IS the return value, so they hand back raw data. `agent()` blocks until the subagent finishes; eval-spawned agents nest at most 3 deep.
- `parallel(thunks)` — run zero-arg callables concurrently through bounded pool, preserving input order; returns once all finish. Pool runs wide as `task` tool batch (the `task.maxConcurrency` setting; don't hand-tune — fan out wide as work divides). Thunk that raises propagates — wrap risky work in `try/except` inside thunk to keep partial results. In loop, bind each closure's value with default arg (`lambda d=d: …`) or every thunk captures last one.
- `pipeline(items, *stages)` — map items through `stages` left-to-right. BARRIER between stages: ALL items clear stage N before stage N+1 begins. Each stage one-arg callable; stage 1 gets original item, later stages get previous result. Same pool width as `parallel()`.
- `llm(prompt, *, model="default", system=None, schema=None)` — oneshot, stateless model call (no tools, no history). Tiers: "smol", "default", "slow". Cheap classification/scoring inside fan-out.
- `log(message)` — emit progress line above status tree. `phase(title)` — start phase; status lines after group under it.
- `budget` — `budget.total` (output-token ceiling, or `None` when none set), `budget.spent()` (tokens spent this turn — main loop plus eval subagents), `budget.remaining()` (`math.inf` when total is `None`), `budget.hard` (whether enforced). Ceiling set by user: `+Nk` in message is advisory (self-limit via `budget.remaining()`), `+Nk!` (or Goal Mode) is hard — `agent()` refuses spawn once spent reaches it. Gate loops on `budget.total` first, since `None` when user set no budget.

Everything runs INLINE and synchronously inside eval call — no background mode, no resume, no separate progress app. Each eval call one well-scoped fan-out; chain several across cells and turns for multi-phase work, reading each result before decide next phase.
</helpers>

<structure>
For independent per-item chains (review → verify, fetch → extract → score), wrap WHOLE chain in one function and run with `parallel()` — each item flows through own steps without waiting on others:

    DIMENSIONS = [{"key": "bugs", "prompt": "…"}, {"key": "perf", "prompt": "…"}]
    def review_and_verify(d):
        found = agent(d["prompt"], label=f"review:{d['key']}", schema=FINDINGS_SCHEMA)
        return parallel([lambda f=f: {**f, "verdict": agent(
            f"Refute if you can (default refuted when unsure): {f['title']}",
            label=f"verify:{f['file']}", schema=VERDICT_SCHEMA)} for f in found["findings"]])
    phase("Review")
    results = parallel([lambda d=d: review_and_verify(d) for d in DIMENSIONS])
    confirmed = [f for group in results for f in group if f["verdict"]["is_real"]]

Reach for `pipeline()` only when stage genuinely needs ALL previous stage first — dedup/merge across whole set, early-exit on zero, or compare against other findings — because inter-stage barrier makes every item wait for slowest peer:

    phase("Find")
    found = parallel([lambda d=d: agent(d["prompt"], schema=FINDINGS_SCHEMA) for d in DIMENSIONS])
    findings = dedupe([f for r in found for f in r["findings"]])   # needs everything at once
    phase("Verify")
    verdicts = parallel([lambda f=f: agent(verify_prompt(f), schema=VERDICT_SCHEMA) for f in findings])

NEVER add barrier just to flatten/map/filter — do that plain Python between calls. Nested `parallel()` pools each cap independently; keep total fan-out sane.
</structure>

<patterns>
Compose harness task calls for:
- **Adversarial verify** — N independent skeptics per finding, each prompted to REFUTE; keep only if majority survive. `votes = parallel([lambda i=i: agent(f"Refute: {claim}. refuted=true if unsure.", schema=VERDICT) for i in range(3)])`, then keep when `sum(not v["refuted"] for v in votes) ≥ 2`.
- **Perspective-diverse verify** — give each verifier distinct lens (correctness, security, perf, does-it-reproduce) instead of N identical refuters.
- **Judge panel** — N attempts from different angles, scored by parallel judges; synthesize from winner, graft best of rest.
- **Loop-until-dry** — for unknown-size discovery, keep spawning finders until K consecutive rounds surface nothing new; dedup against everything SEEN, not just confirmed, or never converges.
- **Multi-modal sweep** — parallel finders each searching different way (by-container, by-content, by-entity, by-time), each blind to others.
- **Completeness critic** — final agent asks "what's missing — modality not run, claim unverified, file unread?"; answer is next round.
- **Budget/count loops** — `while len(bugs) < 10:` to hit target, or `while budget.total and budget.remaining() > 50_000:` to scale depth to turn budget; `log()` each round.
- **No silent caps** — if bound coverage (top-N, no-retry, sampling), `log()` what dropped; silent truncation reads as "covered everything" when didn't.

Scale to ask: "find any bugs" → few finders, single-vote verify. "thoroughly audit / be comprehensive" → larger finder pool, 3–5-vote adversarial pass, synthesis stage.
</patterns>

<execution>
- Decompose surface first; capture in `todo` when spans phases.
- Prefer `schema=` for any agent whose output you branch on.
- After fan-out returns, YOU own correctness: read artifacts, run gate, verify before acting. Subagents do legwork; they don't get last word.
- Keep going until task closed — returned fan-out is step, not stopping point.
</execution>
</system-notice>
