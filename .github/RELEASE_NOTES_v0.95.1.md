# OMK v0.95.1

OMK v0.95.1 is a patch release published to npm as `open-multi-agent-kit@0.95.1`, in lockstep with `omk-ai`, `omk-agent-core`, `omk-tui`, and `omk-adaptorch-wpl`. Prebuilt binaries are attached to the GitHub release.

## Highlights

| Area | What changed |
| --- | --- |
| Harness Graph | Build-time agents×skills×hooks×MCP control plane: inventory, bipartite SPOF, Louvain communities, lift rules, hybrid CF wiring recs, health gate, dashboard, CI |
| Debt burn-down | Retired `protect-secrets` capability refs pruned; skills-index compacted to demand-union; health gate **PASS**; scorecard **96/100** |
| Docs / AEO | Root README FAQ + marketing/SEO skill map; changelog + release notes |

## Harness Graph

Deterministic suite under `.omk/harness-graph/` (stdlib + networkx):

```bash
bash .omk/harness-graph/run.sh
python3 .omk/harness-graph/health_gate.py --json   # expect PASS
python3 .omk/harness-graph/test_harness_graph.py
python3 .omk/harness-graph/test_properties.py
```

Primary reads: `out/dashboard.md`, `out/health-gate.md`, `out/wiring-patch.md`, `SCORECARD.md`.

CI: `.github/workflows/harness-graph.yml` (unit + property tests on harness-graph paths).

Spec: `specs/012-harness-graph-engineering/`.

## Marketing / SEO skills (operator install)

Route growth work through `omk-marketing`. Skill keywords covered by the bundled pack include:

`ab-testing`, `ab-test-setup`, `ad-creative`, `ads`, `ai-seo`, `analytics`, `aso`, `churn-prevention`, `co-marketing`, `cold-email`, `community-marketing`, `competitor-profiling`, `competitors`, `content-strategy`, `copy-editing`, `copywriting`, `cro`, `customer-research`, `directory-submissions`, `emails`, `free-tools`, `image`, `launch`, `lead-magnets`, `marketing-council`, `marketing-ideas`, `marketing-loops`, `marketing-plan`, `marketing-psychology`, `offers`, `onboarding`, `paywalls`, `popups`, `pricing`, `product-marketing`, `programmatic-seo`, `prospecting`, `public-relations`, `referrals`, `revops`, `sales-enablement`, `schema`, `seo-audit`, `signup`, `site-architecture`, `sms`, `social`, `video`.

## Install

```bash
npm install -g open-multi-agent-kit@0.95.1 --ignore-scripts
omk --version
```

## Verification

- `python3 .omk/harness-graph/test_harness_graph.py`
- `python3 .omk/harness-graph/test_properties.py`
- `python3 .omk/harness-graph/health_gate.py` → PASS
- monorepo `npm run check` via release gate

## Migration and rollback

No migration required. Roll back with:

```bash
npm install -g open-multi-agent-kit@0.95.0 --ignore-scripts
```
