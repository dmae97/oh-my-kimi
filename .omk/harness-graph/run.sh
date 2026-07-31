#!/usr/bin/env bash
# Regenerate every harness-graph report deterministically. Read-only except when you pass --fix.
set -euo pipefail
cd "$(dirname "$0")/../.." # -> project root

echo "== build harness graph =="
node .omk/harness-graph/build-harness-graph.mjs

echo "== reconcile catalog (P0) =="
node .omk/harness-graph/reconcile-catalog.mjs

echo "== structural analysis (networkx) =="
python3 .omk/harness-graph/graph_analyze.py

echo "== wiring recommendations (item-based CF) =="
python3 .omk/harness-graph/recommend-wiring.py

echo "== code cross-link (skill->script->dependency) =="
python3 .omk/harness-graph/code_crosslink.py

echo "== drift loop (snapshot + diff vs previous) =="
python3 .omk/harness-graph/drift_loop.py

if [[ "${1:-}" == "--fix" ]]; then
	echo "== apply agent hygiene (backs up first) =="
	node .omk/harness-graph/fix-agent-hygiene.mjs --apply
	echo "== activate demanded skill roots (idempotent, backs up settings.json) =="
	node .omk/harness-graph/activate-roots.mjs --apply
else
	echo "== agent hygiene (dry-run; pass --fix to apply) =="
	node .omk/harness-graph/fix-agent-hygiene.mjs
fi

echo "== done -> .omk/harness-graph/out/ =="
ls -1 .omk/harness-graph/out/
