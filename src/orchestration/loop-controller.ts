import { createHash } from "node:crypto";

import type { DagNode } from "./dag.js";
import type {
  DagLoopSnapshot,
  EvaluateLoopDecisionInput,
  LoopDecision,
  LoopNodeSets,
  LoopProgressSignal,
  LoopRiskSignal,
  OrchestrationLoopState,
} from "./loop-state.js";

export const DEFAULT_LOOP_MAX_ITERATIONS = 3;
export const HARD_LOOP_MAX_ITERATIONS = 8;

export function evaluateLoopDecision(
  input: EvaluateLoopDecisionInput,
): LoopDecision {
  const createdAt = (input.now ?? (() => new Date()))().toISOString();
  const iteration = Math.max(1, input.iteration ?? input.runState.iterationCount ?? 1);
  const maxIterations = resolveMaxIterations(input.maxIterations ?? input.runState.maxIterations);
  const snapshot = snapshotRunState(input.runState);
  const progress = detectProgress(input.previousSnapshot, snapshot);
  const failedNodes = snapshot.nodeSets.failed;
  const blockedNodes = snapshot.nodeSets.blocked;
  const failedGates = collectFailedGates(input.runState.nodes);
  const pendingNodes = [...snapshot.nodeSets.pending, ...snapshot.nodeSets.running];
  const requiredEvidenceMissing = collectMissingRequiredEvidence(input.runState.nodes);
  const risk = assessLoopRisk({
    snapshot,
    failedGates,
    requiredEvidenceMissing,
    noProgressCount: input.noProgressCount ?? 0,
  });
  const common = {
    nodeSets: snapshot.nodeSets,
    progress,
    risk,
    failedNodes,
    blockedNodes,
    pendingNodes,
    failedGates,
    requiredEvidenceMissing,
    iteration,
    createdAt,
  };

  if (
    iteration >= maxIterations &&
    (failedNodes.length > 0 ||
      blockedNodes.length > 0 ||
      pendingNodes.length > 0 ||
      requiredEvidenceMissing.length > 0 ||
      risk.deadlock > 0)
  ) {
    return buildDecision(input, {
      action: "block",
      reason: "Maximum loop iterations reached before required evidence closed",
      confidence: 0.9,
      ...common,
    });
  }

  if (input.requestedAction === "verify") {
    return buildDecision(input, {
      action: "verify-only",
      reason: "Operator requested verification-only loop action",
      confidence: 0.85,
      ...common,
    });
  }

  if (
    input.requestedAction === "replan" ||
    failedNodes.length > 0 ||
    blockedNodes.length > 0 ||
    failedGates.length > 0
  ) {
    return buildDecision(input, {
      action: "replan",
      reason: failedNodes.length + blockedNodes.length > 0
        ? `Run has failed or blocked nodes: ${[...failedNodes, ...blockedNodes].join(", ")}`
        : "Operator requested replan or gate failures require a new plan",
      confidence: 0.86,
      ...common,
    });
  }

  if (risk.deadlock > 0) {
    return buildDecision(input, {
      action: "replan",
      reason: `Pending nodes have no runnable or running path: ${snapshot.nodeSets.pending.join(", ")}`,
      confidence: 0.84,
      ...common,
    });
  }

  if (
    pendingNodes.length === 0 &&
    failedNodes.length === 0 &&
    blockedNodes.length === 0 &&
    failedGates.length === 0 &&
    requiredEvidenceMissing.length === 0
  ) {
    return buildDecision(input, {
      action: "close",
      reason: "All required nodes and evidence gates are closed",
      confidence: 0.92,
      failedNodes: [],
      blockedNodes: [],
      pendingNodes: [],
      nodeSets: snapshot.nodeSets,
      progress,
      risk,
      failedGates,
      requiredEvidenceMissing,
      iteration,
      createdAt,
    });
  }

  if (!progress.madeProgress && (input.noProgressCount ?? 0) >= 2) {
    return buildDecision(input, {
      action: "block",
      reason: "No progress across repeated loop ticks",
      confidence: 0.82,
      ...common,
    });
  }

  if (input.requestedAction === "continue" || pendingNodes.length > 0 || requiredEvidenceMissing.length > 0) {
    return buildDecision(input, {
      action: "continue",
      reason: pendingNodes.length > 0
        ? `Run still has active or pending nodes: ${pendingNodes.join(", ")}`
        : "Required evidence is not yet recorded",
      confidence: 0.8,
      ...common,
    });
  }

  return buildDecision(input, {
    action: "block",
    reason: "Loop state did not match a safe continuation or close condition",
    confidence: 0.7,
    ...common,
  });
}

