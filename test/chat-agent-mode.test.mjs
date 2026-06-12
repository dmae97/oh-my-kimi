import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildChatAgentRuntimeMcpAllowlist,
  buildChatAgentRuntimeSkillAllowlist,
  buildChatAgentHarnessManifest,
  buildChatAgentModeContract,
  buildParallelAlgorithmInjection,
  prepareChatAgentModeAgent,
} from "../dist/util/chat-agent-mode.js";

test("chat agent mode contract captures mode and active runtime resources", () => {
  const contract = buildChatAgentModeContract({
    mode: "agent",
    runId: "chat-agent-test",
    resources: {
      workers: "3",
      maxStepsPerTurn: "12",
      resourceProfile: "standard",
      approvalPolicy: "interactive",
      providerPolicy: "auto",
      ensembleDefaultEnabled: true,
      mcpScope: "all",
      skillsScope: "all",
      hooksScope: "project",
      mcpNames: ["omk-project"],
      skillNames: ["omk-repo-explorer"],
      hookNames: ["subagent-stop-audit.sh"],
    },
  });

  assert.match(contract, /Mode: agent/);
  assert.match(contract, /Active MCP \(1\): count=1; digest=[a-f0-9]{12}; full=chat-agent-harness\.json/);
  assert.match(contract, /Active skills \(1\): count=1; digest=[a-f0-9]{12}; full=chat-agent-harness\.json/);
  assert.match(contract, /Active hooks \(1\): count=1; digest=[a-f0-9]{12}; full=chat-agent-harness\.json/);
  assert.match(contract, /Harness manifest: \.\/chat-agent-harness\.json/);
  assert.match(contract, /Authority provider: kimi/);
  assert.match(contract, /Treat every non-trivial user prompt as an orchestration request/);
  assert.match(contract, /Hard gate: in non-chat modes, every non-trivial user prompt MUST ask parallel agents vs one-by-one/);
  assert.match(contract, /root MUST spawn bounded Agent-tool lanes in parallel: explorer, planner, coder, reviewer, qa/);
  assert.match(contract, /IntentFrame and ActionAtoms/);
  assert.match(contract, /delegate bounded subagents/);
  assert.match(contract, /Injected parallel DAG algorithm/);
  assert.match(contract, /Raw Input -> IntentFrame -> ActionAtoms -> Evidence DAG -> Novelty Guard -> Replan\/Continue/);
  assert.match(contract, /raw input in audit\/digest artifacts only/);
  assert.match(contract, /bootstrap\(done\) -> root-coordinator -> model\/capability\/worker lanes -> review-merge -> quality\/security\/design gates/);
  assert.match(contract, /DeepSeek direct lanes are read-only/);
  assert.doesNotMatch(contract, /Kimi keeps root\/integrator authority|Kimi\/OMK chat owns edits|integrator is Kimi-only/);
  assert.match(contract, /default command-pass gate is `npm run check`/);
  assert.match(contract, /authority=kimi; ensemble=enabled; workerCap=3/);
});

test("parallel algorithm injection mirrors the parallel DAG routing contract", () => {
  const injection = buildParallelAlgorithmInjection({
    workers: "9",
    maxStepsPerTurn: "20",
    resourceProfile: "standard",
    approvalPolicy: "interactive",
    providerPolicy: "auto",
    ensembleDefaultEnabled: true,
    mcpScope: "project",
    skillsScope: "project",
    hooksScope: "project",
    mcpNames: ["omk-project"],
    skillNames: ["omk-context-broker"],
    hookNames: ["routing-hints"],
  });

  assert.equal(injection.workerCap, 6);
  assert.match(injection.text, /Progressive intent algorithm/);
  assert.match(injection.text, /Strict action DAG/);
  assert.match(injection.text, /Intent schema to infer before delegation: taskType, complexity, estimatedWorkers/);
  assert.match(injection.text, /Capability-agent routing: when active inventory exists/);
  assert.match(injection.text, /spawn read-only Flash quick-decomposition and Pro critique lanes/);
  assert.match(injection.text, /review-merge depends on every model, capability, and worker lane/);
  assert.match(injection.text, /read `chat-agent-harness\.json` for the full MCP\/skills\/hooks inventory/);
});

