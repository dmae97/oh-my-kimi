import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildChildEnv,
  buildChildEnvWithMetadata,
  isSecretLikeEnvName,
  runtimeMetadataEnv,
} from "../dist/runtime/child-env.js";
import { runProcessSession } from "../dist/runtime/process-session.js";
import { createExternalCliAdapter } from "../dist/runtime/external-cli-adapter.js";
import { createCommandcodeCliAdapter } from "../dist/adapters/commandcode/commandcode-cli-adapter.js";
import { createOpencodeCliAdapter } from "../dist/adapters/opencode/opencode-cli-adapter.js";

test("buildChildEnv keeps safe parent env and drops unlisted secret-like names", () => {
  const env = buildChildEnv({
    parentEnv: {
      PATH: "/usr/bin",
      HOME: "/tmp/omk-home",
      SECRET_TOKEN: "hidden",
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "hidden",
      RANDOM_VALUE: "drop-me",
    },
    overrideEnv: {
      EXPLICIT_TOKEN: "caller-owned",
      GITHUB_TOKEN: "hidden",
      NPM_TOKEN: "hidden",
      DOTENV_CONFIG_PATH: "/repo/.env",
      EMPTY_VALUE: undefined,
      BAD_VALUE: "bad\0value",
    },
  });

  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/tmp/omk-home");
  assert.equal(env.SECRET_TOKEN, undefined);
  assert.equal(env.AWS_REGION, undefined);
  assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(env.RANDOM_VALUE, undefined);
  assert.equal(env.EXPLICIT_TOKEN, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.NPM_TOKEN, undefined);
  assert.equal(env.DOTENV_CONFIG_PATH, undefined);
  assert.equal(env.EMPTY_VALUE, undefined);
  assert.equal(env.BAD_VALUE, undefined);
});

test("buildChildEnv strips denied env even when inheriting parent env", () => {
  const env = buildChildEnv({
    inheritParentEnv: true,
    parentEnv: {
      PATH: "/usr/bin",
      AWS_REGION: "us-east-1",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      KUBECONFIG: "/home/user/.kube/config",
      SAFE_NONSECRET: "kept",
      GITHUB_TOKEN: "hidden",
    },
  });

  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.SAFE_NONSECRET, "kept");
  assert.equal(env.AWS_REGION, undefined);
  assert.equal(env.SSH_AUTH_SOCK, undefined);
  assert.equal(env.KUBECONFIG, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
});

test("buildChildEnv requires explicit grants for secret-like allowlist entries", () => {
  const parentEnv = {
    PATH: "/usr/bin",
    OPENAI_API_KEY: "secret-value",
    GITHUB_TOKEN: "blocked-even-when-granted",
  };

  const withoutGrant = buildChildEnv({
    parentEnv,
    allowedParentEnvNames: ["PATH", "OPENAI_API_KEY"],
  });
  assert.equal(withoutGrant.PATH, "/usr/bin");
  assert.equal(withoutGrant.OPENAI_API_KEY, undefined);

  const withGrant = buildChildEnvWithMetadata({
    parentEnv,
    allowedParentEnvNames: ["PATH", "OPENAI_API_KEY", "GITHUB_TOKEN"],
    allowedSecretEnvNames: ["OPENAI_API_KEY", "GITHUB_TOKEN"],
    allowSecretPassthrough: true,
  });
  assert.equal(withGrant.env.OPENAI_API_KEY, "secret-value");
  assert.equal(withGrant.env.GITHUB_TOKEN, undefined);
  assert.deepEqual(withGrant.metadata.grantedSecretEnvNames, ["OPENAI_API_KEY"]);
  assert.deepEqual(withGrant.metadata.deniedChildEnvNames, ["GITHUB_TOKEN"]);
  assert.deepEqual(withGrant.metadata.deniedSecretEnvNames, []);
});

