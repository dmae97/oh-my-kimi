/**
 * OMK Provider Runner — Result builders & failure summarization
 * Extracted from provider-task-runner.ts to break God Module coupling
 */

import type { TaskResult } from "../../contracts/orchestration.js";
import type { DagNode } from "../../orchestration/dag.js";
import type {
  DeepSeekRoutePlan,
  ProviderAssistMetadata,
  ProviderFailureKind,
  ProviderId,
  ProviderModelRef,
  ProviderRouteDecision,
  ProviderTaskMetadata,
} from "../types.js";
import { withProviderMetadata } from "../types.js";
import { deepseekMetadata, providerModelMetadata } from "./env.js";

export function markProviderLaneSkippable(node: DagNode): void {
  node.failurePolicy = {
    ...(node.failurePolicy ?? {}),
    skipOnFailure: true,
  };
}

export function providerLaneSkipResult(options: {
  node: DagNode;
  provider: ProviderId;
  requestedProvider: ProviderId;
  decision: ProviderRouteDecision;
  reason: string;
  failureKind: ProviderFailureKind;
  attempts: number;
  traceMetadata: Partial<ProviderTaskMetadata>;
  providerModel?: ProviderModelRef;
  deepseekPlan?: DeepSeekRoutePlan;
  providerAssist?: ProviderAssistMetadata;
  baseResult: TaskResult;
}): TaskResult {
  markProviderLaneSkippable(options.node);
  const stdout = options.baseResult.stdout || `[omk] ${providerDisplayName(options.provider)} optional lane skipped: ${options.reason}\n`;
  const stderr = options.baseResult.stderr || options.reason;
  const metadata: ProviderTaskMetadata = {
    provider: options.provider,
    requestedProvider: options.requestedProvider,
    providerRouteReason: options.decision.reason,
    ...options.traceMetadata,
    providerAttemptCount: options.attempts,
    ...(options.provider === "deepseek"
      ? deepseekMetadata(options.deepseekPlan)
      : providerModelMetadata(options.providerModel)),
    providerSkip: {
      provider: options.provider,
      reason: options.reason,
      skippable: true,
      attempts: options.attempts,
      failureKind: options.failureKind,
    },
  };
  if (options.providerAssist) {
    metadata.providerAssist = options.providerAssist;
  }

  return withProviderMetadata({
    ...options.baseResult,
    success: false,
    exitCode: options.baseResult.exitCode ?? 1,
    stdout,
    stderr,
  }, metadata);
}

export function providerExceptionResult(error: unknown): TaskResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    success: false,
    exitCode: 1,
    stdout: "",
    stderr: message,
  };
}

export function authorityUnavailableResult(
  node: DagNode,
  decision: ProviderRouteDecision,
  traceMetadata: Partial<ProviderTaskMetadata>,
  reason: string,
  authorityProvider: ProviderId
): TaskResult {
  markProviderLaneSkippable(node);
  return withProviderMetadata({
    success: false,
    exitCode: 1,
    stdout: `[omk] Authority provider unavailable: ${reason}\n`,
    stderr: reason,
  }, {
    provider: authorityProvider,
    requestedProvider: decision.provider,
    providerRouteReason: decision.reason,
    ...traceMetadata,
    providerSkip: {
      provider: authorityProvider,
      reason,
      skippable: true,
      attempts: 0,
      failureKind: "availability",
    },
  });
}

export function summarizeAdvisory(stdout: string): string {
  return stdout
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 6000);
}

export function summarizeFailures(failures: TaskResult[]): string {
  if (failures.length === 0) return "";
  return failures
    .map((failure, index) => {
      const text = `${failure.stderr}\n${failure.stdout}`.trim().replace(/\s+/g, " ");
      return `attempt ${index + 1}: ${text || `exit ${failure.exitCode ?? "unknown"}`}`;
    })
    .join(" | ")
    .slice(0, 500);
}

function providerDisplayName(provider: ProviderId): string {
  if (provider === "deepseek") return "DeepSeek";
  if (provider === "qwen") return "Qwen";
  if (provider === "codex") return "Codex";
  if (provider === "openrouter") return "OpenRouter";
  if (provider === "kimi") return "Kimi";
  return provider;
}