test("chat agent harness manifest captures full inventory and safe worker limits", () => {
  const skills = Array.from({ length: 32 }, (_, index) => `skill-${index + 1}`);
  const manifest = buildChatAgentHarnessManifest({
    mode: "agent",
    runId: "chat-agent-harness",
    resources: {
      workers: "4",
      resourceProfile: "standard",
      approvalPolicy: "interactive",
      providerPolicy: "auto",
      ensembleDefaultEnabled: true,
      mcpScope: "all",
      skillsScope: "all",
      hooksScope: "all",
      mcpNames: ["omk-project", "omk-project"],
      skillNames: skills,
      hookNames: ["pre-shell-guard.sh"],
    },
  });

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.resources.workerBudget, 4);
  assert.equal(manifest.resources.workerCap, 4);
  assert.equal(manifest.resources.providerPolicy, "auto");
  assert.equal(manifest.resources.authorityProvider, "kimi");
  assert.equal(manifest.resources.providerModel, "auto");
  assert.deepEqual(manifest.resources.active.mcp, ["omk-project"]);
  assert.equal(manifest.resources.active.skills.length, 32);
  assert.equal(manifest.capabilityPolicy.useMcp, true);
  assert.equal(manifest.capabilityPolicy.useSkills, true);
  assert.equal(manifest.capabilityPolicy.useHooks, true);
  assert.deepEqual(manifest.execution.allowed, ["ask", "auto", "parallel", "sequential"]);
  assert.equal(manifest.execution.policy, "ask");
  assert.equal(manifest.hardGateContract.requiresPromptBeforeNonTrivialTTY, true);
  assert.ok(manifest.hardGateContract.parallelKeywords.includes("병렬"));
  assert.ok(manifest.laneCapabilityAssignments.some((lane) => lane.laneId === "explorer" && lane.mcpServers.includes("omk-project")));
  assert.ok(manifest.laneCapabilityAssignments.some((lane) => lane.laneId === "qa"));
  assert.ok(manifest.virtualDag.nodes.some((node) => node.id === "capability-skill-agent"));
  assert.ok(manifest.virtualDag.nodes.some((node) => node.id === "capability-mcp-agent"));
  assert.ok(manifest.virtualDag.nodes.some((node) => node.id === "capability-hook-agent"));
  assert.ok(manifest.virtualDag.nodes.some((node) => node.id === "review-merge"));
  assert.equal(manifest.virtualDag.nodes.find((node) => node.id === "capability-skill-agent")?.assignedCapabilities.skills.length, 32);
  assert.deepEqual(manifest.virtualDag.nodes.find((node) => node.id === "capability-mcp-agent")?.assignedCapabilities.mcp, ["omk-project"]);
  assert.deepEqual(manifest.virtualDag.nodes.find((node) => node.id === "capability-hook-agent")?.assignedCapabilities.hooks, ["pre-shell-guard.sh"]);
  assert.deepEqual(manifest.virtualDag.nodes.find((node) => node.id === "worker-1")?.assignedProviderCapabilities, ["write", "shell", "mcp", "merge"]);
  assert.deepEqual(manifest.virtualDag.nodes.find((node) => node.id === "capability-skill-agent")?.candidateProviders, ["deepseek", "qwen", "openrouter", "kimi"]);
  const explorerLane = manifest.laneCapabilityAssignments.find((lane) => lane.laneId === "explorer");
  assert.equal(explorerLane?.assignedProvider, "deepseek");
  assert.deepEqual(explorerLane?.candidateProviders, ["deepseek", "qwen", "openrouter", "kimi"]);
  assert.equal(explorerLane?.assignedModel, "deepseek-v4-flash");
  assert.deepEqual(explorerLane?.assignedCapabilities, ["read", "research", "web"]);
  const coderLane = manifest.laneCapabilityAssignments.find((lane) => lane.laneId === "coder");
  assert.equal(coderLane?.assignedProvider, "kimi");
  assert.equal(coderLane?.assignedModel, "kimi-k2.6");
  assert.deepEqual(coderLane?.assignedCapabilities, ["write", "shell", "mcp", "merge"]);
  assert.equal(manifest.memoryRecall.requiredBeforePlanning, true);
  assert.ok(manifest.authority.some((line) => /kimi is the configured OMK authority provider/.test(line)));
  assert.equal(manifest.authority.some((line) => /Kimi\/OMK chat owns edits/.test(line)), false);
});

