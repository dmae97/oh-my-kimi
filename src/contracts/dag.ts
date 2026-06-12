// Contract: src/contracts/dag.ts
// Owner: Contract Worker (Phase 0)
// Read-only for all other workers. Version-bump only via Integration Worker.

import type { DeepSeekModelTier, DeepSeekParticipation, ProviderAssistMetadata, ProviderId } from "../providers/types.js";
import type { ProviderPolicy } from "../runtime/agent-runtime.js";

export type TaskStatus = "pending" | "running" | "done" | "failed" | "blocked" | "skipped";
export type DagContextBudget = "tiny" | "small" | "normal";
export type DagOutputGate = "file-exists" | "test-pass" | "review-pass" | "command-pass" | "summary" | "none";

export interface DagNodeInput {
  name: string;
  ref: string;
  from?: string;
  required?: boolean;
}

export interface DagNodeOutput {
  name: string;
  ref?: string;
  gate?: DagOutputGate;
  required?: boolean;
}

export interface DagNodeRouting {
  provider?: "auto" | ProviderId;
  fallbackProvider?: ProviderId;
  providerReason?: string;
  providerModel?: string;
  providerModelTier?: DeepSeekModelTier;
  assignedProvider?: ProviderId;
  candidateProviders?: ProviderId[];
  assignedModel?: string;
  assignedProviderAuthority?: "authority" | "direct" | "advisory" | "veto";
  assignedProviderCapabilities?: string[];
  risk?: "read" | "write" | "shell" | "merge";
  promptMode?: "default" | "dnc-nlp";
  runtimeSidecar?: {
    provider: string;
    model: string;
    intent: string;
    risk: string;
    sandbox: string;
    requiredMcp: string[];
    optionalMcp: string[];
    disabledMcp: string[];
    selectedSkills: string[];
    failurePolicy: "required-only" | "strict";
  };
  executionPrompt?: string;
  approvalPolicy?: string;
  sandboxMode?: "read-only" | "workspace-write";
  autoSpawned?: boolean;
  spawnReason?: string;
  routeSource?: "skill" | "mcp" | "hook" | "provider";
  assignedCapabilities?: {
    skills?: string[];
    mcpServers?: string[];
    tools?: string[];
    hooks?: string[];
  };
  /**
   * Skills/MCP/tools are routing hints for the selected provider adapter by default.
   * Set these booleans only when a node cannot run without live MCP/tool
   * authority; opportunistic providers can still advise from the hint list.
   */
  requiresMcp?: boolean;
  requiresToolCalling?: boolean;
  skills?: string[];
  mcpServers?: string[];
  tools?: string[];
  hooks?: string[];
  contextBudget?: DagContextBudget;
  readOnly?: boolean;
  evidenceRequired?: boolean;
  rationale?: string;
  replanHint?: {
    criterionId?: string;
    artifactRef?: string;
    targetAtomId?: string;
    preserveEvidence?: boolean;
  };
  rejected?: Array<{ id: string; reason: string }>;
  actionAtom?: {
    id: string;
    label: string;
    verb: string;
    object?: string;
    evidenceTarget: string;
    doneCondition: string;
  };
}

export interface DagNodeFailurePolicy {
  retryable?: boolean;
  blockDependents?: boolean;
  fallbackRole?: string;
  skipOnFailure?: boolean;
}

export interface DagNodeEvidence {
  gate: string;
  passed: boolean;
  ref?: string;
  message?: string;
  failureKind?: string;
}

export interface DagNodeAttempt {
  attempt: number;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  status?: "done" | "failed";
  provider?: ProviderId;
  requestedProvider?: ProviderId;
  fallbackFrom?: ProviderId;
  fallbackReason?: string;
  providerModel?: string;
  providerModelTier?: DeepSeekModelTier;
  providerParticipation?: DeepSeekParticipation;
  providerAssist?: ProviderAssistMetadata;
}

export interface DagNode {
  id: string;
  name: string;
  role: string;
  dependsOn: string[];
  status: TaskStatus;
  worktree?: string;
  retries: number;
  maxRetries: number;
  timeoutMs?: number;
  timeoutPreset?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  attempts?: DagNodeAttempt[];
  priority?: number;
  cost?: 1 | 2 | 3;
  inputs?: DagNodeInput[];
  outputs?: DagNodeOutput[];
  routing?: DagNodeRouting;
  failurePolicy?: DagNodeFailurePolicy;
  blockedReason?: string;
  evidence?: DagNodeEvidence[];
  /** Live "thinking" text exposed while the node is running (e.g. ensemble progress). */
  thinking?: string;
  executionMode?: "in-process" | "subprocess";
  providerPolicy?: ProviderPolicy;
}

export interface Dag {
  nodes: DagNode[];
}

export type DagNodeDefinition = Omit<DagNode, "status" | "retries">;
