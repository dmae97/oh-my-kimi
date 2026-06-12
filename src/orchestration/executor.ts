import type { Dag, DagNode, DagNodeEvidence } from "./dag.js";
import type { DagExecutor, RunOptions, RunProgressEstimate, RunResult, RunState, TaskRunner, TaskResult } from "../contracts/orchestration.js";
import { createScheduler } from "./scheduler.js";
import type { StatePersister } from "./state-persister.js";
import { createStatePersister } from "./state-persister.js";
import { createEnsembleTaskRunner, type EnsemblePolicy } from "./ensemble.js";
import { estimateRunProgress } from "./eta.js";
import { dagNodeRoutingEnv } from "./routing.js";
import { buildTaskRunContext, envFromWorkerManifest } from "../runtime/worker-manifest.js";
import { getOmkResourceSettings } from "../util/resource-profile.js";
import { checkEvidenceGates } from "./evidence-gate.js";
import { invalidateTaskDagGraph } from "./task-graph.js";
import { resolveTimeoutMs } from "../util/timeout-config.js";
import { createNodeMonitorEngine } from "./node-monitor.js";
import type { DeepSeekModelTier, DeepSeekParticipation, ProviderAssistMetadata, ProviderId } from "../providers/types.js";
import { appendEvent } from "../util/events-logger.js";

export interface ExecutorOptions {
  persister?: StatePersister;
  ensemble?: false | EnsemblePolicy;
  signal?: AbortSignal;
  resumeFromState?: RunState;
  eventRunDir?: string;
}

