import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { evaluateLoopDecision, createLoopState, snapshotRunState } =
  await import("../dist/orchestration/loop-controller.js");
const { persistLoopArtifacts } =
  await import("../dist/orchestration/loop-artifacts.js");

function runState(nodes, overrides = {}) {
  return {
    schemaVersion: 1,
    runId: "run-loop",
    nodes,
    startedAt: "2026-05-30T00:00:00.000Z",
    ...overrides,
  };
}

test("evaluateLoopDecision closes when all required gates pass", () => {
  const state = runState([
    {
      id: "review-merge",
      name: "review",
      role: "reviewer",
      dependsOn: [],
      status: "done",
      retries: 0,
      maxRetries: 1,
      outputs: [{ name: "review result", gate: "review-pass" }],
      evidence: [{ gate: "review-pass", passed: true }],
    },
  ]);

  const decision = evaluateLoopDecision({
    runId: "run-loop",
    inputId: "input-loop",
    runState: state,
    now: () => new Date("2026-05-30T00:00:05.000Z"),
  });

  assert.equal(decision.action, "close");
  assert.deepEqual(decision.failedNodes, []);
  assert.deepEqual(decision.blockedNodes, []);
  assert.deepEqual(decision.pendingNodes, []);
  assert.deepEqual(decision.nodeSets.done, ["review-merge"]);
  assert.equal(decision.progress.madeProgress, true);
  assert.equal(decision.risk.deadlock, 0);
  assert.equal(decision.failedGates.length, 0);
  assert.equal(decision.requiredEvidenceMissing.length, 0);
});

test("evaluateLoopDecision replans on failed nodes and blocks at max iterations", () => {
  const state = runState(
    [
      {
        id: "worker-1",
        name: "worker",
        role: "coder",
        dependsOn: [],
        status: "failed",
        retries: 1,
        maxRetries: 1,
        outputs: [{ name: "worker output", gate: "command-pass" }],
        evidence: [{ gate: "command-pass", passed: false, message: "check failed" }],
      },
    ],
    { iterationCount: 1, maxIterations: 2 },
  );

  const replan = evaluateLoopDecision({
    runId: "run-loop",
    inputId: "input-loop",
    runState: state,
    iteration: 1,
    maxIterations: 2,
  });
  assert.equal(replan.action, "replan");
  assert.deepEqual(replan.failedNodes, ["worker-1"]);
  assert.deepEqual(replan.blockedNodes, []);
  assert.deepEqual(replan.pendingNodes, []);
  assert.deepEqual(replan.nodeSets.failed, ["worker-1"]);
  assert.equal(replan.risk.retryExhaustion, 1);
  assert.deepEqual(replan.failedGates, ["worker-1:command-pass"]);

  const blocked = evaluateLoopDecision({
    runId: "run-loop",
    inputId: "input-loop",
    runState: state,
    iteration: 2,
    maxIterations: 2,
  });
  assert.equal(blocked.action, "block");
  assert.deepEqual(blocked.failedNodes, ["worker-1"]);
});

test("evaluateLoopDecision detects pending deadlock when no node can run", () => {
  const state = runState([
    {
      id: "worker-1",
      name: "worker",
      role: "coder",
      dependsOn: ["missing-parent"],
      status: "pending",
      retries: 0,
      maxRetries: 1,
    },
  ]);

  const decision = evaluateLoopDecision({
    runId: "run-loop",
    inputId: "input-loop",
    runState: state,
  });

  assert.equal(decision.action, "replan");
  assert.deepEqual(decision.nodeSets.pending, ["worker-1"]);
  assert.deepEqual(decision.nodeSets.runnable, []);
  assert.equal(decision.risk.deadlock, 1);
  assert.match(decision.reason, /no runnable or running path/);
});

test("evaluateLoopDecision blocks repeated no-progress ticks", () => {
  const state = runState([
    {
      id: "worker-1",
      name: "worker",
      role: "coder",
      dependsOn: [],
      status: "running",
      retries: 0,
      maxRetries: 1,
    },
  ]);
  const previousSnapshot = snapshotRunState(state);

  const decision = evaluateLoopDecision({
    runId: "run-loop",
    inputId: "input-loop",
    runState: state,
    previousSnapshot,
    noProgressCount: 2,
  });

  assert.equal(decision.action, "block");
  assert.equal(decision.progress.madeProgress, false);
  assert.equal(decision.risk.livelock, 1);
  assert.match(decision.reason, /No progress/);
});

test("evaluateLoopDecision defaults to a practical three-iteration loop window", () => {
  const state = runState([
    {
      id: "worker-1",
      name: "worker",
      role: "coder",
      dependsOn: [],
      status: "failed",
      retries: 1,
      maxRetries: 1,
      outputs: [{ name: "worker output", gate: "summary" }],
      evidence: [{ gate: "summary", passed: false, message: "summary missing" }],
    },
  ]);

  const firstFailure = evaluateLoopDecision({
    runId: "run-loop",
    inputId: "input-loop",
    runState: state,
  });
  assert.equal(firstFailure.action, "replan");

  const thirdFailure = evaluateLoopDecision({
    runId: "run-loop",
    inputId: "input-loop",
    runState: state,
    iteration: 3,
  });
  assert.equal(thirdFailure.action, "block");
});

test("persistLoopArtifacts writes loop state decisions and next input", async () => {
  const root = await mkdtemp(join(tmpdir(), "omk-loop-artifacts-"));
  try {
    const state = runState([
      {
        id: "loop-decision",
        name: "loop",
        role: "orchestrator",
        dependsOn: [],
        status: "done",
        retries: 0,
        maxRetries: 1,
        outputs: [{ name: "loop decision", gate: "summary" }],
        evidence: [{ gate: "summary", passed: true }],
      },
    ]);
    const decision = evaluateLoopDecision({
      runId: "run-loop",
      inputId: "input-loop",
      runState: state,
      now: () => new Date("2026-05-30T00:00:06.000Z"),
    });
    const loopState = createLoopState({
      runId: "run-loop",
      inputId: "input-loop",
      runState: state,
      decision,
      now: () => new Date("2026-05-30T00:00:06.000Z"),
    });
    const paths = await persistLoopArtifacts(loopState, decision, {
      root,
      nextInputEnvelope: {
        schemaVersion: 1,
        inputId: "input-next",
        runId: "run-loop",
        kind: "continue",
        raw: "continue verification",
        normalized: "continue verification",
        redactionCount: 0,
        source: "chat",
        cwd: root,
        root,
        constraints: [],
        requestedArtifacts: [],
        createdAt: "2026-05-30T00:00:06.000Z",
      },
    });

    assert.equal(existsSync(paths.statePath), true);
    assert.equal(existsSync(paths.decisionsPath), true);
    assert.equal(existsSync(paths.nextInputPath), true);
    const persisted = JSON.parse(await readFile(paths.statePath, "utf8"));
    assert.equal(persisted.status, "closed");
    assert.equal(persisted.decisions[0].action, "close");
    assert.match(await readFile(paths.decisionsPath, "utf8"), /"action":"close"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
