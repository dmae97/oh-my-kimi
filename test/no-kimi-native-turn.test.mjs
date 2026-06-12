import test from "node:test";
import assert from "node:assert/strict";

import { createRuntimeBackedTaskRunner } from "../dist/runtime/runtime-backed-task-runner.js";
import { buildTaskRunContext } from "../dist/runtime/worker-manifest.js";

test("native no-Kimi turn executes OMK-owned worker context through non-Kimi runtime", async () => {
  const runner = await createRuntimeBackedTaskRunner({
    cwd: process.cwd(),
    env: {
      KIMI_BIN: "/nonexistent/kimi",
      OMK_LEGACY_CHAT: "0",
    },
    runId: "local-no-kimi-native-turn",
  });
  const registry = runner._registry;
  for (const runtime of [...registry.list()]) registry.unregister(runtime.id);

  let captured;
  registry.register({
    id: "codex-cli",
    priority: 100,
    capabilities: {
      read: true,
      write: true,
      shell: true,
      mcp: true,
      patch: true,
      review: true,
      merge: true,
      vision: false,
      supportsToolCalling: true,
    },
    supports: () => true,
    async runNode() {
      throw new Error("execute path expected");
    },
    async execute(task) {
      captured = task;
      return {
        output: "non-kimi native turn ok",
        exitCode: 0,
        metadata: { runtime: "codex-cli" },
      };
    },
  });

  const node = {
    id: "no-kimi-owned-turn",
    name: "Implement via OMK-owned non-Kimi worker",
    role: "coder",
    dependsOn: [],
    status: "running",
    retries: 0,
    maxRetries: 1,
    routing: {
      provider: "codex",
      providerModel: "codex-cli",
      readOnly: false,
      requiresMcp: true,
      requiresToolCalling: true,
      assignedProviderCapabilities: ["write", "patch", "shell", "mcp"],
      mcpServers: ["omk-project"],
      skills: ["omk-typescript-strict"],
      hooks: ["protect-secrets.sh"],
      tools: ["apply_patch"],
      contextBudget: "small",
    },
  };
  const context = buildTaskRunContext({
    runId: "local-no-kimi-native-turn",
    root: process.cwd(),
    node,
    toolPlane: {
      mcpServers: ["omk-project"],
      skills: ["omk-typescript-strict"],
      hooks: ["protect-secrets.sh"],
      tools: ["apply_patch"],
      requiresRuntimeMcp: true,
    },
    selectedRuntimeId: "codex-cli",
    model: "codex-cli",
  });

  const result = await runner.run(node, {}, undefined, context);

  assert.equal(result.success, true);
  assert.equal(result.metadata.selectedRuntime, "codex-cli");
  assert.equal(result.metadata.workerOwner, "omk");
  assert.equal(captured.context.goalContext.runId, "local-no-kimi-native-turn");
  assert.equal(captured.context.goalContext.objective, "Implement via OMK-owned non-Kimi worker");
  assert.equal(captured.context.workerManifest.owner, "omk");
  assert.equal(captured.context.workerManifest.toolPlane.requiresRuntimeMcp, true);
  assert.deepEqual(captured.context.workerManifest.toolPlane.skills, ["omk-typescript-strict"]);
  assert.deepEqual(captured.context.workerManifest.toolPlane.hooks, ["protect-secrets.sh"]);
  assert.ok(captured.providerPolicy.preferredProviders.includes("codex"));
  assert.deepEqual(captured.tools.mcpServers, ["omk-project"]);
  assert.deepEqual(captured.tools.skills, ["omk-typescript-strict"]);
  assert.deepEqual(captured.tools.hooks, ["protect-secrets.sh"]);
  assert.deepEqual(captured.tools.available.map((tool) => tool.name), ["apply_patch"]);
  assert.equal(registry.list().some((runtime) => runtime.id.includes("kimi")), false);
});

test("native no-Kimi turn keeps optional MCP available without requiring runtime MCP", async () => {
  const runner = await createRuntimeBackedTaskRunner({
    cwd: process.cwd(),
    env: {
      KIMI_BIN: "/nonexistent/kimi",
      OMK_LEGACY_CHAT: "0",
    },
    runId: "local-no-kimi-optional-mcp",
  });
  const registry = runner._registry;
  for (const runtime of [...registry.list()]) registry.unregister(runtime.id);

  let captured;
  registry.register({
    id: "codex-cli",
    priority: 100,
    capabilities: {
      read: true,
      write: true,
      shell: true,
      mcp: true,
      patch: true,
      review: true,
      merge: true,
      vision: false,
      supportsToolCalling: true,
    },
    supports: () => true,
    async runNode() {
      throw new Error("execute path expected");
    },
    async execute(task) {
      captured = task;
      return {
        output: "optional mcp ok",
        exitCode: 0,
        metadata: { runtime: "codex-cli" },
      };
    },
  });

  const node = {
    id: "no-kimi-optional-mcp",
    name: "Read status with optional MCP",
    role: "coordinator",
    dependsOn: [],
    status: "running",
    retries: 0,
    maxRetries: 1,
    routing: {
      provider: "codex",
      providerModel: "codex-cli",
      readOnly: true,
      requiresMcp: false,
      requiresToolCalling: false,
      assignedProviderCapabilities: ["read", "mcp"],
      mcpServers: ["omk-project"],
      skills: ["omk-context-broker"],
      hooks: ["protect-secrets.sh"],
      tools: [],
      contextBudget: "small",
    },
  };
  const context = buildTaskRunContext({
    runId: "local-no-kimi-optional-mcp",
    root: process.cwd(),
    node,
    toolPlane: {
      mcpServers: ["omk-project"],
      skills: ["omk-context-broker"],
      hooks: ["protect-secrets.sh"],
      tools: [],
      requiresRuntimeMcp: false,
    },
    selectedRuntimeId: "codex-cli",
    model: "codex-cli",
  });

  const result = await runner.run(node, {}, undefined, context);

  assert.equal(result.success, true);
  assert.equal(result.metadata.selectedRuntime, "codex-cli");
  assert.deepEqual(captured.tools.mcpServers, ["omk-project"]);
  assert.equal(captured.context.workerManifest.toolPlane.requiresRuntimeMcp, false);
  assert.equal(registry.list().some((runtime) => runtime.id.includes("kimi")), false);
});