test("buildChildEnv metadata records denied explicit secrets without values", () => {
  const result = buildChildEnvWithMetadata({
    parentEnv: {},
    overrideEnv: {
      EXPLICIT_TOKEN: "secret-value",
      OMK_CAPTURE_PATH: "/tmp/capture.json",
    },
  });

  assert.deepEqual(result.env, { OMK_CAPTURE_PATH: "/tmp/capture.json" });
  assert.deepEqual(result.metadata.deniedSecretEnvNames, ["EXPLICIT_TOKEN"]);
  assert.equal(JSON.stringify(result.metadata).includes("secret-value"), false);
});

test("isSecretLikeEnvName treats authorization env names as secret-like", () => {
  assert.equal(isSecretLikeEnvName("OPENAI_API_KEY"), true);
  assert.equal(isSecretLikeEnvName("AUTHORIZATION"), true);
  assert.equal(isSecretLikeEnvName("OMK_CAPTURE_PATH"), false);
});

test("runtimeMetadataEnv maps runtime session metadata", () => {
  assert.deepEqual(
    runtimeMetadataEnv({
      runtimeId: "test-runtime",
      runId: "run-1",
      nodeId: "node-1",
      role: "tester",
      goal: "verify metadata",
    }),
    {
      OMK_RUNTIME_ID: "test-runtime",
      OMK_RUN_ID: "run-1",
      OMK_NODE_ID: "node-1",
      OMK_ROLE: "tester",
      OMK_GOAL: "verify metadata",
    }
  );
});