test("chat agent harness records explicit provider and model assignments per lane", () => {
  const manifest = buildChatAgentHarnessManifest({
    mode: "agent",
    runId: "chat-agent-provider-lanes",
    resources: {
      workers: "3",
      resourceProfile: "standard",
      approvalPolicy: "interactive",
      providerPolicy: "qwen",
      providerModel: "qwen3-max",
      ensembleDefaultEnabled: true,
      mcpScope: "project",
      skillsScope: "project",
      hooksScope: "project",
      mcpNames: ["omk-project", "omk-web-bridge"],
      skillNames: ["omk-repo-explorer", "omk-quality-gate"],
      hookNames: ["protect-secrets.sh"],
    },
  });

  assert.equal(manifest.resources.providerPolicy, "qwen");
  assert.equal(manifest.resources.providerModel, "qwen3-max");
  const byLane = new Map(manifest.laneCapabilityAssignments.map((lane) => [lane.laneId, lane]));
  assert.equal(byLane.get("explorer")?.assignedProvider, "qwen");
  assert.deepEqual(byLane.get("explorer")?.candidateProviders, ["qwen", "kimi"]);
  assert.equal(byLane.get("explorer")?.assignedModel, "qwen3-max");
  assert.deepEqual(byLane.get("explorer")?.assignedCapabilities, ["read", "research", "review", "qa", "advisory"]);
  assert.equal(byLane.get("coder")?.assignedProvider, "kimi");
  assert.deepEqual(byLane.get("coder")?.assignedCapabilities, ["write", "shell", "mcp", "merge"]);
  assert.equal(byLane.get("security")?.assignedProvider, "qwen");
  assert.deepEqual(byLane.get("security")?.candidateProviders, ["qwen", "kimi"]);
  assert.deepEqual(byLane.get("security")?.assignedCapabilities, ["read", "review", "security"]);

  const worker = manifest.virtualDag.nodes.find((node) => node.id === "worker-1");
  assert.equal(worker?.assignedProvider, "kimi");
  assert.deepEqual(worker?.candidateProviders, ["kimi"]);
  assert.equal(worker?.assignedProviderAuthority, "authority");
  assert.deepEqual(worker?.assignedProviderCapabilities, ["write", "shell", "mcp", "merge"]);
});

test("chat agent harness routes write lanes to configured authority provider", () => {
  const manifest = buildChatAgentHarnessManifest({
    mode: "agent",
    runId: "chat-agent-authority-provider",
    resources: {
      workers: "2",
      resourceProfile: "standard",
      approvalPolicy: "interactive",
      providerPolicy: "authority",
      authorityProvider: "codex",
      providerModel: "codex-cli",
      ensembleDefaultEnabled: true,
      mcpScope: "project",
      skillsScope: "project",
      hooksScope: "project",
      mcpNames: ["omk-project"],
      skillNames: ["omk-typescript-strict"],
      hookNames: ["protect-secrets.sh"],
    },
  });

  assert.equal(manifest.resources.providerPolicy, "authority");
  assert.equal(manifest.resources.authorityProvider, "codex");
  const byLane = new Map(manifest.laneCapabilityAssignments.map((lane) => [lane.laneId, lane]));
  assert.equal(byLane.get("coder")?.assignedProvider, "codex");
  assert.deepEqual(byLane.get("coder")?.candidateProviders, ["codex"]);
  assert.deepEqual(byLane.get("coder")?.assignedCapabilities, ["write", "shell", "mcp", "merge"]);
  assert.equal(byLane.get("security")?.assignedProvider, "codex");
  const worker = manifest.virtualDag.nodes.find((node) => node.id === "worker-1");
  assert.equal(worker?.assignedProvider, "codex");
  assert.equal(worker?.assignedProviderAuthority, "authority");
  assert.deepEqual(worker?.candidateProviders, ["codex"]);
  assert.ok(manifest.authority.some((line) => /codex is the configured OMK authority provider/.test(line)));
});

