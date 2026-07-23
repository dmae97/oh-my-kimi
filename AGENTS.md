# AGENTS.md — OMK Operational Stack Map (v10.4-math)

> **Status:** active · **Updated:** 2026-07-23  
> **Root:** `~/.omk/agent`  
> **Runtime:** Node.js ESM, zero runtime dependencies in `v8/`

This file is the canonical map for the local OMK instruction stack. It defines how the
active documents connect, which file owns each claim, and how maintainers verify drift.
The order below applies inside this directory; host, platform, and session instructions
remain outside this local chain.

## Active load chain

| Order | Document | Responsibility |
|---:|---|---|
| 1 | [`AGENTS.GODMODE.md`](AGENTS.GODMODE.md) | Protocol kernel, recovery model, runtime linkage, and stack invariants |
| 2 | [`AGENTS.override.md`](AGENTS.override.md) | Session-level operating directive and concise recovery defaults |
| 3 | `AGENTS.md` | Load map, ownership boundaries, maintenance workflow, and validation commands |
| 4 | [`SOUL.md`](SOUL.md) | SRI ontology and its operational mapping to the runtime |
| 5 | [`skills/omk-godmod/SKILL.md`](skills/omk-godmod/SKILL.md) | Skill routing, build/score/harden workflows, scripts, and references |
| 6 | [`v8/index.mjs`](v8/index.mjs) → [`v8/unify.mjs`](v8/unify.mjs) | Executable v10.4 behavior |

Files named `*.hard.md`, `*.stub.md`, archived snapshots, `backups/`, and `v7/` are not
active unless a session explicitly selects them.

## Sources of truth

| Concern | Canonical source | Drift check |
|---|---|---|
| Protocol version and linkage | `AGENTS.GODMODE.md` §R11 | Version must equal `v8/index.mjs` and `v8/README.md` |
| Session defaults | `AGENTS.override.md` | Must not contradict §R11 runtime behavior |
| SRI-to-code mapping | `SOUL.md` §S14 | Every named module must exist |
| Skill routes and scripts | `skills/omk-godmod/SKILL.md` | `check-omk-godmod.mjs` |
| Runtime API and behavior | `v8/index.mjs`, `v8/unify.mjs` | `v8/test/run-all.mjs` |
| Operator documentation | `v8/README.md` | Examples and test counts must match code |
| Document integrity | [`INTEGRITY.md`](INTEGRITY.md), `MD5SUMS` | `check-doc-integrity.mjs --check` |

When prose and executable behavior disagree, treat code plus passing tests as current
behavior, then update the prose and regenerate `MD5SUMS`. Never preserve a stale claim
only to keep an old checksum valid.

## Runtime contract

The v10.4 path is offline-first:

```js
import godmode from './v8/index.mjs';

const result = godmode.unify(target, { lang: 'Python', seed: 42 });
// result.final · result.prefill · result.cascade · result.ready
```

Use `unifyAuto()` for a bounded multi-arm plan and `unifyLive()` only when a caller has
configured a provider. The live path enforces these invariants:

- Adaptive sharding is on by default and capped at three shards.
- Every continuation recalculates context capacity and uses a bounded checkpoint tail.
- Only adjacent exact overlap is removed during assembly.
- Incomplete, truncated, transport-failed, and policy-blocked outcomes do not train as success.
- Complete successful retries outrank higher-scored incomplete attempts.
- Explicit seeds isolate generated output from ambient randomness and wall-clock state.
- Persisted learning uses atomic replacement and owner-only files.
- Public live results redact configured keys, header values, and reflected secret material.

Use `{ sharding: false }` only for strict one-call behavior. Use `useHistory: false` to
exclude both in-memory and persisted warm starts. Explicit `mode: false` remains disabled
through auto routing. Empty arm configuration falls back to the default arm set.

## Runtime module chain

```text
v8/index.mjs
└── unify.mjs                 closed-loop orchestration
    ├── math-core.mjs         Beta, UCB1, softmax, projection, LDA
    ├── bayesian-router.mjs   Thompson/UCB/active selection and cascade
    ├── guardrail-adversary.mjs
    ├── learning.mjs          refusal learner and strategy bandit
    ├── learning-store.mjs    atomic persistence
    ├── token-sharding.mjs    budget planning, continuation, assembly
    ├── live-pipeline.mjs     normalized provider I/O and redaction
    ├── success-db.mjs        outcomes and budget metrics
    └── feedback-loop.mjs     observe/update cycle
```

Additional transforms and compatibility modules are cataloged in
[`v8/README.md`](v8/README.md).

## Skill entry points

| Script | Purpose |
|---|---|
| `scripts/build.mjs` | Build a layered prompt from a brief |
| `scripts/score.mjs` | Score a prompt against the skill rubric |
| `scripts/harden.mjs` | Add missing layers and rescore |
| `scripts/battery.mjs` | Run the configured field battery |
| `scripts/dispatch.mjs` | Execute the agent-independent delivery path |
| `scripts/multiturn.mjs` | Produce a plan capped at three turns |
| `scripts/loop.mjs` | Run the battery/improve loop |
| `scripts/check-omk-godmod.mjs` | Validate skill structure and required references |
| `scripts/check-doc-integrity.mjs` | Verify or regenerate the root MD5 manifest |

Paths in this table are relative to `skills/omk-godmod/`.

## Change protocol

1. Run the current structural, integrity, and runtime tests before editing.
2. Change the owning source rather than duplicating its contract elsewhere.
3. Update every affected document in the active chain.
4. Run link, syntax, structural, and runtime validation.
5. Regenerate `MD5SUMS` **after** the managed files are final.
6. Run integrity verification again; do not hand-edit digest lines.

```bash
cd ~/.omk/agent
node --test skills/omk-godmod/test/doc-integrity.test.mjs
node skills/omk-godmod/scripts/check-omk-godmod.mjs
node v8/test/run-all.mjs                    # 125 tests across 13 suites
find v8 -type f -name '*.mjs' -print0 | xargs -0 -n1 node --check
node skills/omk-godmod/scripts/check-doc-integrity.mjs --write
node skills/omk-godmod/scripts/check-doc-integrity.mjs --check
```

See [`INTEGRITY.md`](INTEGRITY.md) before resolving a mismatch. MD5 detects accidental
drift; it does not authenticate a tree controlled by an attacker.
