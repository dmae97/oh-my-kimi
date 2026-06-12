import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { createDag, skipNode } from "../dist/orchestration/dag.js";
import { createScheduler } from "../dist/orchestration/scheduler.js";
import { createEnsembleTaskRunner } from "../dist/orchestration/ensemble.js";
import { createExecutor } from "../dist/orchestration/executor.js";
import { estimateRunProgress } from "../dist/orchestration/eta.js";
import { renderCapabilityRoutingArtifact } from "../dist/orchestration/capability-routing.js";
import { createRoutedRunState, refreshRunStateEstimate, routeRunState, createExecutableDagFromState, buildRunGoalState } from "../dist/orchestration/run-state.js";
import { dagNodeRoutingEnv, discoverRoutingInventory, resetRoutingInventoryCache } from "../dist/orchestration/routing.js";
import { OMK_RELEASE_GUARD_PRESET } from "../dist/runtime/core-verified-preset.js";
import { collectMcpConfigs, getUserHome, injectKimiGlobals, normalizeUserHomePath, pruneRuntimeMcpServers } from "../dist/util/fs.js";
import { runShellStreaming } from "../dist/util/shell.js";
import { resetTimeoutPresetCache, resolveTimeoutMs } from "../dist/util/timeout-config.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(path, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf-8");
    } catch {
      await sleep(25);
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === "linux") {
    try {
      const statContent = await readFile(`/proc/${pid}/stat`, "utf-8");
      const state = statContent.slice(statContent.lastIndexOf(")") + 2).split(" ")[0];
      if (state === "Z") return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function waitForPidExit(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPidAlive(pid))) return;
    await sleep(50);
  }
  assert.fail(`process ${pid} is still alive`);
}

function bestEffortKill(pid) {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

async function tempWorktree() {
  return mkdtemp(join(tmpdir(), "omk-ensemble-"));
}

function toWslUncPath(absPath, distro = "Ubuntu-24.04") {
  return `\\\\wsl.localhost\\${distro}${absPath.replace(/\//g, "\\")}`;
}

async function withRoutingSkills(skills, fn) {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-routing-skills-"));
  const previousRoot = process.env.OMK_PROJECT_ROOT;
  const previousSkillsScope = process.env.OMK_SKILLS_SCOPE;
  process.env.OMK_PROJECT_ROOT = projectRoot;
  process.env.OMK_SKILLS_SCOPE = "project";
  resetRoutingInventoryCache();

  try {
    for (const skill of skills) {
      const dir = join(projectRoot, ".agents", "skills", skill);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), `# ${skill}\n`);
    }
    resetRoutingInventoryCache();
    return await fn(projectRoot);
  } finally {
    resetRoutingInventoryCache();
    restoreEnv("OMK_PROJECT_ROOT", previousRoot);
    restoreEnv("OMK_SKILLS_SCOPE", previousSkillsScope);
    await rm(projectRoot, { recursive: true, force: true });
  }
}

test("task graph returns runnable nodes in deterministic topological order", () => {
  const dag = createDag({
    nodes: [
      { id: "plan", name: "Plan", role: "planner", dependsOn: [], maxRetries: 1 },
      { id: "code", name: "Code", role: "coder", dependsOn: ["plan"], maxRetries: 1 },
      { id: "review", name: "Review", role: "reviewer", dependsOn: ["code"], maxRetries: 1 },
    ],
  });
  const scheduler = createScheduler();

  assert.deepEqual(scheduler.getRunnableNodes(dag).map((node) => node.id), ["plan"]);
  scheduler.updateNodeStatus(dag, "plan", "done");
  assert.deepEqual(scheduler.getRunnableNodes(dag).map((node) => node.id), ["code"]);
});

test("task graph ranks critical-path runnable nodes before low-impact siblings", () => {
  const dag = createDag({
    nodes: [
      { id: "side", name: "Side task", role: "coder", dependsOn: [], maxRetries: 1 },
      { id: "root", name: "Root critical task", role: "planner", dependsOn: [], maxRetries: 1 },
      { id: "mid", name: "Middle", role: "coder", dependsOn: ["root"], maxRetries: 1 },
      { id: "leaf", name: "Leaf", role: "reviewer", dependsOn: ["mid"], maxRetries: 1 },
    ],
  });

  assert.deepEqual(createScheduler().getRunnableNodes(dag).map((node) => node.id), ["root", "side"]);
});

test("createDag adds bounded OMK routing hints without changing node contract", async () => {
  await withRoutingSkills(["omk-research-verify"], async () => {
    const dag = createDag({
      nodes: [
        {
          id: "route-research",
          name: "Verify provider paper and official API docs before planner handoff",
          role: "researcher",
          dependsOn: [],
          maxRetries: 1,
          outputs: [{ name: "citation notes", gate: "summary" }],
        },
      ],
    });
    const routing = dag.nodes[0].routing;

    assert.ok(routing?.skills?.includes("omk-research-verify"));
    assert.ok(routing?.tools?.includes("SearchWeb"));
    // Budget limits are expanded when a routing preset is triggered so its
    // essential skills are not silently dropped; assert a reasonable upper bound.
    assert.ok((routing?.skills?.length ?? 0) <= 10);
    assert.ok((routing?.tools?.length ?? 0) <= 4);
    assert.equal(routing?.contextBudget, "small");
    assert.equal(routing?.evidenceRequired, true);
  });
});

test("createDag preserves the full release guard preset for release/security work", () => {
  const inventory = discoverRoutingInventory();
  const dag = createDag({
    nodes: [
      {
        id: "publish-release",
        name: "Publish npm release with changelog, provenance, audit summary, and GitHub release",
        role: "coder",
        dependsOn: [],
        maxRetries: 1,
        outputs: [{ name: "release evidence", gate: "summary" }],
      },
    ],
  });
  const routing = dag.nodes[0].routing;

  // Routing includes available preset skills/hooks/MCP; unavailable ones are
  // intentionally filtered out by the routing logic based on inventory.
  const availableSkills = OMK_RELEASE_GUARD_PRESET.skills.filter((s) => inventory.skills.has(s));
  const availableHooks = OMK_RELEASE_GUARD_PRESET.hooks.filter((h) => inventory.hooks.has(h));
  const availableMcp = OMK_RELEASE_GUARD_PRESET.mcpServers.filter((m) => inventory.mcpServers.has(m));

  for (const skill of availableSkills) {
    assert.ok(routing?.skills?.includes(skill), `missing available release guard skill: ${skill}`);
  }
  for (const hook of availableHooks) {
    assert.ok(routing?.hooks?.includes(hook), `missing available release guard hook: ${hook}`);
  }
  for (const mcp of availableMcp) {
    assert.ok(routing?.mcpServers?.includes(mcp), `missing available release guard MCP: ${mcp}`);
  }
  assert.equal(routing?.mcpServers?.includes("filesystem"), false);
  assert.match(routing?.rationale ?? "", /omk-release-guard/);
});

