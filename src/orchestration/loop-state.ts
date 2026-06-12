import type { RunState } from "../contracts/orchestration.js";

export type LoopDecisionAction =
  | "close"
  | "continue"
  | "replan"
  | "verify-only"
  | "block"
  | "handoff";

export interface LoopNodeSets {
  runnable: string[];
  running: string[];
  pending: string[];
  failed: string[];
  blocked: string[];
  done: string[];
  skipped: string[];
}

export interface LoopProgressSignal {
  previousHash: string;
  currentHash: string;
  changedNodes: string[];
  terminalDelta: number;
  runnableDelta: number;
  evidenceDelta: number;
  madeProgress: boolean;
}

export interface LoopRiskSignal {
  deadlock: number;
  livelock: number;
  envPoisoning: number;
  retryExhaustion: number;
  blockedRequiredDependency: number;
}

export interface DagLoopSnapshot {
  hash: string;
  nodeSets: LoopNodeSets;
  terminalCount: number;
  evidenceCount: number;
  nodes: Array<{
    id: string;
    status: string;
    retries: number;
    maxRetries: number;
    dependsOn: string[];
    requiredInputs: string[];
    requiredOutputs: string[];
    evidence: string[];
  }>;
}

export interface LoopDecision {
  schemaVersion: 1;
  action: LoopDecisionAction;
  reason: string;
  confidence: number;
  inputId: string;
  runId: string;
  iteration: number;
  nextPrompt?: string;
  failedNodes: string[];
  blockedNodes: string[];
  pendingNodes: string[];
  nodeSets: LoopNodeSets;
  progress: LoopProgressSignal;
  risk: LoopRiskSignal;
  failedGates: string[];
  requiredEvidenceMissing: string[];
  createdAt: string;
}

export interface OrchestrationLoopState {
  schemaVersion: 1;
  runId: string;
  parentRunId?: string;
  inputId: string;
  iteration: number;
  maxIterations: number;
  status: "running" | "closed" | "blocked" | "failed";
  decisions: LoopDecision[];
  stateSnapshot?: Pick<RunState, "runId" | "iterationCount" | "maxIterations" | "completedAt">;
  createdAt: string;
  updatedAt: string;
}

export interface EvaluateLoopDecisionInput {
  runId: string;
  inputId: string;
  runState: RunState;
  iteration?: number;
  maxIterations?: number;
  requestedAction?: "continue" | "replan" | "verify";
  previousSnapshot?: DagLoopSnapshot;
  noProgressCount?: number;
  now?: () => Date;
}
