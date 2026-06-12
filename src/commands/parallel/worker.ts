import type { Dag } from "../../orchestration/dag.js";
import type { RunState } from "../../contracts/orchestration.js";
import type { ProviderPolicy } from "../../providers/index.js";
import type { IntentFrame } from "../../contracts/goal.js";
import type { ExecutionStrategy } from "../../contracts/orchestration.js";
import { parseProviderModelArg } from "../../providers/model-registry.js";
import { getOmkResourceSettings } from "../../util/resource-profile.js";
import { ParallelLiveRenderer, renderCompactParallelFrame, type ParallelViewMode } from "../../orchestration/parallel-ui.js";
import { omkCliHero, style, status, label, bullet } from "../../util/theme.js";
import { formatOmkVersionFooter } from "../../util/version.js";
import { captureTerminalInputState, restoreTerminalInputState } from "../../util/terminal-input.js";
import { createHarnessTaskRunner } from "../../harness/create-harness-task-runner.js";
import { executeHarnessRun } from "../../harness/execute-harness-run.js";
import { getActiveRuntimePreset } from "../../util/resource-profile.js";
import { createOmkSessionEnv } from "../../util/session.js";
import { t } from "../../util/i18n.js";
import readline from "readline";
import { isCapabilityAgentNode } from "../../orchestration/capability-agents.js";
import { renderActionDigest } from "../../goal/intent-frame.js";

export function normalizeWorkerCount(value: string | undefined, fallback: number): number {
  const effective = (value ?? process.env.OMK_WORKERS)?.trim();
  if (!effective || effective === "auto") return fallback;
  if (!/^\d+$/.test(effective)) return fallback;
  const parsed = Number(effective);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, 6);
}

function buildWorkerLabels(state: RunState): Record<string, string> {
  const labels: Record<string, string> = {};
  const withProvider = (node: RunState["nodes"][number], base: string): string => {
    const provider = node.routing?.assignedProvider ?? node.routing?.provider;
    return provider && provider !== "auto" ? `${base}@${provider}` : base;
  };
  const coordinator = state.nodes.find((n) => n.id === "root-coordinator" || n.id === "architect");
  if (coordinator) {
    labels[coordinator.id] = withProvider(coordinator, coordinator.role === "architect" ? "architect" : "planner");
  }
  const reviewer = state.nodes.find((n) => n.id === "review-merge" || n.role === "reviewer" || n.role === "aggregator");
  if (reviewer) {
    labels[reviewer.id] = withProvider(reviewer, reviewer.role === "aggregator" ? "aggregator" : "reviewer");
  }
  const security = state.nodes.find((n) => n.id === "security-audit");
  if (security) {
    labels[security.id] = withProvider(security, "security");
  }
  const design = state.nodes.find((n) => n.id === "design-review");
  if (design) {
    labels[design.id] = withProvider(design, "design");
  }
  const qa = state.nodes.find((n) => n.id === "quality-check");
  if (qa) {
    labels[qa.id] = withProvider(qa, qa.role === "tester" ? "tester" : "qa");
  }
  const workers = state.nodes.filter((n) => n.id.startsWith("worker-"));
  const roleCounts: Record<string, number> = {};
  workers.forEach((n) => {
    const role = n.role ?? "coder";
    roleCounts[role] = (roleCounts[role] ?? 0) + 1;
    if (!labels[n.id]) {
      labels[n.id] = withProvider(n, `${role}-${roleCounts[role]}`);
    }
  });
  for (const node of state.nodes.filter((n) => n.id.startsWith("deepseek-"))) {
    labels[node.id] = node.routing?.providerModelTier
      ? `deepseek-${node.routing.providerModelTier}`
      : "deepseek";
  }
  for (const node of state.nodes.filter((n) => isCapabilityAgentNode(n))) {
    labels[node.id] = node.routing?.routeSource ? `capability-${node.routing.routeSource}` : "capability";
  }
  return labels;
}

function logRunStateTransitions(stateSnapshot: RunState, previousStatuses: Map<string, string>): void {
  for (const node of stateSnapshot.nodes) {
    const previous = previousStatuses.get(node.id);
    previousStatuses.set(node.id, node.status);
    if (previous === node.status) continue;
    if (previous === undefined && node.status === "pending") continue;
    console.log(renderNodeTransition(node.id, node.name, node.status));
  }
}

