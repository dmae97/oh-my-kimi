import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { analyzeUserIntent, createGoalSpec, normalizeGoal, updateGoalStatus } from "../dist/goal/intake.js";
import { createGoalPersister } from "../dist/goal/persistence.js";
import { compileGoalToDagNodes, attachGoalToRunState } from "../dist/goal/compiler.js";
import {
  cleanupControlLoopRun,
  evaluateAdaptiveLoopGuard,
  evaluateGoalProgressDelta,
  evaluateGoalProgressEnsemble,
  generateNextPrompt,
  getControlLoopCacheStats,
  pruneControlLoopRunCaches,
} from "../dist/goal/control-loop.js";
import { buildIntentFrame, evaluatePromptNovelty } from "../dist/goal/intent-frame.js";
import { scoreGoal } from "../dist/goal/scoring.js";
import { checkGoalEvidence } from "../dist/goal/evidence.js";
import { evaluateMissingCriteria, suggestNextAction } from "../dist/goal/eval-criteria.js";
import { createRoutedRunState } from "../dist/orchestration/run-state.js";
import { createDag } from "../dist/orchestration/dag.js";
import { goalCloseCommand, goalCreateCommand, goalPlanCommand } from "../dist/commands/goal.js";
import { CliError } from "../dist/util/cli-contract.js";

const CLI = join(process.cwd(), "dist", "cli.js");

async function tempGoalDir() {
  return mkdtemp(join(tmpdir(), "omk-goal-"));
}

test("control-loop run caches are bounded and can be cleaned after completion", () => {
  const progressDelta = {
    value: 0,
    newlyPassedCriteria: [],
    newlyPassedOptionalCriteria: [],
    newlyValidArtifacts: [],
    newlyFailedCriteria: [],
    failedCriteria: [],
    missingRequiredCriteria: [],
    blockedNodes: [],
    repeatedFailures: [],
    recommendation: "continue",
    reason: "test",
    preserveEvidence: true,
  };
  const ensemble = { confidence: 0.5, action: "continue" };

  for (let index = 0; index < 140; index += 1) {
    evaluateAdaptiveLoopGuard({
      runId: `cache-run-${index}`,
      startedAt: new Date().toISOString(),
      nodes: [],
      workerCount: 1,
      iterationCount: 1,
      maxIterations: 10,
    }, progressDelta, ensemble);
  }

  assert.ok(getControlLoopCacheStats().trackedRuns <= 128);
  cleanupControlLoopRun("cache-run-139");
  assert.ok(getControlLoopCacheStats().trackedRuns < 128);
  pruneControlLoopRunCaches(Date.now() + 25 * 60 * 60 * 1000);
  assert.equal(getControlLoopCacheStats().trackedRuns, 0);
});

async function tempGoalCliFixture({ summary = true } = {}) {
  const root = await tempGoalDir();
  const bin = join(root, "bin");
  const workspace = join(root, "workspace");
  await mkdir(bin, { recursive: true });
  await mkdir(workspace, { recursive: true });
  // Copy tracked agent templates so the fixture is hermetic in clean CI checkouts.
  try {
    await cp(join(process.cwd(), "templates", ".omk", "agents"), join(workspace, ".omk", "agents"), { recursive: true });
    await mkdir(join(workspace, ".omk", "prompts"), { recursive: true });
    await copyFile(
      join(process.cwd(), "templates", ".omk", "prompts", "root.md"),
      join(workspace, ".omk", "prompts", "root.md"),
    );
    await copyFile(
      join(workspace, ".omk", "agents", "roles", "planner.yaml"),
      join(workspace, ".omk", "agents", "roles", "orchestrator.yaml"),
    );
  } catch {
    // ignore if source file is missing
  }
  const outputLines = summary
    ? [
      "## Summary",
      "OMK goal execution completed with verification evidence.",
      "A scoped execution plan exists before worker delegation.",
      "Documentation reflects the verified behavior.",
      "The reported issue is reproduced, fixed, and verified with a regression test.",
      "Success criteria and quality gates are verified.",
      "## Evidence",
      "- npm run check passed",
      "## Verification",
      "- all required criteria passed",
    ]
    : ["short"];
  const fakeKimiSource = `${outputLines.map((line) => `console.log(${JSON.stringify(line)});`).join("\n")}\nprocess.exit(0);\n`;
  const fakeCodexSource = [
    "import { writeFileSync } from 'node:fs';",
    "const args = process.argv.slice(2);",
    "if (args.includes('--version')) { console.log('codex 0.0.0-test'); process.exit(0); }",
    "const outputIndex = args.indexOf('--output-last-message');",
    "const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;",
    `const output = ${JSON.stringify(outputLines.join("\n"))};`,
    "if (outputPath) writeFileSync(outputPath, output + '\\n');",
    "console.log(output);",
    "process.exit(0);",
    "",
  ].join("\n");
  const kimiBin = join(bin, process.platform === "win32" ? "kimi.cmd" : "kimi");
  const codexBin = join(bin, process.platform === "win32" ? "codex.cmd" : "codex");
  if (process.platform === "win32") {
    const fakeKimiScript = join(bin, "kimi.mjs");
    const fakeCodexScript = join(bin, "codex.mjs");
    await writeFile(fakeKimiScript, fakeKimiSource, "utf-8");
    await writeFile(fakeCodexScript, fakeCodexSource, "utf-8");
    await writeFile(kimiBin, `@echo off\r\n"${process.execPath}" "${fakeKimiScript}" %*\r\n`, "utf-8");
    await writeFile(codexBin, `@echo off\r\n"${process.execPath}" "${fakeCodexScript}" %*\r\n`, "utf-8");
  } else {
    const fakeKimiScript = join(bin, "kimi.mjs");
    const fakeCodexScript = join(bin, "codex.mjs");
    await writeFile(fakeKimiScript, fakeKimiSource, "utf-8");
    await writeFile(fakeCodexScript, fakeCodexSource, "utf-8");
    await writeFile(kimiBin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeKimiScript)} "$@"\n`, { mode: 0o755 });
    await writeFile(codexBin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeCodexScript)} "$@"\n`, { mode: 0o755 });
  }
  await writeFile(join(workspace, 'package.json'), JSON.stringify({ scripts: { check: 'node -e "process.exit(0)"' } }));
  const env = {
    ...process.env,
    OMK_PROJECT_ROOT: workspace,
    OMK_GOAL_ALPHA: "1",
    OMK_MODE: "agent",
    OMK_RESOURCE_PROFILE: "lite",
    OMK_MCP_SCOPE: "none",
    OMK_SKILLS_SCOPE: "none",
    OMK_RENDER_LOGO: "0",
    OMK_STAR_PROMPT: "0",
    OMK_AUTO_CONTINUE_MAX_ITERATIONS: "0",
    OMK_DEEPSEEK_GOAL_ENSEMBLE: "false",
    OMK_ISOLATED_HOME_INHERIT_AUTH: "0",
    KIMI_BIN: kimiBin,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
  };
  return { root, workspace, env };
}

