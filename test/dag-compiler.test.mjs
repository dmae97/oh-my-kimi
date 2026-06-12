import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { buildInputEnvelope } = await import("../dist/input/input-envelope.js");
const { compileInputEnvelopeToDag } =
  await import("../dist/orchestration/dag-compiler.js");
const { persistDagCompileArtifacts, renderDagCompileReport } =
  await import("../dist/orchestration/dag-artifacts.js");

function stubIntent(overrides = {}) {
  return {
    taskType: "implement",
    complexity: "complex",
    estimatedWorkers: 3,
    requiredRoles: ["coder", "tester", "reviewer"],
    isReadOnly: false,
    needsResearch: false,
    needsSecurityReview: false,
    needsTesting: true,
    needsDesignReview: false,
    parallelizable: true,
    rationale: "test fixture",
    confidence: 0.91,
    matchedRules: ["test-fixture"],
    language: "mixed",
    domainTerms: ["harness"],
    targetSurfaces: ["harness", "tests"],
    extractedFiles: [],
    extractedCommands: ["npm run check"],
    ambiguitySignals: [],
    routingHints: {
      preferredExecutionStrategy: "parallel",
      requireEvidence: true,
      requireHarness: true,
    },
    ...overrides,
  };
}

test("compileInputEnvelopeToDag creates a role-specific multi-node DAG", async () => {
  const envelope = buildInputEnvelope({
    runId: "run-dag-compile",
    kind: "plain-prompt",
    raw: "tui harness tests 고도화하고 검증해줘",
    source: "chat",
    cwd: "/tmp/project",
    root: "/tmp/project",
    provider: "codex",
    model: "codex-cli",
    constraints: ["preserve untracked files"],
    requestedArtifacts: [
      {
        name: "test evidence",
        path: ".omk/runs/run-dag-compile/dag-compile-report.json",
      },
    ],
    now: () => new Date("2026-05-30T00:00:03.000Z"),
  });

  const compiled = await compileInputEnvelopeToDag({
    input: envelope,
    workerCount: 3,
    intent: stubIntent(),
  });
  const nodeIds = compiled.dag.nodes.map((node) => node.id);

  assert.equal(compiled.schemaVersion, 1);
  assert.equal(compiled.inputId, envelope.inputId);
  assert.equal(compiled.runId, envelope.runId);
  assert.equal(compiled.workerCount, 3);
  assert.deepEqual(nodeIds.slice(0, 4), [
    "bootstrap",
    "intent-router",
    "planner",
    "capability-router",
  ]);
  assert.ok(nodeIds.includes("worker-1"));
  assert.ok(nodeIds.includes("worker-2"));
  assert.ok(nodeIds.includes("worker-3"));
  assert.ok(nodeIds.includes("evidence-verifier"));
  assert.ok(nodeIds.includes("review-merge"));
  assert.ok(nodeIds.includes("loop-decision"));
  assert.deepEqual(
    compiled.dag.nodes.find((node) => node.id === "worker-1")?.dependsOn,
    ["planner", "capability-router"],
  );
  assert.equal(
    compiled.dag.nodes.find((node) => node.id === "evidence-verifier")?.outputs?.[0]?.gate,
    "test-pass",
  );
  assert.equal(
    compiled.dag.nodes.find((node) => node.id === "loop-decision")?.outputs?.[0]?.ref,
    "loop-state.json",
  );
  assert.equal(compiled.dag.nodes[0].routing.provider, "codex");
  assert.equal(compiled.dag.nodes[0].routing.providerModel, "codex-cli");
  assert.equal(compiled.intent.targetSurfaces.includes("harness"), true);
  assert.equal(compiled.intentFrame.actionAtoms.length > 0, true);
});

