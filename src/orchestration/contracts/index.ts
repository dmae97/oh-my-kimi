/**
 * Orchestration contracts — types shared across the orchestration layer.
 *
 * Extracted from orchestration-state.ts (Phase 4a).
 */

import type { DagNode } from "../dag.js";
import type { RunCapabilityAssignment, RunState, TaskResult } from "../../contracts/orchestration.js";

export type WorkerStatus = "idle" | "running" | "completed" | "failed" | "retrying";

export interface WorkerState {
  nodeId: string;
  status: WorkerStatus;
  retryCount: number;
  maxRetries: number;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  result?: TaskResult;
  error?: string;
  assignment?: RunCapabilityAssignment;
}

export interface OrchestrationEvent {
  type: "worker_started" | "worker_completed" | "worker_failed" | "worker_retrying" | "batch_completed" | "orchestration_completed";
  nodeId?: string;
  batchIndex?: number;
  timestamp: string;
  data?: Record<string, unknown>;
}

export type OrchestrationEventType = OrchestrationEvent["type"];

export interface OrchestrationState {
  runId: string;
  status: "initializing" | "running" | "paused" | "completed" | "failed" | "cancelled";
  workers: Map<string, WorkerState>;
  events: OrchestrationEvent[];
  completedNodes: Set<string>;
  startedAt: string;
  completedAt?: string;
}

export interface StateManagerOptions {
  runId: string;
  nodes: DagNode[];
  workerCount: number;
  goalId?: string;
  goalSnapshot?: RunState["goalSnapshot"];
  basePath?: string;
}