function runGoalCli(args, env, timeout = 180_000) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: process.cwd(),
    env,
    encoding: "utf-8",
    timeout,
  });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf-8"));
}


test("IntentFrameV2 redacts secrets, extracts directives, and emits capability hints", () => {
  const rawPrompt = [
    "READ-ONLY scope: src/goal/intent-frame.ts",
    "expected output: novelty-report.json",
    "Use MCP skills hooks but no edits.",
    `OPENAI_API_KEY=${["sk", "proj", "secretsecretsecretsecret"].join("-")}`,
  ].join("\n");
  const frame = buildIntentFrame(rawPrompt, {
    constraints: ["Do not modify files"],
    successCriteria: ["Intent frame is deterministic"],
  });

  assert.equal(frame.schemaVersion, 2);
  assert.equal(frame.strict, true);
  assert.match(frame.rawPromptDigest, /^[a-f0-9]{12}$/);
  assert.ok(frame.directives.some((directive) => directive.kind === "read-only"));
  assert.ok(frame.directives.some((directive) => directive.kind === "scope"));
  assert.ok(frame.directives.some((directive) => directive.kind === "expected-output"));
  assert.equal(frame.capabilityHints.needsMcp, true);
  assert.equal(frame.capabilityHints.needsSkills, true);
  assert.equal(frame.capabilityHints.needsHooks, true);
  assert.equal(frame.capabilityHints.readOnly, true);
  assert.ok(frame.diagnostics.some((diagnostic) => diagnostic.kind === "redaction"));
  assert.doesNotMatch(JSON.stringify(frame), /sk-proj-secretsecret/);
  assert.ok(frame.actionAtoms.some((atom) => atom.label === "inspect-read-only-scope"));
  assert.ok(frame.actionAtoms.some((atom) => atom.label === "verify-evidence"));
});

test("analyzeUserIntent honors explicit read-only directives over write keywords", () => {
  const intent = analyzeUserIntent("READ-ONLY review src/goal/intake.ts and do not edit files");
  const frame = buildIntentFrame("READ-ONLY review src/goal/intake.ts and do not edit files");

  assert.equal(intent.isReadOnly, true);
  assert.equal(frame.capabilityHints.readOnly, true);
  assert.ok(frame.actionAtoms.some((atom) => atom.label === "inspect-read-only-scope"));
});

test("analyzeUserIntent treats Korean critical issue scan as parallel security review", () => {
  const intent = analyzeUserIntent("현재 변경사항에서 크리티컬 이슈와 위험을 찾아줘");

  assert.equal(intent.taskType, "review");
  assert.equal(intent.needsSecurityReview, true);
  assert.equal(intent.parallelizable, true);
  assert.ok(intent.requiredRoles.includes("security"));
  assert.ok(intent.requiredRoles.includes("reviewer"));
});

test("normalizeGoal creates a GoalSpec with inferred success criteria", () => {
  const spec = normalizeGoal({ rawPrompt: "Add a user authentication feature to the API" });

  assert.equal(spec.schemaVersion, 1);
  assert.ok(spec.goalId.length > 0);
  assert.ok(spec.title.length > 0);
  assert.ok(spec.objective.length > 0);
  assert.ok(spec.successCriteria.length > 0);
  assert.ok(spec.successCriteria.some((c) => c.inferred));
  assert.ok(["low", "medium", "high"].includes(spec.riskLevel));
  assert.equal(spec.status, "draft");
  assert.equal(spec.planRevision, 0);
  assert.deepEqual(spec.runIds, []);
  assert.ok(spec.intentFrame);
  assert.ok(spec.actionAtoms.length >= 3);
  assert.equal(spec.intentFrame.strict, true);
  assert.ok(spec.actionAtoms.some((atom) => atom.label === "implement-change"));
});

test("normalizeGoal accepts explicit title and objective", () => {
  const spec = normalizeGoal({
    rawPrompt: "Build a thing",
    title: "My Custom Title",
    objective: "Custom objective text",
    riskLevel: "low",
  });

  assert.equal(spec.title, "My Custom Title");
  assert.equal(spec.objective, "Custom objective text");
  assert.equal(spec.riskLevel, "low");
});

