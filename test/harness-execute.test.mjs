import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeHarnessRun, mergeEnvWithTrace } from "../dist/harness/execute-harness-run.js";
import { createDag } from "../dist/orchestration/dag.js";

async function withTempRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "omk-harness-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function createSingleNodeDag(id = "node-1") {
  return createDag({
    nodes: [
      {
        id,
        name: "Harness test node",
        role: "tester",
        dependsOn: [],
        maxRetries: 1,
        routing: {
          readOnly: true,
          rationale: "test harness execution",
        },
      },
    ],
  });
}

test("executeHarnessRun runs a DAG through the shared executor and persists RunState", async () => {
  await withTempRoot(async (root) => {
    const calls = [];
    const starts = [];
    const completes = [];
    const stateStatuses = [];
    const runner = {
      async run(node, env, _signal, context) {
        calls.push({
          nodeId: node.id,
          envRunId: env.OMK_RUN_ID,
          baseEnv: env.CUSTOM_BASE_ENV,
          envMcpConfigFile: env.OMK_MCP_CONFIG_FILE,
          contextRunId: context?.goal?.runId,
          contextRoot: context?.goal?.root,
          workerRunId: context?.worker?.runId,
          contextMcpConfigFile: context?.worker?.toolPlane?.mcpConfigFile,
        });
        return {
          success: true,
          stdout: "## Summary\nok\n\n## Evidence\nok",
          stderr: "",
        };
      },
    };

    const result = await executeHarnessRun({
      root,
      runId: "harness-test",
      dag: createSingleNodeDag(),
      runner,
      env: {
        CUSTOM_BASE_ENV: "base-value",
        OMK_MCP_CONFIG_FILE: join(root, ".kimi", "mcp.json"),
      },
      workers: 1,
      approvalPolicy: "block",
      onStateChange: (state) => stateStatuses.push(state.nodes[0].status),
      onNodeStart: (node) => starts.push(node.id),
      onNodeComplete: (node, taskResult) => completes.push([node.id, taskResult.success]),
    });

    assert.equal(result.success, true);
    assert.equal(result.state.runId, "harness-test");
    assert.equal(result.state.nodes[0].status, "done");
    assert.deepEqual(calls, [
      {
        nodeId: "node-1",
        envRunId: "harness-test",
        baseEnv: "base-value",
        envMcpConfigFile: join(root, ".kimi", "mcp.json"),
        contextRunId: "harness-test",
        contextRoot: root,
        workerRunId: "harness-test",
        contextMcpConfigFile: join(root, ".kimi", "mcp.json"),
      },
    ]);
    assert.deepEqual(starts, ["node-1"]);
    assert.deepEqual(completes, [["node-1", true]]);
    assert.ok(stateStatuses.includes("running"));
    assert.ok(stateStatuses.includes("done"));

    const persisted = JSON.parse(
      await readFile(join(root, ".omk", "runs", "harness-test", "state.json"), "utf8")
    );
    assert.equal(persisted.runId, "harness-test");
    assert.equal(persisted.nodes[0].status, "done");
  });
});

test("executeHarnessRun applies worker manifest env after base and node env", async () => {
  await withTempRoot(async (root) => {
    const calls = [];
    const runner = {
      async run(_node, env, _signal, context) {
        calls.push({
          baseOnly: env.BASE_ONLY,
          nodeRole: env.OMK_NODE_ROLE,
          providerModel: env.OMK_PROVIDER_MODEL,
          contextModel: context?.worker?.provider?.model,
        });
        return {
          success: true,
          stdout: "## Summary\nok\n\n## Evidence\nok",
          stderr: "",
        };
      },
    };

    const result = await executeHarnessRun({
      root,
      runId: "harness-env-precedence",
      dag: createDag({
        nodes: [
          {
            id: "env-node",
            name: "Harness env precedence",
            role: "tester",
            dependsOn: [],
            maxRetries: 1,
            routing: {
              readOnly: true,
              providerModel: "manifest-model",
              rationale: "test env merge precedence",
            },
          },
        ],
      }),
      runner,
      env: {
        BASE_ONLY: "base",
        OMK_NODE_ROLE: "base-role",
        OMK_PROVIDER_MODEL: "base-model",
      },
      workers: 1,
      approvalPolicy: "block",
    });

    assert.equal(result.success, true);
    assert.deepEqual(calls, [
      {
        baseOnly: "base",
        nodeRole: "tester",
        providerModel: "manifest-model",
        contextModel: "manifest-model",
      },
    ]);
  });
});

