#!/usr/bin/env bash
# Standing drift + health audit hook. Rebuilds the harness graph, diffs vs the
# previous snapshot, and surfaces FAIL/WARN from the health gate.
# Wire into OMK session_start (register-hook.mjs). Read-only; never mutates agents.
#
# Exit codes:
#   0 — PASS or WARN (allowlisted residual debt)
#   1 — health gate FAIL (new/grown debt) when HARNESS_GRAPH_STRICT=1 (default)
# Set HARNESS_GRAPH_STRICT=0 to keep session non-blocking (legacy soft mode).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
STRICT="${HARNESS_GRAPH_STRICT:-1}"

node .omk/harness-graph/build-harness-graph.mjs >/dev/null 2>&1 || {
	echo "[harness-drift] build failed"
	exit 0
}
python3 .omk/harness-graph/graph_analyze.py >/dev/null 2>&1 || true
python3 .omk/harness-graph/drift_loop.py 2>/dev/null | sed 's/^/[harness-drift] /' || true

set +e
GATE_OUT="$(python3 .omk/harness-graph/health_gate.py 2>&1)"
GATE_RC=$?
set -e
python3 .omk/harness-graph/dashboard.py >/dev/null 2>&1 || true

STATUS="$(printf '%s\n' "$GATE_OUT" | head -n1)"
echo "[harness-health] $STATUS"
if [[ "$GATE_RC" -ne 0 ]] || printf '%s\n' "$GATE_OUT" | grep -q "🟠\|🔴"; then
	printf '%s\n' "$GATE_OUT" | sed 's/^/[harness-health] /'
	echo "[harness-health] see .omk/harness-graph/out/health-gate.md + dashboard.md"
fi

if grep -q "🔴\|🟠" .omk/harness-graph/out/drift-report.md 2>/dev/null; then
	echo "[harness-drift] ⚠ drift detected — see .omk/harness-graph/out/drift-report.md"
fi

if [[ "$STRICT" == "1" && "$GATE_RC" -ne 0 ]]; then
	echo "[harness-health] STRICT fail (HARNESS_GRAPH_STRICT=1)"
	exit "$GATE_RC"
fi
exit 0