export function createExecutor(executorOptions: ExecutorOptions = {}): DagExecutor {
  const scheduler = createScheduler();
  const persister = executorOptions.persister ?? createStatePersister();
  const stateChangeHandlers: Array<(state: RunState) => void> = [];
  const nodeStartHandlers: Array<(node: DagNode) => void> = [];
  const nodeCompleteHandlers: Array<(node: DagNode, result: TaskResult) => void> = [];
  let commitQueue: Promise<void> = Promise.resolve();
  let commitQueueSize = 0;
  const MAX_COMMIT_QUEUE = 10;
  const COMMIT_SAVE_TIMEOUT_MS = 10_000;
  const RUNNER_ABORT_DRAIN_MS = 2_000;
  const activeTimers = new Map<string, { progress: ReturnType<typeof setInterval>; persist: ReturnType<typeof setInterval>; heartbeat: ReturnType<typeof setInterval> }>();
  const nodeAbortRegistry = new Map<string, () => void>();
  let aborting = false;
  let isShuttingDown = false;
  let activeDag: Dag | undefined;
  let activeTick: (() => Promise<void>) | undefined;
  let activeRunOptions: RunOptions | undefined;
  let lastTerminalChangeAt = Date.now();
  let telemetryQueue: Promise<void> = Promise.resolve();
  function emitTelemetry(event: Parameters<typeof appendEvent>[1]): void {
    if (!executorOptions.eventRunDir) return;
    telemetryQueue = telemetryQueue
      .then(() => appendEvent(executorOptions.eventRunDir!, event))
      .catch(() => {});
  }
  async function flushTelemetry(): Promise<void> {
    await telemetryQueue.catch(() => {});
  }
  function bumpTerminalActivity(): void {
    lastTerminalChangeAt = Date.now();
  }

  function clearActiveTimers(): void {
    for (const [, timers] of activeTimers) {
      clearInterval(timers.progress);
      clearInterval(timers.persist);
      clearInterval(timers.heartbeat);
    }
    activeTimers.clear();
  }

  function markOpenNodesBlocked(dag: Dag, reason: string): void {
    for (const node of dag.nodes) {
      if (node.status === "running" || node.status === "pending") {
        node.status = "blocked";
        node.blockedReason = reason;
      }
    }
  }

  function rewriteNodeInputFrom(node: DagNode, fromId: string, toId: string): void {
    if (!node.inputs) return;
    node.inputs = node.inputs.map((input) =>
      input.from === fromId ? { ...input, from: toId } : input
    );
  }

  const monitor = createNodeMonitorEngine({
    heartbeatIntervalMs: 30_000,
    stallThresholdMultiplier: 3,
    onStall: (m) => {
      process.stderr.write(`[omk] node ${m.nodeId} stalled (no heartbeat for ${m.stallThresholdMs}ms)\n`);
      emitTelemetry({
        type: "lane.stalled",
        runId: m.runId,
        nodeId: m.nodeId,
        laneId: m.nodeId,
        data: { stallThresholdMs: m.stallThresholdMs },
      });
    },
    onKill: (m) => {
      process.stderr.write(`[omk] node ${m.nodeId} killed (no heartbeat for ${m.stallThresholdMs}ms)\n`);
      // Forcibly abort the underlying child process so it does not hang.
      const abortFn = nodeAbortRegistry.get(m.nodeId);
      if (abortFn) {
        try {
          abortFn();
        } catch {
          // ignore abort errors
        }
      }
      if (activeDag && activeRunOptions) {
        try {
          const node = activeDag.nodes.find((n) => n.id === m.nodeId);
          if (node && node.status === "running") {
            markNodeFinished(node, "failed");
            scheduler.updateNodeStatus(activeDag, m.nodeId, "failed", activeRunOptions.runId);
            activeTick?.().catch(() => {});
          }
        } catch {
          // ignore kill handler errors
        }
      }
    },
  });

  function buildState(dag: Dag, options: RunOptions): RunState {
    const startedAt = new Date().toISOString();
    return {
      schemaVersion: 1,
      runId: options.runId,
      nodes: dag.nodes.map((n) => ({
        ...n,
        dependsOn: [...n.dependsOn],
        outputs: n.outputs ? n.outputs.map((o) => ({ ...o })) : undefined,
        routing: n.routing ? { ...n.routing } : undefined,
        failurePolicy: n.failurePolicy ? { ...n.failurePolicy } : undefined,
      })),
      startedAt,
      updatedAt: startedAt,
      lastActivityAt: startedAt,
      lastHeartbeatAt: startedAt,
      activitySeq: 0,
      estimate: estimateRunProgress({
        nodes: dag.nodes,
        startedAt,
        workerCount: options.workers,
      }),
    };
  }

  function refreshState(state: RunState, dag: Dag, options: RunOptions): void {
    state.nodes = dag.nodes.map((n) => ({
      ...n,
      dependsOn: [...n.dependsOn],
      outputs: n.outputs ? n.outputs.map((o) => ({ ...o })) : undefined,
      routing: n.routing ? { ...n.routing } : undefined,
      failurePolicy: n.failurePolicy ? { ...n.failurePolicy } : undefined,
      attempts: n.attempts?.map((attempt) => ({ ...attempt })),
    }));
    state.estimate = estimateRunProgress({
      nodes: dag.nodes,
      startedAt: state.startedAt,
      workerCount: options.workers,
    });
    state.updatedAt = new Date().toISOString();
  }

  function bumpActivity(state: RunState): void {
    const now = new Date().toISOString();
    state.lastActivityAt = now;
    state.lastHeartbeatAt = now;
    state.activitySeq = (state.activitySeq ?? 0) + 1;
  }

  function cloneState(state: RunState): RunState {
    return {
      ...state,
      nodes: state.nodes.map((n) => ({
        ...n,
        dependsOn: [...n.dependsOn],
        outputs: n.outputs ? n.outputs.map((o) => ({ ...o })) : undefined,
        routing: n.routing ? { ...n.routing } : undefined,
        failurePolicy: n.failurePolicy ? { ...n.failurePolicy } : undefined,
        attempts: n.attempts?.map((attempt) => ({ ...attempt })),
      })),
      estimate: state.estimate ? { ...state.estimate } : undefined,
    };
  }

  let latestSnapshot: RunState | undefined;

  async function commitState(state: RunState, opts?: { mustPersist?: boolean }): Promise<void> {
    latestSnapshot = cloneState(state);
    emit(cloneState(latestSnapshot));
    // Coalesce: skip intermediate snapshots when queue is full,
    // but always persist final/must-persist snapshots.
    if (!opts?.mustPersist && commitQueueSize >= MAX_COMMIT_QUEUE) {
      return;
    }
    commitQueueSize++;
    const snap = latestSnapshot;
    commitQueue = commitQueue
      .then(async () => {
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            persister.save(snap),
            new Promise<never>((_, reject) => {
              timeoutHandle = setTimeout(() => reject(new Error(`state persist timed out after ${COMMIT_SAVE_TIMEOUT_MS}ms`)), COMMIT_SAVE_TIMEOUT_MS);
            }),
          ]);
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          commitQueueSize = Math.max(0, commitQueueSize - 1);
        }
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[omk] state persist warning: ${message}
`);
      });
    // Only await when mustPersist (caller needs durability guarantee)
    if (opts?.mustPersist) await commitQueue;
  }

  function emit(state: RunState): void {
    for (const h of stateChangeHandlers) {
      try {
        h(state);
      } catch {
        // ignore handler errors
      }
    }
  }

  function markNodeStarted(node: DagNode): void {
    const startedAt = new Date().toISOString();
    const attemptNumber = node.retries + 1;
    node.startedAt = startedAt;
    node.completedAt = undefined;
    node.durationMs = undefined;
    const attempts = node.attempts ?? [];
    attempts.push({ attempt: attemptNumber, startedAt });
    node.attempts = attempts;
  }

  function markNodeFinished(node: DagNode, status: "done" | "failed"): void {
    const completedAt = new Date().toISOString();
    const startedAtMs = node.startedAt ? Date.parse(node.startedAt) : Date.parse(completedAt);
    const completedAtMs = Date.parse(completedAt);
    const durationMs = Math.max(0, completedAtMs - startedAtMs);
    const latestAttempt = node.attempts?.[node.attempts.length - 1];

    if (latestAttempt) {
      latestAttempt.completedAt = completedAt;
      latestAttempt.durationMs = durationMs;
      latestAttempt.status = status;
    }

    if (status === "done") {
      node.completedAt = completedAt;
      node.durationMs = durationMs;
    }
  }

  function recordProviderAttempt(node: DagNode, result: TaskResult): void {
    const latestAttempt = node.attempts?.[node.attempts.length - 1];
    if (!latestAttempt) return;
    const metadata = result.metadata ?? {};
    const provider = metadata.provider;
    const requestedProvider = metadata.requestedProvider;
    if (isProviderId(provider)) latestAttempt.provider = provider;
    if (isProviderId(requestedProvider)) latestAttempt.requestedProvider = requestedProvider;
    if (typeof metadata.providerModel === "string") latestAttempt.providerModel = metadata.providerModel;
    if (isDeepSeekModelTier(metadata.providerModelTier)) latestAttempt.providerModelTier = metadata.providerModelTier;
    if (isDeepSeekParticipation(metadata.providerParticipation)) {
      latestAttempt.providerParticipation = metadata.providerParticipation;
    }

    const fallback = metadata.providerFallback;
    if (isProviderFallback(fallback)) {
      latestAttempt.fallbackFrom = fallback.from;
      latestAttempt.fallbackReason = fallback.reason;
    }

    const assist = result.metadata?.providerAssist as ProviderAssistMetadata | undefined;
    if (assist && assist.participation === "advisory") {
      latestAttempt.providerAssist = assist;
    }
  }

  function etaEnv(estimate: RunProgressEstimate | undefined): Record<string, string> {
    if (!estimate) return {};
    return {
      OMK_ETA_REMAINING_MS: String(estimate.estimatedRemainingMs ?? 0),
      OMK_ETA_COMPLETED_AT: estimate.estimatedCompletedAt ?? "",
      OMK_ETA_CONFIDENCE: estimate.confidence,
      OMK_PROGRESS_PERCENT: String(estimate.percentComplete),
      OMK_PROGRESS_NODES: `${estimate.completedNodes}/${estimate.totalNodes}`,
    };
  }

  function emitNodeStart(node: DagNode): void {
    for (const h of nodeStartHandlers) {
      try { h(node); } catch { /* ignore */ }
    }
  }

  function emitNodeComplete(node: DagNode, result: TaskResult): void {
    for (const h of nodeCompleteHandlers) {
      try { h(node, result); } catch { /* ignore */ }
    }
  }

  async function checkNodeEvidence(
    node: DagNode,
    result: TaskResult,
    options: RunOptions
  ): Promise<{ passed: boolean; evidence: import("./dag.js").DagNodeEvidence[] }> {
    const gates: import("./evidence-gate.js").EvidenceGate[] = [];

    for (const output of node.outputs ?? []) {
      switch (output.gate) {
        case "file-exists":
          if (output.ref) gates.push({ type: "file-exists", path: output.ref });
          break;
        case "test-pass":
          gates.push({ type: "command-pass", command: output.ref ?? "npm test" });
          break;
        case "command-pass":
          gates.push({ type: "command-pass", command: output.ref ?? "" });
          break;
        case "review-pass":
        case "summary":
          gates.push({ type: "summary-present", summaryMarker: output.ref ?? "## Summary" });
          break;
        case "none":
        default:
          break;
      }
    }

    const hasCommandGate = (node.outputs ?? []).some(
      (o) => o.gate === "command-pass" || o.gate === "test-pass"
    );
    if (node.routing?.evidenceRequired && !hasCommandGate) {
      gates.push({ type: "summary-present", summaryMarker: "## Evidence" });
    }

    if (gates.length === 0) {
      return { passed: true, evidence: [] };
    }

    const latestAttempt = node.attempts?.[node.attempts.length - 1];
    const attemptId = latestAttempt ? `${node.id}__${latestAttempt.attempt}` : `${node.id}__1`;

    return checkEvidenceGates(gates, {
      cwd: options.worktreeRoot ?? process.cwd(),
      stdout: result.stdout,
      nodeId: node.id,
      runId: options.runId,
      attemptId,
    });
  }

  async function runNode(
    node: DagNode,
    dag: Dag,
    runner: TaskRunner,
    options: RunOptions,
    state: RunState,
    signal?: AbortSignal,
    outAbort?: { abort: () => void }
  ): Promise<void> {
    scheduler.updateNodeStatus(dag, node.id, "running", options.runId);
    markNodeStarted(node);
    bumpActivity(state);
    refreshState(state, dag, options);
    await commitState(state);
    emitTelemetry({ type: "lane.started", runId: options.runId, nodeId: node.id, laneId: node.id, data: { role: node.role, name: node.name } });
    emitNodeStart(node);

    const resources = await getOmkResourceSettings();
    const runContext = buildTaskRunContext({
      runId: options.runId,
      ...(state.goalId ? { goalId: state.goalId } : {}),
      root: options.worktreeRoot ?? process.cwd(),
      node,
      objective: state.goalSnapshot?.objective ?? node.name,
      scopes: {
        mcp: resources.mcpScope,
        skills: resources.skillsScope,
        hooks: resources.hooksScope,
      },
      toolPlane: {
        mcpServers: node.routing?.mcpServers ?? node.routing?.assignedCapabilities?.mcpServers,
        skills: node.routing?.skills ?? node.routing?.assignedCapabilities?.skills,
        hooks: node.routing?.hooks ?? node.routing?.assignedCapabilities?.hooks,
        tools: node.routing?.tools ?? node.routing?.assignedCapabilities?.tools,
        requiresRuntimeMcp: node.routing?.requiresMcp,
      },
      model: node.routing?.providerModel,
    });
    const env: Record<string, string> = {
      OMK_NODE_ID: node.id,
      OMK_RUN_ID: options.runId,
      OMK_NODE_ROLE: node.role,
      OMK_ROLE: node.role,
      OMK_MCP_ENABLED: resources.mcpScope === "none" ? "false" : "true",
      OMK_SKILLS_ENABLED: resources.skillsScope === "none" ? "false" : "true",
      OMK_HOOKS_ENABLED: resources.hooksScope === "none" ? "false" : "true",
      ...dagNodeRoutingEnv(node, dag),
      ...envFromWorkerManifest(runContext.worker),
      ...etaEnv(state.estimate),
    };

    let result: TaskResult;
    let ignoredAbortEvidence: DagNodeEvidence | undefined;
    node.thinking = undefined;

    // Use fork() if available for parallel-safe isolated thinking callbacks.
    const nodeRunner = runner.fork
      ? runner.fork((thinking: string) => {
          node.thinking = thinking;
        })
      : {
          ...runner,
          onThinking: (thinking: string) => {
            node.thinking = thinking;
          },
          run: runner.run.bind(runner),
        };

    // Sync thinking back to state.nodes periodically so the live UI
    // can show ensemble / runner progress while the node is running.
    let lastEmittedThinking: string | undefined;
    const progressTimer = setInterval(() => {
      if (node.status !== "running") return;
      const stateNode = state.nodes.find((sn) => sn.id === node.id);
      if (stateNode) stateNode.thinking = node.thinking;
      if (node.thinking && node.thinking !== lastEmittedThinking) {
        lastEmittedThinking = node.thinking;
        bumpActivity(state);
        emitTelemetry({
          type: "lane.activity",
          runId: options.runId,
          nodeId: node.id,
          laneId: node.id,
          data: { phase: node.thinking },
        });
        emit(cloneState(state));
      }
    }, 500);

    // Persist live activity to disk less frequently to avoid I/O thrash.
    const persistTimer = setInterval(() => {
      void commitState(state);
    }, 2000);

    monitor.register(node.id, options.runId);
    const heartbeatTimer = setInterval(() => {
      if (node.status === "running") {
        monitor.heartbeat(node.id, options.runId);
        state.lastHeartbeatAt = new Date().toISOString();
        emitTelemetry({ type: "lane.heartbeat", runId: options.runId, nodeId: node.id, laneId: node.id });
      }
    }, 30_000);
    activeTimers.set(node.id, { progress: progressTimer, persist: persistTimer, heartbeat: heartbeatTimer });

    try {
      const timeoutPreset = node.timeoutPreset ?? options.timeoutPreset;
      const nodeTimeoutMs = await resolveTimeoutMs({
        timeoutMs: node.timeoutMs ?? (timeoutPreset ? undefined : options.nodeTimeoutMs),
        timeoutPreset,
      });
      const HARD_MAX_TIMEOUT_MS = 1_800_000; // 30 minutes
      const nodeAbortController = new AbortController();
      let abortReason: string | undefined;
      const abortNode = (reason?: string | Error): void => {
        if (reason) abortReason = reason instanceof Error ? reason.message : reason;
        if (!nodeAbortController.signal.aborted) {
          nodeAbortController.abort(reason);
        }
      };
      nodeAbortRegistry.set(node.id, abortNode);
      if (outAbort) {
        outAbort.abort = abortNode;
      }
      let runPromiseSettled = false;
      const runPromise = nodeRunner.run(node, env, nodeAbortController.signal, runContext).finally(() => {
        runPromiseSettled = true;
      });
      let hardMaxHandle: ReturnType<typeof setTimeout> | undefined;
      const hardMaxPromise = new Promise<never>((_, reject) => {
        hardMaxHandle = setTimeout(() => {
          const error = new Error(`Node ${node.id} exceeded hard maximum timeout`);
          abortNode(error);
          reject(error);
        }, HARD_MAX_TIMEOUT_MS);
      });
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let abortHandler: (() => void) | undefined;
      const racePromises: Promise<unknown>[] = [runPromise, hardMaxPromise];
        if (nodeTimeoutMs > 0) {
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => {
              const error = new Error(`Node ${node.id} timed out after ${nodeTimeoutMs}ms`);
              abortNode(error);
              reject(error);
            }, nodeTimeoutMs);
          });
          racePromises.push(timeoutPromise);
        }
        if (signal) {
          const abortPromise = new Promise<never>((_, reject) => {
            abortHandler = () => {
              const reason = signal.reason instanceof Error ? signal.reason : new Error(`Node ${node.id} aborted`);
              abortNode(reason);
              reject(reason);
            };
            signal.addEventListener('abort', abortHandler, { once: true });
          });
          racePromises.push(abortPromise);
        }
        try {
          result = await Promise.race(racePromises) as TaskResult;
        } finally {
          clearTimeout(hardMaxHandle);
          clearTimeout(timeoutHandle);
          if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
          // If the race rejected (timeout/abort), runPromise may still be alive
          // with a dangling child process. Wait for it to settle so we don't
          // leak subprocesses or keep the event loop alive indefinitely.
          const drained = await Promise.race([
            runPromise.then(() => true, () => true),
            new Promise<false>((resolve) => {
              const drainTimer = setTimeout(() => resolve(false), RUNNER_ABORT_DRAIN_MS);
              drainTimer.unref?.();
            }),
          ]);
          if (!drained && abortReason && !runPromiseSettled) {
            ignoredAbortEvidence = {
              gate: "runner-abort",
              passed: false,
              failureKind: "runner-abort-ignored",
              message: `Runner did not settle within ${RUNNER_ABORT_DRAIN_MS}ms after abort: ${abortReason}`,
            };
            process.stderr.write(`[omk] run ${options.runId} node ${node.id} runner did not settle within ${RUNNER_ABORT_DRAIN_MS}ms after abort\n`);
          }
        }
      recordProviderAttempt(node, result);
      if (aborting && (node.status === "blocked" || node.status === "skipped")) {
        return;
      }
      if (result.success) {
        const evidenceCheck = await checkNodeEvidence(node, result, options);
        node.evidence = evidenceCheck.evidence;
        if (evidenceCheck.passed) {
          markNodeFinished(node, "done");
          scheduler.updateNodeStatus(dag, node.id, "done", options.runId);
        } else {
          markNodeFinished(node, "failed");
          scheduler.updateNodeStatus(dag, node.id, "failed", options.runId);
        }
      } else {
        markNodeFinished(node, "failed");
        scheduler.updateNodeStatus(dag, node.id, "failed", options.runId);
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      result = {
        success: false,
        exitCode: 1,
        stdout: `[ERROR] ${errorMessage}`,
        stderr: errorMessage,
      };
      if (ignoredAbortEvidence) {
        node.evidence = [...(node.evidence ?? []), ignoredAbortEvidence];
      }
      if (aborting && (node.status === "blocked" || node.status === "skipped")) {
        return;
      }
      recordProviderAttempt(node, result);
      markNodeFinished(node, "failed");
      scheduler.updateNodeStatus(dag, node.id, "failed", options.runId);
    } finally {
      clearInterval(progressTimer);
      clearInterval(persistTimer);
      clearInterval(heartbeatTimer);
      monitor.unregister(node.id, options.runId);
      activeTimers.delete(node.id);
      nodeAbortRegistry.delete(node.id);
      const stateNode = state.nodes.find((sn) => sn.id === node.id);
      if (stateNode) stateNode.thinking = node.thinking;
      bumpActivity(state);
    }

    bumpTerminalActivity();
    if (aborting) {
      // Skip final emit/persist so the abort state is not overwritten
      // by a late-finishing node after execute() has already returned.
      return;
    }

    emitNodeComplete(node, result);
    emitTelemetry({
      type: result.success ? "lane.completed" : "lane.failed",
      runId: options.runId,
      nodeId: node.id,
      laneId: node.id,
      status: node.status,
      data: { success: result.success, exitCode: result.exitCode },
    });
    for (const evidence of node.evidence ?? []) {
      emitTelemetry({
        type: "evidence.result",
        runId: options.runId,
        nodeId: node.id,
        laneId: node.id,
        status: evidence.passed ? "passed" : "failed",
        data: { ...evidence },
      });
    }
    refreshState(state, dag, options);
    await commitState(state);
  }

  return {
    onStateChange(handler: (state: RunState) => void): () => void {
      stateChangeHandlers.push(handler);
      return () => {
        const idx = stateChangeHandlers.indexOf(handler);
        if (idx !== -1) stateChangeHandlers.splice(idx, 1);
      };
    },

    onNodeStart(handler: (node: DagNode) => void): () => void {
      nodeStartHandlers.push(handler);
      return () => {
        const idx = nodeStartHandlers.indexOf(handler);
        if (idx !== -1) nodeStartHandlers.splice(idx, 1);
      };
    },

    onNodeComplete(handler: (node: DagNode, result: TaskResult) => void): () => void {
      nodeCompleteHandlers.push(handler);
      return () => {
        const idx = nodeCompleteHandlers.indexOf(handler);
        if (idx !== -1) nodeCompleteHandlers.splice(idx, 1);
      };
    },

    async execute(dag: Dag, runner: TaskRunner, options: RunOptions): Promise<RunResult> {
      if (!Number.isInteger(options.workers) || options.workers < 1) {
        throw new TypeError(`options.workers must be a positive integer, got ${options.workers}`);
      }
      aborting = false;
      isShuttingDown = false;
      activeTick = undefined;
      const effectiveRunner = executorOptions.ensemble === false
        ? runner
        : createEnsembleTaskRunner(runner, executorOptions.ensemble ?? {});

      activeDag = dag;
      activeRunOptions = options;
      lastTerminalChangeAt = Date.now();

      let state: RunState;
      if (executorOptions.resumeFromState) {
        state = cloneState(executorOptions.resumeFromState);
        const stateNodeById = new Map(state.nodes.map((n) => [n.id, n]));
        for (const node of dag.nodes) {
          const saved = stateNodeById.get(node.id);
          if (saved) {
            // Do not restore non-terminal running state; reset to pending so
            // the scheduler can re-dispatch it. Only preserve terminal states.
            node.status = saved.status === "running" ? "pending" : saved.status;
            node.retries = saved.retries;
            node.startedAt = saved.startedAt;
            node.completedAt = saved.completedAt;
            node.durationMs = saved.durationMs;
            node.attempts = saved.attempts?.map((a) => ({ ...a }));
            node.evidence = saved.evidence?.map((e) => ({ ...e }));
            node.blockedReason = saved.blockedReason;
          }
        }
      } else {
        state = buildState(dag, options);
      }
      await commitState(state);

      const runningMap = new Map<string, { promise: Promise<void>; abort: () => void }>();
      const runAbortController = new AbortController();
      const runningCoreCount = (): number => [...runningMap.keys()]
        .filter((nodeId) => {
          const node = dag.nodes.find((entry) => entry.id === nodeId);
          return node ? !isOptionalExecutionLane(dag, node) : true;
        })
        .length;
      const hasOpenRequiredNodes = (): boolean => dag.nodes.some((node) => (
        !isOptionalExecutionLane(dag, node) && (node.status === "pending" || node.status === "running")
      ));
      const skipOpenOptionalLanes = (reason: string): void => {
        for (const node of dag.nodes) {
          if (!isOptionalExecutionLane(dag, node)) continue;
          if (node.status !== "pending" && node.status !== "running") continue;
          node.status = "skipped";
          node.blockedReason = reason;
          try {
            runningMap.get(node.id)?.abort();
          } catch {
            // ignore optional-lane abort errors
          }
        }
      };
      let resolveDone: (value: RunResult) => void;
      const donePromise = new Promise<RunResult>((resolve) => {
        resolveDone = resolve;
      });
      let settled = false;
      function resolveOnce(result: RunResult): void {
        if (settled) return;
        settled = true;
        if (runTimeoutHandle) {
          clearInterval(runTimeoutHandle);
          runTimeoutHandle = undefined;
        }
        if (executorOptions.signal) {
          executorOptions.signal.removeEventListener("abort", externalAbortHandler);
        }
        void flushTelemetry().finally(() => resolveDone(result));
      }

      async function finalizeRunFailure(reason: string, logMessage?: string): Promise<void> {
        if (settled) return;
        if (logMessage) process.stderr.write(logMessage);
        aborting = true;
        isShuttingDown = true;
        runAbortController.abort();
        for (const [, running] of runningMap) {
          try {
            running.abort();
          } catch {
            // ignore abort errors
          }
        }
        clearActiveTimers();
        markOpenNodesBlocked(dag, reason);
        bumpTerminalActivity();
        state.completedAt = new Date().toISOString();
        refreshState(state, dag, options);
        await commitState(state, { mustPersist: true });
        monitor.dispose();
        resolveOnce({ state, success: false });
      }

      function externalAbortHandler(): void {
        void finalizeRunFailure("cancelled");
      }
      if (executorOptions.signal) {
        if (executorOptions.signal.aborted) {
          void finalizeRunFailure("cancelled");
        } else {
          executorOptions.signal.addEventListener("abort", externalAbortHandler, { once: true });
        }
      }

      const fallbackNodes = new Map<string, DagNode>();

      async function tick(): Promise<void> {
        try {
          activeTick = tick;
          if (settled) return;
          // Handle fallback nodes FIRST, before isFailed check, so that a
          // terminal failure with a fallbackRole does not immediately fail the run.
          let fallbackCreated = false;
          for (const node of dag.nodes) {
            if (node.status === "failed" && node.retries >= node.maxRetries && node.failurePolicy?.fallbackRole && !fallbackNodes.has(node.id)) {
              let fallbackId = `${node.id}--fallback`;
              let fallbackCounter = 1;
              while (dag.nodes.some((n) => n.id === fallbackId)) {
                fallbackId = `${node.id}--fallback-${fallbackCounter++}`;
              }
              const fallbackNode: DagNode = {
                id: fallbackId,
                name: `${node.name} (fallback)`,
                role: node.failurePolicy.fallbackRole,
                dependsOn: [...node.dependsOn],
                status: "pending",
                retries: 0,
                maxRetries: 1,
                timeoutMs: node.timeoutMs,
                timeoutPreset: node.timeoutPreset,
                priority: node.priority,
                cost: node.cost,
                inputs: node.inputs?.map((input) => ({ ...input })),
                outputs: node.outputs?.map((output) => ({ ...output })),
                routing: node.routing ? { ...node.routing } : undefined,
                failurePolicy: { retryable: false, blockDependents: true },
              };
              dag.nodes.push(fallbackNode);
              fallbackNodes.set(node.id, fallbackNode);
              state.nodes.push({ ...fallbackNode });
              // Mark original node as skipped so dependents can proceed via fallback
              node.status = "skipped";
              node.blockedReason = `fallback created: ${fallbackId}`;
              invalidateTaskDagGraph(dag);
              // Redirect dependents from original node to fallback node
              for (const dep of dag.nodes) {
                if (dep.dependsOn.includes(node.id)) {
                  if (dep.status === "blocked" || dep.status === "skipped") {
                    dep.status = "pending";
                    dep.blockedReason = undefined;
                  }
                  dep.dependsOn = dep.dependsOn.filter((id) => id !== node.id);
                  if (!dep.dependsOn.includes(fallbackId)) {
                    dep.dependsOn.push(fallbackId);
                  }
                  rewriteNodeInputFrom(dep, node.id, fallbackId);
                }
              }
              fallbackCreated = true;
            }
          }
          if (fallbackCreated) {
            bumpTerminalActivity();
            refreshState(state, dag, options);
            await commitState(state);
            tick().catch(() => {});
            return;
          }

          if (executorOptions.signal?.aborted) {
            await finalizeRunFailure("cancelled");
            return;
          }

          if (runningMap.size === 0 && scheduler.isComplete(dag)) {
            state.completedAt = new Date().toISOString();
            refreshState(state, dag, options);
            await commitState(state, { mustPersist: true });
            monitor.dispose();
            resolveOnce({ state, success: true });
            return;
          }

          if (runningMap.size === 0 && scheduler.isFailed(dag)) {
            state.completedAt = new Date().toISOString();
            refreshState(state, dag, options);
            await commitState(state, { mustPersist: true });
            monitor.dispose();
            resolveOnce({ state, success: false });
            return;
          }

          if (scheduler.isFailed(dag)) return;

          if (runningCoreCount() === 0 && isRequiredDagComplete(dag)) {
            aborting = true;
            isShuttingDown = true;
            skipOpenOptionalLanes("optional lane skipped after required DAG completed");
            clearActiveTimers();
            state.completedAt = new Date().toISOString();
            refreshState(state, dag, options);
            await commitState(state, { mustPersist: true });
            monitor.dispose();
            resolveOnce({ state, success: true });
            return;
          }

          const runnable = scheduler.getRunnableNodes(dag);
          const eligible = runnable
            .filter((node) => !runningMap.has(node.id) && !fallbackNodes.has(node.id));
          const coreRunnable = eligible.filter((node) => !isOptionalExecutionLane(dag, node));
          const optionalRunnable = eligible.filter((node) => isOptionalExecutionLane(dag, node));
          const availableCoreSlots = Math.max(0, options.workers - runningCoreCount());
          const coreToRun = coreRunnable.slice(0, availableCoreSlots);
          const optionalSlots = options.workers > 1
            ? Math.max(0, options.workers - runningMap.size - coreToRun.length)
            : (coreToRun.length === 0 && !hasOpenRequiredNodes() && runningMap.size === 0 ? 1 : 0);
          const toRun = [
            ...coreToRun,
            ...optionalRunnable.slice(0, optionalSlots),
          ];

          for (const node of toRun) {
            if (isShuttingDown) break;
            const nodeAbortRef: { abort: () => void } = { abort: () => {} };
            const runnerForNode = isOptionalExecutionLane(dag, node) ? runner : effectiveRunner;
            const promise = runNode(node, dag, runnerForNode, options, state, runAbortController.signal, nodeAbortRef)
              .catch(() => {
                // runNode already marks node as failed on runner errors;
                // swallow persist/emit errors to allow tick() to continue
              })
              .finally(() => {
                runningMap.delete(node.id);
                tick().catch(() => {});
              });
            runningMap.set(node.id, { promise, abort: () => nodeAbortRef.abort() });
          }

          if (runningMap.size === 0 && toRun.length === 0 && runnable.length === 0) {
            // Deadlock or nothing to do — treat as failure
            state.completedAt = new Date().toISOString();
            refreshState(state, dag, options);
            await commitState(state, { mustPersist: true });
            monitor.dispose();
            resolveOnce({ state, success: false });
          }
        } catch (error: unknown) {
          if (settled) return;
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`[omk] executor tick crashed: ${message}\n`);
          aborting = true;
          isShuttingDown = true;
          runAbortController.abort();
          clearActiveTimers();
          markOpenNodesBlocked(dag, "executor crash");
          state.completedAt = new Date().toISOString();
          try {
            refreshState(state, dag, options);
            await commitState(state, { mustPersist: true });
          } catch {
            // ignore
          }
          monitor.dispose();
          resolveOnce({ state, success: false });
        }
      }

      let runTimeoutHandle: ReturnType<typeof setInterval> | undefined;
      if (options.runTimeoutMs && options.runTimeoutMs > 0) {
        runTimeoutHandle = setInterval(() => {
          if (settled) return;
          if (Date.now() - lastTerminalChangeAt > options.runTimeoutMs!) {
            void finalizeRunFailure(
              "run timeout",
              `[omk] run ${options.runId} timed out after ${options.runTimeoutMs}ms with no terminal state change\n`
            );
          }
        }, Math.min(options.runTimeoutMs, 30_000));
      }

      tick().catch(() => {});
      return donePromise;
    },
  };
}

function isRequiredDagComplete(dag: Dag): boolean {
  const requiredNodes = dag.nodes.filter((node) => !isOptionalExecutionLane(dag, node));
  return requiredNodes.length > 0 && requiredNodes.every(isTerminalForRequiredCompletion);
}

function isTerminalForRequiredCompletion(node: DagNode): boolean {
  return node.status === "done" ||
    node.status === "skipped" ||
    (node.status === "failed" && Boolean(node.failurePolicy?.fallbackRole));
}

function isOptionalExecutionLane(dag: Dag, node: DagNode): boolean {
  if (hasRequiredDependent(dag, node)) return false;
  const outputs = node.outputs ?? [];
  if (outputs.length > 0 && outputs.every((output) => output.required === false)) return true;
  if (hasOptionalDependent(dag, node)) return true;
  return node.routing?.autoSpawned === true || node.routing?.assignedProviderAuthority === "advisory";
}

function hasRequiredDependent(dag: Dag, node: DagNode): boolean {
  return dag.nodes.some((dependent) => (
    dependent.dependsOn.includes(node.id) && isRequiredReadinessDependency(dependent, node)
  ));
}

function hasOptionalDependent(dag: Dag, node: DagNode): boolean {
  return dag.nodes.some((dependent) => (
    dependent.dependsOn.includes(node.id) && !isRequiredReadinessDependency(dependent, node)
  ));
}

function isRequiredReadinessDependency(dependent: DagNode, predecessor: DagNode): boolean {
  const inputsFromPredecessor = dependent.inputs?.filter((input) => input.from === predecessor.id) ?? [];
  if (inputsFromPredecessor.length > 0) {
    return inputsFromPredecessor.some((input) => input.required !== false);
  }
  const outputs = predecessor.outputs ?? [];
  if (outputs.length > 0 && outputs.every((output) => output.required === false)) {
    return false;
  }
  return dependent.dependsOn.includes(predecessor.id);
}

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && value.trim().length > 0;
}

function isDeepSeekModelTier(value: unknown): value is DeepSeekModelTier {
  return value === "flash" || value === "pro";
}

function isDeepSeekParticipation(value: unknown): value is DeepSeekParticipation {
  return value === "direct" || value === "advisory";
}

function isProviderFallback(value: unknown): value is { from: ProviderId; reason: string } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return isProviderId(record.from) && typeof record.reason === "string";
}
