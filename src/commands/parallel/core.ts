import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { getOmkPath, getProjectRoot, getRunPath, sanitizeRunId } from "../../util/fs.js";
import { header, label, status } from "../../util/theme.js";
import { t } from "../../util/i18n.js";
import { getOmkResourceSettings } from "../../util/resource-profile.js";
import { parseRuntimeScopeOption } from "../../util/runtime-scope.js";
import { createRoutedRunState, routeRunState } from "../../orchestration/run-state.js";
import { UsageError } from "../../util/cli-contract.js";
import { writeMemoryRecallSummary } from "../../util/chat-startup.js";
import { normalizeProviderPolicy, parseProviderModelArg } from "../../providers/model-registry.js";
import { parseExecutionPromptPolicy } from "../../util/execution-selection.js";
import { analyzeUserIntent } from "../../goal/intake.js";
import { buildIntentFrame } from "../../goal/intent-frame.js";
import type { ProviderPolicy } from "../../providers/index.js";
import type { ExecutionStrategy, ExecutionSelectionDecision, RunState, UserIntent } from "../../contracts/orchestration.js";
import type { IntentFrame } from "../../contracts/goal.js";
import type { DagNodeDefinition } from "../../orchestration/dag.js";
import { renderCapabilityRoutingArtifact } from "../../orchestration/capability-routing.js";

import { buildParallelRouteDecision, resolveParallelCommandExecutionDecision, createInteractiveRunState, createExecutableDagFromState } from "./orchestrator.js";
import { normalizeWorkerCount, executeParallelRun } from "./worker.js";
import { buildPromptText, buildDeepSeekPromptPrefix, normalizeApprovalPolicy } from "./utils.js";

export interface ParallelCommandOptions {
  workers?: string;
  runId?: string;
  approvalPolicy?: string;
  watch?: boolean;
  noWatch?: boolean;
  view?: string;
  chat?: boolean;
  fromSpec?: string;
  alternateScreen?: boolean;
  noPause?: boolean;
  compact?: boolean;
  goalId?: string;
  timeoutPreset?: string;
  provider?: ProviderPolicy;
  model?: string;
  mcpScope?: string;
  execution?: string;
  executionStrategy?: ExecutionStrategy;
  executionDecision?: ExecutionSelectionDecision;
  intentFrame?: IntentFrame;
  /** Analyzed user intent for dynamic DAG construction and role routing. */
  intent?: UserIntent;
  signal?: AbortSignal;
}