test("createGoalSpec parses structured English and Korean goal sections", () => {
  const spec = createGoalSpec(`
Implement goal automation

Success Criteria:
1. Planner JSON is parseable
2. Verification suggests the next action

제약:
- 절대 시크릿을 출력하지 않는다

비목표:
- 배포는 하지 않는다

리스크:
- stale evidence can mislead continuation

산출물:
- Plan file: \`docs/goal-plan.md\`
`);

  assert.deepEqual(spec.successCriteria.map((c) => c.description), [
    "Planner JSON is parseable",
    "Verification suggests the next action",
  ]);
  assert.equal(spec.constraints[0].description, "절대 시크릿을 출력하지 않는다");
  assert.equal(spec.nonGoals[0], "배포는 하지 않는다");
  assert.equal(spec.risks[0].description, "stale evidence can mislead continuation");
  assert.deepEqual(spec.expectedArtifacts[0], { name: "Plan file", path: "docs/goal-plan.md" });
});

test("createGoalSpec falls back to inferred criteria when no criteria section exists", () => {
  const spec = createGoalSpec("Add a strict goal planner JSON contract");

  assert.ok(spec.successCriteria.length > 0);
  assert.ok(spec.successCriteria.some((criterion) => criterion.inferred));
});

test("updateGoalStatus updates status and timestamps", () => {
  const spec = normalizeGoal({ rawPrompt: "Test" });
  const updated = updateGoalStatus(spec, "running", { runId: "run-1" });

  assert.equal(updated.status, "running");
  assert.ok(updated.updatedAt >= spec.updatedAt);
  assert.deepEqual(updated.runIds, ["run-1"]);
});

test("GoalPersister saves and loads GoalSpec atomically", async () => {
  const base = await tempGoalDir();
  const persister = createGoalPersister(base);
  const spec = normalizeGoal({ rawPrompt: "Persist me" });

  await persister.save(spec);
  const loaded = await persister.load(spec.goalId);

  assert.ok(loaded);
  assert.equal(loaded.goalId, spec.goalId);
  assert.equal(loaded.title, spec.title);
  assert.equal(loaded.status, spec.status);

  // Verify no temp files left behind
  const entries = await (await import("node:fs/promises")).readdir(join(base, spec.goalId));
  assert.ok(entries.includes("goal.json"));
  assert.ok(!entries.some((e) => e.endsWith(".tmp")));

  await rm(base, { recursive: true, force: true });
});

test("GoalPersister list returns goals sorted by updatedAt desc", async () => {
  const base = await tempGoalDir();
  const persister = createGoalPersister(base);

  const a = normalizeGoal({ rawPrompt: "A" });
  const b = normalizeGoal({ rawPrompt: "B" });

  await persister.save(a);
  await new Promise((r) => setTimeout(r, 50));
  await persister.save(b);

  const ids = await persister.list();
  assert.equal(ids[0], b.goalId);
  assert.equal(ids[1], a.goalId);

  await rm(base, { recursive: true, force: true });
});

test("GoalPersister tolerates corrupt JSON gracefully", async () => {
  const base = await tempGoalDir();
  const goalId = "corrupt-goal";
  await mkdir(join(base, goalId), { recursive: true });
  await writeFile(join(base, goalId, "goal.json"), "not json");

  const persister = createGoalPersister(base);
  const loaded = await persister.load(goalId);

  assert.equal(loaded, null);
  await rm(base, { recursive: true, force: true });
});

test("GoalPersister saveEvidence and loadEvidence", async () => {
  const base = await tempGoalDir();
  const persister = createGoalPersister(base);
  const spec = normalizeGoal({ rawPrompt: "Evidence test" });

  await persister.save(spec);
  const evidence = [
    { criterionId: "c1", passed: true, checkedAt: new Date().toISOString() },
    { criterionId: "c2", passed: false, checkedAt: new Date().toISOString() },
  ];
  await persister.saveEvidence(spec.goalId, evidence);
  const loaded = await persister.loadEvidence(spec.goalId);

  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].criterionId, "c1");
  assert.equal(loaded[1].passed, false);

  await rm(base, { recursive: true, force: true });
});

test("compileGoalToDagNodes produces valid DAG with bootstrap, coordinator, and verify", () => {
  const spec = normalizeGoal({ rawPrompt: "Build auth" });
  spec.expectedArtifacts = [
    { name: "auth.ts", path: "src/auth.ts", gate: "file-exists" },
  ];

  const nodes = compileGoalToDagNodes(spec);
  const dag = createDag({ nodes });

  assert.ok(dag.nodes.some((n) => n.id === "bootstrap"));
  assert.ok(dag.nodes.some((n) => n.id === "goal-coordinator"));
  assert.ok(dag.nodes.some((n) => n.id === "artifact-1"));
  assert.ok(dag.nodes.some((n) => n.id === "goal-verify"));
  const coordinator = dag.nodes.find((n) => n.id === "goal-coordinator");
  assert.equal(coordinator?.role, "planner");
  assert.equal(coordinator?.outputs?.[0]?.ref, "plan.md");

  const verify = dag.nodes.find((n) => n.id === "goal-verify");
  assert.ok(verify?.dependsOn.includes("artifact-1"));
});


