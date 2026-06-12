import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeCompiledDag } from "../dist/orchestration/compiled-dag-executor.js";
import { createDag } from "../dist/orchestration/dag.js";

async function withTempRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "omk-compiled-dag-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function singleNodeDag(id = "compiled-node") {
  return createDag({
    nodes: [
      {
        id,
        name: "Compiled DAG node",
        role: "tester",
        dependsOn: [],
        maxRetries: 1,
        routing: {
          readOnly: true,
          rationale: "compiled DAG executor test",
        },
      },
    ],
  });
}

function compiledDag(dag, overrides = {}) {
  return {
    schemaVersion: 1,
    inputId: "input-compiled",
    runId: "run-compiled",
    dag,
    workerCount: 1,
    executionStrategy: "sequential",
    artifacts: {
      explanation: "test compiled DAG",
    },
    compiledAt: "2026-05-30T00:00:00.000Z",
    ...overrides,
  };
}

test("executeCompiledDag runs compiled DAGs and persists loop decisions", async () => {
  await withTempRoot(async (root) => {
    const envCalls = [];
    const result = await executeCompiledDag({
      root,
      compiled: compiledDag(singleNodeDag()),
      providerPolicy: "auto",
      model: "test-model",
      mcpScope: "none",
      env: {
        BASE_ENV: "base",
      },
      runner: {
        async run(_node, env) {
          envCalls.push({
            baseEnv: env.BASE_ENV,
            runId: env.OMK_RUN_ID,
            inputId: env.OMK_INPUT_ID,
            flow: env.OMK_FLOW,
            strategy: env.OMK_DAG_EXECUTION_STRATEGY,
            model: env.OMK_PROVIDER_MODEL,
            mcpScope: env.OMK_MCP_SCOPE,
          });
          return {
            success: true,
            stdout: "## Summary\nok",
            stderr: "",
          };
        },
      },
      loop: {
        now: () => new Date("2026-05-30T00:00:01.000Z"),
      },
    });

    assert.equal(result.run.success, true);
    assert.equal(result.loopDecision.action, "close");
    assert.equal(result.loopState.status, "closed");
    assert.equal(existsSync(result.loopArtifacts.statePath), true);
    assert.equal(existsSync(result.loopArtifacts.decisionsPath), true);
    assert.deepEqual(envCalls, [
      {
        baseEnv: "base",
        runId: "run-compiled",
        inputId: "input-compiled",
        flow: "compiled-dag",
        strategy: "sequential",
        model: "test-model",
        mcpScope: "none",
      },
    ]);

    const persistedState = JSON.parse(
      await readFile(result.loopArtifacts.statePath, "utf8"),
    );
    assert.equal(persistedState.status, "closed");
    assert.equal(persistedState.decisions[0].action, "close");
  });
});

test("executeCompiledDag creates a harness task runner when no runner is injected", async () => {
  await withTempRoot(async (root) => {
    const providerCalls = [];
    const envCalls = [];
    const result = await executeCompiledDag({
      root,
      compiled: compiledDag(singleNodeDag("factory-node"), {
        workerCount: 2,
        executionStrategy: "parallel",
      }),
      providerPolicy: "codex",
      model: "codex-cli",
      mcpScope: "none",
      env: {
        BASE_ENV: "factory",
      },
      factories: {
        async providerBacked(options) {
          providerCalls.push(options);
          return {
            async run(_node, env) {
              envCalls.push({
                baseEnv: env.BASE_ENV,
                inputId: env.OMK_INPUT_ID,
              });
              return {
                success: true,
                stdout: "## Summary\nok\n\n## Evidence\nok",
                stderr: "",
              };
            },
          };
        },
      },
      loop: {
        persist: false,
      },
    });

    assert.equal(result.run.success, true);
    assert.equal(result.loopDecision.action, "close");
    assert.equal(result.loopArtifacts, undefined);
    assert.equal(providerCalls.length, 1);
    assert.equal(providerCalls[0].providerPolicy, "codex");
    assert.equal(providerCalls[0].eventRunDir, join(root, ".omk", "runs", "run-compiled"));
    assert.equal(providerCalls[0].kimi.mcpScope, "none");
    assert.equal(providerCalls[0].kimi.env.OMK_RUN_ID, "run-compiled");
    assert.equal(providerCalls[0].kimi.env.OMK_INPUT_ID, "input-compiled");
    assert.equal(providerCalls[0].kimi.env.OMK_PROVIDER_MODEL, "codex-cli");
    assert.equal(providerCalls[0].kimi.env.OMK_DAG_EXECUTION_STRATEGY, "parallel");
    assert.deepEqual(envCalls, [{ baseEnv: "factory", inputId: "input-compiled" }]);
  });
});

test("executeCompiledDag replans when compiled DAG execution fails", async () => {
  await withTempRoot(async (root) => {
    const result = await executeCompiledDag({
      root,
      compiled: compiledDag(singleNodeDag("failing-node")),
      runner: {
        async run() {
          return {
            success: false,
            stdout: "",
            stderr: "failed by test",
          };
        },
      },
      loop: {
        persist: false,
        iteration: 1,
        maxIterations: 2,
      },
    });

    assert.equal(result.run.success, false);
    assert.equal(result.run.state.nodes[0].status, "failed");
    assert.equal(result.loopDecision.action, "replan");
    assert.deepEqual(result.loopDecision.failedNodes, ["failing-node"]);
    assert.match(result.loopDecision.reason, /failed or blocked nodes/);
    assert.equal(result.loopState.status, "failed");
  });
});
