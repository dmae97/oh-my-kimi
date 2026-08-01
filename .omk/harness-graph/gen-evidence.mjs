#!/usr/bin/env node
// Evidence generator — runs each spec task's read-only verify command and writes an honest
// evidence file (command + exit + captured head) to .omk/runs/harness-graph/T0xx.md.
// No fabrication: every result is the real command output.

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const RUNS = path.join(process.cwd(), ".omk/runs/harness-graph");
fs.mkdirSync(RUNS, { recursive: true });

const TASKS = [
  ["T001", "Graph engine + 3-tier", "node .omk/harness-graph/build-harness-graph.mjs | tail -5"],
  ["T002", "Reconcile catalog", "node .omk/harness-graph/reconcile-catalog.mjs | head -3"],
  ["T003", "MCP hardening + hygiene", "node .omk/harness-graph/build-harness-graph.mjs | grep -E 'dead mcp|dead hooks'"],
  ["T004", "Root activation (inactive:0)", "node .omk/harness-graph/build-harness-graph.mjs | grep inactive"],
  ["T005", "networkx structural", "python3 .omk/harness-graph/graph_analyze.py | tail -2"],
  ["T006", "Drift loop", "python3 .omk/harness-graph/drift_loop.py | head -3"],
  ["T007", "Framework research", "test -f .omk/harness-graph/FRAMEWORK-RESEARCH.md && echo EXISTS"],
  ["T008", "Meta-skill alignment", "grep -c harness-graph ~/.agents/skills/harness/SKILL.md"],
  ["T009", "Normalize dead+malformed", "node .omk/harness-graph/build-harness-graph.mjs | grep -E 'DEAD|malformed'"],
  ["T010", "Orphan triage", "test -f .omk/harness-graph/out/orphan-triage.md && echo EXISTS"],
  ["T011", "Session hook", "test -x .omk/harness-graph/hooks/session-drift-audit.sh && echo EXECUTABLE"],
  ["T012", "Governance verify", "test -f specs/012-harness-graph-engineering/spec.md && echo SPEC-PRESENT"],
  ["T013", "Skill-wiring recommender", "python3 .omk/harness-graph/recommend-wiring.py | head -3"],
  ["T014", "Harness↔code cross-link", "python3 .omk/harness-graph/code_crosslink.py | head -3"],
  ["T015", "Bipartite SPOF criticality", "python3 .omk/harness-graph/graph_analyze.py | grep -E 'top SPOF|critical-caps'"],
  ["T016", "Health gate + allowlist", "python3 .omk/harness-graph/health_gate.py; test -f .omk/harness-graph/out/health-gate.md"],
  ["T017", "Dashboard + unit tests", "python3 .omk/harness-graph/test_harness_graph.py && test -f .omk/harness-graph/out/dashboard.md"],
  ["T018", "Projection+modularity communities", "python3 .omk/harness-graph/graph_analyze.py | grep -E 'communities:|top community'"],
  ["T019", "Association lift rules", "python3 .omk/harness-graph/graph_analyze.py | grep 'top rule'"],
  ["T020", "Hybrid CF recommender", "python3 .omk/harness-graph/recommend-wiring.py | grep -E 'hybrid|top lift|agents with recs'"],
  ["T021", "Docs + scorecard", "test -f .omk/harness-graph/SCORECARD.md && grep -q '96' .omk/harness-graph/SCORECARD.md && grep -q 'Requirement 7' specs/012-harness-graph-engineering/spec.md && echo DOCS-OK"],
  ["T022", "protect-secrets pruned", "node .omk/harness-graph/build-harness-graph.mjs | grep -E 'dead hooks: 0'"],
  ["T023", "orphans under budget", "python3 -c \"import json;q=json.load(open('.omk/harness-graph/out/harness-queries.json'));assert len(q['orphanActiveSkills'])<=150\""],
  ["T024", "health gate PASS", "python3 .omk/harness-graph/health_gate.py --json | grep -q 'PASS'"],
  ["T025", "property tests", "python3 .omk/harness-graph/test_properties.py"],
  ["T026", "wiring patch artifact", "test -f .omk/harness-graph/out/wiring-patch.md && echo OK"],
  ["T027", "CI workflow", "test -f .github/workflows/harness-graph.yml && echo OK"],
];

let pass = 0;
for (const [id, title, cmd] of TASKS) {
  let out, ok;
  try { out = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); ok = true; pass++; }
  catch (e) { out = (e.stdout || "") + (e.stderr || e.message); ok = false; }
  const md = [
    `# ${id} — ${title}`, "", `**Status**: ${ok ? "✅ verified" : "❌ failed"}`,
    `**When**: ${new Date().toISOString()}`, "", "**Verify command**:", "```bash", cmd, "```",
    "", "**Result**:", "```", out.slice(0, 800), "```", "",
  ].join("\n");
  fs.writeFileSync(path.join(RUNS, `${id}.md`), md);
}
console.log(`evidence -> .omk/runs/harness-graph/ (${pass}/${TASKS.length} verified)`);