test("PromptNoveltyReportV2 forces replan on replay risk without evidence delta", () => {
  const rawPrompt = "Do not replay this exact objective; replan with a narrower ActionAtom";
  const spec = normalizeGoal({ rawPrompt, title: "Replay guard", objective: rawPrompt });
  const repeatedAtom = spec.intentFrame.actionAtoms.find((atom) => atom.label.startsWith("plan-")) ?? spec.intentFrame.actionAtoms[0];
  const runState = createRoutedRunState({
    runId: "novelty-v2",
    startedAt: new Date().toISOString(),
    nodes: [1, 2, 3].map((index) => ({
      id: `repeat-${index}`,
      name: rawPrompt,
      role: "planner",
      dependsOn: [],
      maxRetries: 1,
      routing: { actionAtom: repeatedAtom },
    })),
    workerCount: 1,
  });

  const report = evaluatePromptNovelty({
    goal: spec,
    runState,
    previousPrompt: rawPrompt,
    evidence: [],
    action: "continue",
    targetAtomId: repeatedAtom.id,
  });

  assert.equal(report.schemaVersion, 2);
  assert.equal(report.recommendation, "replan");
  assert.equal(report.replayRisk, true);
  assert.equal(report.oscillation, true);
  assert.equal(report.evidenceDelta, 0);
  assert.equal(report.progressDelta, 0);
  assert.equal(report.targetAtomId, repeatedAtom.id);
});

test("Evidence-Delta Adaptive Replan distinguishes missing evidence from hard failure", () => {
  const spec = normalizeGoal({
    rawPrompt: "Advance goal DAG automation loop",
    title: "EDAR",
    objective: "Advance goal DAG automation loop",
  });
  spec.successCriteria = [
    { id: "c1", description: "Replan contract exists", requirement: "required", weight: 1, inferred: false },
  ];

  const runState = createRoutedRunState({
    runId: "edar-delta",
    startedAt: new Date().toISOString(),
    nodes: [
      { id: "planner", name: "Plan delta loop", role: "planner", dependsOn: [], maxRetries: 1 },
    ],
    workerCount: 1,
  });
  const delta = evaluateGoalProgressDelta(
    spec,
    [{
      criterionId: "c1",
      passed: false,
      message: "Required criterion missing evidence: Replan contract exists",
      checkedAt: new Date().toISOString(),
      evidenceType: "criterion",
    }],
    runState,
  );

  assert.equal(delta.value, 0);
  assert.deepEqual(delta.failedCriteria, []);
  assert.deepEqual(delta.missingRequiredCriteria, ["c1"]);
  assert.equal(delta.recommendation, "continue");
});

test("goal progress ensemble replans stalled replay loops with evidence-delta context", async () => {
  const rawPrompt = "Do not replay this exact objective; replan goal DAG automation with a narrower ActionAtom";
  const spec = normalizeGoal({ rawPrompt, title: "EDAR replay", objective: rawPrompt });
  spec.successCriteria = [
    { id: "c1", description: "A narrower replan target is selected", requirement: "required", weight: 1, inferred: false },
  ];
  const repeatedAtom = spec.intentFrame.actionAtoms.find((atom) => atom.label.startsWith("plan-")) ?? spec.intentFrame.actionAtoms[0];
  const runState = createRoutedRunState({
    runId: "edar-replay",
    startedAt: new Date().toISOString(),
    nodes: [1, 2, 3].map((index) => ({
      id: `repeat-${index}`,
      name: rawPrompt,
      role: "planner",
      dependsOn: [],
      maxRetries: 1,
      routing: { actionAtom: repeatedAtom },
    })),
    workerCount: 1,
  });

  const result = await evaluateGoalProgressEnsemble(spec, runState, undefined, { deepseek: false });

  assert.equal(result.nextAction, "replan");
  assert.equal(result.progressDelta.value, 0);
  assert.equal(result.noveltyReport?.recommendation, "replan");
  assert.match(result.ensemble.nextPrompt ?? "", /Evidence Delta Replan/);
  assert.match(result.ensemble.nextPrompt ?? "", /Keep MCP, skills, hooks/);
});

