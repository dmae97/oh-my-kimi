import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { explainLoopDecision, explainEnvMergeTrace } = await import("../dist/ux/explain-loop-decision.js");
const { whyCommand } = await import("../dist/commands/why.js");

function decision(overrides = {}) {
  return {
    schemaVersion: 1,
    action: "replan",
    reason: "pending nodes without runnable work",
    confidence: 0.8,
    inputId: "input-why",
    runId: "run-why",
    iteration: 1,
    failedNodes: [],
    blockedNodes: ["review-merge"],
    pendingNodes: ["review-merge"],
    nodeSets: {
      runnable: [],
      running: [],
      pending: ["review-merge"],
      failed: ["worker-2"],
      blocked: ["review-merge"],
      done: ["planner"],
      skipped: [],
    },
    progress: {
      previousHash: "a",
      currentHash: "b",
      changedNodes: ["worker-2"],
      terminalDelta: 1,
      runnableDelta: -1,
      evidenceDelta: 0,
      madeProgress: true,
    },
    risk: {
      deadlock: 0.8,
      livelock: 0,
      envPoisoning: 0,
      retryExhaustion: 0.2,
      blockedRequiredDependency: 0.9,
    },
    failedGates: [],
    requiredEvidenceMissing: [],
    createdAt: "2026-05-30T00:00:00.000Z",
    ...overrides,
  };
}

test("explainLoopDecision renders friendly deadlock guidance", () => {
  const lines = explainLoopDecision(decision());
  assert.match(lines.join("\n"), /pending tasks cannot run yet/i);
  assert.match(lines.join("\n"), /review-merge/);
  assert.match(lines.join("\n"), /worker-2/);
});

test("explainLoopDecision renders no-progress guidance", () => {
  const lines = explainLoopDecision(decision({
    action: "block",
    reason: "no progress across loop ticks",
    risk: { deadlock: 0, livelock: 0.7, envPoisoning: 0, retryExhaustion: 0, blockedRequiredDependency: 0 },
    progress: {
      previousHash: "same",
      currentHash: "same",
      changedNodes: [],
      terminalDelta: 0,
      runnableDelta: 0,
      evidenceDelta: 0,
      madeProgress: false,
    },
  }));
  assert.match(lines.join("\n"), /no progress/i);
});

test("explainEnvMergeTrace summarizes protected runtime env", () => {
  const lines = explainEnvMergeTrace([
    { key: "OMK_PROVIDER_MODEL", previous: "codex-cli", next: "", source: "worker-manifest", action: "preserve-non-empty" },
    { key: "OMK_MCP_SCOPE", previous: undefined, next: "", source: "node", action: "drop-empty" },
    { key: "OMK_PROVIDER_PREFERRED", previous: "auto", next: "codex", source: "worker-manifest", action: "overwrite" },
  ]);
  assert.match(lines.join("\n"), /protected your runtime environment/i);
  assert.match(lines.join("\n"), /Preserved non-empty keys: OMK_PROVIDER_MODEL/);
  assert.match(lines.join("\n"), /Ignored empty keys: OMK_MCP_SCOPE/);
});

test("whyCommand reads the latest loop-state artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "omk-why-"));
  try {
    const runDir = join(root, ".omk", "runs", "run-why");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "loop-state.json"), `${JSON.stringify({
      schemaVersion: 1,
      runId: "run-why",
      inputId: "input-why",
      iteration: 1,
      maxIterations: 3,
      status: "running",
      decisions: [decision()],
      createdAt: "2026-05-30T00:00:00.000Z",
      updatedAt: "2026-05-30T00:00:00.000Z",
    }, null, 2)}\n`);

    const result = await whyCommand({ root, emit: false });
    assert.equal(result.runId, "run-why");
    assert.match(result.lines.join("\n"), /pending tasks cannot run yet/i);
    assert.match(await readFile(result.statePath, "utf8"), /run-why/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