test("mergeEnvWithTrace preserves non-empty compiled DAG env values", () => {
  const { env, trace } = mergeEnvWithTrace([
    {
      source: "base",
      env: {
        OMK_RUN_ID: "run-1",
        OMK_PROVIDER_MODEL: "deepseek-v4-pro",
        OMK_MCP_CONFIG_FILE: "/tmp/mcp.json",
      },
    },
    {
      source: "node",
      env: {
        OMK_PROVIDER_MODEL: "",
        OMK_MCP_CONFIG_FILE: "",
        OMK_ROUTE_RATIONALE: "",
      },
    },
    {
      source: "worker-manifest",
      env: {
        OMK_WORKER_MANIFEST_NODE_ID: "worker-1",
        OMK_PROVIDER_PREFERRED: "deepseek",
      },
    },
  ]);

  assert.equal(env.OMK_PROVIDER_MODEL, "deepseek-v4-pro");
  assert.equal(env.OMK_MCP_CONFIG_FILE, "/tmp/mcp.json");
  assert.equal(env.OMK_ROUTE_RATIONALE, undefined);
  assert.equal(trace.some((entry) => entry.key === "OMK_PROVIDER_MODEL" && entry.action === "preserve-non-empty"), true);
  assert.equal(trace.some((entry) => entry.key === "OMK_ROUTE_RATIONALE" && entry.action === "drop-empty"), true);
});

test("executeHarnessRun exposes env merge trace in TaskRunContext diagnostics", async () => {
  await withTempRoot(async (root) => {
    const calls = [];
    const result = await executeHarnessRun({
      root,
      runId: "harness-env-trace",
      dag: createSingleNodeDag("env-trace-node"),
      runner: {
        async run(_node, env, _signal, context) {
          calls.push({
            providerModel: env.OMK_PROVIDER_MODEL,
            preservedModel: context?.diagnostics?.envMergeTrace?.some(
              (entry) => entry.key === "OMK_PROVIDER_MODEL" && entry.action === "preserve-non-empty",
            ),
          });
          return {
            success: true,
            stdout: "## Summary\nok\n\n## Evidence\nok",
            stderr: "",
          };
        },
      },
      env: {
        OMK_PROVIDER_MODEL: "compiled-model",
      },
      workers: 1,
      approvalPolicy: "block",
    });

    assert.equal(result.success, true);
    assert.deepEqual(calls, [{ providerModel: "compiled-model", preservedModel: true }]);
  });
});

test("executeHarnessRun resumes terminal state without rerunning completed nodes", async () => {
  await withTempRoot(async (root) => {
    const first = await executeHarnessRun({
      root,
      runId: "harness-resume",
      dag: createSingleNodeDag("resume-node"),
      runner: {
        async run() {
          return {
            success: true,
            stdout: "## Summary\nok\n\n## Evidence\nok",
            stderr: "",
          };
        },
      },
      workers: 1,
      approvalPolicy: "block",
    });

    let rerunCount = 0;
    const resumed = await executeHarnessRun({
      root,
      runId: "harness-resume",
      dag: createSingleNodeDag("resume-node"),
      runner: {
        async run() {
          rerunCount += 1;
          return {
            success: true,
            stdout: "unexpected rerun",
            stderr: "",
          };
        },
      },
      workers: 1,
      approvalPolicy: "block",
      resumeFromState: first.state,
    });

    assert.equal(resumed.success, true);
    assert.equal(rerunCount, 0);
    assert.equal(resumed.state.nodes[0].status, "done");
  });
});

test("executeHarnessRun applies nodeTimeoutMs to runner execution", async () => {
  await withTempRoot(async (root) => {
    const result = await executeHarnessRun({
      root,
      runId: "harness-node-timeout",
      dag: createSingleNodeDag("timeout-node"),
      runner: {
        async run(_node, _env, signal) {
          return await new Promise((resolve) => {
            signal?.addEventListener("abort", () => {
              resolve({
                success: false,
                stdout: "",
                stderr: "aborted by timeout",
              });
            }, { once: true });
          });
        },
      },
      workers: 1,
      approvalPolicy: "block",
      nodeTimeoutMs: 5,
    });

    assert.equal(result.success, false);
    assert.equal(result.state.nodes[0].status, "failed");
  });
});