test("chat agent hard gate follows execution policy and chat exemption", () => {
  const baseResources = {
    workers: "2",
    resourceProfile: "standard",
    approvalPolicy: "interactive",
    providerPolicy: "auto",
    ensembleDefaultEnabled: true,
    mcpScope: "project",
    skillsScope: "project",
    hooksScope: "project",
    mcpNames: ["omk-project"],
    skillNames: ["omk-plan-first"],
    hookNames: ["subagent-stop-audit.sh"],
  };

  const askAgent = buildChatAgentHarnessManifest({
    mode: "agent",
    runId: "chat-agent-hard-gate-ask",
    resources: { ...baseResources, executionPrompt: "ask", executionPromptSource: "config" },
  });
  assert.equal(askAgent.hardGateContract.requiresPromptBeforeNonTrivialTTY, true);
  assert.equal(askAgent.hardGateContract.nonTTYAutoParallelForComplex, true);

  const sequentialAgent = buildChatAgentHarnessManifest({
    mode: "agent",
    runId: "chat-agent-hard-gate-sequential",
    resources: { ...baseResources, executionPrompt: "sequential", executionPromptSource: "cli" },
  });
  assert.equal(sequentialAgent.hardGateContract.requiresPromptBeforeNonTrivialTTY, false);
  assert.equal(sequentialAgent.hardGateContract.nonTTYAutoParallelForComplex, false);

  const chatMode = buildChatAgentHarnessManifest({
    mode: "chat",
    runId: "chat-agent-hard-gate-chat",
    resources: { ...baseResources, executionPrompt: "ask", executionPromptSource: "config" },
  });
  assert.equal(chatMode.hardGateContract.requiresPromptBeforeNonTrivialTTY, false);
  assert.equal(chatMode.hardGateContract.nonTTYAutoParallelForComplex, false);
});

test("chat mode contract omits agent orchestration injection", () => {
  const contract = buildChatAgentModeContract({
    mode: "chat",
    runId: "chat-only-contract",
    resources: {
      workers: "2",
      executionPrompt: "ask",
      mcpScope: "project",
      skillsScope: "project",
      hooksScope: "project",
      mcpNames: ["omk-project"],
      skillNames: ["omk-repo-explorer"],
      hookNames: ["subagent-stop-audit.sh"],
    },
  });

  assert.match(contract, /Chat-only guardrails/);
  assert.match(contract, /do not run the execution-choice hard gate/);
  assert.doesNotMatch(contract, /Treat every non-trivial user prompt as an orchestration request/);
  assert.doesNotMatch(contract, /Injected parallel DAG algorithm/);
});

test("chat agent runtime MCP allowlist is bounded to coordinator MCPs", () => {
  const resources = {
    workers: "2",
    mcpScope: "all",
    skillsScope: "project",
    hooksScope: "project",
    mcpNames: ["omk-project", "omk-web-bridge", "github", "unrelated-remote"],
    skillNames: ["omk-repo-explorer", "omk-project-rules", "omk-context-broker", "omk-security-review"],
    hookNames: ["subagent-stop-audit.sh"],
  };

  const agentAllowlist = buildChatAgentRuntimeMcpAllowlist({ mode: "agent", resources });
  assert.ok(agentAllowlist?.includes("omk-project"));
  assert.equal(agentAllowlist?.includes("omk-web-bridge"), false);
  assert.equal(agentAllowlist?.includes("unrelated-remote"), false);

  const chatAllowlist = buildChatAgentRuntimeMcpAllowlist({ mode: "chat", resources });
  assert.ok(chatAllowlist?.includes("omk-project"));
  assert.equal(chatAllowlist?.includes("omk-web-bridge"), false);

  const skillAllowlist = buildChatAgentRuntimeSkillAllowlist({ mode: "agent", resources });
  assert.ok(skillAllowlist?.includes("omk-project-rules"));
  assert.ok(skillAllowlist?.includes("omk-context-broker"));
  assert.equal(skillAllowlist?.includes("omk-security-review"), false);
});

