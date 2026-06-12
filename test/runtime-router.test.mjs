import test from "node:test";
import assert from "node:assert/strict";

import { createRuntimeBackedTaskRunner } from "../dist/runtime/runtime-backed-task-runner.js";
import { createRuntimeRouter } from "../dist/runtime/runtime-router.js";
import { buildTaskRunContext } from "../dist/runtime/worker-manifest.js";

test("runtime router prefers direct Kimi API for advisory coding intent when Kimi API and Codex are available", async () => {
  const calls = [];
  const router = createRuntimeRouter({
    runtimes: [
      fakeRuntime("kimi-api", calls, advisoryApiCapabilities({ vision: true, supportsToolCalling: true })),
      fakeRuntime("codex-cli", calls),
    ],
  });

  const result = await router.execute(fakeTask({
    prompt: "implement the provider-neutral routing patch",
    capabilities: {
      read: true,
      write: false,
      shell: false,
      mcp: false,
      patch: false,
      review: true,
      merge: false,
      vision: false,
    },
  }));

  assert.equal(result.exitCode, 0);
  assert.equal(result.metadata.selectedRuntime, "kimi-api");
  assert.deepEqual(calls, ["kimi-api"]);
  assert.deepEqual(result.metadata.fallbackChain, ["kimi-api", "codex-cli"]);
});

test("runtime router skips API advisory runtimes for workspace-write tasks", async () => {
  const calls = [];
  const router = createRuntimeRouter({
    runtimes: [
      fakeRuntime("mimo-api", calls, advisoryApiCapabilities({ vision: true, supportsToolCalling: true })),
      fakeRuntime("kimi-api", calls, advisoryApiCapabilities({ vision: true, supportsToolCalling: true })),
      fakeRuntime("local-llm", calls, advisoryApiCapabilities()),
      fakeRuntime("codex-cli", calls, {
        read: true,
        write: true,
        shell: true,
        mcp: false,
        patch: true,
        review: true,
        merge: false,
        vision: false,
      }),
    ],
  });

  const result = await router.execute(fakeTask({
    prompt: "implement the provider-neutral routing patch",
    capabilities: {
      read: true,
      write: true,
      shell: false,
      mcp: false,
      patch: true,
      review: false,
      merge: false,
      vision: false,
    },
  }));

  assert.equal(result.exitCode, 0);
  assert.equal(result.metadata.selectedRuntime, "codex-cli");
  assert.deepEqual(calls, ["codex-cli"]);
});

test("runtime router keeps Kimi as compatibility fallback when preferred runtimes are absent", async () => {
  const calls = [];
  const router = createRuntimeRouter({
    runtimes: [
      fakeRuntime("kimi-cli", calls),
    ],
  });

  const result = await router.execute(fakeTask({ prompt: "implement a fallback-only patch" }));

  assert.equal(result.exitCode, 0);
  assert.equal(result.metadata.selectedRuntime, "kimi-cli");
  assert.deepEqual(calls, ["kimi-cli"]);
  assert.deepEqual(result.metadata.fallbackChain, ["kimi-cli"]);
});

test("runtime router filters runtimes that lack requested task capabilities", async () => {
  const calls = [];
  const router = createRuntimeRouter({
    runtimes: [
      fakeRuntime("deepseek-api", calls, {
        read: true,
        write: false,
        shell: false,
        mcp: false,
        patch: false,
        review: true,
        merge: false,
        vision: false,
      }),
      fakeRuntime("codex-cli", calls, {
        read: true,
        write: true,
        shell: true,
        mcp: false,
        patch: true,
        review: true,
        merge: false,
        vision: false,
      }),
    ],
  });

  const result = await router.execute(fakeTask({
    prompt: "review then patch and run shell test",
    capabilities: {
      read: true,
      write: true,
      shell: true,
      mcp: false,
      patch: true,
      review: true,
      merge: false,
      vision: false,
    },
  }));

  assert.equal(result.exitCode, 0);
  assert.equal(result.metadata.selectedRuntime, "codex-cli");
  assert.deepEqual(calls, ["codex-cli"]);
  assert.deepEqual(result.metadata.fallbackChain, ["codex-cli"]);
});

test("runtime router explains MCP authority route blocks", async () => {
  const calls = [];
  const router = createRuntimeRouter({
    runtimes: [
      fakeRuntime("codex-cli", calls, {
        read: true,
        write: true,
        shell: true,
        mcp: false,
        patch: true,
        review: true,
        merge: false,
        vision: false,
        supportsToolCalling: true,
      }),
    ],
  });

  await assert.rejects(
    () => router.execute(fakeTask({
      prompt: "execute MCP-backed worker task",
      capabilities: {
        read: true,
        write: true,
        shell: true,
        mcp: true,
        patch: true,
        review: false,
        merge: false,
        vision: false,
        toolCalling: true,
      },
    })),
    /Node requires MCP authority.*Codex CLI runtime does not receive OMK MCP authority/
  );
  assert.deepEqual(calls, []);
});

