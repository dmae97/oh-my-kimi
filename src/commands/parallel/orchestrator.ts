import type { ExecutionPromptPolicy, ExecutionSelectionDecision, ExecutionStrategy, RunRouteDecision, RunState, UserIntent } from "../../contracts/orchestration.js";
import type { Dag, DagNodeDefinition } from "../../orchestration/dag.js";
import { createDagFromRunState, createRoutedRunState, refreshRunStateEstimate } from "../../orchestration/run-state.js";
import { buildCapabilityAgentNodes, isCapabilityAgentNode } from "../../orchestration/capability-agents.js";
import { resolveExecutionSelectionDecision, resolvePromptExecutionDecision, EXECUTION_PROMPT_CHOICES } from "../../util/execution-selection.js";
import { buildIntentFrame, actionAtomRouting, makeActionAtom, renderActionDigest } from "../../goal/intent-frame.js";

import { DEFAULT_AUTHORITY_PROVIDER, resolveFallbackProvider, type DeepSeekModelTier, type ProviderId } from "../../providers/types.js";
import { getSuperOmkConfig, isSuperOmkEnabled } from "../../providers/deepseek/deepseek-super-config.js";
import type { ProviderPolicy } from "../../providers/index.js";
import type { IntentFrame } from "../../contracts/goal.js";
import { normalizeWorkerCount } from "./worker.js";

export async function resolveParallelCommandExecutionDecision(input: {
  requestedPolicy: ExecutionPromptPolicy | undefined;
  configPolicy: ExecutionPromptPolicy;
  strategyOverride: ExecutionStrategy | undefined;
  intent: UserIntent;
  isTTY: boolean;
}): Promise<ExecutionSelectionDecision> {
  if (input.strategyOverride && input.strategyOverride !== "prompt") {
    return {
      policy: input.requestedPolicy ?? input.configPolicy,
      source: input.requestedPolicy ? "cli" : "config",
      strategy: input.strategyOverride,
      reason: "caller supplied an execution strategy override",
      isTTY: input.isTTY,
      isNonTrivial: input.intent.complexity !== "simple" || input.intent.estimatedWorkers > 1 || input.intent.parallelizable,
    };
  }

  if (!input.requestedPolicy) {
    return {
      policy: "parallel",
      source: "default",
      strategy: "parallel",
      reason: "direct omk parallel preserves historical parallel execution unless --execution is supplied",
      isTTY: input.isTTY,
      isNonTrivial: input.intent.complexity !== "simple" || input.intent.estimatedWorkers > 1 || input.intent.parallelizable,
    };
  }

  const base = resolveExecutionSelectionDecision({
    cliValue: input.requestedPolicy,
    intent: input.intent,
    isTTY: input.isTTY,
  });
  if (base.strategy !== "prompt") return base;

  const { select } = await import("@inquirer/prompts");
  const selected = await select(
    {
      message: "이 작업은 병렬 처리에 적합합니다. Parallel agents로 나눌까요, one by one으로 진행할까요?",
      choices: EXECUTION_PROMPT_CHOICES.map((choice) => ({
        name: choice === "parallel"
          ? "Parallel agents (Recommended)"
          : choice === "sequential"
            ? "One by one"
            : "Plan only",
        value: choice,
      })),
    },
    { signal: AbortSignal.timeout(60_000) }
  );
  return resolvePromptExecutionDecision(base, selected as Exclude<ExecutionStrategy, "prompt">);
}

export function createInteractiveRunState(input: {
  runId: string;
  flow: string;
  goal: string;
  intentFrame?: IntentFrame;
  workerCount: number;
  startedAt: string;
  approvalPolicy: string;
  goalId?: string;
  goalSnapshot?: RunState["goalSnapshot"];
  intent?: UserIntent;
  profile?: string;
  providerPolicy?: ProviderPolicy;
  executionStrategy?: ExecutionStrategy;
}): RunState {
  const intent = input.intent;
  const effectiveWorkers = input.executionStrategy === "sequential"
    ? 1
    : intent?.estimatedWorkers === undefined
    ? input.workerCount
    : normalizeWorkerCount(String(intent.estimatedWorkers), input.workerCount);

  // Build dynamic nodes based on intent
  const nodes = buildDynamicNodes({
    flow: input.flow,
    goal: input.goal,
    intentFrame: input.intentFrame,
    startedAt: input.startedAt,
    workerCount: effectiveWorkers,
    intent,
    profile: input.profile,
    providerPolicy: input.providerPolicy,
    executionStrategy: input.executionStrategy,
  });

  const state = createRoutedRunState({
    runId: input.runId,
    startedAt: input.startedAt,
    workerCount: effectiveWorkers,
    goalId: input.goalId,
    goalObjective: input.goal,
    goalSnapshot: input.goalSnapshot,
    routeDecision: buildParallelRouteDecision(input.goal, intent),
    nodes,
  });

  const bootstrap = state.nodes.find((node) => node.id === "bootstrap");
  if (bootstrap) {
    bootstrap.status = "done";
    bootstrap.startedAt = input.startedAt;
    bootstrap.completedAt = input.startedAt;
  }
  const coordinator = state.nodes.find((node) => node.id === "root-coordinator" || node.id === "architect");
  if (coordinator) {
    coordinator.status = "running";
    coordinator.startedAt = input.startedAt;
  }
  return refreshRunStateEstimate(state, effectiveWorkers);
}

