#!/usr/bin/env bash
# Regenerate every harness-graph report deterministically. Read-only except when you pass --fix.
# Exit non-zero if the health gate FAILs (use --no-gate to skip).
set -euo pipefail
cd "$(dirname "$0")/../.." # -> project root

NO_GATE=0
FIX=0
for arg in "$@"; do
	case "$arg" in
	--fix) FIX=1 ;;
	--no-gate) NO_GATE=1 ;;
	esac
done

echo "== build harness graph =="
node .omk/harness-graph/build-harness-graph.mjs

echo "== reconcile catalog (P0) =="
node .omk/harness-graph/reconcile-catalog.mjs

echo "== structural analysis (networkx, bipartite SPOF) =="
python3 .omk/harness-graph/graph_analyze.py

echo "== wiring recommendations (hybrid CF: jaccard·idf·lift) =="
python3 .omk/harness-graph/recommend-wiring.py

echo "== wiring patch (review-only half-bundles) =="
python3 .omk/harness-graph/apply-wiring-patch.py

echo "== code cross-link (skill->script->dependency) =="
python3 .omk/harness-graph/code_crosslink.py

echo "== drift loop (snapshot + diff vs previous) =="
python3 .omk/harness-graph/drift_loop.py

echo "== orphan triage (report-only) =="
node .omk/harness-graph/orphan-triage.mjs

echo "== health gate (fail-closed + allowlisted debt) =="
set +e
python3 .omk/harness-graph/health_gate.py
GATE_RC=$?
set -e

echo "== dashboard =="
python3 .omk/harness-graph/dashboard.py

if [[ "$FIX" -eq 1 ]]; then
	echo "== apply agent hygiene (backs up first) =="
	node .omk/harness-graph/fix-agent-hygiene.mjs --apply
	echo "== activate demanded skill roots (idempotent, backs up settings.json) =="
	node .omk/harness-graph/activate-roots.mjs --apply
	echo "== compact skills-index (agent-demanded ∪ settings ∪ skills.json) =="
	node .omk/harness-graph/compact-skills-index.mjs --apply
else
	echo "== agent hygiene (dry-run; pass --fix to apply) =="
	node .omk/harness-graph/fix-agent-hygiene.mjs
	echo "== compact skills-index (dry-run) =="
	node .omk/harness-graph/compact-skills-index.mjs
fi

echo "== unit + property tests =="
python3 .omk/harness-graph/test_harness_graph.py
python3 .omk/harness-graph/test_properties.py

echo "== done -> .omk/harness-graph/out/ =="
ls -1 .omk/harness-graph/out/

if [[ "$NO_GATE" -eq 0 && "$GATE_RC" -ne 0 ]]; then
	echo "health gate FAILED (exit $GATE_RC) — see .omk/harness-graph/out/health-gate.md" >&2
	exit "$GATE_RC"
fi
