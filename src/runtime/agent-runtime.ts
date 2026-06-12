/**
 * AgentRuntime — internal runtime implementation interface.
 *
 * Concrete runtimes (KimiApiRuntime, DeepSeekRuntime, CodexRuntime,
 * KimiWireProtocolRuntime, etc.) implement this interface.
 *
 * It is broader than RuntimeAdapter: runNode operates on ContextCapsule,
 * and execute()/health() are optional extension hooks.
 *
 * For the provider-routing interface, see src/runtime/adapter.ts (RuntimeAdapter).
 */

import type { TaskResult } from "../contracts/orchestration.js";
import type { GoalExecutionContext, WorkerManifest } from "../contracts/worker-context.js";
import type { ContextCapsule } from "./context-capsule.js";
import type {
  RuntimeId,
  RuntimeKind,
  RuntimeAuthority,
  RuntimeCapabilities,
  RuntimeHealth,
} from "./contracts/shared.js";

export type { RuntimeId, RuntimeKind, RuntimeAuthority, RuntimeCapabilities, RuntimeHealth };

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface ToolCallRecord {
  readonly name: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly durationMs: number;
  readonly success: boolean;
  /** SHA-256 hash from AuditRecord for dedup/correlation */
  readonly auditHash?: string;
  /** Whether secrets were redacted by governance */
  readonly redacted?: boolean;
  /** Path to evidence artifact file (.omk/runs/<runId>/artifacts/mcp/<auditId>.json) */
  readonly evidenceRef?: string;
}

export interface AgentRunResult {
  readonly success: boolean;
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly metadata?: Record<string, unknown>;
  readonly tokenUsage?: TokenUsage;
  readonly toolCalls?: readonly ToolCallRecord[];
}

export interface AgentTask {
  prompt: string;
  context: AgentContext;
  tools: ToolManifest;
  providerPolicy: ProviderPolicy;
  capabilities: CapabilityManifest;
}

export interface AgentResult {
  output: string;
  exitCode: number;
  thinking?: string;
  todos?: Array<{ id: string; title: string; status: "pending" | "in_progress" | "done" }>;
  tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  toolCalls?: readonly ToolCallRecord[];
  metadata?: Record<string, unknown>;
}

export interface AgentContext {
  runId: string;
  nodeId: string;
  role?: string;
  goal?: string;
  system?: string;
  files?: string[];
  memory?: Array<{ key: string; source: string; summary: string }>;
  cwd?: string;
  env?: Record<string, string>;
  providerModel?: string;
  risk?: string;
  approvalPolicy?: string;
  sandboxMode?: string;
  abortSignal?: AbortSignal;
  goalContext?: GoalExecutionContext;
  workerManifest?: WorkerManifest;
  onOutput?: (text: string) => void;
}

export interface ToolManifestEntry {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly readOnly?: boolean;
  readonly parallelSafe?: boolean;
  readonly stormExempt?: boolean;
  readonly skipRetentionSave?: boolean;
}

export interface ToolManifest {
  available: ToolManifestEntry[];
  mcpServers?: string[];
  skills?: string[];
  hooks?: string[];
}

export interface ProviderPolicy {
  strategy: "priority-first" | "cost-aware" | "fallback-on-evidence-fail" | "round-robin" | "lowest-latency";
  preferredProviders: string[];
  fallbackChain: string[];
  maxCost?: number;
  maxLatencyMs?: number;
}

export interface CapabilityManifest {
  read: boolean;
  write: boolean;
  shell: boolean;
  mcp: boolean;
  patch: boolean;
  review: boolean;
  merge: boolean;
  vision: boolean;
  streaming?: boolean;
  structuredOutput?: boolean;
  toolCalling?: boolean;
  maxTokens?: number;
}

export interface AgentRuntime {
  readonly id: RuntimeId;
  readonly displayName?: string;
  readonly kind?: RuntimeKind;
  readonly priority: number;
  readonly capabilities?: RuntimeCapabilities;
  supports(capsule: ContextCapsule): boolean;
  runNode(capsule: ContextCapsule, signal: AbortSignal): Promise<AgentRunResult>;
  execute?(task: AgentTask): Promise<AgentResult>;
  health?(): Promise<RuntimeHealth>;
}

export function toTaskResult(result: AgentRunResult): TaskResult {
  return {
    success: result.success,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    metadata: {
      ...result.metadata,
      ...(result.tokenUsage != null && { tokenUsage: result.tokenUsage }),
      ...(result.toolCalls != null && result.toolCalls.length > 0 && { toolCalls: result.toolCalls }),
    },
  };
}