function renderNodeTransition(id: string, name: string, nodeStatus: string): string {
  const text = `${id}: ${name}`;
  if (nodeStatus === "running") return bullet(`running  ${text}`, "purple");
  if (nodeStatus === "done") return bullet(`done     ${text}`, "mint");
  if (nodeStatus === "failed") return bullet(`failed   ${text}`, "pink");
  if (nodeStatus === "blocked") return bullet(`blocked  ${text}`, "skin");
  return bullet(`${nodeStatus}  ${text}`, "blue");
}

export async function executeParallelRun(input: {
  runId: string;
  dag: Dag;
  routedState: RunState;
  statePath: string;
  options: {
    noPause?: boolean;
    chat?: boolean;
    signal?: AbortSignal;
    timeoutPreset?: string;
    alternateScreen?: boolean;
    compact?: boolean;
    view?: string;
    noWatch?: boolean;
    watch?: boolean;
  };
  root: string;
  runDir: string;
  resources: Awaited<ReturnType<typeof getOmkResourceSettings>>;
  effectiveGoal: string;
  workerCount: number;
  approvalPolicy: "interactive" | "auto" | "yolo" | "block";
  providerPolicy: ProviderPolicy;
  modelArg: ReturnType<typeof parseProviderModelArg>;
  mcpScope: "all" | "project" | "none";
  executionPrompt: string;
  agentFile: string;
  promptText: string;
  intentFrame: IntentFrame;
  deepseekPromptPrefix: string;
  executionStrategy: ExecutionStrategy;
}): Promise<{ runId: string; success: boolean }> {
  const {
    runId,
    dag,
    routedState,
    statePath,
    options,
    root,
    runDir,
    resources,
    effectiveGoal,
    workerCount,
    approvalPolicy,
    providerPolicy,
    modelArg,
    mcpScope,
    agentFile,
    promptText,
    intentFrame,
    deepseekPromptPrefix,
  } = input;

  const abortController = new AbortController();
  if (options.signal) {
    options.signal.addEventListener("abort", () => abortController.abort(), { once: true });
  }
  let shuttingDown = false;
  let forceExitTimer: ReturnType<typeof setTimeout> | undefined;
  function handleSignal(): void {
    if (shuttingDown) {
      if (options.noPause !== true) {
        process.exit(1);
      }
      return;
    }
    shuttingDown = true;
    abortController.abort();
    // Force exit if graceful shutdown hangs (e.g. long-running node)
    // In programmatic mode (noPause=true) we skip force-exit so callers can handle abort.
    if (options.noPause !== true) {
      forceExitTimer = setTimeout(() => process.exit(1), 5000);
      forceExitTimer.unref?.();
    }
  }
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  console.log(omkCliHero(formatOmkVersionFooter()));
  console.log(style.purpleBold("🐾 omk parallel — DAG executor with live UI"));
  console.log(style.gray(t("parallel.agentsActivated")));

  // Determine TTY and mode defaults
  const isTTY = Boolean(process.stdout.isTTY);
  const useWatch = options.noWatch
    ? false
    : options.watch ?? isTTY;
  const useAlternateScreen = options.alternateScreen === true;
  const useCompact = options.compact === true || options.view === "compact";
  const shouldPause = isTTY && options.noPause !== true;

  // Build worker labels for the UI
  const workerLabels = buildWorkerLabels(routedState);

  // Enter alternate screen only when explicitly requested
  if (useAlternateScreen && isTTY) {
    process.stdout.write("\x1b[?1049h");
  }

  // ── Live parallel UI ──
  let latestState: RunState = routedState;
  const liveRenderer = new ParallelLiveRenderer({
    runId,
    approvalPolicy,
    workerCount,
    ensembleEnabled: resources.ensembleDefaultEnabled,
    refreshMs: 1500,
    goalTitle: effectiveGoal,
    mode: useWatch ? "watch" : "no-watch",
    workerLabels,
    statePath,
    view: (options.view as ParallelViewMode | undefined) ?? (useCompact ? "compact" : "cockpit"),
  });

  const previousStatuses = new Map<string, string>();
  const handleStateChange = (stateSnapshot: RunState): void => {
    if (useWatch) {
      latestState = stateSnapshot;
      if (useCompact) {
        const line = renderCompactParallelFrame(stateSnapshot, {
          runId,
          approvalPolicy,
          workerCount,
          ensembleEnabled: resources.ensembleDefaultEnabled,
          goalTitle: effectiveGoal,
          mode: "watch",
          workerLabels,
          statePath,
        });
        console.log(line);
      }
      return;
    }
    logRunStateTransitions(stateSnapshot, previousStatuses);
  };

  if (useWatch) {
    if (!useCompact) {
      liveRenderer.start(() => latestState);
    }
  }

  const activePreset = await getActiveRuntimePreset();
  const harnessEnv = {
    ...createOmkSessionEnv(root, runId),
    OMK_RUN_ID: runId,
    OMK_FLOW: "parallel",
    OMK_GOAL: intentFrame.desiredOutcome,
    OMK_GOAL_CONTEXT: renderActionDigest(intentFrame),
    OMK_WORKERS: String(workerCount),
    OMK_DAG_ROUTING: "1",
    OMK_DAG_STATE_PATH: statePath,
    OMK_MCP_SCOPE: mcpScope,
    OMK_SKILLS_SCOPE: resources.skillsScope,
    OMK_APPROVAL_POLICY: approvalPolicy,
    ...(modelArg.model ? { OMK_PROVIDER_MODEL: modelArg.model } : {}),
  };
  const runner = await createHarnessTaskRunner({
    root,
    runId,
    mode: "parallel",
    providerPolicy,
    providerOptions: {
      eventRunDir: runDir,
      deepseekPromptPrefix,
      allowDeepSeekAdvisoryFileNodes: true,
      agentFile,
      promptPrefix: promptText,
      mcpScope,
      skillsScope: resources.skillsScope,
      hooksScope: resources.hooksScope,
      mcpNames: activePreset?.mcpServers ?? [],
      skillNames: activePreset?.skills ?? [],
      hookNames: activePreset?.hooks ?? [],
      toolNames: [],
    },
    env: harnessEnv,
  });

  let result: Awaited<ReturnType<typeof executeHarnessRun>>;
  try {
    result = await executeHarnessRun({
      root,
      runId,
      dag,
      runner,
      env: harnessEnv,
      workers: workerCount,
      approvalPolicy: approvalPolicy as "interactive" | "auto" | "yolo" | "block",
      nodeTimeoutMs: options.timeoutPreset ? undefined : 600_000,
      timeoutPreset: options.timeoutPreset,
      resumeFromState: routedState,
      eventRunDir: runDir,
      ensemble: resources.ensembleDefaultEnabled ? {} : false,
      signal: abortController.signal,
      onStateChange: handleStateChange,
    });
  } finally {
    liveRenderer.stop();

    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    if (forceExitTimer) {
      clearTimeout(forceExitTimer);
      forceExitTimer = undefined;
    }

    // Restore original terminal screen before printing results/errors.
    if (useAlternateScreen && isTTY) {
      process.stdout.write("\x1b[?1049l");
    }
  }

  console.log("");
  if (result.success) {
    console.log(status.ok("Parallel DAG run complete"));
  } else {
    console.log(status.error("Parallel DAG run failed"));
  }
  console.log(label("State", statePath));

  // ── Interactive handoff ──
  if (options.chat && result.success) {
    console.log(style.purple(t("parallel.complete")));
    const { chatCommand } = await import("../chat.js");
    await chatCommand({ runId });
    return { runId, success: true };
  }

  // Pause so the user can read the result before the process exits
  if (shouldPause) {
    console.log(style.gray("\n  Press Enter to continue..."));
    const terminalInputState = captureTerminalInputState(process.stdin);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await new Promise<void>((resolve) => {
      rl.once("line", () => {
        resolve();
      });
    }).finally(() => {
      rl.close();
      restoreTerminalInputState(process.stdin, terminalInputState);
    });
  }

  return { runId, success: result.success };
}