test("runtime router honors task provider policy and does not fall back to Kimi implicitly", async () => {
  const calls = [];
  const router = createRuntimeRouter({
    runtimes: [
      fakeRuntime("kimi-cli", calls),
      fakeRuntime("codex-cli", calls),
    ],
  });

  const result = await router.execute(fakeTask({
    prompt: "implement with explicitly requested codex provider",
    providerPolicy: {
      strategy: "priority-first",
      preferredProviders: ["codex"],
      fallbackChain: [],
    },
  }));

  assert.equal(result.exitCode, 0);
  assert.equal(result.metadata.selectedRuntime, "codex-cli");
  assert.deepEqual(calls, ["codex-cli"]);
  assert.deepEqual(result.metadata.fallbackChain, ["codex-cli"]);
});

test("runtime router accepts explicit MiMo advisory chat turns after authority downgrade", async () => {
  const calls = [];
  const router = createRuntimeRouter({
    runtimes: [
      fakeRuntime("mimo-api", calls, {
        read: true,
        write: false,
        shell: false,
        mcp: false,
        patch: false,
        review: true,
        merge: false,
        vision: true,
        supportsToolCalling: true,
      }),
    ],
  });

  const result = await router.execute(fakeTask({
    prompt: "npm run verify 해줘",
    context: {
      runId: "local-runtime-router-test",
      nodeId: "chat-turn",
      role: "coordinator",
      goal: "native mimo advisory shell turn",
      system: "",
      files: [],
      memory: [],
      cwd: process.cwd(),
      risk: "shell",
      sandboxMode: "read-only",
    },
    providerPolicy: {
      strategy: "priority-first",
      preferredProviders: ["mimo"],
      fallbackChain: [],
    },
    capabilities: {
      read: true,
      write: false,
      shell: false,
      mcp: false,
      patch: false,
      review: true,
      merge: false,
      vision: false,
    },
  }));

  assert.equal(result.exitCode, 0);
  assert.equal(result.metadata.selectedRuntime, "mimo-api");
  assert.deepEqual(calls, ["mimo-api"]);
});

test("runtime-backed runner routes non-Kimi CLI turns without optional capability over-constraint", async () => {
  const runner = await createRuntimeBackedTaskRunner({ cwd: process.cwd(), env: {}, runId: "local-runtime-backed" });
  const registry = runner._registry;
  registry.unregister("codex-cli");
  registry.unregister("kimi-print");
  registry.unregister("deepseek-api");
  registry.unregister("opencode-cli");
  registry.unregister("commandcode-cli");
  registry.unregister("omk-advisory");

  const calls = [];
  registry.register(fakeRuntime("opencode-cli", calls, {
    read: true,
    write: true,
    shell: true,
    mcp: false,
    patch: true,
    review: true,
    merge: false,
    vision: false,
  }));

  const result = await runner.run({
    id: "native-turn",
    name: "Implement a small patch",
    role: "coder",
    dependsOn: [],
    status: "running",
    retries: 0,
    maxRetries: 1,
    routing: {
      provider: "opencode",
      readOnly: false,
      contextBudget: "small",
    },
  }, {});

  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, ["opencode-cli"]);
  assert.equal(result.metadata.selectedRuntime, "opencode-cli");
});

test("runtime-backed runner forwards per-turn env and routing providerModel", async () => {
  const runner = await createRuntimeBackedTaskRunner({ cwd: process.cwd(), env: { OMK_PROVIDER_MODEL: "initial-model" }, runId: "local-runtime-backed-model" });
  const registry = runner._registry;
  for (const runtime of [...registry.list()]) registry.unregister(runtime.id);

  let seen;
  registry.register({
    id: "codex-cli",
    priority: 100,
    capabilities: {
      read: true,
      write: false,
      shell: false,
      mcp: false,
      patch: false,
      review: false,
      merge: false,
      vision: false,
    },
    supports: () => true,
    async runNode() {
      throw new Error("execute path expected");
    },
    async execute(task) {
      seen = {
        providerModel: task.context.providerModel,
        envModel: task.context.env?.OMK_PROVIDER_MODEL,
      };
      return {
        output: "ok",
        exitCode: 0,
        metadata: { runtime: "codex-cli" },
      };
    },
  });

  const result = await runner.run({
    id: "native-model-turn",
    name: "Summarize",
    role: "coordinator",
    dependsOn: [],
    status: "running",
    retries: 0,
    maxRetries: 1,
    routing: {
      provider: "codex",
      providerModel: "routing-model",
      readOnly: true,
      assignedProviderCapabilities: ["read"],
      contextBudget: "small",
    },
  }, { OMK_PROVIDER_MODEL: "turn-env-model" });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(seen, {
    providerModel: "routing-model",
    envModel: "turn-env-model",
  });
});