test("compileInputEnvelopeToDag keeps slash commands on the operator compatibility lane", async () => {
  const envelope = buildInputEnvelope({
    runId: "run-slash-compile",
    kind: "slash-command",
    raw: "/view graph",
    source: "chat",
    cwd: "/tmp/project",
    root: "/tmp/project",
    provider: "codex",
    slashCommand: {
      command: "/view",
      argv: ["graph"],
      positional: ["graph"],
      flags: {},
    },
    now: () => new Date("2026-05-30T00:00:03.500Z"),
  });

  const compiled = await compileInputEnvelopeToDag({
    input: envelope,
    workerCount: 4,
    intent: stubIntent({
      taskType: "general",
      isReadOnly: false,
      parallelizable: true,
      estimatedWorkers: 4,
    }),
  });

  assert.equal(compiled.dag.nodes.length, 1);
  assert.equal(compiled.dag.nodes[0].role, "operator");
  assert.equal(compiled.dag.nodes[0].routing.readOnly, true);
  assert.equal(compiled.dag.nodes[0].routing.risk, "read");
  assert.match(compiled.dag.nodes[0].name, /Operator command \/view/);
});

test("compileInputEnvelopeToDag uses a bounded read-only DAG for inspect prompts", async () => {
  const envelope = buildInputEnvelope({
    runId: "run-readonly-compile",
    kind: "plain-prompt",
    raw: "summarize repository state without edits",
    source: "chat",
    cwd: "/tmp/project",
    root: "/tmp/project",
    provider: "codex",
    now: () => new Date("2026-05-30T00:00:03.750Z"),
  });

  const compiled = await compileInputEnvelopeToDag({
    input: envelope,
    workerCount: 2,
    intent: stubIntent({
      taskType: "explore",
      complexity: "simple",
      estimatedWorkers: 1,
      requiredRoles: ["explorer"],
      isReadOnly: true,
      needsTesting: false,
      parallelizable: false,
      targetSurfaces: ["runtime"],
      routingHints: { preferredExecutionStrategy: "sequential" },
    }),
  });
  const nodeIds = compiled.dag.nodes.map((node) => node.id);

  assert.deepEqual(nodeIds, [
    "bootstrap",
    "intent-router",
    "read-lane",
    "loop-decision",
  ]);
  assert.equal(compiled.dag.nodes.find((node) => node.id === "read-lane")?.routing.readOnly, true);
  assert.equal(compiled.dag.nodes.find((node) => node.id === "loop-decision")?.dependsOn[0], "read-lane");
});

test("persistDagCompileArtifacts writes DAG report intent and frame artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "omk-dag-compiler-"));
  try {
    const envelope = buildInputEnvelope({
      runId: "run-dag-artifacts",
      kind: "plain-prompt",
      raw: "summarize repository state without edits",
      source: "chat",
      cwd: root,
      root,
      provider: "codex",
      now: () => new Date("2026-05-30T00:00:04.000Z"),
    });
    const compiled = await compileInputEnvelopeToDag({
      input: envelope,
      workerCount: 1,
      intent: stubIntent({
        taskType: "explore",
        complexity: "simple",
        estimatedWorkers: 1,
        requiredRoles: ["explorer"],
        isReadOnly: true,
        needsTesting: false,
        parallelizable: false,
        targetSurfaces: ["runtime"],
        routingHints: { preferredExecutionStrategy: "sequential" },
      }),
    });
    const paths = await persistDagCompileArtifacts(compiled, { root });

    assert.equal(existsSync(paths.dagPath), true);
    assert.equal(existsSync(paths.reportPath), true);
    assert.equal(existsSync(join(paths.runDir, "intent-analysis.json")), true);
    assert.equal(existsSync(join(paths.runDir, "intent-frame.json")), true);
    const report = JSON.parse(await readFile(paths.reportPath, "utf8"));
    assert.equal(report.inputId, envelope.inputId);
    assert.equal(report.nodeCount, 4);
    assert.equal(report.nodes[2].readOnly, true);
    assert.deepEqual(renderDagCompileReport(compiled).nodeCount, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