test("chat agent harness budget 4 routes all capability lanes and keeps four worker lanes", () => {
  const manifest = buildChatAgentHarnessManifest({
    mode: "agent",
    runId: "chat-agent-budget-four",
    resources: {
      workers: "4",
      resourceProfile: "standard",
      approvalPolicy: "interactive",
      providerPolicy: "auto",
      ensembleDefaultEnabled: true,
      mcpScope: "project",
      skillsScope: "all",
      hooksScope: "project",
      mcpNames: ["omk-project"],
      skillNames: ["omk-test-debug-loop", "omk-quality-gate"],
      hookNames: ["pre-shell-guard.sh"],
    },
  });

  const capabilityNodes = manifest.virtualDag.nodes.filter((node) => node.source === "capability");
  const workerNodes = manifest.virtualDag.nodes.filter((node) => node.source === "worker");
  assert.equal(manifest.resources.workerBudget, 4);
  assert.deepEqual(capabilityNodes.map((node) => node.id), [
    "capability-skill-agent",
    "capability-mcp-agent",
    "capability-hook-agent",
  ]);
  assert.equal(workerNodes.length, 4);
  assert.equal(manifest.capabilityPolicy.maxCapabilityAgents, 3);
  assert.equal(manifest.capabilityPolicy.useMcp, true);
  assert.equal(manifest.capabilityPolicy.useSkills, true);
  assert.equal(manifest.capabilityPolicy.useHooks, true);
});

test("chat agent harness budget 4 uses four worker lanes when no capability inventory is active", () => {
  const manifest = buildChatAgentHarnessManifest({
    mode: "agent",
    runId: "chat-agent-budget-four-workers",
    resources: {
      workers: "4",
      resourceProfile: "standard",
      approvalPolicy: "interactive",
      providerPolicy: "auto",
      ensembleDefaultEnabled: true,
      mcpScope: "none",
      skillsScope: "none",
      hooksScope: "none",
      mcpNames: [],
      skillNames: [],
      hookNames: [],
    },
  });

  assert.equal(manifest.virtualDag.nodes.filter((node) => node.source === "capability").length, 0);
  assert.equal(manifest.virtualDag.nodes.filter((node) => node.source === "worker").length, 4);
});

test("chat agent harness resolves auto workers and keeps capability lanes independent from workers", () => {
  const previousMaxWorkers = process.env.OMK_MAX_WORKERS;
  try {
    process.env.OMK_MAX_WORKERS = "3";
    const manifest = buildChatAgentHarnessManifest({
      mode: "agent",
      runId: "chat-agent-auto-workers",
      resources: {
        workers: "auto",
        resourceProfile: "standard",
        approvalPolicy: "interactive",
        providerPolicy: "auto",
        ensembleDefaultEnabled: true,
        mcpScope: "project",
        skillsScope: "project",
        hooksScope: "project",
        mcpNames: ["omk-project"],
        skillNames: ["omk-context-broker"],
        hookNames: ["subagent-stop-audit.sh"],
      },
    });

    assert.equal(manifest.resources.workerBudget, 3);
    assert.equal(manifest.resources.workerCap, 3);
    const capabilityLanes = manifest.virtualDag.nodes.filter((node) => node.source === "capability");
    const workerLanes = manifest.virtualDag.nodes.filter((node) => node.source === "worker");
    assert.equal(capabilityLanes.length, 3);
    assert.equal(workerLanes.length, 3);
  } finally {
    if (previousMaxWorkers === undefined) delete process.env.OMK_MAX_WORKERS;
    else process.env.OMK_MAX_WORKERS = previousMaxWorkers;
  }
});

