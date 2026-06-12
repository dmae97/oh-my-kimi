import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildAgentWorkerSpawnEnv, createAgentYaml } from "../dist/orchestration/agent-worker.js";
import { buildParallelWorkerCapabilityContext, buildParallelWorkerEnv } from "../dist/orchestration/parallel-orchestrator.js";

test("parallel worker capability context merges role defaults with explicit routing", () => {
  const node = workerNode();
  const context = buildParallelWorkerCapabilityContext(node, { nodes: [node] });

  assert.ok(context.scopes.skills.includes("omk-typescript-strict"));
  assert.ok(context.scopes.skills.includes("custom-skill"));
  assert.ok(context.scopes.mcpServers.includes("omk-project"));
  assert.ok(context.scopes.mcpServers.includes("custom-mcp"));
  assert.ok(context.scopes.tools.includes("custom-tool"));
  assert.ok(context.scopes.hooks.includes("protect-secrets.sh"));
  assert.ok(context.scopes.hooks.includes("custom-hook"));
  assert.deepEqual(context.assignment.mcpServers, [...context.scopes.mcpServers]);
  assert.equal(context.workerManifest.owner, "omk");
  assert.equal(context.workerManifest.nodeId, "worker-1");
  assert.deepEqual(context.workerManifest.toolPlane.mcpServers, [...context.scopes.mcpServers]);
  assert.deepEqual(context.workerManifest.toolPlane.skills, [...context.scopes.skills]);
  assert.deepEqual(context.workerManifest.toolPlane.hooks, [...context.scopes.hooks]);
  assert.deepEqual(context.workerManifest.toolPlane.tools, [...context.scopes.tools]);
  assert.deepEqual(context.runContext.worker, context.workerManifest);
  assert.equal(context.node.routing?.requiresMcp, true);
  assert.equal(context.node.routing?.requiresToolCalling, true);
  assert.match(context.env.OMK_NODE_SKILLS, /custom-skill/);
  assert.match(context.env.OMK_NODE_MCP_SERVERS, /custom-mcp/);
  assert.match(context.env.OMK_NODE_TOOLS, /custom-tool/);
  assert.match(context.env.OMK_NODE_HOOKS, /custom-hook/);
  assert.equal(context.env.OMK_ROUTE_REQUIRES_MCP, "true");
  assert.equal(context.env.OMK_ROUTE_REQUIRES_TOOL_CALLING, "true");
  assert.match(context.env.OMK_NODE_CAPABILITY_SUMMARY, /mcp=/);
});

test("parallel worker context carries explicit goal and capability assignment into run context", () => {
  const node = workerNode();
  const root = "/tmp/omk-parallel-goal";
  const context = buildParallelWorkerCapabilityContext(node, { nodes: [node] }, {
    runId: "custom-run",
    root,
    goalId: "goal-parallel-agents",
    objective: "Coordinate parallel subagents with scoped capabilities",
  });

  assert.equal(context.runContext.goal.runId, "custom-run");
  assert.equal(context.runContext.goal.goalId, "goal-parallel-agents");
  assert.equal(context.runContext.goal.objective, "Coordinate parallel subagents with scoped capabilities");
  assert.equal(context.runContext.goal.root, root);
  assert.equal(context.runContext.worker.owner, "omk");
  assert.equal(context.runContext.worker.runId, "custom-run");
  assert.ok(context.runContext.worker.toolPlane.mcpServers.includes("omk-project"));
  assert.ok(context.runContext.worker.toolPlane.mcpServers.includes("custom-mcp"));
  assert.ok(context.runContext.worker.toolPlane.skills.includes("omk-typescript-strict"));
  assert.ok(context.runContext.worker.toolPlane.skills.includes("custom-skill"));
  assert.ok(context.runContext.worker.toolPlane.hooks.includes("protect-secrets.sh"));
  assert.ok(context.runContext.worker.toolPlane.hooks.includes("custom-hook"));
  assert.ok(context.runContext.worker.toolPlane.tools.includes("custom-tool"));
  assert.equal(context.runContext.worker.toolPlane.requiresRuntimeMcp, true);
});