export function buildParallelRouteDecision(goal: string, intent: UserIntent | undefined): RunRouteDecision {
  if (isCriticalIssueScan(goal)) {
    return {
      intent: "critical_issue_scan",
      selectedAgents: [
        "repo_explorer",
        "risk_classifier",
        "runtime_reviewer",
        "security_reviewer",
        "test_impact_analyzer",
        "evidence_verifier",
      ],
      reason: "User requested critical issue/risk detection across repository state",
      requiredEvidence: [
        { kind: "diff", required: true, description: "Inspect modified file diffs and classify risk" },
        { kind: "test", required: true, description: "Map changed files to affected tests and run focused checks" },
        { kind: "diagnostic", required: true, description: "Check runtime/session/auth blockers before merge advice" },
      ],
      mode: "read-only",
    };
  }

  return {
    intent: intent?.taskType ?? "general",
    selectedAgents: intent?.requiredRoles ?? ["planner", "coder", "reviewer"],
    reason: intent?.rationale ?? "Default parallel route policy",
    requiredEvidence: [
      { kind: "file", required: true, description: "Capture changed files and scoped implementation evidence" },
      { kind: "test", required: intent?.needsTesting ?? true, description: "Run affected checks before final success" },
    ],
    mode: intent?.isReadOnly ? "read-only" : "write",
  };
}

function isCriticalIssueScan(text: string): boolean {
  return /critical|크리티컬|심각|위험|리스크|risk|issue|이슈/i.test(text);
}

function agentRoleToDagRole(agentRole: string): string {
  const normalized = agentRole.toLowerCase();
  if (normalized.includes("repo") || normalized.includes("explorer")) return "explorer";
  if (normalized.includes("security")) return "security";
  if (normalized.includes("test")) return "tester";
  if (normalized.includes("evidence")) return "qa";
  if (normalized.includes("risk") || normalized.includes("runtime") || normalized.includes("merge")) return "reviewer";
  return normalized.replace(/[^a-z0-9-]+/g, "-") || "reviewer";
}