test("chat agent harness routes web bridge MCP only to browser-relevant lanes by default", () => {
  const manifest = buildChatAgentHarnessManifest({
    mode: "agent",
    runId: "chat-agent-web-bridge",
    resources: {
      workers: "2",
      resourceProfile: "standard",
      approvalPolicy: "interactive",
      providerPolicy: "auto",
      ensembleDefaultEnabled: true,
      mcpScope: "project",
      skillsScope: "project",
      hooksScope: "project",
      mcpNames: ["omk-web-bridge", "omk-project"],
      skillNames: ["omk-research-verify", "omk-frontend-ui-review"],
      hookNames: ["protect-secrets.sh"],
    },
  });

  const byLane = new Map(manifest.laneCapabilityAssignments.map((lane) => [lane.laneId, lane]));
  assert.ok(byLane.get("explorer")?.mcpServers.includes("omk-web-bridge"));
  assert.ok(byLane.get("researcher")?.mcpServers.includes("omk-web-bridge"));
  assert.ok(byLane.get("qa")?.mcpServers.includes("omk-web-bridge"));
  assert.ok(byLane.get("vision-debugger")?.mcpServers.includes("omk-web-bridge"));
  assert.equal(byLane.get("coder")?.mcpServers.includes("omk-web-bridge"), false);
  assert.equal(byLane.get("planner")?.mcpServers.includes("omk-web-bridge"), false);
  assert.match(buildParallelAlgorithmInjection({
    workers: "2",
    mcpScope: "project",
    skillsScope: "project",
    hooksScope: "project",
    mcpNames: ["omk-web-bridge"],
    skillNames: [],
    hookNames: [],
  }).text, /Web bridge: route `omk-web-bridge`/);
});

test("chat agent harness assigns explicit skills hooks and MCP per worker lane", () => {
  const manifest = buildChatAgentHarnessManifest({
    mode: "agent",
    runId: "chat-agent-worker-capabilities",
    resources: {
      workers: "2",
      resourceProfile: "standard",
      approvalPolicy: "interactive",
      providerPolicy: "auto",
      ensembleDefaultEnabled: true,
      mcpScope: "project",
      skillsScope: "project",
      hooksScope: "project",
      mcpNames: ["omk-project", "github", "omk-web-bridge"],
      skillNames: ["omk-typescript-strict", "omk-test-debug-loop", "omk-repo-explorer"],
      hookNames: ["protect-secrets.sh", "subagent-stop-audit.sh"],
    },
  });

  const workerNodes = manifest.virtualDag.nodes.filter((node) => node.source === "worker");
  assert.equal(workerNodes.length, 2);
  for (const node of workerNodes) {
    assert.ok(node.assignedCapabilities);
    assert.equal(node.assignedCapabilities.mcp.includes("omk-web-bridge"), false);
    assert.ok(node.assignedCapabilities.mcp.includes("omk-project"));
    assert.ok(node.assignedCapabilities.mcp.includes("github"));
    assert.ok(node.assignedCapabilities.skills.includes("omk-typescript-strict"));
    assert.ok(node.assignedCapabilities.skills.includes("omk-test-debug-loop"));
    assert.ok(node.assignedCapabilities.hooks.includes("protect-secrets.sh"));
  }
  assert.equal(manifest.virtualDag.nodes.find((node) => node.id === "capability-skill-agent")?.required, false);
  assert.equal(manifest.virtualDag.nodes.find((node) => node.id === "capability-mcp-agent")?.required, false);
  assert.equal(manifest.virtualDag.nodes.find((node) => node.id === "capability-hook-agent")?.required, false);
});

