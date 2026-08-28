# Lane F — AdaptOrch Preview Algorithm (structured spec)

**Status:** Proposed.

**Evidence roots:** `packages/adaptorch-wpl/`, `.omk/runs/adaptorch-native-loop-algorithm-20260701/final-part1-core-algorithm.md`, `packages/coding-agent/src/core/adaptorch-bridge.ts`, `packages/coding-agent/docs/loadout-domains/README.md`.

**Not a shipped runtime:** this spec describes a **preview** path (planning, routing, and evidence contracts) unless a future implementation lane wires it.

---

## Inputs

| Input | Type | Source | Notes |
| --- | --- | --- | --- |
| `task_text` | string | user / lane kickoff | Primary routing signal; may be truncated for headroom. |
| `path_hints` | string[] | cwd, owned paths, globs | Optional; used for domain triggers and write-scope checks. |
| `upstream_tags` | string[] | goal id, lane role, preset | e.g. `grok-adaptorch-prod`, `omk-planner`. |
| `payload_shape` | object | planner / DAG artifact | Non-empty `subtasks` array plus optional `dependencies`; descriptions are bounded and sanitized, with no secrets or session ids. |
| `provider_profile` | enum | session | `xai` \| `default` \| other registered provider. |
| `adaptorch_transport` | optional | MCP grant | If absent, preview runs **local-only** (OMK compose + deterministic fallbacks). |
| `lane_grants[]` | object[] | root coordinator | Each: scope, authority, skills, MCP, acceptance, evidence path. |
| `budget_caps` | object | loop / goal | `max_lanes`, `max_dispatch_preview_calls`, wall-clock cap (immutable per preview instance). |

**Hard input exclusions (never pass into AdaptOrch advisory or preview payloads):** raw full prompts or hashes, bulk file lists, session/user ids, live-turn tool names, hook stderr, credentials, and `.env` material. `subtasks[].description` contains only the bounded, sanitized task summary needed by the topology router.

---

## Stage A — Signal intake and domain preview

**Purpose:** Normalize the kickoff into scored domain signals and a confidence band before any external control-plane call.

**Steps:**

1. Lowercase and tokenize `task_text`; merge `path_hints` and `upstream_tags` into the scoring buffer.
2. Score each registered domain profile (keyword, regex, extension, path triggers) per `loadout-domains` rules.
3. Emit `domain_leader`, `confidence` (`confident` \| `tentative` \| `fallback`), and `ambiguous` flag (runner-up within margin).
4. Attach recommended **read-only** skills tier (max 2–3) from domain + task class — do not bulk-load the catalog.

**Outputs:** `PreviewSignalRecord { domain_id, confidence, ambiguous, suggested_skills[] }`.

---

## Stage B — Topology preview (AdaptOrch read/local)

**Purpose:** Classify execution topology **without** submitting `adaptorch_run`.

**Precondition:** `adaptorch_transport` granted **and** `payload_shape` is sanitized.

**Steps:**

1. Call `adaptorch_capabilities` once per preview session (cache TTL).
2. Call `adaptorch_route_topology` with `payload_shape` as the tool's top-level argument object.
3. Read `raw.topology` and validate it against `adaptorch_capabilities.topologies`.
4. If transport is missing or the value is outside that advertised set, set `topology = null` and record a bounded `skipped_reason`.

**Outputs:** `TopologyPreview { topology: string | null, raw_redacted_summary }`.

---

## Stage C — Lane grant and loadout compose

**Purpose:** Turn topology + domain into non-overlapping lane grants for parallel workers.

**Steps:**

1. Treat topology as advice only. For any proposed parallel lane set, decompose along **write-scope boundaries** (one writer per file) and validate dependencies independently.
2. Compose each lane: `scope`, `authority`, `skills[]`, `mcp[]`, relevant hooks, `acceptance`, `evidence_output_path`.
3. Run read-only authority stripping and always-on security hooks policy.
4. Reject parallel grants that share the same write path.

**Outputs:** `LaneGrantTable[]`, `compose_diagnostics[]`.

---

## Stage D — Dispatch cardinality preview

**Purpose:** Preview how many `adaptorch_run` invocations a full loop **might** need without issuing them.

**Steps:**

