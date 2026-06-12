/**
 * Reasoning Trace Engine (RTE) — 검증 가능한 작업 추론 흔적
 *
 * NOT raw CoT. Stores structured evidence of what the agent did and why.
 * Dataset export: redacted trajectory opt-in only.
 *
 * Key rule: "모델에게는 작은 NLP prompt만. 런타임에는 sidecar만.
 *            사용자에게는 theme/NLG만. 데이터셋에는 opt-in redacted trace만."
 */

import type { RequestIntent } from "../debloat-nlp.js";

// ── Trace Schema ────────────────────────────────────────────────

export interface ReasoningTrace {
  readonly id: string;
  readonly turnId: string;
  readonly timestamp: string;
  readonly userIntent: TraceIntent;
  readonly plan: TracePlan;
  readonly execution: TraceExecution;
  readonly evidence: TraceEvidence;
  readonly result: TraceResult;
  readonly privacy: TracePrivacy;
}

export interface TraceIntent {
  readonly raw: string;
  readonly classified: RequestIntent;
  readonly risk: string;
  readonly confidence: number;
}

export interface TracePlan {
  readonly summary: string;
  readonly steps: readonly string[];
  readonly toolsSelected: readonly string[];
  readonly mcpSelected: readonly string[];
  readonly skillsSelected: readonly string[];
}

export interface TraceExecution {
  readonly toolSequence: readonly TraceToolCall[];
  readonly decisionRecords: readonly TraceDecision[];
  readonly durationMs: number;
  readonly retries: number;
}

export interface TraceToolCall {
  readonly name: string;
  readonly args?: string;
  readonly resultSummary: string;
  readonly success: boolean;
  readonly durationMs: number;
}

export interface TraceDecision {
  readonly point: string;
  readonly chosen: string;
  readonly alternatives: readonly string[];
  readonly reason: string;
}

export interface TraceEvidence {
  readonly testResult?: TraceTestResult;
  readonly diffSummary?: string;
  readonly filesChanged: readonly string[];
  readonly commandsRun: readonly string[];
  readonly screenshots: readonly string[];
}

export interface TraceTestResult {
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly duration: string;
  readonly failures: readonly string[];
}

export interface TraceResult {
  readonly status: "success" | "partial" | "failed" | "blocked";
  readonly summary: string;
  readonly failureReason?: string;
  readonly acceptReject: "accept" | "reject" | "pending";
  readonly confidence: number;
}

export interface TracePrivacy {
  readonly level: "l0" | "l1" | "l2" | "l3";
  readonly redacted: boolean;
  readonly includedInDataset: boolean;
  readonly consentGiven: boolean;
  readonly redactionRules: readonly string[];
}

// ── Trace Store ─────────────────────────────────────────────────

export interface TraceStoreOptions {
  readonly baseDir?: string;
  readonly maxTraces?: number;
  readonly autoRedact?: boolean;
}

export interface TraceSearchResult {
  readonly trace: ReasoningTrace;
  readonly relevance: number;
}

export interface ReasoningTraceStore {
  append(trace: ReasoningTrace): Promise<void>;
  load(traceId: string): Promise<ReasoningTrace | undefined>;
  search(query: string, limit?: number): Promise<readonly TraceSearchResult[]>;
  list(limit?: number): Promise<readonly ReasoningTrace[]>;
  clear(): Promise<void>;
  exportRedacted(level: TracePrivacy["level"]): Promise<readonly ReasoningTrace[]>;
}

// ── NLG Report Types ────────────────────────────────────────────

export interface TraceSummary {
  readonly intent: string;
  readonly planSummary: string;
  readonly toolsUsed: readonly string[];
  readonly testResult?: string;
  readonly outcome: string;
  readonly duration: string;
  readonly confidence: number;
}

export interface ConsentAwareNlgInput {
  readonly trace: ReasoningTrace;
  readonly consentLevel: TracePrivacy["level"];
  readonly language: "ko" | "en";
  readonly includeFiles: boolean;
  readonly includeCommands: boolean;
}

export interface ConsentAwareNlgOutput {
  readonly summary: TraceSummary;
  readonly report: string;
  readonly redactedFields: readonly string[];
  readonly eligibleForDataset: boolean;
}