test("prepareChatAgentModeAgent writes run-scoped wrapper agent and prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "omk-chat-agent-mode-"));
  try {
    const agentDir = join(root, ".omk", "agents");
    const promptDir = join(root, ".omk", "prompts");
    await mkdir(join(agentDir, "roles"), { recursive: true });
    await mkdir(promptDir, { recursive: true });

    const baseAgentFile = join(agentDir, "root.yaml");
    const basePromptPath = join(promptDir, "root.md");
    await writeFile(baseAgentFile, [
      "version: 1",
      "agent:",
      "  name: root",
      "  subagents:",
      "    explorer:",
      "      path: ./roles/explorer.yaml",
      "      description: Explore repo",
      "",
    ].join("\n"), "utf-8");
    await writeFile(join(agentDir, "roles", "explorer.yaml"), "version: 1\nagent:\n  name: explorer\n", "utf-8");
    await writeFile(basePromptPath, "# Base Root Prompt\n", "utf-8");

    const prepared = await prepareChatAgentModeAgent({
      root,
      runId: "chat-agent-run",
      baseAgentFile,
      basePromptPath,
      mode: "debugging",
      resources: {
        workers: "2",
        resourceProfile: "lite",
        approvalPolicy: "interactive",
        providerPolicy: "auto",
        ensembleDefaultEnabled: false,
        mcpScope: "project",
        skillsScope: "project",
        hooksScope: "project",
        mcpNames: [],
        skillNames: ["omk-test-debug-loop"],
        hookNames: [],
      },
    });

    assert.equal(prepared.agentFile, join(root, ".omk", "runs", "chat-agent-run", "chat-agent.yaml"));
    assert.equal(prepared.promptPath, join(root, ".omk", "runs", "chat-agent-run", "chat-agent-prompt.md"));
    assert.equal(prepared.contractPath, join(root, ".omk", "runs", "chat-agent-run", "chat-agent-contract.md"));
    assert.equal(prepared.harnessPath, join(root, ".omk", "runs", "chat-agent-run", "chat-agent-harness.json"));

    const yaml = await readFile(prepared.agentFile, "utf-8");
    assert.match(yaml, /extend: /);
    assert.match(yaml, /system_prompt_path: \.\/chat-agent-prompt\.md/);
    assert.match(yaml, /OMK_ROLE: "root-coordinator"/);
    assert.match(yaml, /OMK_MCP_ENABLED: "true"/);
    assert.match(yaml, /OMK_SKILLS_ENABLED: "true"/);
    assert.match(yaml, /OMK_HOOKS_ENABLED: "true"/);
    assert.match(yaml, /OMK_SKILL_HINTS: "count=1;digest=[a-f0-9]{12};top=omk-test-debug-loop"/);
    assert.match(yaml, /OMK_MCP_HINTS: "count=0;digest=000000000000"/);
    assert.match(yaml, /OMK_HOOK_HINTS: "count=0;digest=000000000000"/);
    assert.match(yaml, /OMK_CONTEXT_BUDGET: "normal"/);
    assert.match(yaml, /OMK_PROVIDER_AUTHORITY: "kimi"/);

    const prompt = await readFile(prepared.promptPath, "utf-8");
    assert.match(prompt, /# Base Root Prompt/);
    assert.match(prompt, /# OMK Interactive Orchestrator Runtime Contract/);
    assert.match(prompt, /Mode: debugging/);
    assert.match(prompt, /Authority provider: kimi/);
    assert.match(prompt, /Active skills \(1\): count=1; digest=[a-f0-9]{12}; full=chat-agent-harness\.json/);
    assert.match(prompt, /Injected parallel DAG algorithm/);
    assert.match(prompt, /profile=lite; approval=interactive; provider=auto; authority=kimi; ensemble=disabled; workerCap=2/);

    const contract = await readFile(prepared.contractPath, "utf-8");
    assert.match(contract, /Debugging: reproduce or inspect the exact failing path/);

    const harness = JSON.parse(await readFile(prepared.harnessPath, "utf-8"));
    assert.equal(harness.schemaVersion, 1);
    assert.equal(harness.mode, "debugging");
    assert.deepEqual(harness.resources.active.skills, ["omk-test-debug-loop"]);
    assert.ok(harness.gates.includes("run npm run check before final implementation claims"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepareChatAgentModeAgent fallback root prompt is provider-neutral OMK", async () => {
  const root = await mkdtemp(join(tmpdir(), "omk-chat-agent-neutral-prompt-"));
  try {
    const agentDir = join(root, ".omk", "agents");
    await mkdir(agentDir, { recursive: true });
    const baseAgentFile = join(agentDir, "root.yaml");
    await writeFile(baseAgentFile, "version: 1\nagent:\n  name: root\n", "utf-8");

    const prepared = await prepareChatAgentModeAgent({
      root,
      runId: "neutral-prompt-run",
      baseAgentFile,
      basePromptPath: join(root, ".omk", "prompts", "missing-root.md"),
      mode: "agent",
      resources: {
        workers: "1",
        resourceProfile: "standard",
        approvalPolicy: "interactive",
        providerPolicy: "authority",
        authorityProvider: "codex",
        ensembleDefaultEnabled: true,
        mcpScope: "project",
        skillsScope: "project",
        hooksScope: "project",
        mcpNames: [],
        skillNames: [],
        hookNames: [],
      },
    });

    const prompt = await readFile(prepared.promptPath, "utf-8");
    assert.match(prompt, /# open_multi-agent_kit Root Agent/);
    assert.match(prompt, /provider-neutral orchestration layer/);
    assert.match(prompt, /Authority provider: codex/);
    assert.doesNotMatch(prompt, /# oh-my-kimi Root Agent|oh-my-kimi root coordinator|Kimi-native/);
    const yaml = await readFile(prepared.agentFile, "utf-8");
    assert.match(yaml, /OMK_PROVIDER_AUTHORITY: "codex"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepareChatAgentModeAgent reflects disabled capability scopes in wrapper agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "omk-chat-agent-disabled-scopes-"));
  try {
    const agentDir = join(root, ".omk", "agents");
    const promptDir = join(root, ".omk", "prompts");
    await mkdir(join(agentDir, "roles"), { recursive: true });
    await mkdir(promptDir, { recursive: true });

    const baseAgentFile = join(agentDir, "root.yaml");
    const basePromptPath = join(promptDir, "root.md");
    await writeFile(baseAgentFile, [
      "version: 1",
      "agent:",
      "  name: root",
      "  subagents:",
      "    explorer:",
      "      path: ./roles/explorer.yaml",
      "      description: Explore repo",
      "",
    ].join("\n"), "utf-8");
    await writeFile(join(agentDir, "roles", "explorer.yaml"), "version: 1\nagent:\n  name: explorer\n", "utf-8");
    await writeFile(basePromptPath, "# Base Root Prompt\n", "utf-8");

    const prepared = await prepareChatAgentModeAgent({
      root,
      runId: "chat-agent-disabled",
      baseAgentFile,
      basePromptPath,
      mode: "agent",
      resources: {
        workers: "1",
        mcpScope: "none",
        skillsScope: "none",
        hooksScope: "none",
        mcpNames: [],
        skillNames: [],
        hookNames: [],
      },
    });

    const yaml = await readFile(prepared.agentFile, "utf-8");
    assert.match(yaml, /OMK_MCP_ENABLED: "false"/);
    assert.match(yaml, /OMK_SKILLS_ENABLED: "false"/);
    assert.match(yaml, /OMK_HOOKS_ENABLED: "false"/);
    assert.match(yaml, /explorer:\n      path: "\.\/roles\/explorer\.yaml"/);

    const roleYaml = await readFile(join(root, ".omk", "runs", "chat-agent-disabled", "roles", "explorer.yaml"), "utf-8");
    assert.match(roleYaml, /extend: "\.\.\/\.\.\/\.\.\/agents\/roles\/explorer\.yaml"/);
    assert.match(roleYaml, /OMK_MCP_ENABLED: "false"/);
    assert.match(roleYaml, /OMK_SKILLS_ENABLED: "false"/);
    assert.match(roleYaml, /OMK_HOOKS_ENABLED: "false"/);
    assert.match(roleYaml, /OMK_MCP_HINTS: "disabled"/);
    assert.match(roleYaml, /OMK_SKILL_HINTS: "disabled"/);
    assert.match(roleYaml, /OMK_HOOK_HINTS: "disabled"/);

    const harness = JSON.parse(await readFile(prepared.harnessPath, "utf-8"));
    assert.deepEqual(harness.resources.scopes, { mcp: "none", skills: "none", hooks: "none" });
    assert.equal(harness.capabilityPolicy.useMcp, false);
    assert.equal(harness.capabilityPolicy.useSkills, false);
    assert.equal(harness.capabilityPolicy.useHooks, false);
    assert.equal(harness.virtualDag.nodes.some((node) => node.id === "capability-mcp-agent"), false);
    assert.equal(harness.virtualDag.nodes.some((node) => node.id === "capability-skill-agent"), false);
    assert.equal(harness.virtualDag.nodes.some((node) => node.id === "capability-hook-agent"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