test("parallel worker env excludes parent process env secrets", () => {
  const previousSecret = process.env.OMK_PARALLEL_SECRET_TOKEN;
  process.env.OMK_PARALLEL_SECRET_TOKEN = "must-not-leak";
  try {
    const context = buildParallelWorkerCapabilityContext(workerNode());
    const env = buildParallelWorkerEnv(
      context,
      { provider: "kimi", fallbackProvider: "codex" },
      { skills: ["omk-typescript-strict"], hooks: ["protect-secrets.sh"] }
    );

    assert.equal(env.OMK_PARALLEL_SECRET_TOKEN, undefined);
    assert.equal(env.PATH, undefined);
    assert.equal(env.OMK_WORKER_MANIFEST_OWNER, "omk");
    assert.match(env.OMK_NODE_SKILLS, /custom-skill/);
    assert.deepEqual(JSON.parse(env.OMK_NODE_PROVIDER_POLICY), {
      provider: "kimi",
      fallbackProvider: "codex",
    });
    assert.deepEqual(JSON.parse(env.OMK_NODE_CAPABILITIES), {
      skills: ["omk-typescript-strict"],
      hooks: ["protect-secrets.sh"],
    });
  } finally {
    if (previousSecret === undefined) delete process.env.OMK_PARALLEL_SECRET_TOKEN;
    else process.env.OMK_PARALLEL_SECRET_TOKEN = previousSecret;
  }
});

test("agent worker spawn env keeps scoped metadata without inheriting process secrets", () => {
  const previousSecret = process.env.OMK_AGENT_WORKER_SECRET_TOKEN;
  process.env.OMK_AGENT_WORKER_SECRET_TOKEN = "must-not-leak";
  try {
    const context = buildParallelWorkerCapabilityContext(workerNode());
    const workerEnv = buildParallelWorkerEnv(context, { provider: "kimi" });
    const spawnEnv = buildAgentWorkerSpawnEnv(workerEnv, {
      runId: "run-1",
      nodeId: "worker-1",
      role: "coder",
    });

    assert.equal(spawnEnv.OMK_AGENT_WORKER_SECRET_TOKEN, undefined);
    assert.equal(spawnEnv.OMK_PARALLEL_SECRET_TOKEN, undefined);
    assert.equal(spawnEnv.OMK_RUN_ID, "run-1");
    assert.equal(spawnEnv.OMK_NODE_ID, "worker-1");
    assert.equal(spawnEnv.OMK_NODE_ROLE, "coder");
    assert.match(spawnEnv.OMK_NODE_SKILLS, /custom-skill/);
    assert.deepEqual(JSON.parse(spawnEnv.OMK_NODE_PROVIDER_POLICY), {
      provider: "kimi",
    });
  } finally {
    if (previousSecret === undefined) delete process.env.OMK_AGENT_WORKER_SECRET_TOKEN;
    else process.env.OMK_AGENT_WORKER_SECRET_TOKEN = previousSecret;
  }
});

test("parallel worker scoped YAML carries capability hint digests without secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "omk-parallel-capabilities-"));
  try {
    const outputDir = join(root, ".omk", "runs", "run-1", "agents");
    await mkdir(join(root, ".omk", "agents"), { recursive: true });
    await mkdir(outputDir, { recursive: true });
    const context = buildParallelWorkerCapabilityContext(workerNode());
    const yamlPath = await createAgentYaml(context.node, "run-1", {
      skills: [],
      mcpServers: [],
      tools: [],
      hooks: [],
      rationale: "test",
    }, outputDir);
    const yaml = await readFile(yamlPath, "utf-8");

    assert.match(yaml, /OMK_MCP_ENABLED: "true"/);
    assert.match(yaml, /OMK_SKILLS_ENABLED: "true"/);
    assert.match(yaml, /OMK_HOOKS_ENABLED: "true"/);
    assert.match(yaml, /OMK_MCP_HINTS: "count=\d+;digest=[0-9a-f]+;top=[^"]*custom-mcp/);
    assert.match(yaml, /OMK_SKILL_HINTS: "count=\d+;digest=[0-9a-f]+;/);
    assert.match(yaml, /OMK_TOOL_HINTS: "count=\d+;digest=[0-9a-f]+;top=[^"]*custom-tool/);
    assert.match(yaml, /OMK_HOOK_HINTS: "count=\d+;digest=[0-9a-f]+;/);
    assert.doesNotMatch(yaml, /Authorization|API_TOKEN|SECRET|PASSWORD/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function workerNode() {
  return {
    id: "worker-1",
    name: "Implement parallel worker capability propagation",
    role: "coder",
    dependsOn: [],
    status: "pending",
    retries: 0,
    maxRetries: 1,
    routing: {
      provider: "auto",
      skills: ["custom-skill"],
      mcpServers: ["custom-mcp"],
      tools: ["custom-tool"],
      hooks: ["custom-hook"],
      requiresMcp: true,
      requiresToolCalling: true,
      readOnly: false,
      contextBudget: "small",
    },
  };
}