function uniqueRoles(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

export interface DynamicNodeBuildInput {
  flow: string;
  goal: string;
  intentFrame?: IntentFrame;
  startedAt: string;
  workerCount: number;
  intent?: UserIntent;
  profile?: string;
  providerPolicy?: ProviderPolicy;
  executionStrategy?: ExecutionStrategy;
}

export function buildDynamicNodes(input: DynamicNodeBuildInput): DagNodeDefinition[] {
  const { flow, goal, startedAt, workerCount, intent, profile, executionStrategy } = input;
  const providerPolicy = input.providerPolicy ?? "auto";
  const intentFrame = input.intentFrame ?? buildIntentFrame(goal);
  const routeDecision = buildParallelRouteDecision(goal, intent);
  const actionDigest = renderActionDigest(intentFrame, { maxAtoms: 6 });
  const taskType = intent?.taskType ?? "general";
  const roles = routeDecision.intent === "critical_issue_scan"
    ? uniqueRoles(routeDecision.selectedAgents.map(agentRoleToDagRole))
    : intent?.requiredRoles ?? ["planner", "coder", "reviewer"];
  const isSequential = executionStrategy === "sequential";
  const effectiveWorkerCount = isSequential ? 1 : normalizeWorkerCount(String(workerCount), 1);
  const superConfig = getSuperOmkConfig(process.env);

  const isSuper = !isSequential && (isSuperOmkEnabled() || profile === "super");
  const authorityWorkerCount = isSuper
    ? Math.min(superConfig.authorityWorkerCap, effectiveWorkerCount)
    : effectiveWorkerCount;
  const deepseekWorkerCount = isSuper
    ? Math.min(superConfig.deepseekWorkerCap, effectiveWorkerCount - authorityWorkerCount)
    : 0;

  const bootstrap: DagNodeDefinition = {
    id: "bootstrap",
    name: `Prepare ${flow} run`,
    role: "omk",
    dependsOn: [],
    maxRetries: 1,
    startedAt,
    completedAt: startedAt,
    routing: {
      actionAtom: actionAtomRouting(makeActionAtom({
        id: "atom-bootstrap",
        label: "bootstrap",
        verb: "bootstrap",
        object: "parallel runtime",
        evidenceTarget: "state.json",
        doneCondition: "Run state is initialized",
        source: "runtime",
      })),
    },
  };

  // Determine coordinator / planner node based on task type
  const coordinatorRole = taskType === "plan" || taskType === "migrate" || taskType === "security" ? "architect" : "orchestrator";
  const coordinator: DagNodeDefinition = {
    id: "root-coordinator",
    name: "Coordinate strict intent DAG",
    role: coordinatorRole,
    dependsOn: ["bootstrap"],
    maxRetries: 1,
    startedAt,
    outputs: [{ name: "worker plan", gate: "summary" }],
    routing: {
      actionAtom: actionAtomRouting(makeActionAtom({
        id: "atom-coordinate",
        label: "coordinate-intent-dag",
        verb: "coordinate",
        object: "strict intent DAG",
        evidenceTarget: "plan.md",
        doneCondition: "Coordinator assigns scoped action atoms before delegation",
        source: "runtime",
      })),
    },
  };

  // Create worker nodes with role specialization
  const workerRoles = roles.filter((r) => r !== "planner" && r !== "orchestrator" && r !== "architect" && r !== "router");
  if (workerRoles.length === 0) workerRoles.push("coder");

  const capabilitySeed = intentFrame.actionAtoms.map((atom) => atom.label).join(", ");
  const deepseekAgentNodes = providerPolicy === "kimi" || isSequential || (providerPolicy !== "auto" && providerPolicy !== "deepseek")
    ? []
    : buildDeepSeekAgentNodes({
      goal: actionDigest,
      taskType,
      intent,
    });
  const capabilityAgentNodes = !isSequential && shouldSpawnCapabilityAgents(effectiveWorkerCount, taskType, intent)
    ? buildCapabilityAgentNodes({
      goal: capabilitySeed || actionDigest,
      dependsOn: ["root-coordinator"],
      maxAgents: 3,
      seedId: "parallel-capability-routing-seed",
      seedRole: coordinatorRole,
      seedName: "Route active MCP, skills, and hooks for action atoms",
    }).map((node) => ({
      ...node,
      routing: {
        ...node.routing,
        actionAtom: actionAtomRouting(makeActionAtom({
          id: `atom-${node.id}`,
          label: node.routing?.routeSource ? `route-${node.routing.routeSource}` : "route-capabilities",
          verb: "route",
          object: "active capability inventory",
          evidenceTarget: node.outputs?.[0]?.name ?? "capability routing plan",
          doneCondition: "Relevant MCP, skills, and hooks are bounded to the current action atom",
          source: "runtime",
        })),
      },
    }))
    : [];

  const authorityWorkerNodes: DagNodeDefinition[] = Array.from(
    { length: authorityWorkerCount },
    (_, index) => {
      const role = workerRoles[index % workerRoles.length];
      const taskName =
        taskType === "explore" || taskType === "research"
          ? `investigate area ${index + 1}`
          : taskType === "review"
          ? `audit scope ${index + 1}`
          : taskType === "test"
          ? `test scenario ${index + 1}`
          : taskType === "document"
          ? `document section ${index + 1}`
          : `execute scoped sub-task ${index + 1}`;
      return {
        id: `worker-${index + 1}`,
        name: `worker-${index + 1} (${role}): ${taskName}`,
        role,
        dependsOn: ["root-coordinator"],
        maxRetries: 1,
        failurePolicy: { retryable: true, blockDependents: true },
        inputs: [{ name: "worker plan", ref: "plan.md", from: "root-coordinator" }],
        outputs: [{ name: `worker-${index + 1} output`, gate: "none" }],
        routing: {
          provider: providerPolicy,
          fallbackProvider: resolveFallbackProvider(workerCandidateProviders(providerPolicy)),
          providerReason: "OMK provider router selects the concrete adapter at node execution time",
          ...(providerPolicy === "auto" || providerPolicy === "authority" ? {} : { assignedProvider: providerPolicy }),
          candidateProviders: workerCandidateProviders(providerPolicy),
          assignedModel: defaultModelForProviderPolicy(providerPolicy),
          assignedProviderAuthority: role === "coder" ? "authority" : "advisory",
          assignedProviderCapabilities: role === "coder" ? ["write", "shell", "mcp"] : ["read", "review", "advisory"],
          actionAtom: actionAtomRouting(intentFrame.actionAtoms[(index + 2) % intentFrame.actionAtoms.length] ?? intentFrame.actionAtoms[0]),
        },
      };
    }
  );

  const deepseekFallbackCandidates = workerCandidateProviders(providerPolicy).filter((provider) => provider !== "deepseek");
  const deepseekWorkerNodes: DagNodeDefinition[] = Array.from(
    { length: deepseekWorkerCount },
    (_, index) => {
      const type = superConfig.deepseekNodeTypes[index % superConfig.deepseekNodeTypes.length];
      const roleMap: Record<string, string> = {
        plan: "planner",
        review: "reviewer",
        analyze: "explorer",
        research: "researcher",
        debug: "debugger",
      };
      const role = roleMap[type] ?? "explorer";
      return {
        id: `deepseek-worker-${index + 1}`,
        name: `deepseek-worker-${index + 1} (${role}): ${type} area ${index + 1}`,
        role,
        dependsOn: ["root-coordinator"],
        maxRetries: 1,
        timeoutMs: 30_000,
        priority: 2,
        cost: 1,
        failurePolicy: { retryable: true, blockDependents: false, skipOnFailure: true },
        inputs: [{ name: "worker plan", ref: "plan.md", from: "root-coordinator" }],
        outputs: [{ name: `deepseek-worker-${index + 1} output`, gate: "none" }],
        routing: {
          provider: "deepseek",
          fallbackProvider: resolveFallbackProvider(deepseekFallbackCandidates),
          providerModel: "deepseek-v4-pro",
          providerModelTier: "pro",
          assignedProvider: "deepseek",
          candidateProviders: ["deepseek", ...deepseekFallbackCandidates],
          assignedModel: "deepseek-v4-pro",
          assignedProviderAuthority: "direct",
          assignedProviderCapabilities: ["read", "review", "qa"],
          providerReason: `Super OMK DeepSeek worker for ${type}`,
          requiresMcp: false,
          requiresToolCalling: false,
          readOnly: true,
          evidenceRequired: false,
          contextBudget: "small",
          skills: ["omk-repo-explorer", "omk-context-broker"],
          mcpServers: [],
          tools: [],
          rationale: `DeepSeek V4 Pro handles ${type} in super co-orchestration mode`,
          actionAtom: actionAtomRouting(makeActionAtom({
            id: `atom-deepseek-worker-${index + 1}`,
            label: `deepseek-${type}`,
            verb: type === "review" ? "review" : type === "research" ? "research" : type === "debug" ? "inspect" : "plan",
            object: "read-only auxiliary action",
            evidenceTarget: `deepseek-worker-${index + 1} output`,
            doneCondition: "DeepSeek advisory lane reports bounded findings",
            source: "runtime",
          })),
        },
      };
    }
  );

  const workerNodes = [...authorityWorkerNodes, ...deepseekWorkerNodes];

  // Build tail nodes based on task type
  const tailNodes: DagNodeDefinition[] = [];
  const synthesisInputNodes = [...deepseekAgentNodes, ...capabilityAgentNodes, ...workerNodes];
  const synthesisInputIds = synthesisInputNodes.map((node) => node.id);

  // Review / aggregator node
  const reviewRole = taskType === "review" ? "aggregator" : "reviewer";
  const reviewNode: DagNodeDefinition = {
    id: "review-merge",
    name: taskType === "review" ? "Aggregate review findings" : "Review, verify, and merge outputs",
    role: reviewRole,
    dependsOn: synthesisInputIds,
    maxRetries: 1,
    inputs: synthesisInputNodes.map((node) => ({
      name: node.outputs?.[0]?.name ?? node.name,
      ref: "state.json",
      from: node.id,
      required: !node.id.startsWith("deepseek-") && !isCapabilityAgentNode(node),
    })),
    outputs: [{ name: "verified result", gate: taskType === "review" ? "summary" : "review-pass" }],
    routing: {
      actionAtom: actionAtomRouting(makeActionAtom({
        id: "atom-review-merge",
        label: "review-merge",
        verb: "review",
        object: "worker outputs",
        evidenceTarget: "verified result",
        doneCondition: "Worker outputs are reviewed and merged into a verified result",
        source: "runtime",
      })),
    },
  };
  tailNodes.push(reviewNode);

  // QA / tester node (for most implementation tasks)
  if (taskType !== "explore" && taskType !== "research" && taskType !== "document") {
    const qaRole = taskType === "test" ? "tester" : "qa";
    tailNodes.push({
      id: "quality-check",
      name: taskType === "test" ? "Test coverage and regression check" : "Quality assurance check",
      role: qaRole,
      dependsOn: ["review-merge"],
      maxRetries: 1,
      outputs: [{ name: "quality result", gate: taskType === "test" ? "test-pass" : "command-pass", ref: "npm run check" }],
      failurePolicy: { blockDependents: false },
      routing: {
        actionAtom: actionAtomRouting(makeActionAtom({
          id: "atom-quality-check",
          label: "quality-check",
          verb: "verify",
          object: "quality gates",
          evidenceTarget: "quality result",
          doneCondition: "Required checks prove the DAG output is safe to report",
          source: "runtime",
        })),
      },
    });
  }

  // Security audit node (when needed)
  if (intent?.needsSecurityReview) {
    tailNodes.push({
      id: "security-audit",
      name: "Security audit and secret scan",
      role: "security",
      dependsOn: ["review-merge"],
      maxRetries: 1,
      outputs: [{ name: "security result", gate: "review-pass" }],
      failurePolicy: { blockDependents: true },
      routing: {
        actionAtom: actionAtomRouting(makeActionAtom({
          id: "atom-security-audit",
          label: "security-audit",
          verb: "review",
          object: "security boundaries",
          evidenceTarget: "security result",
          doneCondition: "Security-sensitive risks are reviewed before completion",
          source: "runtime",
        })),
      },
    });
  }

  // Design review node (when needed)
  if (intent?.needsDesignReview) {
    const designDeps = tailNodes.filter((n) => n.id !== "security-audit").map((n) => n.id);
    tailNodes.push({
      id: "design-review",
      name: "Design system and UI consistency review",
      role: "designer",
      dependsOn: designDeps.length > 0 ? designDeps : ["review-merge"],
      maxRetries: 1,
      outputs: [{ name: "design result", gate: "summary" }],
      failurePolicy: { blockDependents: false },
      routing: {
        actionAtom: actionAtomRouting(makeActionAtom({
          id: "atom-design-review",
          label: "design-review",
          verb: "review",
          object: "design consistency",
          evidenceTarget: "design result",
          doneCondition: "Design/system constraints are checked when applicable",
          source: "runtime",
        })),
      },
    });
  }

  return [bootstrap, coordinator, ...deepseekAgentNodes, ...capabilityAgentNodes, ...workerNodes, ...tailNodes];
}

function shouldSpawnCapabilityAgents(workerCount: number, taskType: string, intent?: UserIntent): boolean {
  void workerCount;
  if (intent?.parallelizable === true) return true;
  if (intent?.complexity && intent.complexity !== "simple") return true;
  return ["bugfix", "implement", "migrate", "plan", "refactor", "review", "security", "test", "general"].includes(taskType);
}

function workerCandidateProviders(providerPolicy: ProviderPolicy): ProviderId[] {
  const omkAuthorityCandidates: ProviderId[] = [DEFAULT_AUTHORITY_PROVIDER, "codex", "qwen", "openrouter"];
  if (providerPolicy === "kimi") return ["kimi"];
  if (providerPolicy === "auto" || providerPolicy === "authority") return omkAuthorityCandidates;
  return [
    providerPolicy,
    ...omkAuthorityCandidates.filter((provider) => provider !== providerPolicy),
  ];
}

function defaultModelForProviderPolicy(providerPolicy: ProviderPolicy): string {
  if (providerPolicy === "qwen") return "qwen3-max";
  if (providerPolicy === "codex") return "codex-cli";
  if (providerPolicy === "deepseek") return "deepseek-v4-flash";
  if (providerPolicy === "openrouter") return "openrouter/auto";
  if (providerPolicy === "kimi") return "kimi-api";
  return "kimi-api";
}

function buildDeepSeekAgentNodes(input: {
  goal: string;
  taskType: string;
  intent?: UserIntent;
}): DagNodeDefinition[] {
  if (!shouldSpawnDeepSeekModelAgents(input.taskType, input.intent)) return [];

  return [
    createDeepSeekAgentNode({
      id: "deepseek-flash-agent",
      name: "DeepSeek Flash action decomposition",
      role: "planner",
      tier: "flash",
      outputName: "deepseek flash decomposition",
      rationale: "Flash handles fast first-pass context slicing from the original user input before OMK synthesis.",
    }),
    createDeepSeekAgentNode({
      id: "deepseek-pro-agent",
      name: "DeepSeek Pro action critique",
      role: "reviewer",
      tier: "pro",
      outputName: "deepseek pro critique",
      rationale: "Pro handles deeper read-only critique and risk detection from the original user input before OMK synthesis.",
    }),
  ];
}

function shouldSpawnDeepSeekModelAgents(taskType: string, intent?: UserIntent): boolean {
  if (intent?.isReadOnly === true) return true;
  if (intent?.parallelizable === true) return true;
  if (intent?.complexity && intent.complexity !== "simple") return true;
  return ["bugfix", "implement", "migrate", "plan", "refactor", "review", "security", "test"].includes(taskType);
}

function createDeepSeekAgentNode(input: {
  id: string;
  name: string;
  role: string;
  tier: DeepSeekModelTier;
  outputName: string;
  rationale: string;
}): DagNodeDefinition {
  return {
    id: input.id,
    name: input.name,
    role: input.role,
    dependsOn: ["root-coordinator"],
    maxRetries: 1,
    timeoutMs: input.tier === "flash" ? 15_000 : 30_000,
    priority: 2,
    cost: input.tier === "pro" ? 2 : 1,
    failurePolicy: { retryable: true, blockDependents: false, skipOnFailure: true },
    inputs: [{ name: "worker plan", ref: "plan.md", from: "root-coordinator" }],
    outputs: [{ name: input.outputName, gate: "none", required: false }],
    routing: {
      provider: "deepseek",
      fallbackProvider: resolveFallbackProvider([DEFAULT_AUTHORITY_PROVIDER, "codex", "qwen", "openrouter"]),
      providerModel: input.tier === "flash" ? "deepseek-v4-flash" : "deepseek-v4-pro",
      providerModelTier: input.tier,
      assignedProvider: "deepseek",
      candidateProviders: ["deepseek", DEFAULT_AUTHORITY_PROVIDER, "codex", "qwen", "openrouter"],
      assignedModel: input.tier === "flash" ? "deepseek-v4-flash" : "deepseek-v4-pro",
      assignedProviderAuthority: "direct",
      assignedProviderCapabilities: ["read", "plan", "review"],
      providerReason: `Dedicated DeepSeek ${input.tier} model agent spawned from initial orchestration input`,
      requiresMcp: false,
      requiresToolCalling: false,
      readOnly: true,
      evidenceRequired: false,
      contextBudget: input.tier === "pro" ? "small" : "tiny",
      skills: ["omk-repo-explorer", "omk-context-broker"],
      mcpServers: [],
      tools: [],
      rationale: input.rationale,
      actionAtom: actionAtomRouting(makeActionAtom({
        id: `atom-${input.id}`,
        label: input.tier === "flash" ? "deepseek-action-decomposition" : "deepseek-action-critique",
        verb: input.role === "reviewer" ? "review" : "plan",
        object: "read-only model-agent lane",
        evidenceTarget: input.outputName,
        doneCondition: "Read-only model-agent output is available for OMK synthesis",
        source: "runtime",
      })),
    },
  };
}

export function createExecutableDagFromState(state: RunState): Dag {
  const dag = createDagFromRunState(state);
  const runtimeById = new Map(state.nodes.map((node) => [node.id, node]));

  for (const node of dag.nodes) {
    const runtime = runtimeById.get(node.id);
    if (runtime?.status !== "done") continue;
    node.status = "done";
    node.startedAt = runtime.startedAt;
    node.completedAt = runtime.completedAt;
    node.durationMs = runtime.durationMs;
    node.attempts = runtime.attempts?.map((attempt) => ({ ...attempt }));
  }

  const bootstrap = dag.nodes.find((node) => node.id === "bootstrap");
  if (bootstrap) {
    bootstrap.status = "done";
    bootstrap.startedAt ??= state.startedAt;
    bootstrap.completedAt ??= state.startedAt;
  }

  return dag;
}