test("compileGoalToDagNodes uses ActionAtom labels instead of replaying raw Korean input", () => {
  const rawPrompt = "한국어 원문을 DAG 노드 이름으로 반복하지 말고 IntentFrame ActionAtom 기반으로 실행해줘";
  const spec = normalizeGoal({ rawPrompt, title: "Strict DAG", objective: rawPrompt });

  const nodes = compileGoalToDagNodes(spec);
  const nodeText = nodes.map((node) => `${node.name} ${node.routing?.actionAtom?.label ?? ""}`).join("\n");

  assert.ok(nodes.every((node) => node.routing?.actionAtom));
  assert.match(nodeText, /bootstrap/);
  assert.match(nodeText, /plan-intent-dag|plan-execution/);
  assert.match(nodeText, /verify-evidence/);
  assert.doesNotMatch(nodeText, new RegExp(rawPrompt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("compileGoalToDagNodes promotes action atoms, criteria, and scoped capability hints", () => {
  const spec = createGoalSpec(`
READ-ONLY scope: src/goal
expected output: goal-dag-findings.md
Use MCP skills hooks for OMK goal DAG orchestration with subagent routing.

Success Criteria:
1. Evidence delta replan contract is explicit
2. MCP skills hooks are scoped per action atom

산출물:
- Findings report: docs/goal-dag-findings.md
`);

  const nodes = compileGoalToDagNodes(spec);
  const labels = nodes.map((node) => node.routing?.actionAtom?.label);

  assert.ok(labels.includes("inspect-read-only-scope"));
  assert.ok(labels.includes("satisfy-expected-output"));
  assert.equal(nodes.some((node) => node.role === "coder"), false);

  const artifact = nodes.find((node) => node.id === "artifact-1");
  assert.equal(artifact?.role, "researcher");
  assert.equal(artifact?.outputs?.[0]?.gate, "summary");
  assert.equal(artifact?.routing?.readOnly, true);

  const criterionNodes = nodes.filter((node) => node.id.startsWith("criterion-"));
  assert.equal(criterionNodes.length, spec.successCriteria.length);
  assert.ok(criterionNodes.every((node) => node.routing?.replanHint?.criterionId));

  const inspectNode = nodes.find((node) => node.routing?.actionAtom?.label === "inspect-read-only-scope");
  assert.equal(inspectNode?.routing?.readOnly, true);
  assert.ok(inspectNode?.routing?.skills?.includes("omk-adaptorch-orchestration-review"));
  assert.ok(inspectNode?.routing?.mcpServers?.includes("omk-project"));
  assert.ok(inspectNode?.routing?.hooks?.includes("SubagentStop"));
});

test("goal plan writes actionable planner DAG instead of placeholder", async () => {
  const root = await tempGoalDir();
  const previousRoot = process.env.OMK_PROJECT_ROOT;
  const previousAlpha = process.env.OMK_GOAL_ALPHA;
  process.env.OMK_PROJECT_ROOT = root;
  process.env.OMK_GOAL_ALPHA = "1";
  const output = [];
  const originalLog = console.log;
  console.log = (...args) => output.push(args.join(" "));

  try {
    await goalCreateCommand("Build a release checklist", {
      title: "Release checklist",
      objective: "Create an actionable release checklist",
      risk: "low",
    });
    const goalsDir = join(root, ".omk", "goals");
    const goalIds = await (await import("node:fs/promises")).readdir(goalsDir);
    await goalPlanCommand(goalIds[0]);
    const plan = await readFile(join(goalsDir, goalIds[0], "plan.md"), "utf-8");

    assert.match(plan, /## Planner/);
    assert.match(plan, /goal-coordinator.*planner/);
    assert.match(plan, /## Execution DAG/);
    assert.match(plan, /## Acceptance Criteria/);
    assert.doesNotMatch(plan, /to be planned/);
    assert.match(output.join("\n"), /Planner/);
  } finally {
    console.log = originalLog;
    if (previousRoot === undefined) delete process.env.OMK_PROJECT_ROOT;
    else process.env.OMK_PROJECT_ROOT = previousRoot;
    if (previousAlpha === undefined) delete process.env.OMK_GOAL_ALPHA;
    else process.env.OMK_GOAL_ALPHA = previousAlpha;
    await rm(root, { recursive: true, force: true });
  }
});

test("goal plan json emits a machine-readable planner contract", async () => {
  const root = await tempGoalDir();
  const previousRoot = process.env.OMK_PROJECT_ROOT;
  const previousAlpha = process.env.OMK_GOAL_ALPHA;
  process.env.OMK_PROJECT_ROOT = root;
  process.env.OMK_GOAL_ALPHA = "1";
  const output = [];
  const originalLog = console.log;
  console.log = (...args) => output.push(args.join(" "));

  try {
    await goalCreateCommand("Build a JSON goal plan", {
      title: "JSON plan",
      objective: "Create a machine-readable plan output",
      risk: "low",
    });
    const goalsDir = join(root, ".omk", "goals");
    const goalIds = await (await import("node:fs/promises")).readdir(goalsDir);
    output.length = 0;
    await goalPlanCommand(goalIds[0], { json: true });
    const parsed = JSON.parse(output[0]);

    assert.equal(parsed.goalId, goalIds[0]);
    assert.equal(parsed.status, "planned");
    assert.equal(parsed.planner, "goal-coordinator");
    assert.ok(parsed.nodes.some((node) => node.id === "goal-verify"));
  } finally {
    console.log = originalLog;
    if (previousRoot === undefined) delete process.env.OMK_PROJECT_ROOT;
    else process.env.OMK_PROJECT_ROOT = previousRoot;
    if (previousAlpha === undefined) delete process.env.OMK_GOAL_ALPHA;
    else process.env.OMK_GOAL_ALPHA = previousAlpha;
    await rm(root, { recursive: true, force: true });
  }
});

test("compileGoalToDagNodes verify depends on coordinator when no artifacts", () => {
  const spec = normalizeGoal({ rawPrompt: "Simple task" });
  const nodes = compileGoalToDagNodes(spec);
  const dag = createDag({ nodes });

  const verify = dag.nodes.find((n) => n.id === "goal-verify");
  assert.ok(verify?.dependsOn.includes("goal-coordinator"));
});

test("attachGoalToRunState injects goalId and snapshot", () => {
  const runState = createRoutedRunState({
    runId: "test-run",
    startedAt: new Date().toISOString(),
    nodes: [{ id: "a", name: "A", role: "coder", dependsOn: [], maxRetries: 1 }],
  });

  const spec = normalizeGoal({ rawPrompt: "Attach me" });
  const attached = attachGoalToRunState(runState, spec);

  assert.equal(attached.schemaVersion, 1);
  assert.equal(attached.goalId, spec.goalId);
  assert.equal(attached.goalSnapshot?.title, spec.title);
  assert.equal(attached.goalSnapshot?.successCriteria.length, spec.successCriteria.length);
});

test("scoreGoal computes pass when all required criteria pass", () => {
  const spec = normalizeGoal({ rawPrompt: "Score me" });
  spec.successCriteria = [
    { id: "c1", description: "Must pass", requirement: "required", weight: 1, inferred: false },
    { id: "c2", description: "Nice to have", requirement: "optional", weight: 0.5, inferred: false },
  ];

  const evidence = [
    { criterionId: "c1", passed: true, checkedAt: new Date().toISOString() },
    { criterionId: "c2", passed: true, checkedAt: new Date().toISOString() },
  ];

  const score = scoreGoal(spec, evidence);
  assert.equal(score.overall, "pass");
  assert.equal(score.requiredPassed, 1);
  assert.equal(score.requiredTotal, 1);
  assert.ok(score.optionalScore > 0);
});

test("scoreGoal computes fail when a required criterion fails", () => {
  const spec = normalizeGoal({ rawPrompt: "Score me" });
  spec.successCriteria = [
    { id: "c1", description: "Must pass", requirement: "required", weight: 1, inferred: false },
  ];

  const evidence = [
    { criterionId: "c1", passed: false, checkedAt: new Date().toISOString() },
  ];

  const score = scoreGoal(spec, evidence);
  assert.equal(score.overall, "fail");
  assert.equal(score.requiredPassed, 0);
});

test("scoreGoal computes incomplete when no evidence for required", () => {
  const spec = normalizeGoal({ rawPrompt: "Score me" });
  spec.successCriteria = [
    { id: "c1", description: "Must pass", requirement: "required", weight: 1, inferred: false },
  ];

  const evidence = [];
  const score = scoreGoal(spec, evidence);
  assert.equal(score.overall, "incomplete");
});

test("scoreGoal uses latest evidence for duplicate criterion IDs", () => {
  const spec = normalizeGoal({ rawPrompt: "Score me" });
  spec.successCriteria = [
    { id: "c1", description: "Must pass", requirement: "required", weight: 1, inferred: false },
    { id: "c2", description: "Nice to have", requirement: "optional", weight: 1, inferred: false },
  ];

  const score = scoreGoal(spec, [
    { criterionId: "c1", passed: true, checkedAt: "2026-05-08T00:00:00.000Z" },
    { criterionId: "c2", passed: false, checkedAt: "2026-05-08T00:00:00.000Z" },
    { criterionId: "c1", passed: false, checkedAt: "2026-05-08T00:01:00.000Z" },
    { criterionId: "c2", passed: true, checkedAt: "2026-05-08T00:01:00.000Z" },
  ]);

  assert.equal(score.overall, "fail");
  assert.equal(score.requiredPassed, 0);
  assert.equal(score.optionalScore, 1);
});

test("goal continuation helpers use latest evidence for missing criteria and artifacts", () => {
  const spec = normalizeGoal({ rawPrompt: "Score me" });
  spec.successCriteria = [
    { id: "c1", description: "Must pass", requirement: "required", weight: 1, inferred: false },
  ];
  spec.expectedArtifacts = [{ name: "report", path: "report.md", gate: "file-exists" }];

  const evidence = [
    { criterionId: "c1", passed: false, checkedAt: "2026-05-08T00:00:00.000Z" },
    { criterionId: "artifact:report", passed: false, checkedAt: "2026-05-08T00:00:00.000Z" },
    { criterionId: "c1", passed: true, checkedAt: "2026-05-08T00:01:00.000Z" },
    { criterionId: "artifact:report", passed: true, checkedAt: "2026-05-08T00:01:00.000Z" },
  ];

  assert.deepEqual(evaluateMissingCriteria(spec, evidence), []);
  assert.equal(suggestNextAction(spec, evidence).type, "close");
});

test("goal artifact evidence blocks traversal outside the project root", async () => {
  const root = await tempGoalDir();
  const spec = normalizeGoal({ rawPrompt: "Artifact containment" });
  spec.expectedArtifacts = [
    { name: "outside", path: "../outside.txt", gate: "file-exists" },
  ];

  try {
    const evidence = await checkGoalEvidence(spec, {
      root,
      runState: { schemaVersion: 1, runId: "none", nodes: [], startedAt: new Date().toISOString() },
    });
    const artifactEvidence = evidence.find((entry) => entry.criterionId === "artifact:outside");

    assert.equal(artifactEvidence?.passed, false);
    assert.match(artifactEvidence?.message ?? "", /blocked|inside the project root/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("goal close rejects without process.exit when evidence is missing", async () => {
  const root = await tempGoalDir();
  const previousRoot = process.env.OMK_PROJECT_ROOT;
  const previousAlpha = process.env.OMK_GOAL_ALPHA;
  const originalError = console.error;
  const originalExit = process.exit;
  process.env.OMK_PROJECT_ROOT = root;
  process.env.OMK_GOAL_ALPHA = "1";
  console.error = () => {};
  process.exit = (code) => {
    throw new Error(`process.exit called with ${code}`);
  };

  try {
    const persister = createGoalPersister(join(root, ".omk", "goals"));
    const spec = normalizeGoal({ rawPrompt: "Close me without evidence" });
    await persister.save(spec);

    await assert.rejects(
      () => goalCloseCommand(spec.goalId, {}),
      (err) => err instanceof CliError && err.name === "VerificationError"
    );
  } finally {
    console.error = originalError;
    process.exit = originalExit;
    if (previousRoot === undefined) delete process.env.OMK_PROJECT_ROOT;
    else process.env.OMK_PROJECT_ROOT = previousRoot;
    if (previousAlpha === undefined) delete process.env.OMK_GOAL_ALPHA;
    else process.env.OMK_GOAL_ALPHA = previousAlpha;
    await rm(root, { recursive: true, force: true });
  }
});

test("old RunState without schemaVersion or goalId is tolerated", () => {
  const oldState = {
    runId: "legacy-run",
    nodes: [],
    startedAt: new Date().toISOString(),
  };

  // createRoutedRunState accepts objects without schemaVersion
  assert.ok(oldState.runId);
  assert.equal(oldState.schemaVersion, undefined);
  assert.equal(oldState.goalId, undefined);
});

test("generateNextPrompt synthesizes current context instead of repeating the original goal", async () => {
  const spec = normalizeGoal({
    rawPrompt: "Improve DeepSeek and goal pipelines",
    title: "Pipeline upgrade",
    objective: "Improve DeepSeek and goal pipelines so follow-up runs use context-aware prompts",
  });
  spec.successCriteria = [
    { id: "c1", description: "DeepSeek receives current goal context", requirement: "required", weight: 1, inferred: false },
    { id: "c2", description: "Goal continuation preserves completed work", requirement: "required", weight: 1, inferred: false },
  ];

  const runState = createRoutedRunState({
    runId: "context-run",
    startedAt: new Date().toISOString(),
    nodes: [
      { id: "deepseek-context", name: "Wire DeepSeek context", role: "coder", dependsOn: [], maxRetries: 1 },
      { id: "goal-followup", name: "Repair goal follow-up prompt", role: "coder", dependsOn: ["deepseek-context"], maxRetries: 1 },
    ],
    workerCount: 1,
  });
  runState.nodes[0].status = "done";
  runState.nodes[0].evidence = [{ gate: "unit", passed: true, message: "DeepSeek context prefix covered" }];
  runState.nodes[1].status = "failed";
  runState.nodes[1].blockedReason = "Previous prompt kept repeating the original objective";
  runState.nodes[1].attempts = [{
    attempt: 1,
    startedAt: new Date().toISOString(),
    status: "failed",
    provider: "kimi",
    requestedProvider: "deepseek",
    fallbackFrom: "deepseek",
    fallbackReason: "advisory only",
  }];

  const result = await generateNextPrompt(
    spec,
    [{ criterionId: "c1", passed: true, checkedAt: new Date().toISOString(), message: "context wired" }],
    runState,
    "### Memory\n- Previous run already wired DeepSeek context."
  );

  assert.match(result.prompt, /Kimi Context Synthesis/);
  assert.match(result.prompt, /Strict Intent \/ Action Digest/);
  assert.match(result.prompt, /Next Action Contract/);
  assert.match(result.prompt, /Novelty Guard/);
  assert.match(result.prompt, /Evidence Delta Replan/);
  assert.match(result.prompt, /Do not repeat the original goal verbatim/);
  assert.match(result.prompt, /Goal Reference \(non-verbatim\)/);
  assert.match(result.prompt, /Original objective digest/);
  assert.doesNotMatch(
    result.prompt,
    /Improve DeepSeek and goal pipelines so follow-up runs use context-aware prompts/
  );
  assert.match(result.prompt, /goal-followup/);
  assert.match(result.prompt, /Goal continuation preserves completed work/);
  assert.match(result.prompt, /Previous run already wired DeepSeek context/);
  assert.match(result.prompt, /fallbackFrom=deepseek/);
  assert.equal(result.nextActionContract.action, "replan");
  assert.equal(result.noveltyReport.recommendation, "replan");
  assert.equal(result.progressDelta.value, 3);
});


test("generateNextPrompt omits raw Korean and English objectives while keeping action contracts", async () => {
  const raws = [
    "한국어 원문 전체를 다음 프롬프트에 그대로 반복하지 말고 ActionAtom 증거 대상으로만 계속해줘",
    "Do not include this exact English objective sentence in any next prompt body",
  ];

  for (const rawPrompt of raws) {
    const spec = normalizeGoal({ rawPrompt, title: "Non repetition", objective: rawPrompt });
    spec.successCriteria = [
      { id: "c1", description: "Follow-up prompt uses digest and ActionAtom contract", requirement: "required", weight: 1, inferred: false },
    ];
    const result = await generateNextPrompt(spec, [], undefined, "");
    assert.match(result.prompt, /Goal Reference \(non-verbatim\)/);
    assert.match(result.prompt, /Original objective digest/);
    assert.match(result.prompt, /Strict Intent \/ Action Digest/);
    assert.match(result.prompt, /Next Action Contract/);
    assert.doesNotMatch(result.prompt, new RegExp(rawPrompt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("goal progress ensemble calls DeepSeek advisory when a key is configured", async () => {
  const homeRoot = await tempGoalDir();
  const spec = normalizeGoal({
    rawPrompt: "Verify DeepSeek goal ensemble participation",
    title: "DeepSeek ensemble probe",
    objective: "Verify that a configured DeepSeek API key participates in the goal progress ensemble",
  });
  spec.successCriteria = [
    { id: "c1", description: "DeepSeek advisory vote is present", requirement: "required", weight: 1, inferred: false },
  ];

  const runState = createRoutedRunState({
    runId: "deepseek-goal-ensemble",
    startedAt: new Date().toISOString(),
    nodes: [
      { id: "goal-review", name: "Review goal progress", role: "reviewer", dependsOn: [], maxRetries: 1 },
    ],
    workerCount: 1,
  });
  runState.nodes[0].status = "failed";
  runState.nodes[0].blockedReason = "Needs another review pass";

  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    const headers = init.headers ?? {};
    calls.push({
      href,
      hasAuthorization: Boolean(headers.Authorization ?? headers.authorization),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (href.endsWith("/user/balance")) {
      return new Response(JSON.stringify({ is_available: true, balance_infos: [] }), { status: 200 });
    }
    if (href.endsWith("/chat/completions")) {
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                action: "replan",
                confidence: 0.84,
                reason: "Failed reviewer node should be replanned with a narrower verification pass",
              }),
            },
          },
        ],
      }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const result = await evaluateGoalProgressEnsemble(spec, runState, undefined, {
      deepseek: {
        env: {
          DEEPSEEK_API_KEY: "fake-deepseek-key-for-test",
          HOME: homeRoot,
          OMK_PROVIDER_CONFIG_PATH: join(homeRoot, "providers.json"),
          OMK_SECRETS_ENV_PATH: join(homeRoot, "secrets.env"),
          OPENCODE_SECRETS_ENV_PATH: join(homeRoot, "opencode-secrets.env"),
        },
        fetchImpl,
        timeoutMs: 5_000,
      },
    });

    assert.deepEqual(calls.map((call) => call.href.replace(/^https:\/\/api\.deepseek\.com/, "")), [
      "/user/balance",
      "/chat/completions",
    ]);
    assert.equal(calls.every((call) => call.hasAuthorization), true);
    assert.equal(calls[1].body.model, "deepseek-v4-pro");
    const deepseekVote = result.ensemble.candidateVotes.find((vote) => vote.id === "deepseek-v4-pro");
    assert.ok(deepseekVote);
    assert.equal(deepseekVote.action, "replan");
    assert.match(deepseekVote.reason, /DeepSeek advisory/);
  } finally {
    await rm(homeRoot, { recursive: true, force: true });
  }
});

test("goal run CLI honors run-id, defaults to auto provider policy, and avoids first-run continuation wrapping", async () => {
  const { root, workspace, env } = await tempGoalCliFixture();
  try {
    const create = runGoalCli(["goal", "create", "Document critical issue execution", "--json"], env);
    assert.equal(create.status, 0, create.stderr);
    const goalId = JSON.parse(create.stdout).goalId;

    const run = runGoalCli([
      "goal", "run", goalId,
      "--workers", "1",
      "--run-id", "repro-critical",
      "--no-watch",
      "--view", "table",
      "--max-auto-continue-iterations", "0",
    ], env);

    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
    const state = await readJson(join(workspace, ".omk", "runs", "repro-critical", "state.json"));
    assert.equal(state.runId, "repro-critical");
    const workerNodes = state.nodes.filter((node) => node.id.startsWith("worker-"));
    assert.ok(workerNodes.length > 0);
    assert.ok(workerNodes.every((node) => node.routing?.provider === "auto"));
    assert.ok(workerNodes.every((node) => node.routing?.assignedProvider === undefined));
    const requiredNodes = state.nodes.filter((node) => !node.id.startsWith("deepseek-") && !node.id.startsWith("capability-"));
    assert.ok(requiredNodes.every((node) => node.status === "done"));

    const plan = await readFile(join(workspace, ".omk", "runs", "repro-critical", "plan.md"), "utf-8");
    assert.match(plan, /Provider policy: auto/);

    const goal = await readJson(join(workspace, ".omk", "goals", goalId, "goal.json"));
    assert.equal(goal.status, "done");
    assert.deepEqual(goal.runIds, ["repro-critical"]);

    const nextPrompt = await readFile(join(workspace, ".omk", "goals", goalId, "next-prompt.md"), "utf-8");
    assert.match(nextPrompt, /Source command: goal-run/);
    assert.match(nextPrompt, /Continuation: no/);
    assert.doesNotMatch(nextPrompt, /## Current Execution Context/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("goal run CLI fails nonzero and records failed goal status when DAG fails", async () => {
  const { root, workspace, env } = await tempGoalCliFixture({ summary: false });
  try {
    const create = runGoalCli(["goal", "create", "Document failed execution", "--json"], env);
    assert.equal(create.status, 0, create.stderr);
    const goalId = JSON.parse(create.stdout).goalId;

    const run = runGoalCli([
      "goal", "run", goalId,
      "--workers", "1",
      "--run-id", "repro-failed",
      "--no-watch",
      "--view", "table",
      "--max-auto-continue-iterations", "0",
    ], env);

    assert.notEqual(run.status, 0);
    const state = await readJson(join(workspace, ".omk", "runs", "repro-failed", "state.json"));
    assert.equal(state.runId, "repro-failed");
    assert.equal(state.nodes.find((node) => node.id === "root-coordinator")?.status, "failed");

    const goal = await readJson(join(workspace, ".omk", "goals", goalId, "goal.json"));
    assert.equal(goal.status, "failed");
    assert.deepEqual(goal.runIds, ["repro-failed"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("goal continue CLI reads a context run but writes a fresh next run", async () => {
  const { root, workspace, env } = await tempGoalCliFixture();
  try {
    const create = runGoalCli(["goal", "create", "Document continuation execution", "--json"], env);
    assert.equal(create.status, 0, create.stderr);
    const goalId = JSON.parse(create.stdout).goalId;
    const goalPath = join(workspace, ".omk", "goals", goalId, "goal.json");
    const previousRunDir = join(workspace, ".omk", "runs", "context-run");
    await mkdir(previousRunDir, { recursive: true });
    await writeFile(join(previousRunDir, "plan.md"), "ORIGINAL CONTEXT PLAN");
    await writeFile(join(previousRunDir, "state.json"), JSON.stringify({
      schemaVersion: 1,
      runId: "context-run",
      startedAt: new Date().toISOString(),
      workerCount: 1,
      nodes: [
        { id: "sentinel", name: "sentinel", role: "reviewer", dependsOn: [], maxRetries: 1, status: "done" },
      ],
    }, null, 2));
    const goal = await readJson(goalPath);
    goal.status = "blocked";
    goal.runIds = ["context-run"];
    await writeFile(goalPath, JSON.stringify(goal, null, 2));

    const run = runGoalCli([
      "goal", "continue", goalId,
      "--from-run-id", "context-run",
      "--run-id", "next-run",
      "--workers", "1",
      "--no-watch",
      "--view", "table",
      "--max-auto-continue-iterations", "0",
    ], { ...env, OMK_EXECUTION_PROMPT: "sequential" });

    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
    assert.equal(await readFile(join(previousRunDir, "plan.md"), "utf-8"), "ORIGINAL CONTEXT PLAN");
    const nextState = await readJson(join(workspace, ".omk", "runs", "next-run", "state.json"));
    assert.equal(nextState.runId, "next-run");
    const updatedGoal = await readJson(goalPath);
    assert.deepEqual(updatedGoal.runIds, ["context-run", "next-run"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