test("executeHarnessRun preserves harness env when the runner is forked", async () => {
  await withTempRoot(async (root) => {
    const calls = [];
    let forked = false;
    const runner = {
      fork() {
        forked = true;
        return {
          async run(_node, env, _signal, context) {
            calls.push({
              baseEnv: env.CUSTOM_BASE_ENV,
              envMcpConfigFile: env.OMK_MCP_CONFIG_FILE,
              contextMcpConfigFile: context?.worker?.toolPlane?.mcpConfigFile,
            });
            return {
              success: true,
              stdout: "## Summary\nok\n\n## Evidence\nok",
              stderr: "",
            };
          },
        };
      },
      async run() {
        throw new Error("base runner should be forked by the executor");
      },
    };

    const result = await executeHarnessRun({
      root,
      runId: "harness-fork-env",
      dag: createSingleNodeDag("forked-node"),
      runner,
      env: {
        CUSTOM_BASE_ENV: "base-value",
        OMK_MCP_CONFIG_FILE: join(root, ".kimi", "mcp.json"),
      },
      workers: 1,
      approvalPolicy: "block",
    });

    assert.equal(result.success, true);
    assert.equal(forked, true);
    assert.deepEqual(calls, [
      {
        baseEnv: "base-value",
        envMcpConfigFile: join(root, ".kimi", "mcp.json"),
        contextMcpConfigFile: join(root, ".kimi", "mcp.json"),
      },
    ]);
  });
});

test("executeHarnessRun marks the run failed when a required node fails", async () => {
  await withTempRoot(async (root) => {
    const result = await executeHarnessRun({
      root,
      runId: "harness-fail",
      dag: createSingleNodeDag("failing-node"),
      runner: {
        async run() {
          return {
            success: false,
            exitCode: 1,
            stdout: "",
            stderr: "boom",
          };
        },
      },
      workers: 1,
      approvalPolicy: "block",
    });

    assert.equal(result.success, false);
    assert.equal(result.state.nodes[0].status, "failed");

    const persisted = JSON.parse(
      await readFile(join(root, ".omk", "runs", "harness-fail", "state.json"), "utf8")
    );
    assert.equal(persisted.nodes[0].status, "failed");
  });
});

test("executeHarnessRun propagates external AbortSignal into the running node", async () => {
  await withTempRoot(async (root) => {
    const controller = new AbortController();
    let started;
    const startedPromise = new Promise((resolve) => {
      started = resolve;
    });
    let sawAbortSignal = false;
    let sawAbort = false;

    const runPromise = executeHarnessRun({
      root,
      runId: "harness-external-abort",
      dag: createDag({
        nodes: [
          { id: "abort-node", name: "Abort node", role: "tester", dependsOn: [], maxRetries: 1 },
          { id: "after-abort", name: "After abort", role: "tester", dependsOn: ["abort-node"], maxRetries: 1 },
        ],
      }),
      runner: {
        async run(_node, _env, signal) {
          sawAbortSignal = signal instanceof AbortSignal;
          started();
          return await new Promise((resolve) => {
            signal?.addEventListener("abort", () => {
              sawAbort = true;
              resolve({
                success: false,
                stdout: "",
                stderr: "aborted by external signal",
              });
            }, { once: true });
          });
        },
      },
      env: { CUSTOM_BASE_ENV: "abort-test" },
      workers: 1,
      approvalPolicy: "block",
      signal: controller.signal,
    });

    await startedPromise;
    controller.abort(new Error("test abort"));
    const result = await runPromise;

    assert.equal(result.success, false);
    assert.equal(sawAbortSignal, true);
    assert.equal(sawAbort, true);
    assert.ok(result.state.nodes.some((node) => node.status === "blocked" && node.blockedReason === "cancelled"));
  });
});

test("executeHarnessRun wires eventRunDir into executor telemetry", async () => {
  await withTempRoot(async (root) => {
    const runId = "harness-telemetry";
    const runDir = join(root, ".omk", "runs", runId);
    await mkdir(runDir, { recursive: true });

    const result = await executeHarnessRun({
      root,
      runId,
      dag: createSingleNodeDag("telemetry-node"),
      runner: {
        fork(onThinking) {
          return {
            async run() {
              onThinking?.("shared harness activity");
              await new Promise((resolve) => setTimeout(resolve, 600));
              return {
                success: true,
                stdout: "## Summary\nok\n\n## Evidence\nok",
                stderr: "",
              };
            },
          };
        },
        async run() {
          return {
            success: true,
            stdout: "## Summary\nok\n\n## Evidence\nok",
            stderr: "",
          };
        },
      },
      env: { CUSTOM_BASE_ENV: "telemetry-test" },
      workers: 1,
      approvalPolicy: "block",
      eventRunDir: runDir,
    });

    assert.equal(result.success, true);
    const lines = (await readFile(join(runDir, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(lines.some((line) => line.type === "lane.started" && line.runId === runId), true);
    assert.equal(lines.some((line) => line.type === "lane.activity" && line.runId === runId), true);
    assert.equal(lines.some((line) => line.type === "lane.completed" && line.runId === runId), true);
  });
});