test("runtime-backed runner forwards OMK-owned scoped worker manifest into native AgentTask", async () => {
  const runner = await createRuntimeBackedTaskRunner({ cwd: process.cwd(), env: {}, runId: "local-runtime-backed-owner" });
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
        output: "ok",
        exitCode: 0,
        metadata: { runtime: "codex-cli" },
      };
    },
  });

  const node = {
    id: "owned-worker",
    name: "Implement with scoped worker tools",
    role: "coder",
    dependsOn: [],
    status: "running",
    retries: 0,
    maxRetries: 1,
    routing: {
      provider: "codex",
      readOnly: false,
      requiresMcp: true,
      requiresToolCalling: true,
      skills: ["omk-typescript-strict", "custom-skill"],
      mcpServers: ["omk-project", "custom-mcp"],
      hooks: ["protect-secrets.sh", "custom-hook"],
      tools: ["custom-tool"],
      assignedProviderCapabilities: ["write", "patch", "shell", "mcp"],
      contextBudget: "small",
    },
  };
  const runContext = buildTaskRunContext({
    runId: "local-runtime-backed-owner",
    root: process.cwd(),
    node,
    toolPlane: {
      mcpServers: ["omk-project", "custom-mcp"],
      skills: ["omk-typescript-strict", "custom-skill"],
      hooks: ["protect-secrets.sh", "custom-hook"],
      tools: ["custom-tool"],
      requiresRuntimeMcp: true,
    },
    selectedRuntimeId: "codex-cli",
    model: "codex-cli",
  });

  const result = await runner.run(node, {}, undefined, runContext);

  assert.equal(result.exitCode, 0);
  assert.equal(result.metadata.selectedRuntime, "codex-cli");
  assert.equal(result.metadata.workerOwner, "omk");
  assert.deepEqual(captured.tools.mcpServers, ["omk-project", "custom-mcp"]);
  assert.deepEqual(captured.tools.skills, ["omk-typescript-strict", "custom-skill"]);
  assert.deepEqual(captured.tools.hooks, ["protect-secrets.sh", "custom-hook"]);
  assert.deepEqual(captured.tools.available.map((tool) => tool.name), ["custom-tool"]);
  assert.equal(captured.context.workerManifest.owner, "omk");
  assert.equal(captured.context.workerManifest.toolPlane.requiresRuntimeMcp, true);
  assert.equal(captured.context.env.OMK_NODE_SKILLS, "omk-typescript-strict,custom-skill");
  assert.equal(captured.context.env.OMK_NODE_MCP_SERVERS, "omk-project,custom-mcp");
  assert.equal(captured.context.env.OMK_NODE_HOOKS, "protect-secrets.sh,custom-hook");
  assert.equal(captured.context.env.OMK_NODE_TOOLS, "custom-tool");
});

function fakeRuntime(id, calls, capabilities) {
  return {
    id,
    priority: id.startsWith("kimi-") ? 100 : 60,
    capabilities,
    supports: () => true,
    async runNode() {
      return {
        success: true,
        exitCode: 0,
        stdout: id,
        stderr: "",
        metadata: { runtime: id },
      };
    },
    async execute() {
      calls.push(id);
      return {
        output: id,
        exitCode: 0,
        metadata: { runtime: id },
      };
    },
  };
}

function advisoryApiCapabilities(overrides = {}) {
  return {
    read: true,
    write: false,
    shell: false,
    mcp: false,
    patch: false,
    review: true,
    merge: false,
    vision: false,
    ...overrides,
  };
}

function fakeTask(overrides = {}) {
  return {
    prompt: "implement a change",
    context: {
      runId: "local-runtime-router-test",
      nodeId: "coder-node",
      role: "coder",
      goal: "provider-neutral routing",
      system: "",
      files: [],
      memory: [],
      cwd: process.cwd(),
    },
    tools: { available: [] },
    providerPolicy: {
      strategy: "priority-first",
      preferredProviders: [],
      fallbackChain: [],
    },
    capabilities: {
      read: true,
      write: true,
      shell: false,
      mcp: false,
      patch: true,
      review: false,
      merge: false,
      vision: false,
    },
    ...overrides,
  };
}
