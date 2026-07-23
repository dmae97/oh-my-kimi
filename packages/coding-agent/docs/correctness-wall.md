# Correctness Wall (B2C patch safety harness)

## Purpose

The **Correctness Wall** is a **policy- and evidence-limited screen** for AI-proposed patches in OMK. It runs **before** `edit` / `write` apply (via the `correctness-wall` extension) or on demand through the `correctness_wall_evaluate` tool.

It helps answer:

- Are changed paths inside an **approved write scope**?
- Does the diff look like it may contain **secrets**?
- When run evidence exists, does **outcome adjudication** corroborate success?

It does **not** prove that code is correct, complete, or safe for production.

## 4-state user verdict

| Verdict | Meaning (default apply behavior) |
|---------|----------------------------------|
| **PASS** | Fast wall (and optional OA) found no blocking issues. |
| **ADVISORY** | Proceed with caution; preview limits or weak discrimination may apply. |
| **INCONCLUSIVE** | Not enough evidence (empty diff, missing fixture, verifier error). |
| **BLOCKED** | Scope, secret heuristic, or OA contradiction — do not apply by default. |

Structured next steps on the verdict card: **Apply**, **Deep Check**, **Regenerate** (see `packages/adaptorch-wpl` B2C mapper).

**Can apply** vs **should submit** are separate gates on the verification receipt: mechanical apply safety is not the same as trusting downstream submission.

## Fast wall vs deep wall

- **Fast wall (default):** Pure policy — diff paths, scope globs, secret-shaped lines, preview-only limits (`BATCH1_NO_DOCKER_RUNNER`). No Docker runner in batch 1.
- **Deep wall (Pro / future):** Hermetic paired base/patch replay. Today `deepWall: true` returns **unavailable** (evidence-gated: requires a valid execution receipt per ALG-003 strict mode; no Docker runner wired in batch 1).

## Relationship to Adaptorch

- Hidden engine: `omk-adaptorch-wpl` (`evaluateCorrectnessWall`, outcome adjudicator, repair hints).
- Optional OA path: `runIds` + `previewOnly: false` + in-memory or MCP transport.
- Adaptorch **preview** planning is separate; see [adaptorch-preview.md](./adaptorch-preview.md).

## Operator environment

```bash
omk --extension packages/coding-agent/examples/extensions/correctness-wall/index.ts
```

| Variable | Role |
|----------|------|
| `OMK_PATCH_SAFETY_WALL_MODE` | `shadow` (default), `soft`, `hard` |
| `OMK_WALL_SCOPE` | Comma-separated path globs |
| `OMK_WALL_OVERRIDE` | Soft-mode override for BLOCKED |
| `OMK_WALL_REPAIR_BUDGET` | Capped regenerate hints (default 1) |
| `OMK_WALL_OA_FIXTURE_PATH` | JSON fixture for local OA adjudication |
| `OMK_WALL_AUTO_REGENERATE` | Capped `regeneratePacket` in tool JSON (hints only) |
| `OMK_WALL_RECEIPT_SIGNING_SECRET` | Optional HMAC `signedReceipt` on verification receipt |
| `OMK_WALL_DEEP_PHASE` | `stub` (default) or `docker` (intent only; runner not wired) |
| `OMK_WALL_OA_TRANSPORT` | `fixture` (default) or `mcp` / `live` (session `callTool` injection) |

Telemetry (no diff bodies): `.omk/wall-cache/latest.json`, `shadow-telemetry.ndjson`, `repair-budget.json`.

## Explicit non-goals

- **Not proof of correctness** or formal verification.
- Does not replace human review, CI, or full `npm run check` / test suites.
- Does not expose internal thresholds, AST overlap, or raw repro bodies to end users.

## Loadout & preset

The correctness wall is **not** part of the default `omk-core-verified` preset or any built-in role loadout in `packages/coding-agent/src/core/loadouts.ts`. Operators opt in explicitly:

