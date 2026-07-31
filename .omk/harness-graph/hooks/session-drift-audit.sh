#!/usr/bin/env bash
# T011 — standing drift audit hook. Rebuilds the harness graph and diffs vs the previous
# snapshot; prints drift alerts. Wire into OMK session_start (see README). Read-only.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)" # project root (.omk/harness-graph/hooks -> root)
cd "$ROOT"

node .omk/harness-graph/build-harness-graph.mjs >/dev/null 2>&1 || {
	echo "[harness-drift] build failed"
	exit 0
}
python3 .omk/harness-graph/drift_loop.py 2>/dev/null | sed 's/^/[harness-drift] /' || true

# surface only if alerts exist
if grep -q "🔴\|🟠" .omk/harness-graph/out/drift-report.md 2>/dev/null; then
	echo "[harness-drift] ⚠ drift detected — see .omk/harness-graph/out/drift-report.md"
fi
exit 0
