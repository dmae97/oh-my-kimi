import type { TaskResult } from "../contracts/orchestration.js";
import type { TaskRunContext } from "../contracts/worker-context.js";
import type { DagNode } from "../orchestration/dag.js";
import type {
  ProviderId,
  ProviderKind,
  ProviderRisk,
  ProviderComplexity,
} from "./types.js";

export type { ProviderKind };

export interface AgentRunInput {
  node: DagNode;
  env: Record<string, string>;
  signal: AbortSignal;
  attempt: number;
  runContext?: TaskRunContext;
}

export interface AgentRunResult {
  success: boolean;
  exitCode?: number;
  stdout: string;
  stderr: string;
  metadata?: Record<string, unknown>;
}

export interface CostEstimate {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  currency: string;
}

export interface ProviderHealth {
  available: boolean;
  latencyMs?: number;
  lastCheckedAt: number;
  reason?: string;
}

export interface AgentProvider {
  readonly id: ProviderId | string;
  readonly kind: ProviderKind;
  readonly priority: number;
  supports(task: DagNode): boolean;
  run(input: AgentRunInput): Promise<AgentRunResult>;
  estimateCost?(input: AgentRunInput): Promise<CostEstimate>;
  health?(): Promise<ProviderHealth>;
}

export interface ProviderRouteInput {
  node: DagNode;
  risk: ProviderRisk;
  complexity: ProviderComplexity;
  needsToolCalling: boolean;
  needsMcp: boolean;
  readOnly: boolean;
  estimatedTokens: number;
  providerHint?: string;
  strategy?: ProviderRouteStrategy;
}

export type ProviderRouteStrategy =
  | "priority-first"
  | "kimi-first"
  | "cost-aware"
  | "fallback-on-evidence-fail"
  | "round-robin"
  | "lowest-latency";

export interface ProviderRouteDecision {
  provider: AgentProvider;
  reason: string;
  fallbacks: AgentProvider[];
  confidence: number;
  strategy: ProviderRouteStrategy;
}

export interface ProviderAttemptRecord {
  runId: string;
  nodeId: string;
  attempt: number;
  providerId: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  success: boolean;
  exitCode?: number;
  fallbackFrom?: string;
  fallbackReason?: string;
  cost?: CostEstimate;
}

export function toTaskResult(result: AgentRunResult): TaskResult {
  return {
    success: result.success,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    metadata: result.metadata,
  };
}
