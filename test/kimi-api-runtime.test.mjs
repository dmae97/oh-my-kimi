import test from "node:test";
import assert from "node:assert/strict";

import { createKimiApiRuntime, createKimiWireRuntime } from "../dist/runtime/kimi-api-runtime.js";
import { createMimoApiRuntime } from "../dist/runtime/mimo-api-runtime.js";
import { LocalLlmRuntime } from "../dist/runtime/local-llm-runtime.js";

function makeCapsule(overrides = {}) {
  return {
    nodeId: "test-node",
    node: { routing: {} },
    ...overrides,
  };
}

test("kimi-api runtime requires KIMI_API_KEY to be available", () => {
  const disabled = createKimiApiRuntime({});
  assert.equal(disabled.supports(makeCapsule()), false);

  const enabled = createKimiApiRuntime({ apiKey: "test-key" });
  assert.equal(enabled.supports(makeCapsule()), true);
});

test("createKimiWireRuntime backward-compat alias works", () => {
  const runtime = createKimiWireRuntime({ apiKey: "test-key" });
  assert.equal(runtime.supports(makeCapsule()), true);
  assert.equal(runtime.id, "kimi-api");
});

test("API runtimes expose advisory authority instead of direct workspace-write authority", () => {
  const runtimes = [
    createKimiApiRuntime({ apiKey: "test-key" }),
    createMimoApiRuntime({ apiKey: "test-key" }),
    new LocalLlmRuntime({ baseUrl: "http://127.0.0.1:9/v1" }),
  ];

  for (const runtime of runtimes) {
    assert.equal(runtime.capabilities?.read, true, runtime.id);
    assert.equal(runtime.capabilities?.write, false, runtime.id);
    assert.equal(runtime.capabilities?.patch, false, runtime.id);
    assert.equal(runtime.capabilities?.shell, false, runtime.id);
    assert.equal(runtime.capabilities?.mcp, false, runtime.id);
    assert.equal(runtime.capabilities?.merge, false, runtime.id);
  }
});

test("Kimi-compatible API runtimes reject direct write authority", async () => {
  const runtime = createKimiApiRuntime({ apiKey: "test-key" });
  assert.equal(runtime.supports(makeCapsule({
    node: {
      routing: {
        assignedProviderCapabilities: ["write", "patch"],
      },
    },
  })), false);

  const result = await runtime.execute({
    prompt: "patch files",
    context: {
      runId: "local-kimi-api-authority",
      nodeId: "node-kimi-api-authority",
      providerModel: "kimi-test",
    },
    tools: { available: [] },
    providerPolicy: {
      strategy: "priority-first",
      preferredProviders: ["kimi"],
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
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.metadata?.authorityMode, "advisory");
});

test("local LLM runtime rejects direct shell and tool-calling authority", async () => {
  const runtime = new LocalLlmRuntime({ baseUrl: "http://127.0.0.1:9/v1" });
  assert.equal(runtime.supports(makeCapsule({
    node: {
      routing: {
        assignedProviderCapabilities: ["shell"],
      },
    },
  })), false);

  const result = await runtime.execute({
    prompt: "run npm test",
    context: {
      runId: "local-llm-authority",
      nodeId: "node-local-llm-authority",
      providerModel: "local-test",
    },
    tools: { available: [] },
    providerPolicy: {
      strategy: "priority-first",
      preferredProviders: ["local-llm"],
      fallbackChain: [],
    },
    capabilities: {
      read: true,
      write: false,
      shell: true,
      mcp: false,
      patch: false,
      review: false,
      merge: false,
      vision: false,
      toolCalling: true,
    },
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.metadata?.authorityMode, "advisory");
});
