import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";

const { ensureChatStartupArtifacts, formatChatStartupDate } = await import("../dist/util/chat-startup.js");
const { shouldUseDirectKimiFallback } = await import("../dist/commands/chat/runtime.js");
const CLI = join(process.cwd(), "dist", "cli.js");

async function createFakeKimi(binRoot, scriptBody) {
  const jsPath = join(binRoot, "kimi.mjs");
  await writeFile(jsPath, scriptBody, "utf-8");
  if (process.platform === "win32") {
    const cmdPath = join(binRoot, "kimi.cmd");
    await writeFile(cmdPath, `@echo off\r\n"${process.execPath}" "${jsPath}" %*\r\n`, "utf-8");
    return cmdPath;
  }
  const binPath = join(binRoot, "kimi");
  await writeFile(binPath, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(jsPath)} "$@"\n`, "utf-8");
  await chmod(binPath, 0o755);
  return binPath;
}

test("chat startup creates dated docs and local ontology graph", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-chat-startup-"));
  const now = new Date("2026-05-05T12:00:00");
  const date = formatChatStartupDate(now);

  try {
    const report = await ensureChatStartupArtifacts({
      root: projectRoot,
      runId: "chat-bootstrap-test",
      now,
      env: { OMK_MEMORY_FORCE: "0" },
    });

    assert.equal(date, "2026-05-05");
    assert.ok(report.created.includes(`docs/${date}/plan.md`));
    assert.equal(existsSync(join(projectRoot, "docs", date, "improvements.md")), true);
    assert.equal(existsSync(join(projectRoot, "docs", date, "critical-issues.md")), true);
    assert.equal(existsSync(join(projectRoot, "docs", date, "init-checklist.md")), true);

    const graphPath = join(projectRoot, ".omk", "memory", "graph-state.json");
    assert.equal(existsSync(graphPath), true);
    const graph = JSON.parse(await readFile(graphPath, "utf-8"));
    assert.equal(graph.ontology.version, "omk-ontology-mindmap-v1");
    assert.ok(
      graph.nodes.some((node) => node.type === "Memory" && node.path === `daily/${date}/plan.md`),
      "daily plan should be indexed in the ontology graph"
    );

    const checklist = await readFile(join(projectRoot, "docs", date, "init-checklist.md"), "utf-8");
    assert.match(checklist, /Required Init Checklist/);
    assert.match(checklist, /graph-state\.json/);
    assert.match(await readFile(report.memoryRecallPath, "utf-8"), /Memory Recall Summary/);
    const recall = JSON.parse(await readFile(report.memoryRecallJsonPath, "utf-8"));
    assert.equal(recall.runId, "chat-bootstrap-test");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("chat startup is idempotent and does not overwrite daily docs", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-chat-startup-idempotent-"));
  const now = new Date("2026-05-05T12:00:00");
  const date = formatChatStartupDate(now);
  const planPath = join(projectRoot, "docs", date, "plan.md");

  try {
    await ensureChatStartupArtifacts({
      root: projectRoot,
      runId: "chat-bootstrap-test",
      now,
      env: { OMK_MEMORY_FORCE: "0" },
    });
    await writeFile(planPath, "# User edited plan\n", "utf-8");

    const second = await ensureChatStartupArtifacts({
      root: projectRoot,
      runId: "chat-bootstrap-test-2",
      now,
      env: { OMK_MEMORY_FORCE: "0" },
    });

    assert.equal(await readFile(planPath, "utf-8"), "# User edited plan\n");
    assert.ok(second.existing.includes(`docs/${date}/plan.md`));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("chat command fails loudly when Kimi exits immediately with code 0", {
  skip: process.platform === "linux" ? false : "native node-pty fake-shell startup classification is covered on Linux",
}, async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-chat-fast-exit-project-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-chat-fast-exit-home-"));
  const binRoot = await mkdtemp(join(tmpdir(), "omk-chat-fast-exit-bin-"));
  const runId = "immediate-exit";

  try {
    await mkdir(binRoot, { recursive: true });
    const kimiBin = await createFakeKimi(binRoot, [
      `console.log("fake kimi started");`,
      `process.exit(0);`,
      ``,
    ].join("\n"));

    const result = spawnSync(process.execPath, [CLI, "chat", "--layout", "plain", "--brand", "plain", "--run-id", runId], {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: 20000,
      env: {
        ...process.env,
        HOME: homeRoot,
        OMK_ORIGINAL_HOME: homeRoot,
        OMK_PROJECT_ROOT: projectRoot,
        OMK_MCP_SCOPE: "",
        OMK_SKILLS_SCOPE: "",
        OMK_HOOKS_SCOPE: "",
        OMK_MCP_SUPPRESS_PRUNE_WARNINGS: "1",
        OMK_RENDER_LOGO: "0",
        OMK_STAR_PROMPT: "0",
        OMK_CHAT_NO_BANNER: "1",
        OMK_CHAT_FAST_EXIT_MS: "5000",
        OMK_LEGACY_CHAT: "1",
        KIMI_BIN: kimiBin,
      },
    });

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /Kimi exited immediately/i);
    assert.match(result.stderr, /resume: omk chat --run-id immediate-exit/);

    const state = JSON.parse(await readFile(join(projectRoot, ".omk", "runs", runId, "state.json"), "utf-8"));
    assert.equal(state.status, "failed");
    assert.equal(state.nodes[0].status, "failed");

    const session = JSON.parse(await readFile(join(projectRoot, ".omk", "runs", runId, "session.json"), "utf-8"));
    assert.equal(session.status, "failed");

    const failure = JSON.parse(await readFile(join(projectRoot, ".omk", "runs", runId, "chat-startup-failure.json"), "utf-8"));
    assert.equal(failure.runId, runId);
    assert.equal(failure.exitCode, 1);
    assert.equal(failure.mcpScope, "project");
    assert.match(failure.recentOutput, /fake kimi started/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(homeRoot, { recursive: true, force: true });
    await rm(binRoot, { recursive: true, force: true });
  }
});

test("chat command startup watchdog fails a silent Kimi launch", {
  skip: process.platform === "linux" ? false : "native node-pty fake-shell startup classification is covered on Linux",
}, async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-chat-silent-project-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-chat-silent-home-"));
  const binRoot = await mkdtemp(join(tmpdir(), "omk-chat-silent-bin-"));
  const runId = "silent-startup";

  try {
    await mkdir(binRoot, { recursive: true });
    const kimiBin = await createFakeKimi(binRoot, [
      `setInterval(() => {}, 1000);`,
      ``,
    ].join("\n"));

    const result = spawnSync(process.execPath, [CLI, "chat", "--layout", "plain", "--brand", "plain", "--run-id", runId], {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: 20000,
      env: {
        ...process.env,
        HOME: homeRoot,
        OMK_ORIGINAL_HOME: homeRoot,
        OMK_PROJECT_ROOT: projectRoot,
        OMK_MCP_SCOPE: "",
        OMK_SKILLS_SCOPE: "",
        OMK_HOOKS_SCOPE: "",
        OMK_MCP_SUPPRESS_PRUNE_WARNINGS: "1",
        OMK_RENDER_LOGO: "0",
        OMK_STAR_PROMPT: "0",
        OMK_CHAT_NO_BANNER: "1",
        OMK_CHAT_STARTUP_TIMEOUT_MS: "1000",
        OMK_LEGACY_CHAT: "1",
        KIMI_BIN: kimiBin,
      },
    });

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /Kimi startup timed out after 1000ms/);
    const failure = JSON.parse(await readFile(join(projectRoot, ".omk", "runs", runId, "chat-startup-failure.json"), "utf-8"));
    assert.equal(failure.runId, runId);
    assert.equal(failure.exitCode, 1);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(homeRoot, { recursive: true, force: true });
    await rm(binRoot, { recursive: true, force: true });
  }
});

test("chat command fails preflight before launching Kimi when agent YAML schema is invalid", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-chat-invalid-agent-project-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-chat-invalid-agent-home-"));
  const binRoot = await mkdtemp(join(tmpdir(), "omk-chat-invalid-agent-bin-"));
  const markerPath = join(projectRoot, "kimi-launched.marker");
  const runId = "invalid-agent-yaml";

  try {
    await mkdir(join(projectRoot, ".omk", "agents", "roles"), { recursive: true });
    await mkdir(join(projectRoot, ".omk", "prompts"), { recursive: true });
    await mkdir(join(projectRoot, ".kimi"), { recursive: true });
    await mkdir(join(homeRoot, ".kimi"), { recursive: true });
    await mkdir(binRoot, { recursive: true });
    const kimiBin = await createFakeKimi(binRoot, [
      `if (process.argv[2] === "--version") {`,
      `  console.log("kimi 1.0.0");`,
      `  process.exit(0);`,
      `}`,
      `require("fs").writeFileSync(${JSON.stringify(markerPath)}, "launched");`,
      `process.exit(0);`,
      ``,
    ].join("\n"));
    await writeFile(join(homeRoot, ".kimi", "config.toml"), "default_model = \"kimi-k2.6\"\n", "utf-8");
    await writeFile(join(projectRoot, ".kimi", "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf-8");
    await writeFile(join(projectRoot, ".omk", "prompts", "root.md"), "# Root\n", "utf-8");
    await writeFile(join(projectRoot, ".omk", "agents", "okabe.yaml"), [
      "version: 1",
      "agent:",
      "  extend: default",
      "  name: okabe",
      "  system_prompt_args:",
      "    OMK_MCP_ENABLED: \"true\"",
      "    OMK_SKILLS_ENABLED: \"true\"",
      "    OMK_HOOKS_ENABLED: \"true\"",
      "",
    ].join("\n"), "utf-8");
    await writeFile(join(projectRoot, ".omk", "agents", "root.yaml"), [
      "version: 1",
      "agent:",
      "  extend: ./okabe.yaml",
      "  name: omk-root",
      "  system_prompt_path: ../prompts/root.md",
      "  system_prompt_args:",
      "    OMK_ROLE: \"root-coordinator\"",
      "    OMK_MCP_ENABLED: \"true\"",
      "    OMK_SKILLS_ENABLED: \"true\"",
      "    OMK_HOOKS_ENABLED: \"true\"",
      "    OMK_MAX_WORKERS: 4",
      "",
    ].join("\n"), "utf-8");

    const result = spawnSync(process.execPath, [CLI, "chat", "--layout", "plain", "--brand", "plain", "--run-id", runId], {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: 20000,
      env: {
        ...process.env,
        HOME: homeRoot,
        OMK_ORIGINAL_HOME: homeRoot,
        OMK_PROJECT_ROOT: projectRoot,
        OMK_RENDER_LOGO: "0",
        OMK_STAR_PROMPT: "0",
        OMK_CHAT_NO_BANNER: "1",
        KIMI_BIN: kimiBin,
      },
    });

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr + result.stdout, /invalid agent YAML schema/i);
    assert.match(result.stderr + result.stdout, /OMK_MAX_WORKERS must be a string/);
    assert.match(result.stderr + result.stdout, /omk doctor --fix/);
    assert.equal(existsSync(markerPath), false, "Kimi should not launch when agent YAML preflight fails");

    const failure = JSON.parse(await readFile(join(projectRoot, ".omk", "runs", runId, "chat-startup-failure.json"), "utf-8"));
    assert.equal(failure.reason.includes("invalid agent YAML schema"), true);
    assert.ok(failure.schemaIssues.some((item) => /OMK_MAX_WORKERS must be a string/.test(item)));
    assert.ok(failure.schemaIssues.some((item) => /missing canonical subagent aliases/.test(item)));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(homeRoot, { recursive: true, force: true });
    await rm(binRoot, { recursive: true, force: true });
  }
});

test("chat smoke validates startup without launching Kimi", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-chat-smoke-project-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-chat-smoke-home-"));
  const binRoot = await mkdtemp(join(tmpdir(), "omk-chat-smoke-bin-"));
  const markerPath = join(projectRoot, "kimi-launched.marker");
  const runId = "chat-smoke";

  try {
    await mkdir(binRoot, { recursive: true });
    const kimiBin = await createFakeKimi(binRoot, [
      `if (process.argv[2] === "--version") {`,
      `  console.log("kimi 1.0.0");`,
      `  process.exit(0);`,
      `}`,
      `require("fs").writeFileSync(${JSON.stringify(markerPath)}, "launched");`,
      `process.exit(0);`,
      ``,
    ].join("\n"));

    const env = {
      ...process.env,
      HOME: homeRoot,
      OMK_ORIGINAL_HOME: homeRoot,
      OMK_PROJECT_ROOT: projectRoot,
      OMK_RENDER_LOGO: "0",
      OMK_STAR_PROMPT: "0",
      OMK_CHAT_NO_BANNER: "1",
      OMK_MCP_SUPPRESS_PRUNE_WARNINGS: "",
      OMK_UPDATE_PROMPT: "force",
      OMK_MCP_SCOPE: "project",
      KIMI_BIN: kimiBin,
    };

    const init = spawnSync(process.execPath, [CLI, "init"], {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: 30000,
      env,
    });
    assert.equal(init.status, 0, init.stderr || init.stdout);
    await writeFile(join(projectRoot, ".kimi", "mcp.json"), JSON.stringify({
      mcpServers: { "smoke-noop": { url: "http://127.0.0.1:9/mcp" } },
    }), "utf-8");

    const result = spawnSync(process.execPath, [
      CLI,
      "chat",
      "--smoke",
      "--json",
      "--layout",
      "plain",
      "--brand",
      "plain",
      "--run-id",
      runId,
    ], {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: 30000,
      env,
    });

    if (result.status !== 0) {
      console.log("=== chat smoke stdout ===");
      console.log(result.stdout);
      console.log("=== chat smoke stderr ===");
      console.log(result.stderr);
      console.log("=== chat smoke env (relevant) ===");
      console.log({ HOME: env.HOME, OMK_PROJECT_ROOT: env.OMK_PROJECT_ROOT });
    }
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(existsSync(markerPath), false, "Kimi should not launch during chat smoke");
    assert.doesNotMatch(result.stdout + result.stderr, /New OMK version available|Update now|npm i -g open-multi-agent-kit/);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.command, "chat smoke");
    assert.equal(report.schemaOk, true);
    assert.equal(report.runtimeMcpConfig.injected, true);
    assert.equal(report.runtimeMcpConfig.exists, true);
    assert.equal(report.startupFailureArtifactExists, false);
    assert.match(report.agentFile.replace(/\\/g, "/"), /\.omk\/runs\/chat-smoke\/chat-agent\.yaml$/);
    const harness = JSON.parse(await readFile(join(projectRoot, ".omk", "runs", runId, "chat-agent-harness.json"), "utf-8"));
    assert.equal(harness.virtualDag.flow, "chat-agent-parallel-harness");
    assert.equal(harness.resources.providerPolicy, "auto");
    assert.equal(harness.resources.scopes.mcp, "project");
    assert.equal(harness.memoryRecall.requiredBeforePlanning, true);
    assert.ok(harness.virtualDag.nodes.some((node) => node.id === "root-coordinator" && node.required === true));
    assert.ok(harness.virtualDag.nodes.some((node) => node.id === "review-merge" && node.required === true));
    assert.ok(harness.virtualDag.failurePolicy.blockingLanes.includes("root-coordinator"));
    assert.ok(harness.authority.some((line) => /kimi is the configured OMK authority provider/.test(line)));
    assert.equal(harness.authority.some((line) => /Kimi\/OMK chat owns edits/.test(line)), false);
    assert.match(await readFile(join(projectRoot, ".omk", "runs", runId, "memory-recall-summary.md"), "utf-8"), /Memory Recall Summary/);
    assert.equal(existsSync(join(projectRoot, ".omk", "runs", runId, "chat-startup-failure.json")), false);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(homeRoot, { recursive: true, force: true });
    await rm(binRoot, { recursive: true, force: true });
  }
});

test("chat smoke report exposes sanitized tool-plane diagnostics", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-chat-smoke-mcp-diagnostics-project-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-chat-smoke-mcp-diagnostics-home-"));
  const binRoot = await mkdtemp(join(tmpdir(), "omk-chat-smoke-mcp-diagnostics-bin-"));
  const markerPath = join(projectRoot, "kimi-launched.marker");
  const runId = "chat-smoke-mcp-diagnostics";

  try {
    await mkdir(binRoot, { recursive: true });
    const kimiBin = await createFakeKimi(binRoot, [
      `if (process.argv[2] === "--version") {`,
      `  console.log("kimi 1.0.0");`,
      `  process.exit(0);`,
      `}`,
      `require("fs").writeFileSync(${JSON.stringify(markerPath)}, "launched");`,
      `process.exit(0);`,
      ``,
    ].join("\n"));

    const env = {
      ...process.env,
      HOME: homeRoot,
      OMK_ORIGINAL_HOME: homeRoot,
      OMK_PROJECT_ROOT: projectRoot,
      OMK_RENDER_LOGO: "0",
      OMK_STAR_PROMPT: "0",
      OMK_CHAT_NO_BANNER: "1",
      OMK_MCP_SUPPRESS_PRUNE_WARNINGS: "",
      OMK_UPDATE_PROMPT: "force",
      OMK_MCP_SCOPE: "project",
      OMK_MCP_PREFLIGHT: "off",
      KIMI_BIN: kimiBin,
    };

    const init = spawnSync(process.execPath, [CLI, "init"], {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: 30000,
      env,
    });
    assert.equal(init.status, 0, init.stderr || init.stdout);
    await writeFile(join(projectRoot, ".kimi", "mcp.json"), '{"mcpServers":{"github":{"env":{"TOKEN":"sk-proj-secret', "utf-8");

    const result = spawnSync(process.execPath, [
      CLI,
      "chat",
      "--smoke",
      "--json",
      "--layout",
      "plain",
      "--brand",
      "plain",
      "--run-id",
      runId,
    ], {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: 30000,
      env,
    });

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(existsSync(markerPath), false, "Kimi should not launch during chat smoke");
    assert.doesNotMatch(result.stdout + result.stderr, /sk-proj-secret|github/);

    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.deepEqual(report.diagnostics.toolPlane, [
      {
        level: "error",
        code: "mcp_config_parse_failed",
        path: ".kimi/mcp.json",
        message: "invalid JSON",
      },
    ]);
    assert.ok(report.checks.some((check) =>
      check.name === "tool-plane diagnostics"
      && check.status === "fail"
      && check.message === "1 error(s), 0 warning(s)"
    ));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(homeRoot, { recursive: true, force: true });
    await rm(binRoot, { recursive: true, force: true });
  }
});

test("chat smoke provider auto does not require Kimi preflight", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-chat-smoke-auto-no-kimi-project-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-chat-smoke-auto-no-kimi-home-"));
  const runId = "chat-smoke-auto-no-kimi";

  try {
    const env = {
      ...process.env,
      HOME: homeRoot,
      OMK_ORIGINAL_HOME: homeRoot,
      OMK_PROJECT_ROOT: projectRoot,
      OMK_RENDER_LOGO: "0",
      OMK_STAR_PROMPT: "0",
      OMK_CHAT_NO_BANNER: "1",
      OMK_UPDATE_PROMPT: "off",
      OMK_MCP_SCOPE: "project",
      KIMI_BIN: join(projectRoot, "missing-kimi"),
    };

    const init = spawnSync(process.execPath, [CLI, "init"], {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: 30000,
      env,
    });
    assert.equal(init.status, 0, init.stderr || init.stdout);

    const result = spawnSync(process.execPath, [
      CLI,
      "chat",
      "--smoke",
      "--json",
      "--provider",
      "auto",
      "--layout",
      "plain",
      "--brand",
      "plain",
      "--run-id",
      runId,
    ], {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: 30000,
      env,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.doesNotMatch(result.stderr, /command not found|Install the primary CLI/i);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    const harness = JSON.parse(await readFile(join(projectRoot, ".omk", "runs", runId, "chat-agent-harness.json"), "utf-8"));
    assert.equal(harness.resources.providerPolicy, "auto");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(homeRoot, { recursive: true, force: true });
  }
});

test("chat runtime direct Kimi fallback requires explicit Kimi policy or legacy opt-in", () => {
  assert.equal(shouldUseDirectKimiFallback("auto", {}), false);
  assert.equal(shouldUseDirectKimiFallback("qwen", {}), false);
  assert.equal(shouldUseDirectKimiFallback("kimi", {}), false);
  assert.equal(shouldUseDirectKimiFallback("kimi", { OMK_LEGACY_CHAT: "1" }), true);
  assert.equal(shouldUseDirectKimiFallback("auto", { OMK_LEGACY_CHAT: "1" }), true);
});

test("chat smoke prefers current shell cwd over stale OMK_PROJECT_ROOT", async () => {
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-chat-cwd-home-"));
  const projectRoot = join(homeRoot, "work", "actual-project");
  const staleRoot = join(homeRoot, "stale", "old-project");
  const binRoot = await mkdtemp(join(tmpdir(), "omk-chat-cwd-bin-"));
  const runId = "chat-cwd-root";

  try {
    await mkdir(projectRoot, { recursive: true });
    await mkdir(staleRoot, { recursive: true });
    await mkdir(binRoot, { recursive: true });
    const kimiBin = await createFakeKimi(binRoot, [
      `if (process.argv[2] === "--version") {`,
      `  console.log("kimi 1.0.0");`,
      `  process.exit(0);`,
      `}`,
      `process.exit(0);`,
      ``,
    ].join("\n"));

    const initEnv = {
      ...process.env,
      HOME: homeRoot,
      OMK_ORIGINAL_HOME: homeRoot,
      OMK_PROJECT_ROOT: projectRoot,
      OMK_RENDER_LOGO: "0",
      OMK_STAR_PROMPT: "0",
      OMK_CHAT_NO_BANNER: "1",
      KIMI_BIN: kimiBin,
      OMK_MCP_SUPPRESS_PRUNE_WARNINGS: "",
    };
    const init = spawnSync(process.execPath, [CLI, "init"], {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: 30000,
      env: initEnv,
    });
    assert.equal(init.status, 0, init.stderr || init.stdout);

    const result = spawnSync(process.execPath, [
      CLI,
      "chat",
      "--smoke",
      "--json",
      "--layout",
      "plain",
      "--brand",
      "plain",
      "--run-id",
      runId,
    ], {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: 30000,
      env: {
        ...initEnv,
        OMK_PROJECT_ROOT: staleRoot,
        OMK_DEFAULT_PROJECT_ROOT: staleRoot,
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.root.path, projectRoot);
    assert.equal(report.root.cwd, projectRoot);
    assert.equal(report.root.source, "strong-marker");
    assert.equal(existsSync(join(projectRoot, ".omk", "runs", runId)), true);
    assert.equal(existsSync(join(staleRoot, ".omk", "runs", runId)), false);
  } finally {
    await rm(homeRoot, { recursive: true, force: true });
    await rm(binRoot, { recursive: true, force: true });
  }
});

test("chat smoke respects OMK_PROJECT_ROOT only when explicitly allowed", async () => {
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-chat-respect-env-home-"));
  const cwdRoot = join(homeRoot, "work", "cwd-project");
  const envRoot = join(homeRoot, "work", "env-project");
  const binRoot = await mkdtemp(join(tmpdir(), "omk-chat-respect-env-bin-"));
  const runId = "chat-respect-env-root";

  try {
    await mkdir(cwdRoot, { recursive: true });
    await mkdir(envRoot, { recursive: true });
    await mkdir(binRoot, { recursive: true });
    const kimiBin = await createFakeKimi(binRoot, [
      `if (process.argv[2] === "--version") {`,
      `  console.log("kimi 1.0.0");`,
      `  process.exit(0);`,
      `}`,
      `process.exit(0);`,
      ``,
    ].join("\n"));

    const initEnv = {
      ...process.env,
      HOME: homeRoot,
      OMK_ORIGINAL_HOME: homeRoot,
      OMK_PROJECT_ROOT: envRoot,
      OMK_RENDER_LOGO: "0",
      OMK_STAR_PROMPT: "0",
      OMK_CHAT_NO_BANNER: "1",
      KIMI_BIN: kimiBin,
      OMK_MCP_SUPPRESS_PRUNE_WARNINGS: "",
    };
    const init = spawnSync(process.execPath, [CLI, "init"], {
      cwd: envRoot,
      encoding: "utf-8",
      timeout: 30000,
      env: initEnv,
    });
    assert.equal(init.status, 0, init.stderr || init.stdout);

    const result = spawnSync(process.execPath, [
      CLI,
      "chat",
      "--smoke",
      "--json",
      "--layout",
      "plain",
      "--brand",
      "plain",
      "--provider",
      "auto",
      "--run-id",
      runId,
    ], {
      cwd: cwdRoot,
      encoding: "utf-8",
      timeout: 30000,
      env: {
        ...initEnv,
        KIMI_BIN: "/nonexistent/kimi",
        OMK_MCP_PREFLIGHT: "off",
        OMK_PROJECT_ROOT: envRoot,
        OMK_CHAT_RESPECT_PROJECT_ROOT_ENV: "1",
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.root.path, envRoot);
    assert.equal(report.root.cwd, cwdRoot);
    assert.equal(report.root.source, "env");
    assert.equal(existsSync(join(envRoot, ".omk", "runs", runId)), true);
    assert.equal(existsSync(join(cwdRoot, ".omk", "runs", runId)), false);
  } finally {
    await rm(homeRoot, { recursive: true, force: true });
    await rm(binRoot, { recursive: true, force: true });
  }
});

test("chat smoke uses OMK_DEFAULT_PROJECT_ROOT when launched from HOME git repo", async () => {
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-chat-home-git-"));
  const projectRoot = join(homeRoot, "work", "open_multi-agent_kit");
  const binRoot = await mkdtemp(join(tmpdir(), "omk-chat-home-git-bin-"));
  const runId = "chat-home-default";
  const markerPath = join(projectRoot, "kimi-launched.marker");

  try {
    const git = spawnSync("git", ["init"], { cwd: homeRoot, encoding: "utf-8" });
    assert.equal(git.status, 0, git.stderr || git.stdout);
    await mkdir(projectRoot, { recursive: true });
    await mkdir(binRoot, { recursive: true });
    const kimiBin = await createFakeKimi(binRoot, [
      `if (process.argv[2] === "--version") {`,
      `  console.log("kimi 1.0.0");`,
      `  process.exit(0);`,
      `}`,
      `require("fs").writeFileSync(${JSON.stringify(markerPath)}, "launched");`,
      `process.exit(0);`,
      ``,
    ].join("\n"));

    const initEnv = {
      ...process.env,
      HOME: homeRoot,
      OMK_ORIGINAL_HOME: homeRoot,
      OMK_PROJECT_ROOT: projectRoot,
      OMK_RENDER_LOGO: "0",
      OMK_STAR_PROMPT: "0",
      OMK_CHAT_NO_BANNER: "1",
      KIMI_BIN: kimiBin,
      OMK_MCP_SUPPRESS_PRUNE_WARNINGS: "",
    };
    const init = spawnSync(process.execPath, [CLI, "init"], {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: 30000,
      env: initEnv,
    });
    assert.equal(init.status, 0, init.stderr || init.stdout);
    await writeFile(join(projectRoot, ".kimi", "mcp.json"), JSON.stringify({
      mcpServers: { "smoke-noop": { url: "http://127.0.0.1:9/mcp" } },
    }), "utf-8");

    const chatEnv = {
      ...initEnv,
      OMK_DEFAULT_PROJECT_ROOT: projectRoot,
    };
    delete chatEnv.OMK_PROJECT_ROOT;

    const result = spawnSync(process.execPath, [
      CLI,
      "chat",
      "--smoke",
      "--json",
      "--layout",
      "plain",
      "--brand",
      "plain",
      "--run-id",
      runId,
    ], {
      cwd: homeRoot,
      encoding: "utf-8",
      timeout: 30000,
      env: chatEnv,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(existsSync(markerPath), false, "Kimi should not launch during chat smoke");
    assert.equal(existsSync(join(projectRoot, ".omk", "runs", runId)), true);
    assert.equal(existsSync(join(homeRoot, ".omk", "runs", runId)), false);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.root.path, projectRoot);
    assert.equal(report.root.cwd, homeRoot);
    assert.equal(report.root.source, "default-env");
  } finally {
    await rm(homeRoot, { recursive: true, force: true });
    await rm(binRoot, { recursive: true, force: true });
  }
});

test("chat refuses HOME git repo without explicit project root", async () => {
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-chat-home-block-"));
  try {
    const git = spawnSync("git", ["init"], { cwd: homeRoot, encoding: "utf-8" });
    assert.equal(git.status, 0, git.stderr || git.stdout);

    const result = spawnSync(process.execPath, [CLI, "chat", "--smoke", "--json"], {
      cwd: homeRoot,
      encoding: "utf-8",
      timeout: 30000,
      env: {
        ...process.env,
        HOME: homeRoot,
        OMK_ORIGINAL_HOME: homeRoot,
        OMK_RENDER_LOGO: "0",
        OMK_STAR_PROMPT: "0",
        OMK_CHAT_NO_BANNER: "1",
        OMK_PROJECT_ROOT: "",
        OMK_DEFAULT_PROJECT_ROOT: "",
      },
    });

    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.match(report.error, /Refusing to start chat from HOME/);
  } finally {
    await rm(homeRoot, { recursive: true, force: true });
  }
});