export function createLoopState(input: {
  runId: string;
  inputId: string;
  runState: EvaluateLoopDecisionInput["runState"];
  decision: LoopDecision;
  parentRunId?: string;
  maxIterations?: number;
  now?: () => Date;
}): OrchestrationLoopState {
  const now = (input.now ?? (() => new Date()))().toISOString();
  return {
    schemaVersion: 1,
    runId: input.runId,
    parentRunId: input.parentRunId,
    inputId: input.inputId,
    iteration: input.decision.iteration,
    maxIterations: resolveMaxIterations(input.maxIterations ?? input.runState.maxIterations),
    status: statusFromDecision(input.decision),
    decisions: [input.decision],
    stateSnapshot: {
      runId: input.runState.runId,
      iterationCount: input.runState.iterationCount,
      maxIterations: input.runState.maxIterations,
      completedAt: input.runState.completedAt,
    },
    createdAt: now,
    updatedAt: now,
  };
}

export function snapshotRunState(runState: EvaluateLoopDecisionInput["runState"]): DagLoopSnapshot {
  const nodeSets = createEmptyNodeSets();
  const byId = new Map(runState.nodes.map((node) => [node.id, node]));

  for (const node of runState.nodes) {
    if (node.status in nodeSets) nodeSets[node.status].push(node.id);
  }

  nodeSets.runnable = runState.nodes
    .filter((node) => {
      if (node.status !== "pending") return false;
      return node.dependsOn.every((dependencyId) => {
        const dependency = byId.get(dependencyId);
        return dependency?.status === "done" || dependency?.status === "skipped";
      });
    })
    .map((node) => node.id)
    .sort();

  sortNodeSets(nodeSets);

  const nodes = runState.nodes
    .map((node) => ({
      id: node.id,
      status: node.status,
      retries: node.retries,
      maxRetries: node.maxRetries,
      dependsOn: [...node.dependsOn].sort(),
      requiredInputs: (node.inputs ?? [])
        .filter((input) => input.required !== false)
        .map((input) => input.from ?? input.ref)
        .filter(Boolean)
        .sort(),
      requiredOutputs: (node.outputs ?? [])
        .filter((output) => output.required !== false)
        .map((output) => `${output.name}:${output.gate ?? "none"}`)
        .sort(),
      evidence: (node.evidence ?? [])
        .map((evidence) => `${evidence.gate}:${evidence.passed ? "pass" : "fail"}`)
        .sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const terminalCount =
    nodeSets.done.length +
    nodeSets.skipped.length +
    nodeSets.failed.length +
    nodeSets.blocked.length;
  const evidenceCount = nodes.reduce((count, node) => count + node.evidence.length, 0);

  return {
    hash: stableHash({ nodes }),
    nodeSets,
    terminalCount,
    evidenceCount,
    nodes,
  };
}

function detectProgress(
  previous: DagLoopSnapshot | undefined,
  current: DagLoopSnapshot,
): LoopProgressSignal {
  if (!previous) {
    return {
      previousHash: "",
      currentHash: current.hash,
      changedNodes: [],
      terminalDelta: 0,
      runnableDelta: current.nodeSets.runnable.length,
      evidenceDelta: current.evidenceCount,
      madeProgress: true,
    };
  }

  const previousStatuses = new Map(previous.nodes.map((node) => [node.id, node.status]));
  const changedNodes = current.nodes
    .filter((node) => previousStatuses.get(node.id) !== node.status)
    .map((node) => node.id);
  const terminalDelta = current.terminalCount - previous.terminalCount;
  const runnableDelta = current.nodeSets.runnable.length - previous.nodeSets.runnable.length;
  const evidenceDelta = current.evidenceCount - previous.evidenceCount;

  return {
    previousHash: previous.hash,
    currentHash: current.hash,
    changedNodes,
    terminalDelta,
    runnableDelta,
    evidenceDelta,
    madeProgress:
      previous.hash !== current.hash ||
      terminalDelta > 0 ||
      runnableDelta !== 0 ||
      evidenceDelta > 0 ||
      changedNodes.length > 0,
  };
}

function assessLoopRisk(input: {
  snapshot: DagLoopSnapshot;
  failedGates: string[];
  requiredEvidenceMissing: string[];
  noProgressCount: number;
}): LoopRiskSignal {
  const noActiveWork =
    input.snapshot.nodeSets.running.length === 0 &&
    input.snapshot.nodeSets.runnable.length === 0;
  const pendingWithoutRunnable = noActiveWork && input.snapshot.nodeSets.pending.length > 0;
  const retryExhausted = input.snapshot.nodes.some((node) => node.status === "failed" && node.retries >= node.maxRetries);
  const blockedRequiredDependency =
    input.snapshot.nodeSets.blocked.length > 0 ||
    (pendingWithoutRunnable && (input.snapshot.nodeSets.failed.length > 0 || input.snapshot.nodeSets.blocked.length > 0));

  return {
    deadlock: pendingWithoutRunnable ? 1 : 0,
    livelock: input.noProgressCount >= 2 ? 1 : 0,
    envPoisoning: 0,
    retryExhaustion: retryExhausted ? 1 : 0,
    blockedRequiredDependency: blockedRequiredDependency ? 1 : 0,
  };
}

function buildDecision(
  input: EvaluateLoopDecisionInput,
  decision: Omit<LoopDecision, "schemaVersion" | "runId" | "inputId">,
): LoopDecision {
  return {
    schemaVersion: 1,
    runId: input.runId,
    inputId: input.inputId,
    ...decision,
  };
}

function statusFromDecision(decision: LoopDecision): OrchestrationLoopState["status"] {
  if (decision.action === "close") return "closed";
  if (decision.action === "block" || decision.action === "handoff") return "blocked";
  if (
    decision.action === "replan" &&
    (decision.failedNodes.length > 0 ||
      decision.blockedNodes.length > 0 ||
      decision.failedGates.length > 0)
  ) {
    return "failed";
  }
  return "running";
}

function resolveMaxIterations(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_LOOP_MAX_ITERATIONS;
  return Math.min(HARD_LOOP_MAX_ITERATIONS, Math.max(1, Math.trunc(value)));
}

function createEmptyNodeSets(): LoopNodeSets {
  return {
    runnable: [],
    running: [],
    pending: [],
    failed: [],
    blocked: [],
    done: [],
    skipped: [],
  };
}

function sortNodeSets(nodeSets: LoopNodeSets): void {
  nodeSets.runnable.sort();
  nodeSets.running.sort();
  nodeSets.pending.sort();
  nodeSets.failed.sort();
  nodeSets.blocked.sort();
  nodeSets.done.sort();
  nodeSets.skipped.sort();
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function collectFailedGates(nodes: DagNode[]): string[] {
  return nodes.flatMap((node) =>
    (node.evidence ?? [])
      .filter((evidence) => evidence.passed === false)
      .map((evidence) => `${node.id}:${evidence.gate}`),
  );
}

function collectMissingRequiredEvidence(nodes: DagNode[]): string[] {
  const missing: string[] = [];
  for (const node of nodes) {
    for (const output of node.outputs ?? []) {
      if (output.required === false || !output.gate || output.gate === "none") continue;
      if (node.status !== "done") continue;
      const hasPassedEvidence = (node.evidence ?? []).some((evidence) => evidence.gate === output.gate && evidence.passed);
      if (!hasPassedEvidence) missing.push(`${node.id}:${output.gate}`);
    }
  }
  return missing;
}