export async function parallelCommand(
  goal: string | undefined,
  options: ParallelCommandOptions = {}
): Promise<{ runId: string; success: boolean }> {
  const root = getProjectRoot();
  const resources = await getOmkResourceSettings();
  const modelArg = parseProviderModelArg(options.model);
  const requestedProviderPolicy = normalizeProviderPolicy(options.provider ?? modelArg.provider);
  const mcpScope = parseRuntimeScopeOption(options.mcpScope, resources.mcpScope, "--mcp-scope");
  const requestedExecutionPrompt = parseExecutionPromptPolicy(options.execution, "--execution");

  const hasFromSpec = Boolean(options.fromSpec);

  if (!goal && !hasFromSpec) {
    throw new UsageError(t("parallel.goalRequired"));
  }

  const approvalPolicy = normalizeApprovalPolicy(options.approvalPolicy, resources.profile);
  const runId = sanitizeRunId(options.runId ?? new Date().toISOString().replace(/[:.]/g, "-"), "parallel");
  const sanitized = runId;
  const runDir = getRunPath(sanitized);
  const startedAt = new Date().toISOString();

  await mkdir(runDir, { recursive: true });

  let runState: RunState;
  let effectiveGoal = goal ?? "";
  let intentFrame: IntentFrame | undefined = options.intentFrame;

  let goalId: string | undefined;
  let goalSnapshot: RunState["goalSnapshot"] | undefined;
  if (options.goalId) {
    const { createGoalPersister } = await import("../../goal/persistence.js");
    const goalPersister = createGoalPersister(join(root, ".omk", "goals"));
    const goalSpec = await goalPersister.load(options.goalId);
    if (goalSpec) {
      goalId = goalSpec.goalId;
      goalSnapshot = {
        title: goalSpec.title,
        objective: goalSpec.objective,
        successCriteria: goalSpec.successCriteria.map((c) => ({
          id: c.id,
          description: c.description,
          requirement: c.requirement,
        })),
      };
      if (!effectiveGoal) {
        effectiveGoal = goalSpec.objective;
      }
      intentFrame = goalSpec.intentFrame ?? buildIntentFrame(goalSpec.rawPrompt || goalSpec.objective || goalSpec.title, {
        constraints: goalSpec.constraints.map((constraint) => constraint.description),
        successCriteria: goalSpec.successCriteria.map((criterion) => criterion.description),
        expectedArtifacts: goalSpec.expectedArtifacts,
      });
    }
  }

  let specNodes: DagNodeDefinition[] | undefined;
  if (hasFromSpec) {
    const { loadSpecDag } = await import("../dag-from-spec.js");
    const specDag = await loadSpecDag(options.fromSpec!, { parallel: true });
    effectiveGoal = goal ?? `spec: ${specDag.nodes[0]?.name ?? options.fromSpec!}`;
    intentFrame = buildIntentFrame(effectiveGoal);

    specNodes = specDag.nodes.map((node) => {
      const { status: _status, retries: _retries, ...def } = node;
      void _status;
      void _retries;
      return def;
    });
  } else {
    intentFrame = intentFrame ?? buildIntentFrame(effectiveGoal);
  }

  const resolvedIntent = options.intent ?? analyzeUserIntent(effectiveGoal);
  const executionDecision = options.executionDecision ?? await resolveParallelCommandExecutionDecision({
    requestedPolicy: requestedExecutionPrompt,
    configPolicy: resources.executionPrompt,
    strategyOverride: options.executionStrategy,
    intent: resolvedIntent,
    isTTY: Boolean(process.stdout.isTTY && process.stdin.isTTY),
  });
  await writeFile(join(runDir, "execution-selection.json"), `${JSON.stringify(executionDecision, null, 2)}\n`);
  const executionPrompt = executionDecision.policy;

  if (executionDecision.strategy === "prompt") {
    throw new Error("Execution selection prompt did not resolve to a runnable strategy.");
  }

  const providerPolicy = requestedProviderPolicy;

  if (executionDecision.strategy === "plan-only") {
    await writeFile(
      join(runDir, "plan.md"),
      `# Plan\n\nFlow: parallel\nWorkers: 0\nResource profile: ${resources.profile}\nMCP scope: ${mcpScope}\nExecution policy: ${executionPrompt}\nExecution strategy: plan-only\nApproval policy: ${approvalPolicy}\nProvider policy: ${providerPolicy}\n`
    );
    await writeFile(join(runDir, "goal.md"), `# Goal\n\n${effectiveGoal}\n`);
    await writeFile(join(runDir, "intent-frame.json"), `${JSON.stringify(intentFrame, null, 2)}\n`);
    await writeFile(join(runDir, "action-atoms.json"), `${JSON.stringify(intentFrame.actionAtoms, null, 2)}\n`);
    console.log(header("Plan Saved"));
    console.log(label("Run ID", runId));
    console.log(label("Goal", effectiveGoal));
    console.log(status.ok(`Plan saved to: ${join(runDir, "plan.md")}`));
    return { runId, success: true };
  }

  const executionStrategy = executionDecision.strategy;
  const workerCount = executionStrategy === "sequential"
    ? 1
    : normalizeWorkerCount(options.workers, resources.maxWorkers);

  await writeFile(
    join(runDir, "plan.md"),
    `# Plan\n\nFlow: parallel\nWorkers: ${workerCount}\nResource profile: ${resources.profile}\nMCP scope: ${mcpScope}\nExecution policy: ${executionPrompt}\nExecution strategy: ${executionStrategy}\nApproval policy: ${approvalPolicy}\nProvider policy: ${providerPolicy}\n`
  );

  if (specNodes) {
    runState = createRoutedRunState({
      runId,
      startedAt,
      nodes: specNodes,
      workerCount,
      goalId,
      goalObjective: effectiveGoal,
      goalSnapshot,
      routeDecision: buildParallelRouteDecision(effectiveGoal, resolvedIntent),
    });
  } else {
    intentFrame = intentFrame ?? buildIntentFrame(effectiveGoal);
    runState = createInteractiveRunState({
      runId,
      flow: "parallel",
      goal: effectiveGoal,
      intentFrame,
      workerCount,
      startedAt,
      approvalPolicy,
      goalId,
      goalSnapshot,
      intent: resolvedIntent,
      profile: resources.profile,
      providerPolicy,
      executionStrategy,
    });
  }

  await writeFile(join(runDir, "goal.md"), `# Goal\n\n${effectiveGoal}\n`);
  const memoryRecall = await writeMemoryRecallSummary({ root, runId, query: effectiveGoal });
  await writeFile(join(runDir, "intent-frame.json"), `${JSON.stringify(intentFrame, null, 2)}\n`);
  await writeFile(join(runDir, "action-atoms.json"), `${JSON.stringify(intentFrame.actionAtoms, null, 2)}\n`);
  await writeFile(join(runDir, "state.json"), JSON.stringify(runState, null, 2));

  console.log(header(executionStrategy === "sequential" ? "Sequential Execution" : "Parallel Execution"));
  console.log(label("Run ID", runId));
  console.log(label("Goal", effectiveGoal));
  console.log(label("Workers", String(workerCount)));
  console.log(label("Resource profile", `${resources.profile} (${resources.reason})`));
  console.log(label("MCP scope", mcpScope));
  console.log(label("Approval policy", approvalPolicy) + "\n");
  console.log(label("Provider policy", providerPolicy));

  const agentFile = getOmkPath("agents/root.yaml");
  const promptText = buildPromptText(effectiveGoal, runId, resources.profile, workerCount, mcpScope, resolvedIntent, intentFrame, memoryRecall.summary, executionStrategy);
  const statePath = join(runDir, "state.json");

  const routedState = routeRunState(runState, workerCount);
  await writeFile(statePath, JSON.stringify(routedState, null, 2));

  const dag = createExecutableDagFromState(routedState);
  await writeFile(
    join(runDir, "capability-routing.json"),
    `${JSON.stringify(renderCapabilityRoutingArtifact(dag.nodes), null, 2)}\n`
  );

  const result = await executeParallelRun({
    runId,
    dag,
    routedState,
    statePath,
    options: {
      noPause: options.noPause,
      chat: options.chat,
      signal: options.signal,
      timeoutPreset: options.timeoutPreset,
      alternateScreen: options.alternateScreen,
      compact: options.compact,
      view: options.view,
      noWatch: options.noWatch,
      watch: options.watch,
    },
    root,
    runDir,
    resources,
    effectiveGoal,
    workerCount,
    approvalPolicy,
    providerPolicy,
    modelArg,
    mcpScope,
    executionPrompt,
    agentFile,
    promptText,
    intentFrame,
    deepseekPromptPrefix: buildDeepSeekPromptPrefix(effectiveGoal, runId, workerCount, resolvedIntent, intentFrame),
    executionStrategy,
  });

  return result;
}