1. Read `observed_cardinality_mode` if configured (`single_call` \| `fanout_n` \| `uncalibrated`).
2. Under `single_call`: `expected_run_ids = 1` per dispatch record.
3. Under `fanout_n`: derive N only from an explicit caller-owned dispatch template; topology names alone do not determine call count. Label the result as a hypothesis until calibrated.
4. Flag `cardinality_anomaly` if prior observations disagree with mode.

**Outputs:** `DispatchPreview { cardinality_mode, expected_run_ids, anomaly_flag }`.

---

## Stage E — Verification preview (adjudicator contract)

**Purpose:** State what evidence the Outcome Adjudicator would require **before** any run exists.

**Steps:**

1. Select verifier registry entry by packet `kind` (string class, stable across retries).
2. List required checks: terminal run status, artifact presence, trace sanity, scope/schema/content gates.
3. Map foreseeable `reason_code` values to disposition classes (`escalate`, `reroute_on_recurrence`, `retry_same_topology`) — preview only, no `adjudicate()` call.

**Outputs:** `VerificationPreview { kind, required_checks[], reason_code_map_summary }`.

---

## Stage F — Evidence and synthesis contract

**Purpose:** Fix the artifact paths and synthesis inputs for the root coordinator.

**Steps:**

1. Require per-lane evidence files under `.omk/goals/<goal-id>/evidence/` (or lane grant path).
2. Define synthesis inputs: explorer facts, planner DAG, tester output, reviewer verdict — **no** success claims without attached evidence class.
3. Optional: if synthesis is explicitly authorized post-evidence, list allowed tools; else local `SYNTHESIS.md` merge.
4. Emit `PreviewResult` bundle for operators and doc cross-links.

**Outputs:** `PreviewResult`, pointers to `packages/coding-agent/docs/adaptorch-preview.md` and this file.

---

## Algorithm 1 — PreviewOrchestrate

```
function PreviewOrchestrate(inputs):
  assert inputs.task_text is non-empty
  A <- StageA_SignalIntake(inputs.task_text, inputs.path_hints, inputs.upstream_tags)
  if inputs.adaptorch_transport is granted and inputs.payload_shape is sanitized:
    B <- StageB_TopologyPreview(inputs.adaptorch_transport, inputs.payload_shape)
  else:
    B <- { topology: null, skipped_reason: transport_or_shape }
  C <- StageC_ComposeLanes(A, B, inputs.lane_grants, inputs.budget_caps)
  D <- StageD_DispatchCardinalityPreview(B, loop_config.observed_cardinality_mode)
  E <- StageE_VerificationPreview(C.default_kind)
  F <- StageF_EvidenceContract(inputs.goal_id, C.lanes)
  return PreviewResult(A, B, C, D, E, F)
```

---

## Algorithm 2 — TopologyClassifyPreview

```
function TopologyClassifyPreview(transport, payload_shape):
  caps <- transport.call("adaptorch_capabilities", {})
  if caps indicates unsupported connector:
    return { topology: null, skipped_reason: capabilities }
  raw <- transport.call("adaptorch_route_topology", payload_shape)
  topology <- extract_enum(raw.topology, caps.topologies)
  if topology is missing:
    return { topology: null, skipped_reason: unparseable }
  return { topology: topology, raw_redacted_summary: redact(raw) }
```

---

## Algorithm 3 — ClaimSafeNarration

```
function ClaimSafeNarration(preview_result, utterance):
  FORBIDDEN <- phrases implying production AdaptOrch execution without run evidence
  ALLOWED <- planning, routing preview, lane grants, read/local tool names, fallback paths
  if utterance matches any FORBIDDEN pattern:
    return { ok: false, rewrite_hint: use ALLOWED framing + cite evidence path }
  if utterance claims "done" or "verified":
    require preview_result.F.evidence_paths exist and tester evidence class satisfied
  return { ok: true, utterance }
```

---

## Acceptance (Lane F)

| Criterion | Evidence |
| --- | --- |
| This spec exists at the path above | read in session |
| adaptorch-preview.md links here | link check in intro doc |
| No adaptorch-wpl src edits | git status scoped to docs + goal only |
| Algorithms 1–3 present as pseudocode | this file Algorithms section |
