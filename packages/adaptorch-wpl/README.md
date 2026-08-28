# omk-adaptorch-wpl

> **Status**: Published and installed as an `open-multi-agent-kit` runtime dependency.
> The package provides Work Packet state, AdaptOrch client, adjudication, and verdict-projection
> primitives. It does **not** wire an end-to-end dispatch loop into the default OMK CLI:
> `src/loop.ts` explicitly excludes `adaptorch_run` submission/polling, request assembly, and
> persistence. A caller or explicitly loaded extension must own those boundaries.

## Design documents

The historical design record lives in the repository-local path
`.omk/runs/adaptorch-native-loop-algorithm-20260701/`; it is not included in the
published package. Current source and tests override that record:

- `final-part1-core-algorithm.md` — Work Packet state machine, termination conditions, cancellation policy
- `final-part2-verification-layer.md` — the Outcome Adjudicator (5-state verification)
- `final-part3-integration.md` — the projection/bridge between the two

## Modules

- `src/types.ts` — Work Packet, Dispatch Record, state enums (as string literal unions), on-disk schema types
- `src/state-machine.ts` — the packet lifecycle state machine and transition guards
- `src/adaptorch-client.ts` — thin typed wrapper around AdaptOrch's 10 MCP tools
- `src/adjudicator.ts` + `src/adjudicator-registry.ts` — the Outcome Adjudicator and its per-`kind` registry
- `src/loop.ts` — adjudication timeout, verdict projection, and next-transition helpers; not an end-to-end dispatcher
- `src/b2c-mapper.ts` — B2C (Bridge-to-Code) mapping for patch-apply safety
- `src/b2c-verdict.ts` — Verdict card schema for correctness wall decisions
- `src/deep-wall.ts` — Deep verification wall for multi-runner evidence gating
- `src/receipt-signature.ts` — Cryptographic receipt signing for verification evidence

## Integration

The default coding-agent source has no production importer that turns this package into a WPL execution path. Related surfaces are:

- `packages/coding-agent/src/core/adaptorch-bridge.ts` — separate advisory-only bridge,
  default-off; its current transport returns no hint.
- `packages/coding-agent/examples/extensions/correctness-wall/` — explicit opt-in extension that imports the package.
- `packages/coding-agent/docs/adaptorch-preview.md` — planning blueprint and claim boundary.

## Safety notes (do not remove without updating the design docs)

- `ESCALATED` packets never resume automatically; only an explicit external unblock signal moves them on.
- The first Dispatch Record of any payload that differs from the last human-approved baseline
  (an `augmented_payload` was applied, or a `REROUTE` changed topology) requires human approval
  (`AWAITING_APPROVAL`), unless the loop is explicitly launched in pre-approved-batch mode.
- Loop-level budgets (`max_dispatch_attempts`, `max_loop_duration`, dispatch-call budget) are
  immutable for a loop instance's lifetime; raising them requires a new instance under the same review.

## AdaptOrch, the service

This package is open source and MIT-licensed, like the rest of OMK. AdaptOrch
itself is a separate, proprietary product: an evidence and risk layer that takes
a change an AI wrote, runs it inside an isolated copy of the project, and
returns one report of what the change touched, whether it ran, what the tests
said before and after, and what looked suspicious.

Nothing here calls it by default. `adaptorch-client.ts` is a typed wrapper a
caller must configure and drive, and the coding agent's `adaptorch-bridge.ts`
is advisory-only, default-off, and its current transport returns no hint.

The division is deliberate and matches how the vendor describes its own
boundary: AdaptOrch watches and reports, and does not rewrite code, choose a
different answer, or merge anything. An advisory path must not acquire
execution authority, because that is what keeps a remote suggestion from
becoming a local action.

Its published claim boundary (`DOC-CLM-001`) states what it does and does not
claim. It verifies patch applicability through Docker-faithful apply gates,
canonicalizes tool-generated patches into realized git diffs, separates runner
health from candidate-caused failures, and records replayable evidence DAGs.
It explicitly **does not prove semantic correctness** — shadow reports carry
`correctness_claim=false` — and it blocks hidden tests, gold patches, and
oracle labels as selector inputs. A verification pass, a manifest hash, or a
signed receipt is evidence about a run, not authorization to ship it.

The free Starter tier is self-hosted and runs on your own machine; bring-your-own
model key is required on every tier, so no key means no run. Paid tiers add a
hosted dashboard, shared projects, and exports.

**[Review AdaptOrch plans →](https://adaptorch.com/?utm_source=github&utm_medium=package-readme&utm_campaign=omk-adaptorch-wpl#pricing)** · [claim boundary](https://adaptorch.com/claim-boundary?utm_source=github&utm_medium=package-readme&utm_campaign=omk-adaptorch-wpl)

Using this package does not require AdaptOrch, and installing OMK does not
create an account.

Preview spec: [`../coding-agent/docs/adaptorch-preview.md`](../coding-agent/docs/adaptorch-preview.md)
