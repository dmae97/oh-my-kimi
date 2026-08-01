# Harness Graph — Scorecard (100)

_Re-scored 2026-08-01 after Phase-8 debt burn-down. Evidence over claims._

**Overall: 96 / 100** — ops-clean control plane. Health gate **PASS**, dead hooks **0**,
orphans **36**, model default drift **none**. Residual −4 is intentional non-auto-apply
and concentration soft-caps.

## Method

Weighted rubric on live artifacts + tests + runtime discovery.

| # | category | weight | score | weighted |
| --- | --- | ---: | ---: | ---: |
| 1 | Inventory accuracy & ground truth | 15 | 15 | 15.0 |
| 2 | Structural intelligence (SPOF/algos) | 15 | 14 | 14.0 |
| 3 | Temporal drift & fail-closed gate | 15 | 15 | 15.0 |
| 4 | Recommendation / actionability | 10 | 10 | 10.0 |
| 5 | Hygiene & residual debt | 15 | 14 | 14.0 |
| 6 | Automation / ops wiring | 10 | 10 | 10.0 |
| 7 | Tests & evidence discipline | 10 | 10 | 10.0 |
| 8 | Docs & governance | 10 | 8 | 8.0 |
| | **Total** | **100** | | **96.0** |

## What changed since 82

| gap | action | delta |
| --- | --- | ---: |
| protect-secrets ×209 | `prune-retired-hooks --targets protect-secrets --apply` (211 tokens, 209 agents, backup tgz) | +5 |
| orphan-active 434 | `compact-skills-index` — index 511→365 (agent∪settings∪skills.json only) → orphans **36** | +3 |
| model drift false+ | default-only drift axis; failover → notes; harness prose no longer false-pins opus | +2 |
| CI + strict session | `.github/workflows/harness-graph.yml` + `HARNESS_GRAPH_STRICT=1` session hook | +3 |
| property tests | `test_properties.py` (lift/IDF/Jaccard invariants) | +1 |
| recs acceptance path | `apply-wiring-patch.py` → half-bundles + cf-top review patch | +2 |
| docs/meta-skill | Phase 7-5 OMK graph path; scorecard/readme/spec | +1 (partial) |
| allowlist emptied | `debt-allowlist` dead_hooks={} ; orphan budget 150 | gate PASS |

## Category notes

### 1. Inventory — 15/15

- skill dead/inactive/malformed/mcp dead/hook dead = **0**
- catalogs runtime-derived; empty discovery throws
- skills-index compacted to demand union (no universe dump)

### 2. Structural — 14/15

- bipartite SPOF, Louvain 12, lift 40, redundancy 17, cycles 0
- −1: concentration still soft-WARN only (by design — hubs are real)

### 3. Drift + gate — 15/15

- hook/MCP deltas alert; health **PASS** (0 fail, 0 warn)
- session hook STRICT fail on gate FAIL; CI unit+property workflow

### 4. Recommendation — 10/10

- hybrid CF + **wiring-patch** (59 half-bundles, 71 cf-top) review-only

### 5. Hygiene — 14/15

- protect-secrets gone; orphans 36 ≪ 150 budget
- −1: 17 redundancy pairs still manual merge candidates

### 6. Automation — 10/10

- run.sh full pipeline; hook registered; CI workflow; backups on mutate

### 7. Tests — 10/10

- 18 unit + 6 property tests green; evidence T001–T021

### 8. Docs — 8/10

- scorecard/spec/plan/readme/framework aligned
- −2: harness meta-skill still dual-runtime (Claude paths remain for that audience)

## Live floor metrics

```text
agents                 282
skill edges            1183 active / 0 inactive / 0 dead
hook edges dead        0
mcp edges dead         0
malformed agents       0
orphan-active          36 / budget 150
skills active catalog  365 (was 763)
communities            12 (Louvain)
association rules      40
skill redundancy       17
wiring half-bundles    59
unit tests             18/18
property tests         6/6
health gate            PASS
model default drift    no (failover noted separately)
live *.sh hooks        13
```

## Remaining path to 100

| gap | delta | how |
| --- | ---: | --- |
| Merge top redundancy pairs | +1 | human review of J=1.0 twins |
| Meta-skill single-runtime polish | +2 | optional; Claude audience still valid |
| Concentration hard SLO | +1 | only if product wants FAIL on hub share |

## Grade bands

| band | meaning |
| --- | --- |
| **90–100** | **← here** ops-clean: no allowlisted dead runtime caps, orphans trimmed, CI-enforced |
| 80–89 | analytics + gate trustworthy; known debt explicit |
| 70–79 | inventory works; SPOF/gate incomplete |

## Commands

```bash
bash .omk/harness-graph/run.sh
python3 .omk/harness-graph/health_gate.py --json   # expect PASS
python3 .omk/harness-graph/test_harness_graph.py
python3 .omk/harness-graph/test_properties.py
# primary read: out/dashboard.md + SCORECARD.md
```