test("runProcessSession executes with sanitized env and explicit overrides", async () => {
  const script = `
    console.log(JSON.stringify({
      secret: process.env.SECRET_TOKEN ?? null,
      random: process.env.RANDOM_VALUE ?? null,
      explicit: process.env.EXPLICIT_VALUE ?? null,
      path: process.env.PATH ?? null,
      runId: process.env.OMK_RUN_ID ?? null
    }));
  `;
  const result = await runProcessSession({
    command: process.execPath,
    args: ["--eval", script],
    parentEnv: {
      PATH: process.env.PATH ?? "",
      SECRET_TOKEN: "hidden",
      RANDOM_VALUE: "drop-me",
    },
    env: {
      EXPLICIT_VALUE: "ok",
      OMK_RUN_ID: "run-session",
    },
    timeoutMs: 10_000,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.failed, false);
  assert.equal(result.aborted, false);
  assert.ok(result.durationMs >= 0);
  const snapshot = JSON.parse(result.stdout.trim());
  assert.deepEqual(snapshot, {
    secret: null,
    random: null,
    explicit: "ok",
    path: process.env.PATH ?? "",
    runId: "run-session",
  });
});

test("runProcessSession strips secret-like explicit child runtime env", async () => {
  const script = `
    console.log(JSON.stringify({
      capture: process.env.OMK_CAPTURE_PATH ?? null,
      github: process.env.GITHUB_TOKEN ?? null,
      npm: process.env.NPM_TOKEN ?? null,
      dotenv: process.env.DOTENV_CONFIG_PATH ?? null
    }));
  `;
  const result = await runProcessSession({
    command: process.execPath,
    args: ["--eval", script],
    env: {
      OMK_CAPTURE_PATH: "/tmp/capture.json",
      GITHUB_TOKEN: "hidden",
      NPM_TOKEN: "hidden",
      DOTENV_CONFIG_PATH: "/repo/.env",
    },
    timeoutMs: 10_000,
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    capture: "/tmp/capture.json",
    github: null,
    npm: null,
    dotenv: null,
  });
});

test("runProcessSession requires explicit grant for secret passthrough", async () => {
  const script = "console.log(JSON.stringify({key: process.env.OPENAI_API_KEY ?? null}))";
  const result = await runProcessSession({
    command: process.execPath,
    args: ["--eval", script],
    parentEnv: {
      PATH: process.env.PATH ?? "",
      OPENAI_API_KEY: "granted-secret",
    },
    allowedParentEnvNames: ["PATH", "OPENAI_API_KEY"],
    allowedSecretEnvNames: ["OPENAI_API_KEY"],
    allowSecretPassthrough: true,
    timeoutMs: 10_000,
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { key: "granted-secret" });
});

test("runProcessSession sends explicit input to child stdin without argv transport", async () => {
  const marker = "private prompt marker 7f12";
  const script = `
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => {
      console.log(JSON.stringify({
        stdinHash: require("node:crypto").createHash("sha256").update(data).digest("hex"),
        argvText: process.argv.slice(2).join(" ")
      }));
    });
  `;
  const result = await runProcessSession({
    command: process.execPath,
    args: ["--eval", script],
    input: marker,
    timeoutMs: 10_000,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.failed, false);
  const snapshot = JSON.parse(result.stdout.trim());
  assert.equal(snapshot.stdinHash, sha256(marker));
  assert.equal(snapshot.argvText.includes(marker), false);
});

test("createExternalCliAdapter runs through process session with runtime metadata env", async () => {
  const adapter = createExternalCliAdapter({
    id: "test-process-cli",
    displayName: "Test Process CLI",
    bin: process.execPath,
    priority: 50,
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
    env: {
      EXPLICIT_VALUE: "adapter-env",
    },
    buildArgs() {
      return [
        "--eval",
        "console.log(JSON.stringify({runtime:process.env.OMK_RUNTIME_ID,runId:process.env.OMK_RUN_ID,nodeId:process.env.OMK_NODE_ID,role:process.env.OMK_ROLE,goal:process.env.OMK_GOAL ?? null,explicit:process.env.EXPLICIT_VALUE,risk:process.env.OMK_TASK_RISK,approval:process.env.OMK_APPROVAL_POLICY,sandbox:process.env.OMK_SANDBOX_MODE,mcp:process.env.OMK_MCP_SERVERS,skills:process.env.OMK_SKILLS,hooks:process.env.OMK_HOOKS,tools:process.env.OMK_TOOLS}))",
      ];
    },
  });
  const capsule = {
    schemaVersion: 1,
    runId: "run-external",
    nodeId: "node-external",
    goal: "verify adapter env",
    task: "execute child",
    system: "",
    node: {
      id: "node-external",
      name: "execute child",
      role: "tester",
      dependsOn: [],
      status: "running",
      retries: 0,
      maxRetries: 1,
      routing: {
        risk: "shell",
        approvalPolicy: "ask",
        sandboxMode: "workspace-write",
        mcpServers: ["omk-project"],
        skills: ["omk-typescript-strict"],
        hooks: ["secret-guard"],
        tools: ["shell"],
      },
    },
    dependencySummaries: [],
    relevantFiles: [],
    graphMemory: [],
    priorAttempts: [],
    evidenceRequirements: [],
    budget: {
      maxInputTokens: 1000,
      compression: "normal",
    },
  };

  const result = await adapter.runNode(capsule, new AbortController().signal);

  assert.equal(result.success, true);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    runtime: "test-process-cli",
    runId: "run-external",
    nodeId: "node-external",
    role: "tester",
    goal: null,
    explicit: "adapter-env",
    risk: "shell",
    approval: "ask",
    sandbox: "workspace-write",
    mcp: "omk-project",
    skills: "omk-typescript-strict",
    hooks: "secret-guard",
    tools: "shell",
  });
  assert.equal(result.metadata?.sandboxProfile.mode, "workspace-write");
  assert.equal(result.metadata?.sandboxProfile.enforcement, "env-only");
  assert.deepEqual(result.metadata?.sandboxProfile.writableRoots, []);
  assert.match(result.metadata?.sandboxProfile.notes.join(" "), /future work/);
});

test("createExternalCliAdapter execute preserves AgentTask safety and capability metadata", async () => {
  const adapter = createExternalCliAdapter({
    id: "test-execute-cli",
    displayName: "Test Execute CLI",
    bin: process.execPath,
    priority: 50,
    capabilities: {
      read: true,
      write: true,
      shell: true,
      mcp: true,
      patch: true,
      review: false,
      merge: false,
      vision: false,
    },
    buildArgs() {
      return [
        "--eval",
        `console.log(JSON.stringify({
          risk: process.env.OMK_TASK_RISK,
          approval: process.env.OMK_APPROVAL_POLICY,
          sandbox: process.env.OMK_SANDBOX_MODE,
          mcp: process.env.OMK_MCP_SERVERS,
          skills: process.env.OMK_SKILLS,
          hooks: process.env.OMK_HOOKS,
          tools: process.env.OMK_TOOLS
        }))`,
      ];
    },
  });

  const result = await adapter.execute({
    prompt: "execute metadata marker",
    context: {
      runId: "run-execute",
      nodeId: "node-execute",
      role: "worker",
      risk: "write",
      approvalPolicy: "ask",
      sandboxMode: "read-only",
    },
    tools: {
      available: [{ name: "apply_patch", description: "", inputSchema: {} }],
      mcpServers: ["omk-project"],
      skills: ["omk-typescript-strict"],
      hooks: ["secret-guard"],
    },
    providerPolicy: {
      strategy: "priority-first",
      preferredProviders: ["opencode"],
      fallbackChain: [],
    },
    capabilities: {
      read: true,
      write: true,
      shell: false,
      mcp: true,
      patch: true,
      review: false,
      merge: false,
      vision: false,
    },
  });

  assert.equal(result.exitCode, 0);
  const snapshot = JSON.parse(result.output.trim());
  assert.deepEqual(snapshot, {
    risk: "write",
    approval: "ask",
    sandbox: "read-only",
    mcp: "omk-project",
    skills: "omk-typescript-strict",
    hooks: "secret-guard",
    tools: "apply_patch",
  });
  assert.equal(result.metadata?.risk, "write");
  assert.equal(result.metadata?.approvalPolicy, "ask");
  assert.equal(result.metadata?.sandboxMode, "read-only");
  assert.equal(result.metadata?.sandboxProfile.mode, "read-only");
  assert.equal(result.metadata?.sandboxProfile.enforcement, "env-only");
  assert.equal(result.metadata?.sandboxProfile.secretEnvPolicy, "drop-by-default");
});

test("createExternalCliAdapter returns safety metadata on preflight errors", async () => {
  const adapter = createExternalCliAdapter({
    id: "test-empty-cli",
    displayName: "Test Empty CLI",
    bin: process.execPath,
    priority: 50,
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
    buildArgs() {
      return ["--eval", "console.log('should not run')"];
    },
  });

  const result = await adapter.runNode(
    capsuleFixture("empty-node", " ", "empty goal", {
      risk: "read",
      approvalPolicy: "ask",
      sandboxMode: "read-only",
    }),
    new AbortController().signal
  );

  assert.equal(result.success, false);
  assert.equal(result.metadata?.risk, "read");
  assert.equal(result.metadata?.approvalPolicy, "ask");
  assert.equal(result.metadata?.sandboxMode, "read-only");
  assert.equal(result.metadata?.sandboxProfile.enforcement, "env-only");
});

test("createExternalCliAdapter sends prompt via stdin and omits OMK_GOAL", async () => {
  const marker = "stdin prompt marker e1c9";
  const adapter = createExternalCliAdapter({
    id: "test-stdin-cli",
    displayName: "Test Stdin CLI",
    bin: process.execPath,
    priority: 50,
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
    promptTransport: "stdin",
    buildArgs() {
      return [
        "--eval",
        `
          let data = "";
          process.stdin.setEncoding("utf8");
          process.stdin.on("data", (chunk) => { data += chunk; });
          process.stdin.on("end", () => {
            console.log(JSON.stringify({
              stdinHash: require("node:crypto").createHash("sha256").update(data).digest("hex"),
              argvText: process.argv.slice(2).join(" "),
              goal: process.env.OMK_GOAL ?? null
            }));
          });
        `,
      ];
    },
  });

  const result = await adapter.runNode(
    capsuleFixture("stdin-node", marker, marker),
    new AbortController().signal
  );

  assert.equal(result.success, true);
  assert.equal(result.exitCode, 0);
  const snapshot = JSON.parse(result.stdout.trim());
  assert.equal(snapshot.stdinHash, sha256(marker));
  assert.equal(snapshot.argvText.includes(marker), false);
  assert.equal(snapshot.goal, null);
});

test("createExternalCliAdapter writes 0600 temp prompt file and cleans it up", async () => {
  const marker = "temp prompt marker 742a";
  let observedPromptFile;
  const adapter = createExternalCliAdapter({
    id: "test-tempfile-cli",
    displayName: "Test Tempfile CLI",
    bin: process.execPath,
    priority: 50,
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
    promptTransport: "tempfile",
    buildArgs(_capsule, prompt) {
      observedPromptFile = prompt.promptFile;
      return [
        "--eval",
        `
          const fs = require("node:fs");
          const crypto = require("node:crypto");
          const file = process.env.OMK_PROMPT_FILE;
          const content = fs.readFileSync(file, "utf8");
          const stat = fs.statSync(file);
          console.log(JSON.stringify({
            promptHash: crypto.createHash("sha256").update(content).digest("hex"),
            mode: (stat.mode & 0o777).toString(8),
            argvText: process.argv.slice(2).join(" "),
            envFile: file,
            goal: process.env.OMK_GOAL ?? null
          }));
        `,
      ];
    },
  });

  const result = await adapter.runNode(
    capsuleFixture("tempfile-node", marker, marker),
    new AbortController().signal
  );

  assert.equal(result.success, true);
  assert.equal(result.exitCode, 0);
  const snapshot = JSON.parse(result.stdout.trim());
  assert.equal(snapshot.promptHash, sha256(marker));
  if (process.platform === "win32") {
    assert.match(snapshot.mode, /^[0-7]{3}$/);
  } else {
    assert.equal(snapshot.mode, "600");
  }
  assert.equal(snapshot.argvText.includes(marker), false);
  assert.equal(snapshot.goal, null);
  assert.equal(snapshot.envFile, observedPromptFile);
  assert.ok(observedPromptFile);
  await assert.rejects(() => access(observedPromptFile), { code: "ENOENT" });
});

test("createExternalCliAdapter cleans temp prompt file when child fails", async () => {
  let observedPromptFile;
  const adapter = createExternalCliAdapter({
    id: "test-tempfile-fail-cli",
    displayName: "Test Tempfile Failure CLI",
    bin: process.execPath,
    priority: 50,
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
    promptTransport: "tempfile",
    buildArgs(_capsule, prompt) {
      observedPromptFile = prompt.promptFile;
      return ["--eval", "process.exit(7)"];
    },
  });

  const result = await adapter.runNode(
    capsuleFixture("tempfile-fail-node", "failing prompt"),
    new AbortController().signal
  );

  assert.equal(result.success, false);
  assert.equal(result.exitCode, 7);
  assert.ok(observedPromptFile);
  await assert.rejects(() => access(observedPromptFile), { code: "ENOENT" });
});

test("opencode and commandcode adapters keep capsule task out of argv", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "omk-adapter-cli-test-"));
  try {
    const fakeBin = join(tempDir, "capture-cli");
    await writeFile(
      fakeBin,
      `#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");
const promptFile = process.env.OMK_PROMPT_FILE;
const content = promptFile ? fs.readFileSync(promptFile, "utf8") : "";
fs.writeFileSync(process.env.OMK_CAPTURE_PATH, JSON.stringify({
  argv: process.argv.slice(2),
  promptHash: crypto.createHash("sha256").update(content).digest("hex"),
  promptFile: promptFile ?? null,
  goal: process.env.OMK_GOAL ?? null,
  risk: process.env.OMK_TASK_RISK,
  approval: process.env.OMK_APPROVAL_POLICY,
  sandbox: process.env.OMK_SANDBOX_MODE,
  mcp: process.env.OMK_MCP_SERVERS,
  skills: process.env.OMK_SKILLS,
  hooks: process.env.OMK_HOOKS,
  tools: process.env.OMK_TOOLS
}));
console.log("ok");
`
    );
    await chmod(fakeBin, 0o755);

    const marker = "adapter prompt marker 4cd2";
    const scenarios = [
      {
        name: "opencode",
        capturePath: join(tempDir, "opencode-capture.json"),
        adapter: createOpencodeCliAdapter({
          bin: fakeBin,
          env: { OMK_CAPTURE_PATH: join(tempDir, "opencode-capture.json") },
        }),
      },
      {
        name: "commandcode",
        capturePath: join(tempDir, "commandcode-capture.json"),
        adapter: createCommandcodeCliAdapter({
          bin: fakeBin,
          env: { OMK_CAPTURE_PATH: join(tempDir, "commandcode-capture.json") },
        }),
      },
    ];

    for (const scenario of scenarios) {
      const result = await scenario.adapter.runNode(
        capsuleFixture(`${scenario.name}-node`, marker, marker, {
          risk: "write",
          approvalPolicy: "ask",
          sandboxMode: "workspace-write",
          mcpServers: ["omk-project"],
          skills: ["omk-typescript-strict"],
          hooks: ["secret-guard"],
          tools: ["apply_patch"],
        }),
        new AbortController().signal
      );

      assert.equal(result.success, true, scenario.name);
      assert.equal(result.exitCode, 0, scenario.name);
      const captured = JSON.parse(await readFile(scenario.capturePath, "utf8"));
      assert.equal(captured.promptHash, sha256(marker), scenario.name);
      assert.equal(captured.argv.join(" ").includes(marker), false, scenario.name);
      if (scenario.name === "commandcode") {
        assert.equal(captured.argv.includes("--trust"), false, scenario.name);
      }
      assert.ok(captured.promptFile, scenario.name);
      assert.equal(captured.goal, null, scenario.name);
      assert.equal(captured.risk, "write", scenario.name);
      assert.equal(captured.approval, "ask", scenario.name);
      assert.equal(captured.sandbox, "workspace-write", scenario.name);
      assert.equal(captured.mcp, "omk-project", scenario.name);
      assert.equal(captured.skills, "omk-typescript-strict", scenario.name);
      assert.equal(captured.hooks, "secret-guard", scenario.name);
      assert.equal(captured.tools, "apply_patch", scenario.name);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("createExternalCliAdapter honors OMK_TURN_TIMEOUT_MS from runtime env", async () => {
  const adapter = createExternalCliAdapter({
    id: "test-timeout-cli",
    displayName: "Test Timeout CLI",
    bin: process.execPath,
    priority: 50,
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
    env: {
      OMK_TURN_TIMEOUT_MS: "50",
    },
    buildArgs() {
      return ["--eval", "setTimeout(() => console.log('late'), 500)"];
    },
  });

  const result = await adapter.runNode(capsuleFixture("timeout-node"), new AbortController().signal);

  assert.equal(result.success, false);
  assert.notEqual(result.exitCode, 0);
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function capsuleFixture(
  nodeId = "node-external",
  task = "execute child",
  goal = "verify adapter env",
  routing = {}
) {
  return {
    schemaVersion: 1,
    runId: "run-external",
    nodeId,
    goal,
    task,
    system: "",
    node: {
      id: nodeId,
      name: task,
      role: "tester",
      dependsOn: [],
      status: "running",
      retries: 0,
      maxRetries: 1,
      routing,
    },
    dependencySummaries: [],
    relevantFiles: [],
    graphMemory: [],
    priorAttempts: [],
    evidenceRequirements: [],
    budget: {
      maxInputTokens: 1000,
      compression: "normal",
    },
  };
}
