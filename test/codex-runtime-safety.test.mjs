import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { CodexRuntime } = await import("../dist/runtime/codex-runtime.js");
const { DeepSeekRuntime } = await import("../dist/runtime/deepseek-runtime.js");
const { createCodexCliAdvisoryTaskRunner } = await import("../dist/providers/codex-cli-runner.js");

async function fakeCodexBin(dir) {
  const capturePath = join(dir, "capture.json");
  const scriptPath = join(dir, "fake-codex.mjs");
  await writeFile(scriptPath, `
import { writeFileSync } from "node:fs";
let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;
writeFileSync(process.env.OMK_CAPTURE_PATH, JSON.stringify({
  argv: process.argv.slice(2),
  env: {
    OMK_APPROVAL_POLICY: process.env.OMK_APPROVAL_POLICY,
    OMK_SANDBOX_MODE: process.env.OMK_SANDBOX_MODE,
    OMK_TASK_RISK: process.env.OMK_TASK_RISK,
    OMK_PROVIDER_MODEL: process.env.OMK_PROVIDER_MODEL,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? null,
    AWS_REGION: process.env.AWS_REGION ?? null,
    DOTENV_CONFIG_PATH: process.env.DOTENV_CONFIG_PATH ?? null
  },
  stdin
}));
process.stdout.write("ok");
`);
  if (process.platform === "win32") {
    const cmdPath = join(dir, "codex.cmd");
    await writeFile(cmdPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
    return { bin: cmdPath, capturePath };
  }
  const binPath = join(dir, "codex");
  await writeFile(binPath, `#!/usr/bin/env sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`);
  await chmod(binPath, 0o755);
  return { bin: binPath, capturePath };
}

test("CodexRuntime propagates ask approval and read-only sandbox", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omk-codex-runtime-"));
  const { bin, capturePath } = await fakeCodexBin(dir);
  const runtime = new CodexRuntime({ bin, cwd: dir });

  const result = await runtime.execute({
    prompt: "summarize only",
    context: {
      runId: "run-codex-safety",
      nodeId: "node-read",
      role: "reviewer",
      goal: "safety",
      cwd: dir,
      env: {
        OMK_CAPTURE_PATH: capturePath,
        GITHUB_TOKEN: "hidden",
        AWS_REGION: "us-east-1",
        DOTENV_CONFIG_PATH: "/repo/.env",
      },
      approvalPolicy: "ask",
      sandboxMode: "read-only",
      risk: "read",
    },
    tools: { available: [] },
    providerPolicy: {
      strategy: "priority-first",
      preferredProviders: ["codex"],
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
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.metadata.sandbox, "read-only");
  assert.equal(result.metadata.approvalPolicy, "on-request");
  assert.equal(result.metadata.sandboxProfile.mode, "read-only");
  assert.equal(result.metadata.sandboxProfile.enforcement, "provider-native");
  assert.equal(result.metadata.sandboxProfile.network, "unspecified");
  assert.match(result.metadata.sandboxProfile.notes.join(" "), /does not yet enforce OS-level/);

  const capture = JSON.parse(await readFile(capturePath, "utf8"));
  assert.deepEqual(capture.argv.slice(0, 5), ["exec", "--sandbox", "read-only", "--ask-for-approval", "on-request"]);
  assert.equal(capture.env.OMK_APPROVAL_POLICY, "ask");
  assert.equal(capture.env.OMK_SANDBOX_MODE, "read-only");
  assert.equal(capture.env.OMK_TASK_RISK, "read");
  assert.equal(capture.env.GITHUB_TOKEN, null);
  assert.equal(capture.env.AWS_REGION, null);
  assert.equal(capture.env.DOTENV_CONFIG_PATH, null);
  assert.match(capture.stdin, /summarize only/);
});

test("CodexRuntime supports rejects MCP/unsupported provider capability authority", () => {
  const runtime = new CodexRuntime();

  assert.equal(runtime.supports(capsuleWithRouting({ requiresMcp: true })), false);
  assert.equal(runtime.supports(capsuleWithRouting({ assignedProviderCapabilities: ["mcp"] })), false);
  assert.equal(runtime.supports(capsuleWithRouting({ assignedProviderCapabilities: ["merge"] })), false);
  assert.equal(runtime.supports(capsuleWithRouting({ assignedProviderCapabilities: ["vision"] })), false);
  assert.equal(runtime.supports(capsuleWithRouting({ assignedProviderCapabilities: ["read", "write", "patch"] })), true);
});

test("CodexRuntime forces on-request approvals for workspace-write even when env asks for never", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omk-codex-runtime-approval-"));
  const { bin, capturePath } = await fakeCodexBin(dir);
  const runtime = new CodexRuntime({ bin, cwd: dir });

  const result = await runtime.execute({
    prompt: "write bounded patch",
    context: {
      runId: "run-codex-approval",
      nodeId: "node-write",
      role: "coder",
      goal: "approval policy",
      cwd: dir,
      env: { OMK_CAPTURE_PATH: capturePath, OMK_APPROVAL_POLICY: "never" },
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
      risk: "write",
    },
    tools: { available: [] },
    providerPolicy: {
      strategy: "priority-first",
      preferredProviders: ["codex"],
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

  assert.equal(result.exitCode, 0);
  assert.equal(result.metadata.sandbox, "workspace-write");
  assert.equal(result.metadata.approvalPolicy, "on-request");
  assert.equal(result.metadata.sandboxProfile.mode, "workspace-write");
  assert.equal(result.metadata.sandboxProfile.enforcement, "provider-native");
  assert.deepEqual(result.metadata.sandboxProfile.writableRoots, [dir]);
  const capture = JSON.parse(await readFile(capturePath, "utf8"));
  assert.deepEqual(capture.argv.slice(0, 5), ["exec", "--sandbox", "workspace-write", "--ask-for-approval", "on-request"]);
});

function capsuleWithRouting(routing = {}) {
  return {
    runId: "run-codex-supports",
    nodeId: "node-codex-supports",
    goal: "supports check",
    system: "",
    task: "check support",
    dependencySummaries: [],
    relevantFiles: [],
    graphMemory: [],
    priorAttempts: [],
    evidenceRequirements: [],
    budget: {
      maxInputTokens: 1000,
      reservedOutputTokens: 1000,
      maxFileTokens: 1000,
      maxToolResultTokens: 1000,
      maxMemoryFacts: 1,
      compression: "normal",
    },
    node: {
      id: "node-codex-supports",
      name: "check support",
      role: "tester",
      dependsOn: [],
      status: "pending",
      retries: 0,
      maxRetries: 1,
      routing,
    },
  };
}

test("Codex provider runner uses sanitized child env and interactive workspace-write approval", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omk-codex-runner-"));
  const { bin, capturePath } = await fakeCodexBin(dir);
  const runner = createCodexCliAdvisoryTaskRunner({ bin, cwd: dir });
  const result = await runner.run(
    {
      id: "codex-authority-node",
      name: "apply bounded patch",
      role: "coder",
      dependsOn: [],
      status: "running",
      retries: 0,
      maxRetries: 1,
      routing: { risk: "write" },
    },
    {
      OMK_CAPTURE_PATH: capturePath,
      OMK_PROVIDER_AUTHORITY: "codex",
      OMK_PROVIDER: "codex",
      OMK_GOAL: "harden child runtime",
      GITHUB_TOKEN: "hidden",
      AWS_REGION: "us-east-1",
      DOTENV_CONFIG_PATH: "/repo/.env",
    }
  );

  assert.equal(result.exitCode, 0);
  const capture = JSON.parse(await readFile(capturePath, "utf8"));
  assert.deepEqual(capture.argv.slice(0, 5), ["exec", "--sandbox", "workspace-write", "--ask-for-approval", "on-request"]);
  assert.equal(capture.env.GITHUB_TOKEN, null);
  assert.equal(capture.env.AWS_REGION, null);
  assert.equal(capture.env.DOTENV_CONFIG_PATH, null);
});

test("CodexRuntime prefers AgentContext providerModel over env and runtime defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omk-codex-runtime-model-"));
  const { bin, capturePath } = await fakeCodexBin(dir);
  const runtime = new CodexRuntime({ bin, cwd: dir, model: "runtime-default" });

  const result = await runtime.execute({
    prompt: "use selected model",
    context: {
      runId: "run-codex-model",
      nodeId: "node-model",
      role: "coder",
      goal: "model propagation",
      cwd: dir,
      env: { OMK_CAPTURE_PATH: capturePath, OMK_PROVIDER_MODEL: "env-model" },
      providerModel: "context-model",
      approvalPolicy: "ask",
      sandboxMode: "workspace-write",
      risk: "write",
    },
    tools: { available: [] },
    providerPolicy: {
      strategy: "priority-first",
      preferredProviders: ["codex"],
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

  assert.equal(result.exitCode, 0);
  const capture = JSON.parse(await readFile(capturePath, "utf8"));
  assert.deepEqual(capture.argv.slice(0, 3), ["exec", "--model", "context-model"]);
  assert.equal(capture.env.OMK_PROVIDER_MODEL, "context-model");
});

test("DeepSeekRuntime rejects write and tool authority", async () => {
  const runtime = new DeepSeekRuntime({ apiKey: "test-key" });
  assert.equal(runtime.capabilities.write, false);
  assert.equal(runtime.capabilities.patch, false);
  assert.equal(runtime.capabilities.shell, false);
  assert.equal(runtime.capabilities.mcp, false);
  assert.equal(runtime.capabilities.supportsToolCalling, false);

  const result = await runtime.execute({
    prompt: "edit the file",
    context: {
      runId: "run-deepseek-safety",
      nodeId: "node-write",
      role: "coder",
      goal: "safety",
      cwd: process.cwd(),
    },
    tools: { available: [{ name: "write_file", description: "write", inputSchema: {} }] },
    providerPolicy: {
      strategy: "priority-first",
      preferredProviders: ["deepseek"],
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
      toolCalling: true,
    },
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.metadata.authorityMode, "advisory");
  assert.match(result.metadata.error, /advisory\/read-only/);
});
