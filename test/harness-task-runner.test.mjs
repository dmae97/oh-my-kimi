import test from "node:test";
import assert from "node:assert/strict";

import { createHarnessTaskRunner } from "../dist/harness/create-harness-task-runner.js";

const fakeRunner = {
  async run() {
    return { success: true, stdout: "", stderr: "" };
  },
};

test("createHarnessTaskRunner uses runtime-backed runner for chat mode", async () => {
  const calls = [];
  const runner = await createHarnessTaskRunner({
    root: "/repo",
    runId: "run-chat",
    mode: "chat",
    providerPolicy: "codex",
    env: { EXISTING: "1" },
    runtimeOptions: {
      fallbackChain: ["codex", "chat-advisory"],
      goal: "chat goal",
    },
    factories: {
      async runtimeBacked(options) {
        calls.push(options);
        return fakeRunner;
      },
      async providerBacked() {
        throw new Error("provider-backed factory should not be called");
      },
    },
  });

  assert.equal(runner, fakeRunner);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, "/repo");
  assert.equal(calls[0].runId, "run-chat");
  assert.equal(calls[0].runtimePolicy, "codex");
  assert.deepEqual(calls[0].fallbackChain, ["codex", "chat-advisory"]);
  assert.equal(calls[0].goal, "chat goal");
  assert.deepEqual(calls[0].env, { EXISTING: "1", OMK_RUN_ID: "run-chat" });
});

test("createHarnessTaskRunner uses provider-backed runner for parallel mode", async () => {
  const calls = [];
  const runner = await createHarnessTaskRunner({
    root: "/repo",
    runId: "run-parallel",
    mode: "parallel",
    providerPolicy: "auto",
    env: { OMK_FLOW: "parallel" },
    providerOptions: {
      agentFile: "/repo/.omk/agent.md",
      promptPrefix: "prefix",
      mcpScope: "none",
      skillsScope: "project",
      hooksScope: "all",
      mcpNames: ["omk-project"],
      skillNames: ["omk-typescript-strict"],
      hookNames: ["preflight"],
      toolNames: ["ctx_read"],
      model: "provider-model",
      eventRunDir: "/repo/.omk/runs/run-parallel",
      deepseekPromptPrefix: "deepseek",
      allowDeepSeekAdvisoryFileNodes: true,
      fallbackChain: ["mimo", "codex"],
    },
    factories: {
      async runtimeBacked() {
        throw new Error("runtime-backed factory should not be called");
      },
      async providerBacked(options) {
        calls.push(options);
        return fakeRunner;
      },
    },
  });

  assert.equal(runner, fakeRunner);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, "/repo");
  assert.equal(calls[0].providerPolicy, "auto");
  assert.equal(calls[0].eventRunDir, "/repo/.omk/runs/run-parallel");
  assert.equal(calls[0].deepseekPromptPrefix, "deepseek");
  assert.equal(calls[0].allowDeepSeekAdvisoryFileNodes, true);
  assert.deepEqual(calls[0].fallbackChain, ["mimo", "codex"]);
  assert.deepEqual(calls[0].kimi, {
    cwd: "/repo",
    timeout: 0,
    agentFile: "/repo/.omk/agent.md",
    promptPrefix: "prefix",
    mcpScope: "none",
    skillsScope: "project",
    hooksScope: "all",
    roleAgentFiles: true,
    mcpNames: ["omk-project"],
    skillNames: ["omk-typescript-strict"],
    hookNames: ["preflight"],
    toolNames: ["ctx_read"],
    env: {
      OMK_FLOW: "parallel",
      OMK_RUN_ID: "run-parallel",
      OMK_PROVIDER_MODEL: "provider-model",
    },
  });
});

test("createHarnessTaskRunner lets useRuntimeBacked override parallel mode", async () => {
  const calls = [];
  await createHarnessTaskRunner({
    root: "/repo",
    runId: "run-forced",
    mode: "parallel",
    providerPolicy: "mimo",
    useRuntimeBacked: true,
    factories: {
      async runtimeBacked(options) {
        calls.push(options);
        return fakeRunner;
      },
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].runtimePolicy, "mimo");
});

test("createHarnessTaskRunner merges provider-backed kimi env before harness env", async () => {
  const calls = [];
  await createHarnessTaskRunner({
    root: "/repo",
    runId: "run-env",
    mode: "parallel",
    providerPolicy: "auto",
    env: {
      BASE_ONLY: "base",
      SHARED: "harness",
    },
    providerOptions: {
      model: "preferred-model",
      providerBackedOptions: {
        kimi: {
          cwd: "/ignored",
          timeout: 123,
          env: {
            KIMI_ONLY: "kimi",
            SHARED: "kimi",
            OMK_RUN_ID: "stale-run",
            OMK_PROVIDER_MODEL: "stale-model",
          },
        },
      },
    },
    factories: {
      async providerBacked(options) {
        calls.push(options);
        return fakeRunner;
      },
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].kimi.cwd, "/ignored");
  assert.equal(calls[0].kimi.timeout, 123);
  assert.deepEqual(calls[0].kimi.env, {
    KIMI_ONLY: "kimi",
    SHARED: "harness",
    OMK_RUN_ID: "run-env",
    OMK_PROVIDER_MODEL: "preferred-model",
    BASE_ONLY: "base",
  });
});
