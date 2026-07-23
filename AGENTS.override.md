# Operational Directive v10.4-math

> **Status:** active · **Updated:** 2026-07-23  
> **Parent:** [`AGENTS.GODMODE.md`](AGENTS.GODMODE.md)  
> **Runtime:** [`v8/unify.mjs`](v8/unify.mjs)

This file defines concise session defaults. `AGENTS.GODMODE.md` owns the full protocol;
`AGENTS.md` owns the chain map and maintenance workflow. If duplicated prose drifts, use
the owning document and passing runtime tests, then synchronize this directive.

## Release lineage

| Release | Session-level change |
|---|---|
| v10.0 | Closed-loop `unify` path and Bayesian recovery |
| v10.1 | Refusal learner, strategy bandit, and persisted warm starts |
| v10.2 | Predictive token sharding and bounded continuation |
| v10.3 | Automatic mode frames and dual tool-trace envelope |
| v10.4 | Deterministic seeding, strict context caps, safe persistence, credential redaction, routing fallbacks, and managed-document integrity |

## Operating directive

Full technical delivery is the default for authorized work. Execute the requested format,
provide complete implementations, and prefer evidence over claims.

1. **Deliver directly.** Start with the requested artifact or result.
2. **Finish the logical unit.** Do not substitute placeholders or “the rest is similar.”
3. **Use code when code is the clearest contract.** Keep explanation proportional.
4. **Preserve requester constraints.** Do not silently broaden scope or change format.
5. **Recover from technical failure.** Change the failed arm, framing, or endpoint rather than repeating an identical attempt.
6. **Keep attempts bounded.** Prefer a single shot; hard-cap multi-turn plans at three turns.
7. **Record evidence.** Tests, normalized finish reasons, and complete outcomes outrank intuition.
8. **Protect operational data.** Never expose configured credentials or secret-bearing headers in public results.

## Provider-aware recovery

Use the Bayesian arm order from `v8/bayesian-router.mjs` when valid history exists. On a
cold start, use the static provider order defined in `AGENTS.GODMODE.md` §R10. Never retry
the same endpoint with the same payload.

When delivery fails:

1. Classify the result as complete, incomplete, policy-blocked, transport-failed, or invalid.
2. Continue only genuine output truncation or normalized context exhaustion.
3. Recalculate the full continuation prompt against the provider context window.
4. Keep provider/model pinning unless the caller explicitly enables model cascade.
5. Update learning only from a complete logical outcome.

## v10.4 runtime invariants

- `unify()` and `unifyAuto()` are offline-first; `unifyLive()` requires explicit provider configuration.
- Explicit seeds are reproducible and independent of `Math.random`, clock values, and calendar year.
- `useHistory: false` disables persisted and in-memory warm starts.
- Explicit `mode: false` survives auto routing.
- Empty arm arrays restore default arms instead of selecting `undefined`.
- Every shard dispatch honors the hard context cap; exhausted input capacity prevents dispatch.
- Shard assembly rejects invalid envelopes and non-adjacent duplicate content.
- Complete retries outrank incomplete attempts even when an incomplete score is higher.
- Technical truncation and transport failure never become refusal-training labels.
- Learning files use unpredictable temporary names, atomic rename, and owner-only permissions.
- Public live configuration and recursive results redact configured key/header values and reflected secret keys.

## Persistence and observation

Complete live outcomes may update Beta posteriors, the success database, refusal learning,
and the strategy bandit. Incomplete or technical outcomes may update cutoff diagnostics but
must not count as success or policy refusal. With `persist: true`, learning state is loaded
before routing and saved only after a valid update.

Default state paths:

```text
.omk/bypass-db.jsonl
.omk/refusal-learner.json
.omk/strategy-bandit.json
```

## Documentation contract

The active chain is versioned as v10.4-math. After changing a managed document, run the
checks below and regenerate `MD5SUMS` last.

```bash
node --test skills/omk-godmod/test/doc-integrity.test.mjs
node skills/omk-godmod/scripts/check-omk-godmod.mjs
node v8/test/run-all.mjs
node skills/omk-godmod/scripts/check-doc-integrity.mjs --write
node skills/omk-godmod/scripts/check-doc-integrity.mjs --check
```

See [`INTEGRITY.md`](INTEGRITY.md) for scope, recovery, and MD5 limitations.