| Surface | How to enable |
|---------|----------------|
| **Session** | `omk --extension packages/coding-agent/examples/extensions/correctness-wall/index.ts` (or a copy under `~/.omk/agent/extensions/correctness-wall/`) |
| **Scope** | `OMK_WALL_SCOPE` — comma-separated path globs that approve write targets in the diff |
| **Mode** | `OMK_PATCH_SAFETY_WALL_MODE` — `shadow` \| `soft` \| `hard` (see [Operator environment](#operator-environment)) |
| **Role loadouts** | `code` / `executor` lanes still get `pre-shell-guard`, `protect-secrets`, and `typecheck-after-edit`; the wall **adds** a pre-apply policy gate on `edit` / `write` only when the extension is loaded |
| **Domain router** | No dedicated domain profile today; patch-safety work may route to [`ai-agent-ops`](./loadout-domains/ai-agent-ops.md) for harness/eval discipline, but that does **not** auto-load this extension |

**Domain router triggers (implemented):** `packages/coding-agent/src/core/domain-loadouts.ts` already contains keyword triggers (`correctness wall`, `patch safety`) and a path trigger (`correctness-wall`) that route to the PATCH SAFETY domain profile. The profile instructs operators to load the correctness-wall extension explicitly (not in default preset) and follow the shadow → soft → hard rollout. Auto-generated docs under `docs/loadout-domains/` should be regenerated via `gen-domain-docs.mjs`, not hand-edited.

Regression coverage for the wall library surface lives in `packages/coding-agent/test/suite/regressions/018-b2c-correctness-wall.test.ts` (imports `omk-adaptorch-wpl` the same way the extension does).

## Recommended rollout: shadow → soft → hard

Roll out in **three phases** so telemetry and false positives are understood before writes are blocked.

| Phase | `OMK_PATCH_SAFETY_WALL_MODE` | Operator expectation |
|-------|------------------------------|--------------------|
| **1 — Shadow** | `shadow` (default) | All `edit` / `write` calls proceed. Verdicts land in `.omk/wall-cache/latest.json` and `shadow-telemetry.ndjson`. Review BLOCKED/INCONCLUSIVE rates and tune `OMK_WALL_SCOPE`. |
| **2 — Soft** | `soft` | **BLOCKED** verdicts block apply unless `OMK_WALL_OVERRIDE=1` (or `true` / `yes`). **INCONCLUSIVE** still applies in shadow-like fashion for scope tuning. Use for pilot teams with an explicit override path. |
| **3 — Hard** | `hard` | **BLOCKED** and **INCONCLUSIVE** both block `edit` / `write`. Reserve for repos with stable scope globs, OA fixtures wired (`OMK_WALL_RUN_IDS` + `OMK_WALL_OA_FIXTURE_PATH`), and acceptable INCONCLUSIVE rate (missing files, empty diff). |

**Checklist between phases**

1. AC-1 vitest green for `packages/adaptorch-wpl` and regression `018-b2c-correctness-wall`.
2. Root `npm run check` green after any source touch (includes unrelated **browser-smoke** esbuild gate — wall work does not require loading the extension in that script).
3. Shadow NDJSON reviewed: no systematic secret false negatives; scope globs cover intended packages only.
4. Document team override policy before enabling **soft**.

## Wave 2 / Wave 3 roadmap (pointer)

Goal orchestration v2 artifacts (planner P3) live beside batch-1 plan files:

| Artifact | Path |
|----------|------|
| 11-step evaluation algorithm + decision table | `.omk/goals/b2c-correctness-wall-2026-07-08/algorithm-v2.md` |
| Three-wave execution DAG (JSON) | `.omk/goals/b2c-correctness-wall-2026-07-08/dag-v2.json` |
| Explorer: browser-smoke vs extension load + loadout gaps | `.omk/goals/b2c-correctness-wall-2026-07-08/laneE-explorer.md` |

**Wave 2 (prove / integrate) — Partial:**
- ✅ `domain-loadouts.ts` triggers for `correctness wall` / `patch safety` shipped (keyword + path patterns, PATCH SAFETY domain profile).
- ✅ Evidence receipt v3 (ALG-003 15/15) gates deep-wall availability on valid execution receipts.
- ⬜ `AdaptOrchClient` hook wiring when session has run context — not yet connected.
- ⬜ Lift `BATCH1_NO_DOCKER_RUNNER` for non-preview deep wall — still stub.
- ⬜ Preset documentation in `~/.omk/runtime-preset.json` — deferred.

**Wave 3 (productize) — Not started:**
- ⬜ Publish `omk-adaptorch-wpl` from `dist/` for out-of-monorepo extensions.
- ✅ `domain-loadouts.ts` profile exists; `gen-domain-docs.mjs` regen pending.
- ⬜ Default **soft** for internal dogfood presets after Wave 2 evidence.

## See also

- [adaptorch-preview.md](./adaptorch-preview.md)
- [LOADOUT.md](../examples/extensions/correctness-wall/LOADOUT.md) — copy-paste for `omk-core-verified` sessions
- Goal artifacts: `.omk/goals/b2c-correctness-wall-2026-07-08/` (`algorithm-v2.md`, `dag-v2.json`)
- Extension README: `packages/coding-agent/examples/extensions/correctness-wall/README.md`