test("routing inventory discovers project skills and MCP without global scope", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-routing-inventory-"));
  const previousRoot = process.env.OMK_PROJECT_ROOT;
  const previousSkillsScope = process.env.OMK_SKILLS_SCOPE;
  const previousMcpScope = process.env.OMK_MCP_SCOPE;
  const previousHooksScope = process.env.OMK_HOOKS_SCOPE;
  process.env.OMK_PROJECT_ROOT = projectRoot;
  process.env.OMK_SKILLS_SCOPE = "project";
  process.env.OMK_MCP_SCOPE = "project";
  process.env.OMK_HOOKS_SCOPE = "project";
  resetRoutingInventoryCache();

  try {
    await mkdir(join(projectRoot, ".agents", "skills", "omk-repo-explorer"), { recursive: true });
    await mkdir(join(projectRoot, ".kimi", "skills", "omk-task-router"), { recursive: true });
    await mkdir(join(projectRoot, ".omk"), { recursive: true });
    await writeFile(join(projectRoot, ".agents", "skills", "omk-repo-explorer", "SKILL.md"), "# repo explorer\n");
    await writeFile(join(projectRoot, ".kimi", "skills", "omk-task-router", "SKILL.md"), "# task router\n");
    await writeFile(join(projectRoot, ".omk", "mcp.json"), JSON.stringify({ mcpServers: { "omk-project": { command: "node" } } }));
    await writeFile(join(projectRoot, ".omk", "kimi.config.toml"), [
      "[[hooks]]",
      "event = \"SubagentStop\"",
      "command = \".omk/hooks/subagent-stop-audit.sh\"",
      "",
    ].join("\n"));

    const inventory = discoverRoutingInventory(projectRoot);

    assert.equal(inventory.skills.get("omk-repo-explorer"), "project");
    assert.equal(inventory.skills.get("omk-task-router"), "project");
    assert.equal(inventory.mcpServers.get("omk-project"), "project");
    assert.equal(inventory.hooks.get("subagent-stop-audit.sh"), "project");
    assert.equal(inventory.tools.has("omk_run_quality_gate"), true);
    assert.equal(inventory.skillsScope, "project");
    assert.equal(inventory.mcpScope, "project");
    assert.equal(inventory.hooksScope, "project");
  } finally {
    resetRoutingInventoryCache();
    restoreEnv("OMK_PROJECT_ROOT", previousRoot);
    restoreEnv("OMK_SKILLS_SCOPE", previousSkillsScope);
    restoreEnv("OMK_MCP_SCOPE", previousMcpScope);
    restoreEnv("OMK_HOOKS_SCOPE", previousHooksScope);
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("routing inventory exposes virtual omk-project for fresh empty MCP configs", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-routing-virtual-mcp-"));
  const previousRoot = process.env.OMK_PROJECT_ROOT;
  const previousMcpScope = process.env.OMK_MCP_SCOPE;
  process.env.OMK_PROJECT_ROOT = projectRoot;
  process.env.OMK_MCP_SCOPE = "project";
  resetRoutingInventoryCache();

  try {
    await mkdir(join(projectRoot, ".kimi"), { recursive: true });
    await writeFile(join(projectRoot, ".kimi", "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf-8");

    const inventory = discoverRoutingInventory(projectRoot);

    assert.equal(inventory.mcpServers.get("omk-project"), "builtin");
    assert.equal(inventory.tools.has("omk_read_memory"), true);
    assert.equal(inventory.tools.has("omk_run_quality_gate"), true);
  } finally {
    resetRoutingInventoryCache();
    restoreEnv("OMK_PROJECT_ROOT", previousRoot);
    restoreEnv("OMK_MCP_SCOPE", previousMcpScope);
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("routing does not emit skill MCP or hook hints when scopes are none", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-routing-none-scope-"));
  const previousRoot = process.env.OMK_PROJECT_ROOT;
  const previousSkillsScope = process.env.OMK_SKILLS_SCOPE;
  const previousMcpScope = process.env.OMK_MCP_SCOPE;
  const previousHooksScope = process.env.OMK_HOOKS_SCOPE;
  process.env.OMK_PROJECT_ROOT = projectRoot;
  process.env.OMK_SKILLS_SCOPE = "none";
  process.env.OMK_MCP_SCOPE = "none";
  process.env.OMK_HOOKS_SCOPE = "none";
  resetRoutingInventoryCache();

  try {
    const dag = createDag({
      nodes: [
        {
          id: "scoped-review",
          name: "Review implementation and report evidence",
          role: "reviewer",
          dependsOn: [],
          maxRetries: 1,
        },
      ],
    });

    const routing = dag.nodes[0].routing;
    assert.deepEqual(routing?.skills, []);
    assert.deepEqual(routing?.mcpServers, []);
    assert.deepEqual(routing?.hooks, []);
  } finally {
    resetRoutingInventoryCache();
    restoreEnv("OMK_PROJECT_ROOT", previousRoot);
    restoreEnv("OMK_SKILLS_SCOPE", previousSkillsScope);
    restoreEnv("OMK_MCP_SCOPE", previousMcpScope);
    restoreEnv("OMK_HOOKS_SCOPE", previousHooksScope);
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("routing preset requirements do not bypass disabled scopes", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-routing-none-release-"));
  const previousRoot = process.env.OMK_PROJECT_ROOT;
  const previousSkillsScope = process.env.OMK_SKILLS_SCOPE;
  const previousMcpScope = process.env.OMK_MCP_SCOPE;
  const previousHooksScope = process.env.OMK_HOOKS_SCOPE;
  process.env.OMK_PROJECT_ROOT = projectRoot;
  process.env.OMK_SKILLS_SCOPE = "none";
  process.env.OMK_MCP_SCOPE = "none";
  process.env.OMK_HOOKS_SCOPE = "none";
  resetRoutingInventoryCache();

  try {
    const dag = createDag({
      nodes: [
        {
          id: "publish-release",
          name: "Publish npm release with changelog, provenance, audit summary, and GitHub release",
          role: "coder",
          dependsOn: [],
          maxRetries: 1,
          outputs: [{ name: "release evidence", gate: "summary" }],
        },
      ],
    });

    const routing = dag.nodes[0].routing;
    assert.deepEqual(routing?.skills, []);
    assert.deepEqual(routing?.mcpServers, []);
    assert.deepEqual(routing?.hooks, []);
    assert.match(routing?.rationale ?? "", /omk-release-guard/);
  } finally {
    resetRoutingInventoryCache();
    restoreEnv("OMK_PROJECT_ROOT", previousRoot);
    restoreEnv("OMK_SKILLS_SCOPE", previousSkillsScope);
    restoreEnv("OMK_MCP_SCOPE", previousMcpScope);
    restoreEnv("OMK_HOOKS_SCOPE", previousHooksScope);
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("routing inventory reports invalid MCP JSON without dropping valid project MCP", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-routing-invalid-mcp-"));
  const previousRoot = process.env.OMK_PROJECT_ROOT;
  const previousMcpScope = process.env.OMK_MCP_SCOPE;
  process.env.OMK_PROJECT_ROOT = projectRoot;
  process.env.OMK_MCP_SCOPE = "project";
  resetRoutingInventoryCache();

  try {
    await mkdir(join(projectRoot, ".omk"), { recursive: true });
    await mkdir(join(projectRoot, ".kimi"), { recursive: true });
    await writeFile(join(projectRoot, ".omk", "mcp.json"), "{ invalid json", "utf-8");
    await writeFile(join(projectRoot, ".kimi", "mcp.json"), JSON.stringify({ mcpServers: { "omk-project": { command: "node" } } }), "utf-8");

    const inventory = discoverRoutingInventory(projectRoot);

    assert.equal(inventory.mcpServers.get("omk-project"), "project");
    assert.equal(inventory.diagnostics.length, 1);
    assert.deepEqual(inventory.diagnostics[0], {
      kind: "mcp-config",
      source: "project",
      path: join(".omk", "mcp.json"),
      message: "invalid JSON",
    });
  } finally {
    resetRoutingInventoryCache();
    restoreEnv("OMK_PROJECT_ROOT", previousRoot);
    restoreEnv("OMK_MCP_SCOPE", previousMcpScope);
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("project MCP scope excludes global Kimi MCP config", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-scope-"));
  const previousRoot = process.env.OMK_PROJECT_ROOT;
  process.env.OMK_PROJECT_ROOT = projectRoot;

  try {
    await mkdir(join(projectRoot, ".omk"), { recursive: true });
    await mkdir(join(projectRoot, ".kimi"), { recursive: true });
    await writeFile(join(projectRoot, ".omk", "mcp.json"), JSON.stringify({ mcpServers: { "omk-project": {} } }));
    await writeFile(join(projectRoot, ".kimi", "mcp.json"), JSON.stringify({ mcpServers: {} }));

    const configs = await collectMcpConfigs("project");

    assert.deepEqual(configs, [join(projectRoot, ".kimi", "mcp.json")]);
    assert.equal(configs.includes(join(projectRoot, ".omk", "mcp.json")), false);
    assert.equal(configs.some((path) => path.startsWith(join(homedir(), ".kimi"))), false);
  } finally {
    restoreEnv("OMK_PROJECT_ROOT", previousRoot);
    await rm(projectRoot, { recursive: true, force: true });
  }
});


test("injectKimiGlobals passes one merged MCP config to Kimi to avoid duplicate server warnings", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-merged-mcp-project-"));
  const originalHome = await mkdtemp(join(tmpdir(), "omk-merged-mcp-home-"));
  const previousRoot = process.env.OMK_PROJECT_ROOT;
  const previousHome = process.env.HOME;
  const previousOriginalHome = process.env.OMK_ORIGINAL_HOME;
  const previousMcpScope = process.env.OMK_MCP_SCOPE;
  const previousSkillsScope = process.env.OMK_SKILLS_SCOPE;
  const previousMcpPreflight = process.env.OMK_MCP_PREFLIGHT;

  try {
    await mkdir(join(originalHome, ".kimi"), { recursive: true });
    await mkdir(join(projectRoot, ".kimi"), { recursive: true });
    await writeFile(join(originalHome, ".kimi", "mcp.json"), JSON.stringify({
      mcpServers: {
        memory: { command: "global-memory" },
        github: { command: "global-github" },
      },
    }));
    await writeFile(join(projectRoot, ".kimi", "mcp.json"), JSON.stringify({
      mcpServers: {
        memory: { command: "project-memory" },
        filesystem: { command: "project-filesystem" },
      },
    }));

    process.env.OMK_PROJECT_ROOT = projectRoot;
    process.env.HOME = originalHome;
    process.env.OMK_ORIGINAL_HOME = originalHome;
    process.env.OMK_MCP_SCOPE = "all";
    process.env.OMK_SKILLS_SCOPE = "none";
    process.env.OMK_MCP_PREFLIGHT = "off";

    const args = [];
    await injectKimiGlobals(args, { mcpScope: "all", skillsScope: "none" });

    const configArgs = args.filter((arg, index) => args[index - 1] === "--mcp-config-file");
    assert.equal(configArgs.length, 1);
    assert.match(configArgs[0], /mcp-runtime-merged-\d+-\d+\.json$/);

    const merged = JSON.parse(await readFile(configArgs[0], "utf-8"));
    assert.equal(merged.mcpServers.memory.command, "project-memory");
    assert.equal(merged.mcpServers.github.command, "global-github");
    assert.equal(merged.mcpServers.filesystem.command, "project-filesystem");
    assert.ok(merged.mcpServers["omk-project"], "built-in omk-project should remain available");
    if (process.platform !== "win32") {
      const mode = (await stat(configArgs[0])).mode & 0o777;
      assert.equal(mode, 0o600);
    }
  } finally {
    restoreEnv("OMK_PROJECT_ROOT", previousRoot);
    restoreEnv("HOME", previousHome);
    restoreEnv("OMK_ORIGINAL_HOME", previousOriginalHome);
    restoreEnv("OMK_MCP_SCOPE", previousMcpScope);
    restoreEnv("OMK_SKILLS_SCOPE", previousSkillsScope);
    restoreEnv("OMK_MCP_PREFLIGHT", previousMcpPreflight);
    await rm(projectRoot, { recursive: true, force: true });
    await rm(originalHome, { recursive: true, force: true });
  }
});

test("injectKimiGlobals enforces explicit MCP allowlist while keeping omk-project", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-allowlisted-mcp-project-"));
  const originalHome = await mkdtemp(join(tmpdir(), "omk-allowlisted-mcp-home-"));
  const previousRoot = process.env.OMK_PROJECT_ROOT;
  const previousHome = process.env.HOME;
  const previousOriginalHome = process.env.OMK_ORIGINAL_HOME;
  const previousMcpScope = process.env.OMK_MCP_SCOPE;
  const previousSkillsScope = process.env.OMK_SKILLS_SCOPE;
  const previousMcpPreflight = process.env.OMK_MCP_PREFLIGHT;

  try {
    await mkdir(join(originalHome, ".kimi"), { recursive: true });
    await mkdir(join(projectRoot, ".kimi"), { recursive: true });
    await writeFile(join(originalHome, ".kimi", "mcp.json"), JSON.stringify({
      mcpServers: {
        github: { command: "global-github" },
      },
    }));
    await writeFile(join(projectRoot, ".kimi", "mcp.json"), JSON.stringify({
      mcpServers: {
        filesystem: { command: "project-filesystem" },
        memory: { command: "project-memory" },
      },
    }));

    process.env.OMK_PROJECT_ROOT = projectRoot;
    process.env.HOME = originalHome;
    process.env.OMK_ORIGINAL_HOME = originalHome;
    process.env.OMK_MCP_SCOPE = "all";
    process.env.OMK_SKILLS_SCOPE = "none";
    process.env.OMK_MCP_PREFLIGHT = "off";

    const args = [];
    await injectKimiGlobals(args, {
      mcpScope: "all",
      skillsScope: "none",
      mcpAllowlist: ["filesystem"],
    });

    const configArgs = args.filter((arg, index) => args[index - 1] === "--mcp-config-file");
    assert.equal(configArgs.length, 1);
    const merged = JSON.parse(await readFile(configArgs[0], "utf-8"));
    assert.deepEqual(Object.keys(merged.mcpServers).sort(), ["filesystem", "omk-project"]);

    const emptyArgs = [];
    await injectKimiGlobals(emptyArgs, {
      mcpScope: "all",
      skillsScope: "none",
      mcpAllowlist: [],
    });
    const emptyConfigArgs = emptyArgs.filter((arg, index) => emptyArgs[index - 1] === "--mcp-config-file");
    assert.equal(emptyConfigArgs.length, 1);
    const emptyMerged = JSON.parse(await readFile(emptyConfigArgs[0], "utf-8"));
    assert.deepEqual(Object.keys(emptyMerged.mcpServers), ["omk-project"]);
  } finally {
    restoreEnv("OMK_PROJECT_ROOT", previousRoot);
    restoreEnv("HOME", previousHome);
    restoreEnv("OMK_ORIGINAL_HOME", previousOriginalHome);
    restoreEnv("OMK_MCP_SCOPE", previousMcpScope);
    restoreEnv("OMK_SKILLS_SCOPE", previousSkillsScope);
    restoreEnv("OMK_MCP_PREFLIGHT", previousMcpPreflight);
    await rm(projectRoot, { recursive: true, force: true });
    await rm(originalHome, { recursive: true, force: true });
  }
});

test("dagNodeRoutingEnv keeps node MCP allowlist separate from parent MCP context", () => {
  const dag = createDag({
    nodes: [
      {
        id: "parent",
        name: "Parent",
        role: "explorer",
        prompt: "parent",
        dependsOn: [],
        maxRetries: 1,
        routing: { mcpServers: ["parent-mcp"], skills: ["parent-skill"], hooks: ["parent-hook"] },
      },
      {
        id: "child",
        name: "Child",
        role: "coder",
        prompt: "child",
        dependsOn: ["parent"],
        maxRetries: 1,
        routing: { mcpServers: ["child-mcp"], skills: ["child-skill"], hooks: ["child-hook"] },
      },
    ],
  });

  const child = dag.nodes.find((node) => node.id === "child");
  assert.ok(child);
  const env = dagNodeRoutingEnv(child, dag);
  assert.equal(env.OMK_MCP_HINTS, "child-mcp");
  assert.equal(env.OMK_PARENT_MCP_HINTS, "parent-mcp");
});

test("dag routing exposes provider-neutral node capability contract", () => {
  const dag = createDag({
    nodes: [
      {
        id: "worker",
        name: "Worker",
        role: "coder",
        dependsOn: [],
        maxRetries: 1,
        routing: {
          provider: "auto",
          candidateProviders: ["kimi", "codex", "qwen", "openrouter"],
          assignedProviderAuthority: "authority",
          assignedProviderCapabilities: ["write", "shell", "mcp"],
          skills: ["omk-typescript-strict", "omk-typescript-strict"],
          mcpServers: ["omk-project"],
          tools: ["omk_run_quality_gate"],
          hooks: ["protect-secrets.sh"],
        },
      },
    ],
  });
  const [worker] = dag.nodes;

  assert.deepEqual(worker.routing?.assignedCapabilities?.skills, ["omk-typescript-strict"]);
  assert.deepEqual(worker.routing?.assignedCapabilities?.mcpServers, ["omk-project"]);
  assert.deepEqual(worker.routing?.assignedCapabilities?.tools, ["omk_run_quality_gate"]);
  assert.deepEqual(worker.routing?.assignedCapabilities?.hooks, ["protect-secrets.sh"]);

  const env = dagNodeRoutingEnv(worker, dag);
  assert.equal(env.OMK_NODE_PROVIDER, "auto");
  assert.equal(env.OMK_NODE_PROVIDER_AUTHORITY, "authority");
  assert.equal(env.OMK_NODE_PROVIDER_CAPABILITIES, "write,shell,mcp");
  assert.equal(env.OMK_NODE_CANDIDATE_PROVIDERS, "kimi,codex,qwen,openrouter");
  assert.equal(env.OMK_NODE_SKILLS, "omk-typescript-strict");
  assert.equal(env.OMK_NODE_MCP_SERVERS, "omk-project");
  assert.equal(env.OMK_NODE_TOOLS, "omk_run_quality_gate");
  assert.equal(env.OMK_NODE_HOOKS, "protect-secrets.sh");
});

test("capability routing artifact records per-node provider and capability assignments", () => {
  const dag = createDag({
    nodes: [
      {
        id: "worker",
        name: "Worker",
        role: "coder",
        dependsOn: [],
        maxRetries: 1,
        routing: {
          provider: "auto",
          candidateProviders: ["kimi", "codex", "qwen", "openrouter"],
          assignedProviderAuthority: "authority",
          skills: ["omk-typescript-strict"],
          mcpServers: ["omk-project"],
          hooks: ["protect-secrets.sh"],
        },
      },
    ],
  });

  const artifact = renderCapabilityRoutingArtifact(dag.nodes, "2026-05-24T00:00:00.000Z");
  assert.equal(artifact.schemaVersion, 1);
  assert.equal(artifact.generatedAt, "2026-05-24T00:00:00.000Z");
  assert.equal(artifact.nodes[0].nodeId, "worker");
  assert.equal(artifact.nodes[0].provider, "auto");
  assert.deepEqual(artifact.nodes[0].candidateProviders, ["kimi", "codex", "qwen", "openrouter"]);
  assert.deepEqual(artifact.nodes[0].skills, ["omk-typescript-strict"]);
  assert.deepEqual(artifact.nodes[0].mcpServers, ["omk-project"]);
  assert.deepEqual(artifact.nodes[0].hooks, ["protect-secrets.sh"]);
});

test("injectKimiGlobals prunes stale global MCP startup entries before Kimi restore", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-pruned-mcp-project-"));
  const originalHome = await mkdtemp(join(tmpdir(), "omk-pruned-mcp-home-"));
  const previousRoot = process.env.OMK_PROJECT_ROOT;
  const previousHome = process.env.HOME;
  const previousOriginalHome = process.env.OMK_ORIGINAL_HOME;
  const previousMcpScope = process.env.OMK_MCP_SCOPE;
  const previousSkillsScope = process.env.OMK_SKILLS_SCOPE;
  const previousSuppressWarnings = process.env.OMK_MCP_SUPPRESS_PRUNE_WARNINGS;
  const previousMcpPreflight = process.env.OMK_MCP_PREFLIGHT;

  try {
    const missingProxy = join(originalHome, ".kimi", "scripts", "remote_mcp_proxy.py");
    const missingNodeModule = join(originalHome, ".npm-global", "lib", "node_modules", "broken-mcp", "index.js");
    await mkdir(join(originalHome, ".kimi"), { recursive: true });
    await mkdir(join(projectRoot, ".kimi"), { recursive: true });
    await writeFile(join(originalHome, ".kimi", "mcp.json"), JSON.stringify({
      mcpServers: {
        "windows-set": { command: "bash", args: ["-lc", "/mnt/c/WINDOWS/System32/set -a; exec node"] },
        "remote-proxy": { command: "python3", args: [missingProxy] },
        "missing-node-module": { command: "node", args: [missingNodeModule] },
        "stale-sqlite": { command: "npx", args: ["-y", "sqlite-mcp", "/home/not-current/.opencode/data.db"] },
        "page-design-guide": { command: "page-design-guide" },
        "http-transport": { command: "example-mcp", args: ["--transport", "http"] },
        "stdio-page-design-guide": { command: "page-design-guide", args: ["--stdio"] },
        "pdf": { command: "npx", args: ["-y", "@modelcontextprotocol/server-pdf"] },
        "pdf-shell": { command: "bash", args: ["-lc", "exec npx -y @modelcontextprotocol/server-pdf"] },
        "quiet-npx": { command: "npx", args: ["-y", "@example/mcp-server"] },
        "quiet-uvx": { command: "uvx", args: ["mcp-server-fetch"] },
        "quiet-python-pip": { command: "python3", args: ["-m", "pip", "install", "example-mcp"] },
        "quiet-shell-uvx": { command: "bash", args: ["-lc", "exec uvx mcp-server-fetch"] },
        "custom-uvx": { command: "uvx", args: ["custom-mcp"], env: { UV_NO_PROGRESS: "0", CUSTOM_TOKEN_FILE: "/tmp/fake-token" } },
        "ok-remote": { url: "https://mcp.example.test" },
        "ok-shell": { command: "bash", args: ["-lc", "exec node --version"] },
      },
    }));
    const prunedPdf = await pruneRuntimeMcpServers({
      pdf: { command: "npx", args: ["-y", "@modelcontextprotocol/server-pdf"] },
    });
    assert.deepEqual(prunedPdf.servers.pdf.args, ["-y", "@modelcontextprotocol/server-pdf", "--stdio"]);
    assert.equal(prunedPdf.diagnostics.length, 0);
    assert.deepEqual(prunedPdf.normalizations.map((entry) => entry.kind), ["runtime-stdio-normalized"]);
    await writeFile(join(projectRoot, ".kimi", "mcp.json"), JSON.stringify({
      mcpServers: {
        "project-local": { command: "node", args: [process.execPath] },
        "project-relative": { command: "./server.js", args: ["--config", "./mcp/config.json"] },
        "project-npx": { command: "npx", args: ["-y", "@scope/pkg"] },
        "project-shell": { command: "bash", args: ["-lc", "source ./mcp/env.sh; exec npx -y @scope/pkg"] },
      },
    }));
    await mkdir(join(projectRoot, "mcp"), { recursive: true });
    await writeFile(join(projectRoot, "server.js"), "process.exit(0);\n");
    await writeFile(join(projectRoot, "mcp", "env.sh"), "export OK=1\n");
    await writeFile(join(projectRoot, "mcp", "config.json"), "{}\n");

    process.env.OMK_PROJECT_ROOT = projectRoot;
    process.env.HOME = originalHome;
    process.env.OMK_ORIGINAL_HOME = originalHome;
    process.env.OMK_MCP_SCOPE = "all";
    process.env.OMK_SKILLS_SCOPE = "none";
    process.env.OMK_MCP_SUPPRESS_PRUNE_WARNINGS = "1";
    process.env.OMK_MCP_PREFLIGHT = "off";

    const args = [];
    await injectKimiGlobals(args, { mcpScope: "all", skillsScope: "none" });

    const configArgs = args.filter((arg, index) => args[index - 1] === "--mcp-config-file");
    assert.equal(configArgs.length, 1);
    const merged = JSON.parse(await readFile(configArgs[0], "utf-8"));
    assert.equal(merged.mcpServers["windows-set"], undefined);
    assert.equal(merged.mcpServers["remote-proxy"], undefined);
    assert.equal(merged.mcpServers["missing-node-module"], undefined);
    assert.equal(merged.mcpServers["stale-sqlite"], undefined);
    assert.equal(merged.mcpServers["page-design-guide"], undefined);
    assert.equal(merged.mcpServers["http-transport"], undefined);
    assert.equal(merged.mcpServers["stdio-page-design-guide"].command, "page-design-guide");
    assert.deepEqual(merged.mcpServers.pdf.args, ["-y", "@modelcontextprotocol/server-pdf", "--stdio"]);
    assert.equal(merged.mcpServers.pdf.env.npm_config_loglevel, "error");
    assert.equal(merged.mcpServers["pdf-shell"].args[1], "exec npx -y @modelcontextprotocol/server-pdf --stdio");
    assert.equal(merged.mcpServers["quiet-npx"].env.npm_config_loglevel, "error");
    assert.equal(merged.mcpServers["quiet-npx"].env.NPM_CONFIG_PROGRESS, "false");
    assert.equal(merged.mcpServers["quiet-npx"].env.NODE_NO_WARNINGS, "1");
    assert.equal(merged.mcpServers["quiet-uvx"].env.UV_NO_PROGRESS, "1");
    assert.equal(merged.mcpServers["quiet-uvx"].env.PIP_DISABLE_PIP_VERSION_CHECK, "1");
    assert.equal(merged.mcpServers["quiet-python-pip"].env.PIP_PROGRESS_BAR, "off");
    assert.equal(merged.mcpServers["quiet-shell-uvx"].env.UV_NO_PROGRESS, "1");
    assert.equal(merged.mcpServers["custom-uvx"].env.UV_NO_PROGRESS, "0");
    assert.equal(merged.mcpServers["custom-uvx"].env.CUSTOM_TOKEN_FILE, "/tmp/fake-token");
    assert.equal(merged.mcpServers["ok-remote"].url, "https://mcp.example.test");
    assert.equal(merged.mcpServers["ok-shell"].command, "bash");
    assert.equal(merged.mcpServers["project-local"].command, "node");
    assert.equal(merged.mcpServers["project-relative"].command, join(projectRoot, "server.js"));
    assert.deepEqual(merged.mcpServers["project-relative"].args, ["--config", join(projectRoot, "mcp", "config.json")]);
    assert.deepEqual(merged.mcpServers["project-npx"].args, ["-y", "@scope/pkg"]);
    assert.equal(merged.mcpServers["project-shell"].args[1], `source ${join(projectRoot, "mcp", "env.sh")}; exec npx -y @scope/pkg`);
    assert.ok(merged.mcpServers["omk-project"], "built-in omk-project should remain available");
    const globalConfigAfterRuntimeMerge = JSON.parse(await readFile(join(originalHome, ".kimi", "mcp.json"), "utf-8"));
    assert.equal(globalConfigAfterRuntimeMerge.mcpServers["quiet-uvx"].env, undefined);
  } finally {
    restoreEnv("OMK_PROJECT_ROOT", previousRoot);
    restoreEnv("HOME", previousHome);
    restoreEnv("OMK_ORIGINAL_HOME", previousOriginalHome);
    restoreEnv("OMK_MCP_SCOPE", previousMcpScope);
    restoreEnv("OMK_SKILLS_SCOPE", previousSkillsScope);
    restoreEnv("OMK_MCP_SUPPRESS_PRUNE_WARNINGS", previousSuppressWarnings);
    restoreEnv("OMK_MCP_PREFLIGHT", previousMcpPreflight);
    await rm(projectRoot, { recursive: true, force: true });
    await rm(originalHome, { recursive: true, force: true });
  }
});

test("injectKimiGlobals does not inject MCP config when mcpScope is none", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-no-mcp-project-"));
  const previousRoot = process.env.OMK_PROJECT_ROOT;
  const previousMcpScope = process.env.OMK_MCP_SCOPE;
  const previousSkillsScope = process.env.OMK_SKILLS_SCOPE;

  try {
    await mkdir(join(projectRoot, ".kimi"), { recursive: true });
    await writeFile(join(projectRoot, ".kimi", "mcp.json"), JSON.stringify({
      mcpServers: {
        memory: { command: "project-memory" },
      },
    }));

    process.env.OMK_PROJECT_ROOT = projectRoot;
    process.env.OMK_MCP_SCOPE = "none";
    process.env.OMK_SKILLS_SCOPE = "none";

    const args = [];
    await injectKimiGlobals(args, { mcpScope: "none", skillsScope: "none" });

    assert.equal(args.includes("--mcp-config-file"), false);
  } finally {
    restoreEnv("OMK_PROJECT_ROOT", previousRoot);
    restoreEnv("OMK_MCP_SCOPE", previousMcpScope);
    restoreEnv("OMK_SKILLS_SCOPE", previousSkillsScope);
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("global MCP and skills resolve through OMK_ORIGINAL_HOME when HOME is isolated", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-original-home-project-"));
  const originalHome = await mkdtemp(join(tmpdir(), "omk-original-home-"));
  const isolatedHome = await mkdtemp(join(tmpdir(), "omk-isolated-home-"));
  const previousRoot = process.env.OMK_PROJECT_ROOT;
  const previousHome = process.env.HOME;
  const previousOriginalHome = process.env.OMK_ORIGINAL_HOME;
  const previousMcpScope = process.env.OMK_MCP_SCOPE;
  const previousSkillsScope = process.env.OMK_SKILLS_SCOPE;

  try {
    await mkdir(join(originalHome, ".kimi"), { recursive: true });
    await mkdir(join(originalHome, ".kimi", "skills", "global-skill"), { recursive: true });
    await mkdir(join(projectRoot, ".kimi"), { recursive: true });
    await writeFile(join(originalHome, ".kimi", "mcp.json"), JSON.stringify({ mcpServers: { "global-original": { command: "node" } } }));
    await writeFile(join(originalHome, ".kimi", "skills", "global-skill", "SKILL.md"), "# global skill\n");
    await writeFile(join(projectRoot, ".kimi", "mcp.json"), JSON.stringify({ mcpServers: { "omk-project": { command: "omk-project-mcp" } } }));

    process.env.OMK_PROJECT_ROOT = projectRoot;
    process.env.HOME = isolatedHome;
    process.env.OMK_ORIGINAL_HOME = originalHome;
    process.env.OMK_MCP_SCOPE = "all";
    process.env.OMK_SKILLS_SCOPE = "all";
    resetRoutingInventoryCache();

    const configs = await collectMcpConfigs("all");
    assert.deepEqual(configs, [
      join(originalHome, ".kimi", "mcp.json"),
      join(projectRoot, ".kimi", "mcp.json"),
    ]);
    assert.equal(configs.some((path) => path.startsWith(isolatedHome)), false);

    const inventory = discoverRoutingInventory(projectRoot);
    assert.equal(inventory.mcpServers.get("global-original"), "global");
    assert.equal(inventory.mcpServers.get("omk-project"), "project");
    assert.equal(inventory.skills.get("global-skill"), "global");
  } finally {
    resetRoutingInventoryCache();
    restoreEnv("OMK_PROJECT_ROOT", previousRoot);
    restoreEnv("HOME", previousHome);
    restoreEnv("OMK_ORIGINAL_HOME", previousOriginalHome);
    restoreEnv("OMK_MCP_SCOPE", previousMcpScope);
    restoreEnv("OMK_SKILLS_SCOPE", previousSkillsScope);
    await rm(projectRoot, { recursive: true, force: true });
    await rm(originalHome, { recursive: true, force: true });
    await rm(isolatedHome, { recursive: true, force: true });
  }
});

test("global MCP resolves WSL UNC ~/.kimi/mcp.json paths through the native home", {
  skip: process.platform === "win32" ? "WSL UNC normalization is validated from WSL/POSIX runtimes" : false,
}, async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-wsl-unc-project-"));
  const originalHome = await mkdtemp(join(tmpdir(), "omk-wsl-unc-home-"));
  const isolatedHome = await mkdtemp(join(tmpdir(), "omk-wsl-unc-isolated-"));
  const previousRoot = process.env.OMK_PROJECT_ROOT;
  const previousHome = process.env.HOME;
  const previousOriginalHome = process.env.OMK_ORIGINAL_HOME;
  const previousMcpScope = process.env.OMK_MCP_SCOPE;
  const previousSkillsScope = process.env.OMK_SKILLS_SCOPE;

  try {
    await mkdir(join(originalHome, ".kimi", "skills", "global-wsl-skill"), { recursive: true });
    await mkdir(join(projectRoot, ".kimi"), { recursive: true });
    await writeFile(join(originalHome, ".kimi", "mcp.json"), JSON.stringify({ mcpServers: { "global-wsl": { command: "node" } } }));
    await writeFile(join(originalHome, ".kimi", "skills", "global-wsl-skill", "SKILL.md"), "# global WSL skill\n");
    await writeFile(join(projectRoot, ".kimi", "mcp.json"), JSON.stringify({ mcpServers: { "omk-project": { command: "omk-project-mcp" } } }));

    const uncMcpPath = toWslUncPath(join(originalHome, ".kimi", "mcp.json"));
    const uncSkillsPath = toWslUncPath(join(originalHome, ".kimi", "skills"));
    process.env.OMK_PROJECT_ROOT = projectRoot;
    process.env.HOME = isolatedHome;
    process.env.OMK_ORIGINAL_HOME = uncMcpPath;
    process.env.OMK_MCP_SCOPE = "all";
    process.env.OMK_SKILLS_SCOPE = "all";
    resetRoutingInventoryCache();

    assert.equal(normalizeUserHomePath(uncMcpPath), originalHome);
    assert.equal(normalizeUserHomePath(uncSkillsPath), originalHome);
    assert.equal(getUserHome(), originalHome);

    const configs = await collectMcpConfigs("all");
    assert.deepEqual(configs, [
      join(originalHome, ".kimi", "mcp.json"),
      join(projectRoot, ".kimi", "mcp.json"),
    ]);

    const inventory = discoverRoutingInventory(projectRoot);
    assert.equal(inventory.mcpServers.get("global-wsl"), "global");
    assert.equal(inventory.mcpServers.get("omk-project"), "project");
    assert.equal(inventory.skills.get("global-wsl-skill"), "global");
  } finally {
    resetRoutingInventoryCache();
    restoreEnv("OMK_PROJECT_ROOT", previousRoot);
    restoreEnv("HOME", previousHome);
    restoreEnv("OMK_ORIGINAL_HOME", previousOriginalHome);
    restoreEnv("OMK_MCP_SCOPE", previousMcpScope);
    restoreEnv("OMK_SKILLS_SCOPE", previousSkillsScope);
    await rm(projectRoot, { recursive: true, force: true });
    await rm(originalHome, { recursive: true, force: true });
    await rm(isolatedHome, { recursive: true, force: true });
  }
});

test("run state routing helper enriches synthetic CLI nodes", async () => {
  await withRoutingSkills(["omk-industrial-control-loop", "omk-quality-gate"], async () => {
    const state = createRoutedRunState({
      runId: "run-state-test",
      startedAt: "2026-05-01T00:00:00.000Z",
      workerCount: 2,
      nodes: [
        { id: "coordinator", name: "Coordinate DAG team", role: "orchestrator", dependsOn: [], maxRetries: 1 },
        { id: "review", name: "Review quality gate", role: "reviewer", dependsOn: ["coordinator"], maxRetries: 1 },
      ],
    });

    assert.equal(state.nodes[0].status, "pending");
    assert.ok(state.nodes[0].routing?.skills?.includes("omk-industrial-control-loop"));
    assert.ok(state.nodes[1].routing?.skills?.includes("omk-quality-gate"));
    assert.equal(state.estimate?.totalNodes, 2);
  });
});

test("run state binds goal and scoped capability assignments for HUD control loops", () => {
  const goalSnapshot = {
    title: "Critical issue scan",
    objective: "Find critical issues in current repo state",
    successCriteria: [
      { id: "evidence", description: "Evidence is collected", requirement: "required" },
    ],
  };
  const state = createRoutedRunState({
    runId: "goal-assignment-test",
    startedAt: "2026-05-01T00:00:00.000Z",
    workerCount: 2,
    goalId: "goal-1",
    goalSnapshot,
    routeDecision: {
      intent: "critical_issue_scan",
      selectedAgents: ["repo_explorer", "security_reviewer"],
      reason: "critical scan",
      requiredEvidence: [
        { kind: "diff", required: true, description: "diff evidence" },
      ],
      mode: "read-only",
    },
    nodes: [
      {
        id: "scan",
        name: "Scan runtime risk",
        role: "reviewer",
        dependsOn: [],
        maxRetries: 1,
        routing: {
          skills: ["omk-code-review"],
          mcpServers: ["omk-project"],
          hooks: ["stop-verify.sh"],
          tools: ["omk_run_quality_gate"],
          rationale: "test assignment",
        },
      },
    ],
  });

  assert.deepEqual(buildRunGoalState({ goalId: "goal-1", goalSnapshot }), {
    id: "goal-1",
    title: "Critical issue scan",
    objective: "Find critical issues in current repo state",
    successCriteria: goalSnapshot.successCriteria,
    status: "planned",
  });
  assert.equal(state.goal?.objective, goalSnapshot.objective);
  assert.equal(state.routeDecision?.intent, "critical_issue_scan");
  assert.deepEqual(state.capabilityAssignments?.scan, {
    skills: ["omk-code-review"],
    mcpServers: ["omk-project"],
    hooks: ["stop-verify.sh"],
    tools: ["omk_run_quality_gate"],
    source: "routing",
    rationale: "test assignment",
  });

  const routed = routeRunState(state, 2);
  assert.equal(routed.goal?.title, "Critical issue scan");
  assert.equal(routed.capabilityAssignments?.scan?.skills[0], "omk-code-review");
});

test("run state estimate can be refreshed after synthetic status changes", () => {
  const state = createRoutedRunState({
    runId: "estimate-refresh-test",
    startedAt: "2026-05-01T00:00:00.000Z",
    workerCount: 2,
    nodes: [
      { id: "bootstrap", name: "Bootstrap", role: "omk", dependsOn: [], maxRetries: 1 },
      { id: "coordinator", name: "Coordinate DAG team", role: "orchestrator", dependsOn: ["bootstrap"], maxRetries: 1 },
    ],
  });

  state.nodes[0].status = "done";
  state.nodes[1].status = "running";
  refreshRunStateEstimate(state, 2);

  assert.equal(state.estimate?.completedNodes, 1);
  assert.equal(state.estimate?.runningNodes, 1);
});

test("routeRunState preserves runtime status while refreshing routing metadata", async () => {
  await withRoutingSkills(["omk-industrial-control-loop"], async () => {
    const routed = routeRunState({
      runId: "resume-test",
      startedAt: "2026-05-01T00:00:00.000Z",
      nodes: [
        {
          id: "root",
          name: "Coordinate resumed DAG",
          role: "orchestrator",
          dependsOn: [],
          status: "running",
          retries: 0,
          maxRetries: 1,
          startedAt: "2026-05-01T00:00:01.000Z",
        },
      ],
    });

    assert.equal(routed.nodes[0].status, "running");
    assert.equal(routed.nodes[0].startedAt, "2026-05-01T00:00:01.000Z");
    assert.ok(routed.nodes[0].routing?.skills?.includes("omk-industrial-control-loop"));
  });
});

test("scheduler blocks descendants after a terminal failed dependency", () => {
  const dag = createDag({
    nodes: [
      { id: "plan", name: "Plan", role: "planner", dependsOn: [], maxRetries: 1 },
      { id: "code", name: "Code", role: "coder", dependsOn: ["plan"], maxRetries: 1 },
      { id: "review", name: "Review", role: "reviewer", dependsOn: ["code"], maxRetries: 1 },
    ],
  });
  const scheduler = createScheduler();

  scheduler.updateNodeStatus(dag, "plan", "failed");

  assert.equal(dag.nodes.find((node) => node.id === "code")?.status, "blocked");
  assert.equal(dag.nodes.find((node) => node.id === "review")?.status, "blocked");
  assert.equal(scheduler.isFailed(dag), true);
});

test("scheduler keeps transitive optional dependents runnable after a blocker", () => {
  const dag = createDag({
    nodes: [
      { id: "discover", name: "Discover", role: "researcher", dependsOn: [], maxRetries: 1 },
      { id: "summarize", name: "Summarize", role: "writer", dependsOn: ["discover"], maxRetries: 1 },
      {
        id: "report",
        name: "Report with optional summary",
        role: "reviewer",
        dependsOn: ["summarize"],
        maxRetries: 1,
        inputs: [{ name: "optional summary", ref: "summary.md", from: "summarize", required: false }],
      },
    ],
  });
  const scheduler = createScheduler();

  scheduler.updateNodeStatus(dag, "discover", "failed");

  assert.equal(dag.nodes.find((node) => node.id === "summarize")?.status, "blocked");
  assert.equal(dag.nodes.find((node) => node.id === "report")?.status, "pending");
  assert.deepEqual(scheduler.getRunnableNodes(dag).map((node) => node.id), ["report"]);
});

test("scheduler allows review-merge after required deps finish while optional deps are pending or running", () => {
  const dag = createDag({
    nodes: [
      { id: "worker", name: "Worker", role: "coder", dependsOn: [], maxRetries: 1 },
      { id: "optional-blocker", name: "Optional blocker", role: "researcher", dependsOn: [], maxRetries: 1 },
      { id: "optional-pending", name: "Optional pending", role: "researcher", dependsOn: ["optional-blocker"], maxRetries: 1 },
      { id: "optional-running", name: "Optional running", role: "reviewer", dependsOn: [], maxRetries: 1 },
      {
        id: "review-merge",
        name: "Review merge",
        role: "reviewer",
        dependsOn: ["worker", "optional-pending", "optional-running"],
        maxRetries: 1,
        inputs: [
          { name: "worker output", ref: "state.json", from: "worker" },
          { name: "pending advisory", ref: "state.json", from: "optional-pending", required: false },
          { name: "running advisory", ref: "state.json", from: "optional-running", required: false },
        ],
      },
    ],
  });
  const scheduler = createScheduler();

  scheduler.updateNodeStatus(dag, "worker", "done");
  scheduler.updateNodeStatus(dag, "optional-running", "running");

  const runnable = scheduler.getRunnableNodes(dag).map((node) => node.id);
  assert.ok(runnable.includes("review-merge"));
});

test("createDag rejects hidden input dependencies", () => {
  assert.throws(
    () => createDag({
      nodes: [
        { id: "plan", name: "Plan", role: "planner", dependsOn: [], maxRetries: 1 },
        {
          id: "code",
          name: "Code",
          role: "coder",
          dependsOn: [],
          maxRetries: 1,
          inputs: [{ name: "plan output", ref: "plan.md", from: "plan" }],
        },
      ],
    }),
    /hidden dependency/
  );
});

test("createDag rejects malformed dependency contracts", () => {
  assert.throws(
    () => createDag({ nodes: "not-an-array" }),
    /nodes array/
  );
  assert.throws(
    () => createDag({
      nodes: [
        { id: "plan", name: "Plan", role: "planner", dependsOn: ["plan"], maxRetries: 1 },
      ],
    }),
    /cannot depend on itself/
  );
  assert.throws(
    () => createDag({
      nodes: [
        { id: "code", name: "Code", role: "coder", dependsOn: [], maxRetries: 1, inputs: [{ name: "missing", ref: "x", from: "plan" }] },
      ],
    }),
    /missing input dependency/
  );
});

test("task graph rejects cycles with a useful error", () => {
  assert.throws(
    () => createDag({
      nodes: [
        { id: "a", name: "A", role: "planner", dependsOn: ["b"], maxRetries: 1 },
        { id: "b", name: "B", role: "coder", dependsOn: ["a"], maxRetries: 1 },
      ],
    }),
    /circular dependency/
  );
});

test("ensemble runner calls role-specific candidates and aggregates quorum", async () => {
  const calls = [];
  const baseRunner = {
    async run(node, env) {
      calls.push({ node, env });
      return {
        success: env.OMK_ENSEMBLE_CANDIDATE_ID !== "edge-cases",
        stdout: `candidate=${env.OMK_ENSEMBLE_CANDIDATE_ID}\nconfidence: 0.9`,
        stderr: "",
        metadata: env.OMK_ENSEMBLE_CANDIDATE_ID === "implement"
          ? { provider: "deepseek", requestedProvider: "deepseek", providerModel: "deepseek-v4-pro" }
          : { provider: "kimi", requestedProvider: "kimi" },
      };
    },
  };
  const runner = createEnsembleTaskRunner(baseRunner, {
    enabled: true,
    maxCandidatesPerNode: 2,
    maxParallel: 1,
    quorumRatio: 0.5,
  });

  const result = await runner.run(
    { id: "node-1", name: "Implement", role: "coder", dependsOn: [], status: "pending", retries: 0, maxRetries: 1, worktree: await tempWorktree() },
    { OMK_RUN_ID: "test" }
  );

  assert.equal(result.success, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.env.OMK_ENSEMBLE_CANDIDATE_ID), ["implement", "edge-cases"]);
  assert.match(result.stdout, /OMK Ensemble Result/);
  assert.equal(result.metadata.ensemble.winner, "implement");
  assert.equal(result.metadata.provider, "deepseek");
  assert.equal(result.metadata.providerModel, "deepseek-v4-pro");
});

test("ensemble runner tolerates one candidate throwing when quorum still passes", async () => {
  const baseRunner = {
    async run(node, env) {
      if (env.OMK_ENSEMBLE_CANDIDATE_ID === "edge-cases") {
        throw new Error("candidate crashed");
      }
      return {
        success: true,
        stdout: `candidate=${env.OMK_ENSEMBLE_CANDIDATE_ID}\nconfidence: 0.8`,
        stderr: "",
      };
    },
  };
  const runner = createEnsembleTaskRunner(baseRunner, {
    enabled: true,
    maxCandidatesPerNode: 2,
    maxParallel: 1,
    quorumRatio: 0.5,
  });

  const result = await runner.run(
    { id: "node-2", name: "Implement", role: "coder", dependsOn: [], status: "pending", retries: 0, maxRetries: 1, worktree: await tempWorktree() },
    { OMK_RUN_ID: "test" }
  );

  assert.equal(result.success, true);
  assert.match(result.stderr, /\[edge-cases] candidate crashed/);
  assert.equal(result.metadata.ensemble.winner, "implement");
});

test("ensemble runner propagates abort signals into candidate runners", async () => {
  const controller = new AbortController();
  const seenSignals = [];
  const baseRunner = {
    async run(node, env, signal) {
      seenSignals.push({ id: env.OMK_ENSEMBLE_CANDIDATE_ID, signal });
      if (env.OMK_ENSEMBLE_CANDIDATE_ID === "implement") {
        controller.abort(new Error("stop ensemble"));
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return {
        success: true,
        stdout: `candidate=${env.OMK_ENSEMBLE_CANDIDATE_ID}`,
        stderr: "",
      };
    },
  };
  const runner = createEnsembleTaskRunner(baseRunner, {
    enabled: true,
    maxCandidatesPerNode: 2,
    maxParallel: 1,
    quorumRatio: 0.5,
  });
  const worktree = await tempWorktree();

  await assert.rejects(
    () => runner.run(
      { id: "node-abort", name: "Implement", role: "coder", dependsOn: [], status: "pending", retries: 0, maxRetries: 1, worktree },
      { OMK_RUN_ID: "test" },
      controller.signal,
    ),
    /stop ensemble/,
  );
  assert.equal(seenSignals[0].signal instanceof AbortSignal, true);
  assert.equal(seenSignals[0].signal.aborted, true);
});

test("router ensemble candidates preserve routing metadata and use route-specific roles", async () => {
  const calls = [];
  const baseRunner = {
    async run(node, env) {
      calls.push({ node, env });
      return {
        success: true,
        stdout: `candidate=${env.OMK_ENSEMBLE_CANDIDATE_ID}\nconfidence: 0.9`,
        stderr: "",
      };
    },
  };
  const runner = createEnsembleTaskRunner(baseRunner, {
    enabled: true,
    maxCandidatesPerNode: 2,
    maxParallel: 1,
    quorumRatio: 0.5,
  });

  const result = await runner.run(
    {
      id: "route-1",
      name: "Select skills and MCP for DAG node",
      role: "router",
      dependsOn: [],
      status: "pending",
      retries: 0,
      maxRetries: 1,
      worktree: await tempWorktree(),
      routing: { skills: ["omk-repo-explorer"], mcpServers: ["omk-project"], contextBudget: "tiny" },
    },
    { OMK_RUN_ID: "test" }
  );

  assert.equal(result.success, true);
  assert.deepEqual(calls.map((call) => call.env.OMK_ENSEMBLE_CANDIDATE_ID), ["skill-fit", "safety-budget"]);
  assert.deepEqual(calls.map((call) => call.node.role), ["planner", "reviewer"]);
  assert.equal(calls[0].node.routing.skills[0], "omk-repo-explorer");
});

test("orchestrator ensemble keeps OMK context candidate on router role", async () => {
  const calls = [];
  const baseRunner = {
    async run(node, env) {
      calls.push({ node, env });
      return {
        success: true,
        stdout: `candidate=${env.OMK_ENSEMBLE_CANDIDATE_ID}\nconfidence: 0.9`,
        stderr: "",
      };
    },
  };
  const runner = createEnsembleTaskRunner(baseRunner, {
    enabled: true,
    maxCandidatesPerNode: 2,
    maxParallel: 1,
    quorumRatio: 0.5,
  });

  const result = await runner.run(
    {
      id: "orchestrator-1",
      name: "Coordinate parallel lanes",
      role: "orchestrator",
      dependsOn: [],
      status: "pending",
      retries: 0,
      maxRetries: 1,
      worktree: await tempWorktree(),
    },
    { OMK_RUN_ID: "test" }
  );

  assert.equal(result.success, true);
  assert.deepEqual(calls.map((call) => call.env.OMK_ENSEMBLE_CANDIDATE_ID), ["critical-path", "orchestrator-context"]);
  assert.deepEqual(calls.map((call) => call.node.role), ["planner", "router"]);
});

test("ETA estimator uses completed durations and worker count", () => {
  const estimate = estimateRunProgress({
    startedAt: "2026-05-01T00:00:00.000Z",
    now: new Date("2026-05-01T00:00:05.000Z"),
    workerCount: 2,
    nodes: [
      {
        id: "plan",
        name: "Plan",
        role: "planner",
        dependsOn: [],
        status: "done",
        retries: 0,
        maxRetries: 1,
        durationMs: 1000,
      },
      {
        id: "code",
        name: "Code",
        role: "coder",
        dependsOn: [],
        status: "pending",
        retries: 0,
        maxRetries: 1,
      },
      {
        id: "review",
        name: "Review",
        role: "reviewer",
        dependsOn: [],
        status: "pending",
        retries: 0,
        maxRetries: 1,
      },
    ],
  });

  assert.equal(estimate.averageCompletedDurationMs, 1000);
  assert.equal(estimate.estimatedRemainingMs, 1000);
  assert.equal(estimate.percentComplete, 33);
  assert.equal(estimate.confidence, "medium");
});

test("executor records agent timings and passes ETA environment", async () => {
  await withRoutingSkills(["omk-industrial-control-loop", "omk-typescript-strict"], async () => {
    const savedStates = [];
    const seenEnv = [];
    const executor = createExecutor({
      ensemble: false,
      persister: {
        async load() {
          return null;
        },
        async save(state) {
          savedStates.push(JSON.parse(JSON.stringify(state)));
        },
      },
    });
    const dag = createDag({
      nodes: [
        { id: "plan", name: "Plan DAG implementation", role: "planner", dependsOn: [], maxRetries: 1 },
        { id: "code", name: "Implement TypeScript routing", role: "coder", dependsOn: ["plan"], maxRetries: 1 },
      ],
    });
    const runner = {
      async run(_node, env) {
        seenEnv.push({ ...env });
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { success: true, stdout: "", stderr: "" };
      },
    };

    const result = await executor.execute(dag, runner, {
      runId: "eta-test",
      workers: 1,
      approvalPolicy: "yolo",
    });

    assert.equal(result.success, true);
    assert.equal(result.state.estimate.completedNodes, 2);
    assert.equal(result.state.estimate.estimatedRemainingMs, 0);
    assert.ok(result.state.nodes.every((node) => typeof node.startedAt === "string"));
    assert.ok(result.state.nodes.every((node) => typeof node.completedAt === "string"));
    assert.ok(result.state.nodes.every((node) => typeof node.durationMs === "number"));
    assert.ok(result.state.nodes.every((node) => node.attempts?.length === 1));
    assert.ok(seenEnv.every((env) => typeof env.OMK_ETA_REMAINING_MS === "string"));
    assert.ok(seenEnv.every((env) => typeof env.OMK_SKILL_HINTS === "string"));
    assert.ok(seenEnv.every((env) => typeof env.OMK_HOOK_HINTS === "string"));
    assert.ok(seenEnv.some((env) => env.OMK_SKILL_HINTS.includes("omk-industrial-control-loop")));
    assert.ok(seenEnv.some((env) => env.OMK_SKILL_HINTS.includes("omk-typescript-strict")));
    assert.ok(savedStates.some((state) => state.estimate?.runningNodes === 1));
  });
});

test("executor emits telemetry events without faking activity from progress timer", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "omk-executor-events-"));
  const runId = "executor-events";
  const runDir = join(tempRoot, runId);
  await mkdir(runDir, { recursive: true });
  try {
    const savedStates = [];
    const executor = createExecutor({
      ensemble: false,
      eventRunDir: runDir,
      persister: {
        async load() {
          return null;
        },
        async save(state) {
          savedStates.push(JSON.parse(JSON.stringify(state)));
        },
      },
    });
    const dag = createDag({
      nodes: [
        { id: "work", name: "Work", role: "worker", dependsOn: [], maxRetries: 1 },
      ],
    });
    const runner = {
      fork(onThinking) {
        return {
          async run() {
            onThinking?.("real activity");
            await sleep(900);
            return { success: true, stdout: "", stderr: "" };
          },
        };
      },
      async run() {
        return { success: true, stdout: "", stderr: "" };
      },
    };

    const result = await executor.execute(dag, runner, {
      runId,
      workers: 1,
      approvalPolicy: "yolo",
    });

    assert.equal(result.success, true);
    const lines = (await readFile(join(runDir, "events.jsonl"), "utf-8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((line) => line.seq), [1, 2, 3]);
    assert.equal(lines.some((line) => line.type === "lane.started"), true);
    assert.equal(lines.some((line) => line.type === "lane.activity"), true);
    assert.equal(lines.some((line) => line.type === "lane.completed"), true);
    assert.ok(savedStates.some((state) => state.nodes?.[0]?.status === "running"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

test("scheduler retries node when failure is under maxRetries", () => {
  const dag = createDag({
    nodes: [
      { id: "plan", name: "Plan", role: "planner", dependsOn: [], maxRetries: 3 },
      { id: "code", name: "Code", role: "coder", dependsOn: ["plan"], maxRetries: 1 },
    ],
  });
  const scheduler = createScheduler();

  // First failure — should retry (retries=0 < maxRetries=3)
  scheduler.updateNodeStatus(dag, "plan", "failed");
  assert.equal(dag.nodes.find((node) => node.id === "plan")?.status, "pending");
  assert.equal(dag.nodes.find((node) => node.id === "plan")?.retries, 1);
  assert.equal(dag.nodes.find((node) => node.id === "code")?.status, "pending");

  // Second failure — should retry again (retries=1 < maxRetries=3)
  scheduler.updateNodeStatus(dag, "plan", "failed");
  assert.equal(dag.nodes.find((node) => node.id === "plan")?.status, "pending");
  assert.equal(dag.nodes.find((node) => node.id === "plan")?.retries, 2);

  // Third failure — terminal (retries=2 < maxRetries=3 is false), should block dependents
  scheduler.updateNodeStatus(dag, "plan", "failed");
  assert.equal(dag.nodes.find((node) => node.id === "plan")?.status, "failed");
  assert.equal(dag.nodes.find((node) => node.id === "code")?.status, "blocked");
  assert.equal(scheduler.isFailed(dag), true);
});

test("executor times out hanging node and marks it failed", async () => {
  const executor = createExecutor({ ensemble: false });
  const dag = createDag({
    nodes: [
      { id: "fast", name: "Fast", role: "coder", dependsOn: [], maxRetries: 1 },
      { id: "slow", name: "Slow", role: "coder", dependsOn: [], maxRetries: 1 },
    ],
  });
  const runner = {
    async run(node, _env) {
      if (node.id === "slow") {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return { success: true, stdout: "", stderr: "" };
      }
      return { success: true, stdout: "", stderr: "" };
    },
  };

  let slowResult;
  executor.onNodeComplete((node, result) => {
    if (node.id === "slow") slowResult = result;
  });

  const result = await executor.execute(dag, runner, {
    runId: "timeout-test",
    workers: 2,
    approvalPolicy: "yolo",
    nodeTimeoutMs: 50,
  });

  assert.equal(result.success, false);
  const slowNode = result.state.nodes.find((node) => node.id === "slow");
  const fastNode = result.state.nodes.find((node) => node.id === "fast");
  assert.equal(fastNode?.status, "done");
  assert.equal(slowNode?.status, "failed");
  assert.ok(slowNode?.attempts?.[0]?.status === "failed");
  assert.ok(slowResult?.stderr?.includes("timed out"));
});

test("executor aborts runner signal on timeout to prevent late side effects", async () => {
  const executor = createExecutor({ ensemble: false });
  const sideEffectDir = await mkdtemp(join(tmpdir(), "omk-timeout-abort-"));
  const sideEffectPath = join(sideEffectDir, "late-write.txt");
  const dag = createDag({
    nodes: [
      { id: "slow", name: "Slow", role: "coder", dependsOn: [], maxRetries: 1 },
    ],
  });
  let signalSeen = false;

  const runner = {
    async run(_node, _env, signal) {
      signalSeen = signal instanceof AbortSignal;
      await new Promise((resolve) => {
        const timer = setTimeout(async () => {
          await writeFile(sideEffectPath, "late");
          resolve();
        }, 100);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
        }, { once: true });
      });
      return { success: true, stdout: "", stderr: "" };
    },
  };

  try {
    const result = await executor.execute(dag, runner, {
      runId: "timeout-abort-test",
      workers: 1,
      approvalPolicy: "yolo",
      nodeTimeoutMs: 30,
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(result.success, false);
    assert.equal(signalSeen, true);
    await assert.rejects(readFile(sideEffectPath, "utf-8"), /ENOENT/);
  } finally {
    await rm(sideEffectDir, { recursive: true, force: true });
  }
});

test("executor node timeout cleans real shell descendant process tree", { skip: process.platform === "win32" }, async () => {
  const executor = createExecutor({ ensemble: false });
  const tempDir = await mkdtemp(join(tmpdir(), "omk-executor-timeout-tree-"));
  const pidPath = join(tempDir, "child.pid");
  let childPid;
  const dag = createDag({
    nodes: [
      { id: "shell-tree", name: "Shell tree", role: "coder", dependsOn: [], maxRetries: 1 },
    ],
  });
  const script = `
    const { spawn } = require("node:child_process");
    const { writeFileSync } = require("node:fs");
    const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
    child.unref();
    writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
    setInterval(() => {}, 1000);
  `;
  const runner = {
    async run(_node, _env, signal) {
      return runShellStreaming(process.execPath, ["--eval", script], {
        timeout: 5000,
        signal,
      });
    },
  };

  try {
    const result = await executor.execute(dag, runner, {
      runId: "timeout-tree-test",
      workers: 1,
      approvalPolicy: "yolo",
      nodeTimeoutMs: 250,
    });
    childPid = Number((await waitForFile(pidPath)).trim());
    assert.equal(result.success, false);
    const node = result.state.nodes.find((entry) => entry.id === "shell-tree");
    assert.equal(node?.status, "failed");
    await waitForPidExit(childPid);
  } finally {
    if (childPid) bestEffortKill(childPid);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("executor waits for running siblings before terminal failure resolution", async () => {
  const executor = createExecutor({ ensemble: false });
  const dag = createDag({
    nodes: [
      { id: "fail-fast", name: "Fail fast", role: "coder", dependsOn: [], maxRetries: 1 },
      { id: "slow-sibling", name: "Slow sibling", role: "coder", dependsOn: [], maxRetries: 1 },
    ],
  });
  let slowCompleted = false;
  const runner = {
    async run(node, _env) {
      if (node.id === "fail-fast") {
        return { success: false, stdout: "", stderr: "boom" };
      }
      await new Promise((resolve) => setTimeout(resolve, 75));
      slowCompleted = true;
      return { success: true, stdout: "", stderr: "" };
    },
  };

  const result = await executor.execute(dag, runner, {
    runId: "terminal-sibling-race-test",
    workers: 2,
    approvalPolicy: "yolo",
  });

  assert.equal(result.success, false);
  assert.equal(slowCompleted, true);
  assert.equal(result.state.nodes.find((node) => node.id === "fail-fast")?.status, "failed");
  assert.equal(result.state.nodes.find((node) => node.id === "slow-sibling")?.status, "done");
});

test("executor does not let optional advisory lanes monopolize the single core worker slot", async () => {
  const executor = createExecutor({ ensemble: false });
  const started = [];
  const dag = createDag({
    nodes: [
      {
        id: "advisory",
        name: "DeepSeek advisory",
        role: "reviewer",
        dependsOn: [],
        maxRetries: 1,
        priority: 100,
        failurePolicy: { retryable: true, blockDependents: false, skipOnFailure: true },
        outputs: [{ name: "advisory output", gate: "none", required: false }],
        routing: {
          assignedProvider: "deepseek",
          assignedProviderAuthority: "advisory",
          assignedProviderCapabilities: ["read", "review"],
          readOnly: true,
        },
      },
      {
        id: "worker",
        name: "Required worker",
        role: "coder",
        dependsOn: [],
        maxRetries: 1,
        outputs: [{ name: "worker output", gate: "none" }],
      },
      {
        id: "review-merge",
        name: "Review merge",
        role: "reviewer",
        dependsOn: ["worker", "advisory"],
        maxRetries: 1,
        inputs: [
          { name: "worker output", ref: "state.json", from: "worker" },
          { name: "advisory output", ref: "state.json", from: "advisory", required: false },
        ],
        outputs: [{ name: "verified result", gate: "none" }],
      },
    ],
  });
  const runner = {
    async run(node) {
      started.push(node.id);
      if (node.id === "advisory") {
        return new Promise(() => {});
      }
      await sleep(5);
      return { success: true, stdout: "## Evidence\nok", stderr: "" };
    },
  };

  const result = await executor.execute(dag, runner, {
    runId: "single-worker-optional-slot-test",
    workers: 1,
    approvalPolicy: "yolo",
    runTimeoutMs: 500,
  });

  assert.equal(result.success, true);
  assert.deepEqual(started, ["worker", "review-merge"]);
  assert.equal(result.state.nodes.find((node) => node.id === "advisory")?.status, "skipped");
  assert.equal(result.state.nodes.find((node) => node.id === "worker")?.status, "done");
  assert.equal(result.state.nodes.find((node) => node.id === "review-merge")?.status, "done");
});

test("executor bypasses ensemble fanout for optional DeepSeek provider lanes", async () => {
  const executor = createExecutor({
    ensemble: { enabled: true, maxCandidatesPerNode: 2, maxParallel: 2, quorumRatio: 0.5 },
  });
  const calls = [];
  const dag = createDag({
    nodes: [
      {
        id: "deepseek-flash-agent",
        name: "DeepSeek Flash optional lane",
        role: "reviewer",
        dependsOn: [],
        maxRetries: 1,
        failurePolicy: { retryable: true, blockDependents: false, skipOnFailure: true },
        outputs: [{ name: "deepseek output", gate: "none", required: false }],
        routing: {
          provider: "deepseek",
          assignedProvider: "deepseek",
          assignedProviderAuthority: "direct",
          readOnly: true,
        },
      },
    ],
  });
  const runner = {
    async run(node, env) {
      calls.push({ node, env });
      return {
        success: true,
        stdout: "DeepSeek optional output",
        stderr: "",
        metadata: { provider: "deepseek", requestedProvider: "deepseek", providerParticipation: "direct" },
      };
    },
  };

  const result = await executor.execute(dag, runner, {
    runId: "optional-deepseek-no-ensemble-fanout-test",
    workers: 1,
    approvalPolicy: "yolo",
  });

  assert.equal(result.success, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].env.OMK_ENSEMBLE, undefined);
  assert.equal(result.state.nodes[0].attempts.at(-1)?.provider, "deepseek");
  assert.equal(result.state.nodes[0].attempts.at(-1)?.providerParticipation, "direct");
});

test("executor passes OMK-owned worker context to parallel TaskRunner nodes", async () => {
  let capturedContext;
  let capturedEnv;
  const startedAt = new Date(0).toISOString();
  const dag = createDag({
    nodes: [
      {
        id: "owned-worker",
        name: "Implement owned worker context",
        role: "coder",
        dependsOn: [],
        maxRetries: 1,
        routing: {
          provider: "codex",
          readOnly: false,
          requiresMcp: true,
          requiresToolCalling: true,
          skills: ["omk-typescript-strict"],
          mcpServers: ["omk-project"],
          hooks: ["protect-secrets.sh"],
          tools: ["apply_patch"],
          assignedProviderCapabilities: ["write", "patch", "shell", "mcp"],
        },
      },
    ],
  });
  const executor = createExecutor({
    ensemble: false,
    resumeFromState: {
      schemaVersion: 1,
      runId: "executor-owned-context-test",
      goalId: "goal-owned-context",
      goalSnapshot: {
        title: "Parallel owned context",
        objective: "Coordinate workers with assigned skills, hooks, and MCP",
        successCriteria: [],
      },
      nodes: dag.nodes.map((node) => ({ ...node })),
      startedAt,
    },
  });
  const runner = {
    async run(_node, env, _signal, context) {
      capturedEnv = env;
      capturedContext = context;
      return { success: true, stdout: "## Evidence\nok", stderr: "" };
    },
  };

  const result = await executor.execute(dag, runner, {
    runId: "executor-owned-context-test",
    workers: 1,
    approvalPolicy: "yolo",
  });

  assert.equal(result.success, true);
  assert.equal(capturedContext.worker.owner, "omk");
  assert.equal(capturedContext.goal.goalId, "goal-owned-context");
  assert.equal(capturedContext.goal.objective, "Coordinate workers with assigned skills, hooks, and MCP");
  assert.deepEqual(capturedContext.worker.toolPlane.mcpServers, ["omk-project"]);
  assert.deepEqual(capturedContext.worker.toolPlane.skills, ["omk-typescript-strict"]);
  assert.deepEqual(capturedContext.worker.toolPlane.hooks, ["protect-secrets.sh"]);
  assert.deepEqual(capturedContext.worker.toolPlane.tools, ["apply_patch"]);
  assert.equal(capturedEnv.OMK_WORKER_MANIFEST_OWNER, "omk");
  assert.equal(capturedEnv.OMK_NODE_MCP_SERVERS, "omk-project");
  assert.equal(capturedEnv.OMK_NODE_SKILLS, "omk-typescript-strict");
  assert.equal(capturedEnv.OMK_NODE_HOOKS, "protect-secrets.sh");
  assert.equal(capturedEnv.OMK_NODE_TOOLS, "apply_patch");
});

test("executor rejects fractional worker counts", async () => {
  const executor = createExecutor({ ensemble: false });
  const dag = createDag({
    nodes: [
      { id: "plan", name: "Plan", role: "planner", dependsOn: [], maxRetries: 1 },
    ],
  });
  const runner = {
    async run() {
      return { success: true, stdout: "", stderr: "" };
    },
  };

  await assert.rejects(
    () => executor.execute(dag, runner, {
      runId: "fractional-workers-test",
      workers: 1.5,
      approvalPolicy: "yolo",
    }),
    /positive integer/
  );
});

test("executor node timeout preset overrides run preset and default node timeout", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-timeout-preset-"));
  const previousRoot = process.env.OMK_PROJECT_ROOT;
  process.env.OMK_PROJECT_ROOT = projectRoot;
  resetTimeoutPresetCache();

  try {
    await mkdir(join(projectRoot, ".omk"), { recursive: true });
    await writeFile(
      join(projectRoot, ".omk", "config.toml"),
      "[timeouts.tiny]\ntimeout_ms = 50\n\n[timeouts.slow]\ntimeout_ms = 500\n"
    );

    const executor = createExecutor({ ensemble: false });
    const dag = createDag({
      nodes: [
        { id: "slow", name: "Slow", role: "coder", dependsOn: [], maxRetries: 1, timeoutPreset: "tiny" },
      ],
    });
    const runner = {
      async run() {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return { success: true, stdout: "", stderr: "" };
      },
    };
    let slowResult;
    executor.onNodeComplete((node, taskResult) => {
      if (node.id === "slow") slowResult = taskResult;
    });

    const result = await executor.execute(dag, runner, {
      runId: "timeout-preset-test",
      workers: 1,
      approvalPolicy: "yolo",
      nodeTimeoutMs: 5_000,
      timeoutPreset: "slow",
    });

    assert.equal(result.success, false);
    const slowNode = result.state.nodes.find((node) => node.id === "slow");
    assert.equal(slowNode?.status, "failed");
    assert.match(slowResult?.stderr ?? "", /timed out after 50ms/);
  } finally {
    resetTimeoutPresetCache();
    restoreEnv("OMK_PROJECT_ROOT", previousRoot);
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("resolveTimeoutMs rejects unknown timeout presets", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-timeout-invalid-"));
  const previousRoot = process.env.OMK_PROJECT_ROOT;
  process.env.OMK_PROJECT_ROOT = projectRoot;
  resetTimeoutPresetCache();

  try {
    await mkdir(join(projectRoot, ".omk"), { recursive: true });
    await assert.rejects(
      resolveTimeoutMs({ timeoutPreset: "does-not-exist" }),
      /Unknown timeout preset "does-not-exist".*default/
    );
  } finally {
    resetTimeoutPresetCache();
    restoreEnv("OMK_PROJECT_ROOT", previousRoot);
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("executor uses OMK_NODE_TIMEOUT_MS when no explicit timeout or preset is set", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-timeout-env-"));
  const previousRoot = process.env.OMK_PROJECT_ROOT;
  const previousTimeout = process.env.OMK_NODE_TIMEOUT_MS;
  process.env.OMK_PROJECT_ROOT = projectRoot;
  process.env.OMK_NODE_TIMEOUT_MS = "50";
  resetTimeoutPresetCache();

  try {
    await mkdir(join(projectRoot, ".omk"), { recursive: true });
    const executor = createExecutor({ ensemble: false });
    const dag = createDag({
      nodes: [
        { id: "slow", name: "Slow", role: "coder", dependsOn: [], maxRetries: 1 },
      ],
    });
    const runner = {
      async run() {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return { success: true, stdout: "", stderr: "" };
      },
    };
    let slowResult;
    executor.onNodeComplete((node, taskResult) => {
      if (node.id === "slow") slowResult = taskResult;
    });

    const result = await executor.execute(dag, runner, {
      runId: "timeout-env-test",
      workers: 1,
      approvalPolicy: "yolo",
    });

    assert.equal(result.success, false);
    const slowNode = result.state.nodes.find((node) => node.id === "slow");
    assert.equal(slowNode?.status, "failed");
    assert.match(slowResult?.stderr ?? "", /timed out after 50ms/);
  } finally {
    resetTimeoutPresetCache();
    restoreEnv("OMK_PROJECT_ROOT", previousRoot);
    restoreEnv("OMK_NODE_TIMEOUT_MS", previousTimeout);
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("executor returns failure when all nodes are blocked", async () => {
  const executor = createExecutor({ ensemble: false });
  // Build a valid DAG then manually block every node to simulate total dependency failure
  const dag = createDag({
    nodes: [
      { id: "a", name: "A", role: "coder", dependsOn: [], maxRetries: 1 },
      { id: "b", name: "B", role: "coder", dependsOn: ["a"], maxRetries: 1 },
    ],
  });
  dag.nodes[0].status = "blocked";
  dag.nodes[0].blockedReason = "manual block";
  dag.nodes[1].status = "blocked";
  dag.nodes[1].blockedReason = "manual block";

  const runner = {
    async run() {
      return { success: true, stdout: "", stderr: "" };
    },
  };

  const result = await executor.execute(dag, runner, {
    runId: "blocked-test",
    workers: 1,
    approvalPolicy: "yolo",
  });

  assert.equal(result.success, false);
});

test("state persister writes atomically via temp file", async () => {
  const { createStatePersister } = await import("../dist/orchestration/state-persister.js");
  const tmpDir = await mkdtemp(join(tmpdir(), "omk-state-"));
  const persister = createStatePersister(tmpDir);

  const state = {
    runId: "atomic-test",
    nodes: [],
    startedAt: new Date().toISOString(),
  };

  await persister.save(state);
  const loaded = await persister.load("atomic-test");
  assert.equal(loaded.runId, "atomic-test");

  // Verify no temp files left behind
  const entries = await (await import("node:fs/promises")).readdir(join(tmpDir, "atomic-test"));
  assert.ok(entries.includes("state.json"));
  assert.ok(!entries.some((e) => e.endsWith(".tmp")), "temp file should be cleaned up after successful rename");

  await rm(tmpDir, { recursive: true, force: true });
});

test("executor commit queue decrements once after persist completion", async () => {
  const source = await readFile(join(process.cwd(), "dist", "orchestration", "executor.js"), "utf-8");
  assert.match(source, /commitQueueSize = Math\.max\(0, commitQueueSize - 1\)/);
  assert.doesNotMatch(source, /\.catch\(\(err\)[\s\S]{0,160}commitQueueSize--/);
});

test("skipNode propagates skip to dependents", () => {
  const dag = createDag({
    nodes: [
      { id: "plan", name: "Plan", role: "planner", dependsOn: [], maxRetries: 1 },
      { id: "code", name: "Code", role: "coder", dependsOn: ["plan"], maxRetries: 1 },
      { id: "review", name: "Review", role: "reviewer", dependsOn: ["code"], maxRetries: 1 },
    ],
  });

  skipNode(dag, "plan");

  assert.equal(dag.nodes.find((n) => n.id === "plan")?.status, "skipped");
  assert.equal(dag.nodes.find((n) => n.id === "code")?.status, "skipped");
  assert.equal(dag.nodes.find((n) => n.id === "review")?.status, "skipped");
});

test("scheduler skipOnFailure skips dependents instead of blocking", () => {
  const dag = createDag({
    nodes: [
      { id: "plan", name: "Plan", role: "planner", dependsOn: [], maxRetries: 1, failurePolicy: { skipOnFailure: true } },
      { id: "code", name: "Code", role: "coder", dependsOn: ["plan"], maxRetries: 1 },
    ],
  });
  const scheduler = createScheduler();

  scheduler.updateNodeStatus(dag, "plan", "failed");

  assert.equal(dag.nodes.find((n) => n.id === "plan")?.status, "skipped");
  assert.equal(dag.nodes.find((n) => n.id === "code")?.status, "skipped");
  assert.equal(scheduler.isFailed(dag), false);
  assert.equal(scheduler.isComplete(dag), true);
});

test("executor runs fallback node when terminal failure has fallbackRole", async () => {
  const executor = createExecutor({ ensemble: false });
  const dag = createDag({
    nodes: [
      { id: "plan", name: "Plan", role: "planner", dependsOn: [], maxRetries: 1, failurePolicy: { fallbackRole: "coder" } },
      { id: "code", name: "Code", role: "coder", dependsOn: ["plan"], maxRetries: 1 },
    ],
  });
  const runner = {
    async run(node, _env) {
      if (node.role === "planner") {
        return { success: false, stdout: "", stderr: "plan failed" };
      }
      return { success: true, stdout: "fallback ok", stderr: "" };
    },
  };

  const result = await executor.execute(dag, runner, {
    runId: "fallback-test",
    workers: 1,
    approvalPolicy: "yolo",
  });

  const fallbackNode = result.state.nodes.find((n) => n.id === "plan--fallback");
  assert.ok(fallbackNode, "fallback node should exist");
  assert.equal(fallbackNode.status, "done");
  assert.equal(result.state.nodes.find((n) => n.id === "code")?.status, "done");
  assert.equal(result.success, true);
});

test("executor rewrites dependent inputs when fallback node replaces failed dependency", async () => {
  const executor = createExecutor({ ensemble: false });
  const dag = createDag({
    nodes: [
      { id: "plan", name: "Plan", role: "planner", dependsOn: [], maxRetries: 1, failurePolicy: { fallbackRole: "coder" } },
      {
        id: "code",
        name: "Code",
        role: "coder",
        dependsOn: ["plan"],
        maxRetries: 1,
        inputs: [{ name: "plan output", ref: "plan.md", from: "plan" }],
      },
    ],
  });
  const runner = {
    async run(node) {
      if (node.id === "plan") return { success: false, stdout: "", stderr: "plan failed" };
      return { success: true, stdout: "ok", stderr: "" };
    },
  };

  const result = await executor.execute(dag, runner, {
    runId: "fallback-input-rewrite-test",
    workers: 1,
    approvalPolicy: "yolo",
  });

  assert.equal(result.success, true);
  const codeNode = result.state.nodes.find((node) => node.id === "code");
  assert.equal(codeNode?.dependsOn.includes("plan--fallback"), true);
  assert.equal(codeNode?.inputs?.[0]?.from, "plan--fallback");
});


test("executor fallback node inherits evidence gates and blocks dependents on missing artifacts", async () => {
  const executor = createExecutor({ ensemble: false });
  const tmpDir = await mkdtemp(join(tmpdir(), "omk-fallback-evidence-"));
  const dag = createDag({
    nodes: [
      {
        id: "plan",
        name: "Plan",
        role: "planner",
        dependsOn: [],
        maxRetries: 1,
        outputs: [{ name: "artifact", ref: "artifact.txt", gate: "file-exists" }],
        failurePolicy: { fallbackRole: "coder" },
      },
      { id: "code", name: "Code", role: "coder", dependsOn: ["plan"], maxRetries: 1 },
    ],
  });
  const runner = {
    async run(node, _env) {
      if (node.role === "planner") {
        return { success: false, stdout: "", stderr: "plan failed" };
      }
      return { success: true, stdout: "fallback ok", stderr: "" };
    },
  };

  try {
    const result = await executor.execute(dag, runner, {
      runId: "fallback-evidence-test",
      workers: 1,
      approvalPolicy: "yolo",
      worktreeRoot: tmpDir,
    });

    const fallbackNode = result.state.nodes.find((n) => n.id === "plan--fallback");
    assert.ok(fallbackNode, "fallback node should exist");
    assert.equal(fallbackNode.status, "failed");
    assert.equal(fallbackNode.outputs?.[0]?.gate, "file-exists");
    assert.equal(fallbackNode.evidence?.[0]?.passed, false);
    assert.match(fallbackNode.evidence?.[0]?.message ?? "", /File does not exist/);
    assert.equal(result.state.nodes.find((n) => n.id === "code")?.status, "blocked");
    assert.equal(result.success, false);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("executor respects AbortSignal and cancels pending nodes", async () => {
  const ac = new AbortController();
  const executor = createExecutor({ ensemble: false, signal: ac.signal });
  const dag = createDag({
    nodes: [
      { id: "a", name: "A", role: "coder", dependsOn: [], maxRetries: 1 },
      { id: "b", name: "B", role: "coder", dependsOn: ["a"], maxRetries: 1 },
    ],
  });
  const runner = {
    async run(node, _env) {
      if (node.id === "a") {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { success: true, stdout: "", stderr: "" };
      }
      return { success: true, stdout: "", stderr: "" };
    },
  };

  setTimeout(() => ac.abort(), 10);

  const result = await executor.execute(dag, runner, {
    runId: "cancel-test",
    workers: 1,
    approvalPolicy: "yolo",
  });

  assert.equal(result.success, false);
  assert.ok(result.state.nodes.some((n) => n.status === "blocked" && n.blockedReason === "cancelled"));
});

test("executor external AbortSignal resolves even when running node ignores signal", async () => {
  const ac = new AbortController();
  const executor = createExecutor({ ensemble: false, signal: ac.signal });
  const dag = createDag({
    nodes: [
      { id: "hang", name: "Hang", role: "coder", dependsOn: [], maxRetries: 1 },
      { id: "after", name: "After", role: "coder", dependsOn: ["hang"], maxRetries: 1 },
    ],
  });
  const runner = {
    async run() {
      return new Promise(() => {});
    },
  };

  setTimeout(() => ac.abort(), 10);
  const startedAt = Date.now();
  const result = await executor.execute(dag, runner, {
    runId: "external-abort-hanging-node-test",
    workers: 1,
    approvalPolicy: "yolo",
  });

  assert.equal(result.success, false);
  assert.ok(Date.now() - startedAt < 1000);
  assert.ok(result.state.nodes.some((n) => n.status === "blocked" && n.blockedReason === "cancelled"));
});

test("executor resets shutdown flags between execute calls on the same instance", async () => {
  const executor = createExecutor({ ensemble: false });
  const firstDag = createDag({
    nodes: [
      { id: "hang", name: "Hang", role: "coder", dependsOn: [], maxRetries: 1 },
    ],
  });
  const abortAwareRunner = {
    async run(_node, _env, signal) {
      return await new Promise((resolve) => {
        signal?.addEventListener("abort", () => {
          resolve({ success: false, stdout: "", stderr: "aborted" });
        }, { once: true });
      });
    },
  };

  const first = await executor.execute(firstDag, abortAwareRunner, {
    runId: "reset-shutdown-first",
    workers: 1,
    approvalPolicy: "yolo",
    runTimeoutMs: 30,
  });
  assert.equal(first.success, false);

  const secondDag = createDag({
    nodes: [
      { id: "fast", name: "Fast", role: "coder", dependsOn: [], maxRetries: 1 },
    ],
  });
  const second = await executor.execute(secondDag, {
    async run() {
      return { success: true, stdout: "ok", stderr: "" };
    },
  }, {
    runId: "reset-shutdown-second",
    workers: 1,
    approvalPolicy: "yolo",
  });

  assert.equal(second.success, true);
  assert.equal(second.state.nodes[0].status, "done");
});

test("executor records evidence when runner ignores abort after node timeout", async () => {
  const executor = createExecutor({ ensemble: false });
  const dag = createDag({
    nodes: [
      { id: "ignore-abort", name: "Ignore abort", role: "coder", dependsOn: [], maxRetries: 1 },
    ],
  });
  let sawAbort = false;
  const runner = {
    async run(_node, _env, signal) {
      signal?.addEventListener("abort", () => {
        sawAbort = true;
      }, { once: true });
      return new Promise(() => {});
    },
  };

  const startedAt = Date.now();
  const result = await executor.execute(dag, runner, {
    runId: "ignored-abort-evidence-test",
    workers: 1,
    approvalPolicy: "yolo",
    nodeTimeoutMs: 30,
  });

  assert.equal(result.success, false);
  assert.equal(sawAbort, true);
  assert.ok(Date.now() - startedAt < 3500);
  const node = result.state.nodes.find((entry) => entry.id === "ignore-abort");
  assert.equal(node?.status, "failed");
  assert.ok(node?.evidence?.some((entry) =>
    entry.gate === "runner-abort" &&
    entry.passed === false &&
    /did not settle/.test(entry.message ?? "")
  ));
});

test("executor runTimeoutMs persists terminal blocked state before resolving", async () => {
  const savedStates = [];
  const executor = createExecutor({
    ensemble: false,
    persister: {
      async load() {
        return null;
      },
      async save(state) {
        savedStates.push(JSON.parse(JSON.stringify(state)));
      },
    },
  });
  const dag = createDag({
    nodes: [
      { id: "hang", name: "Hang", role: "coder", dependsOn: [], maxRetries: 1 },
    ],
  });
  const runner = {
    async run() {
      return new Promise(() => {});
    },
  };

  const result = await executor.execute(dag, runner, {
    runId: "run-timeout-persist-test",
    workers: 1,
    approvalPolicy: "yolo",
    runTimeoutMs: 30,
  });

  assert.equal(result.success, false);
  const finalSaved = savedStates.at(-1);
  assert.ok(finalSaved.completedAt);
  assert.equal(finalSaved.nodes[0].status, "blocked");
  assert.equal(finalSaved.nodes[0].blockedReason, "run timeout");
});

test("executor resumes from persisted state and skips done nodes", async () => {
  const executor = createExecutor({
    ensemble: false,
    resumeFromState: {
      runId: "resume-test",
      startedAt: new Date().toISOString(),
      nodes: [
        {
          id: "plan",
          name: "Plan",
          role: "planner",
          dependsOn: [],
          status: "done",
          retries: 0,
          maxRetries: 1,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        },
        {
          id: "code",
          name: "Code",
          role: "coder",
          dependsOn: ["plan"],
          status: "pending",
          retries: 0,
          maxRetries: 1,
        },
      ],
    },
  });
  const dag = createDag({
    nodes: [
      { id: "plan", name: "Plan", role: "planner", dependsOn: [], maxRetries: 1 },
      { id: "code", name: "Code", role: "coder", dependsOn: ["plan"], maxRetries: 1 },
    ],
  });
  let codeRan = false;
  const runner = {
    async run(node, _env) {
      if (node.id === "code") codeRan = true;
      return { success: true, stdout: "", stderr: "" };
    },
  };

  const result = await executor.execute(dag, runner, {
    runId: "resume-test",
    workers: 1,
    approvalPolicy: "yolo",
  });

  assert.equal(result.success, true);
  assert.equal(codeRan, true);
  assert.equal(result.state.nodes.find((n) => n.id === "plan")?.status, "done");
  assert.equal(result.state.nodes.find((n) => n.id === "code")?.status, "done");
});

test("evidence gate fails node when file-exists gate misses", async () => {
  const executor = createExecutor({ ensemble: false });
  const dag = createDag({
    nodes: [
      {
        id: "build",
        name: "Build",
        role: "coder",
        dependsOn: [],
        maxRetries: 1,
        outputs: [{ name: "dist", gate: "file-exists", ref: "/nonexistent/path/xyz.txt" }],
      },
    ],
  });
  const runner = {
    async run() {
      return { success: true, stdout: "built", stderr: "" };
    },
  };

  const result = await executor.execute(dag, runner, {
    runId: "evidence-test",
    workers: 1,
    approvalPolicy: "yolo",
  });

  assert.equal(result.success, false);
  const buildNode = result.state.nodes.find((n) => n.id === "build");
  assert.equal(buildNode?.status, "failed");
  assert.ok(buildNode?.evidence?.some((e) => e.gate === "file-exists" && !e.passed));
});

test("evidence gate blocks file-exists refs outside worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "omk-evidence-boundary-"));
  const worktree = join(root, "worktree");
  await mkdir(worktree, { recursive: true });
  await writeFile(join(root, "outside.txt"), "outside");

  try {
    const executor = createExecutor({ ensemble: false });
    const dag = createDag({
      nodes: [
        {
          id: "artifact",
          name: "Artifact",
          role: "coder",
          dependsOn: [],
          maxRetries: 1,
          outputs: [{ name: "outside", gate: "file-exists", ref: "../outside.txt" }],
        },
      ],
    });
    const runner = {
      async run() {
        return { success: true, stdout: "built", stderr: "" };
      },
    };

    const result = await executor.execute(dag, runner, {
      runId: "evidence-boundary-test",
      workers: 1,
      approvalPolicy: "yolo",
      worktreeRoot: worktree,
    });

    assert.equal(result.success, false);
    const artifactNode = result.state.nodes.find((node) => node.id === "artifact");
    assert.equal(artifactNode?.status, "failed");
    assert.ok(artifactNode?.evidence?.some((e) => e.gate === "file-exists" && !e.passed && e.message?.includes("outside workspace")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("evidence gate blocks file-exists symlink escapes outside worktree", {
  skip: process.platform === "win32" ? "Symlinks require admin privileges on Windows" : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "omk-evidence-symlink-"));
  const worktree = join(root, "worktree");
  await mkdir(worktree, { recursive: true });
  await writeFile(join(root, "outside.txt"), "outside");
  await symlink(join(root, "outside.txt"), join(worktree, "artifact.txt"));

  try {
    const executor = createExecutor({ ensemble: false });
    const dag = createDag({
      nodes: [
        {
          id: "artifact",
          name: "Artifact",
          role: "coder",
          dependsOn: [],
          maxRetries: 1,
          outputs: [{ name: "artifact", gate: "file-exists", ref: "artifact.txt" }],
        },
      ],
    });
    const runner = {
      async run() {
        return { success: true, stdout: "built", stderr: "" };
      },
    };

    const result = await executor.execute(dag, runner, {
      runId: "evidence-symlink-test",
      workers: 1,
      approvalPolicy: "yolo",
      worktreeRoot: worktree,
    });

    assert.equal(result.success, false);
    const artifactNode = result.state.nodes.find((node) => node.id === "artifact");
    assert.equal(artifactNode?.status, "failed");
    assert.ok(artifactNode?.evidence?.some((e) => e.gate === "file-exists" && !e.passed && e.message?.includes("outside workspace")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("createExecutableDagFromState restores done node runtime fields", () => {
  const startedAt = new Date().toISOString();
  const completedAt = new Date().toISOString();
  const state = {
    runId: "exec-test",
    startedAt,
    nodes: [
      {
        id: "plan",
        name: "Plan",
        role: "planner",
        dependsOn: [],
        status: "done",
        retries: 0,
        maxRetries: 1,
        startedAt,
        completedAt,
        durationMs: 1234,
        attempts: [{ attempt: 1, startedAt, completedAt, durationMs: 1234, status: "done" }],
      },
      {
        id: "code",
        name: "Code",
        role: "coder",
        dependsOn: ["plan"],
        status: "pending",
        retries: 0,
        maxRetries: 1,
      },
    ],
  };

  const dag = createExecutableDagFromState(state);
  const planNode = dag.nodes.find((n) => n.id === "plan");
  const codeNode = dag.nodes.find((n) => n.id === "code");

  assert.equal(planNode?.status, "done");
  assert.equal(planNode?.startedAt, startedAt);
  assert.equal(planNode?.completedAt, completedAt);
  assert.equal(planNode?.durationMs, 1234);
  assert.equal(planNode?.attempts?.length, 1);
  assert.equal(codeNode?.status, "pending");
});

test("createExecutableDagFromState forces bootstrap to done", () => {
  const startedAt = new Date().toISOString();
  const state = {
    runId: "bootstrap-test",
    startedAt,
    nodes: [
      {
        id: "bootstrap",
        name: "Bootstrap",
        role: "omk",
        dependsOn: [],
        status: "pending",
        retries: 0,
        maxRetries: 1,
      },
    ],
  };

  const dag = createExecutableDagFromState(state);
  const bootstrap = dag.nodes.find((n) => n.id === "bootstrap");
  assert.equal(bootstrap?.status, "done");
  assert.equal(bootstrap?.startedAt, startedAt);
  assert.equal(bootstrap?.completedAt, startedAt);
});
