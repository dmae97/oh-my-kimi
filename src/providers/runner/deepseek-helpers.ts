/**
 * OMK Provider Runner — DeepSeek-specific helpers
 * Extracted from provider-task-runner.ts to break God Module coupling
 */

import type { DagNode } from "../../orchestration/dag.js";
import type { DeepSeekRoutePlan, ProviderAssistMetadata } from "../types.js";
import type { TaskResult, TaskRunner } from "../../contracts/orchestration.js";
import type { TaskRunContext } from "../../contracts/worker-context.js";
import { DEEPSEEK_V4_FLASH_MODEL, DEEPSEEK_V4_PRO_MODEL } from "../router.js";
import { summarizeAdvisory } from "./results.js";

export function deepseekPlanFromNode(node: DagNode): DeepSeekRoutePlan | undefined {
  if (!isDeepSeekLaneNode(node)) return undefined;
  const model = [node.routing?.providerModel, node.routing?.assignedModel]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  const tier = node.routing?.providerModelTier
    ?? (model.includes("pro") ? "pro" : model.includes("flash") ? "flash" : undefined);
  if (!tier) return undefined;
  return {
    provider: "deepseek",
    model: tier === "flash" ? DEEPSEEK_V4_FLASH_MODEL : DEEPSEEK_V4_PRO_MODEL,
    tier,
    participation: "direct",
    reasoningEffort: "max",
    ratioBucket: tier === "flash" ? 0 : 9,
  };
}

function isDeepSeekLaneNode(node: DagNode): boolean {
  return node.routing?.provider === "deepseek" || node.routing?.providerModel?.toLowerCase().includes("deepseek") || false;
}

export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Aborted"));
    }, { once: true });
  });
}

export function resolveDeepSeekAdvisoryTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.OMK_DEEPSEEK_ADVISORY_TIMEOUT_MS;
  if (!raw) return 30_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
}

export interface DeepSeekAdvisoryOutput {
  summary: string;
  suggestions: string[];
  confidence: number;
  findings?: string[];
  risks?: string[];
  questionsForAuthorityProvider?: string[];
  }

export function parseStructuredAdvisory(stdout: string): DeepSeekAdvisoryOutput {
  const result: DeepSeekAdvisoryOutput = { summary: "", suggestions: [], confidence: 0 };
  try {
    const json = JSON.parse(stdout) as unknown;
    if (json && typeof json === "object") {
      const obj = json as Record<string, unknown>;
      if (typeof obj.summary === "string") result.summary = obj.summary;
      if (Array.isArray(obj.suggestions)) result.suggestions = obj.suggestions.filter((s): s is string => typeof s === "string");
      if (Array.isArray(obj.findings)) result.findings = obj.findings.filter((s): s is string => typeof s === "string");
      if (Array.isArray(obj.risks)) result.risks = obj.risks.filter((s): s is string => typeof s === "string");
      if (Array.isArray(obj.questionsForAuthorityProvider)) {
        result.questionsForAuthorityProvider = obj.questionsForAuthorityProvider.filter((s): s is string => typeof s === "string");
      }
      if (typeof obj.confidence === "number") result.confidence = obj.confidence;
    }
  } catch {
    // Fallback: treat entire stdout as summary
    result.summary = stdout.trim();
  }
  return result;
}

export async function runDeepSeekAdvisory(options: {
  node: DagNode;
  env: Record<string, string>;
  runner: TaskRunner;
  routeReason: string;
  plan: DeepSeekRoutePlan;
  invocationKey: string;
  traceEnv: Record<string, string>;
  signal?: AbortSignal;
  context?: TaskRunContext;
}): Promise<{ success: boolean; result: TaskResult; summary: string; failureReason?: string; structured?: DeepSeekAdvisoryOutput; metadata: ProviderAssistMetadata }> {
  let result: TaskResult;
  const controller = new AbortController();
  const forwardAbort = (): void => {
    controller.abort(options.signal?.reason ?? new Error("Aborted"));
  };
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener("abort", forwardAbort, { once: true });
  const timeoutMs = resolveDeepSeekAdvisoryTimeoutMs({ ...process.env, ...options.env });
  let timeout: NodeJS.Timeout | undefined;
  try {
    const runPromise = options.runner.run(options.node, {
      ...options.env,
      ...options.traceEnv,
      OMK_DEEPSEEK_MODEL: options.plan.model,
      OMK_DEEPSEEK_MODEL_TIER: options.plan.tier,
      OMK_DEEPSEEK_PARTICIPATION: options.plan.participation,
      OMK_PROVIDER: "deepseek",
      OMK_PROVIDER_REQUESTED: "deepseek",
      OMK_PROVIDER_ROUTE_REASON: options.routeReason,
      OMK_PROVIDER_AUTHORITY: "advisory",
    }, controller.signal, options.context);
    const timeoutPromise = new Promise<TaskResult>((resolve) => {
      timeout = setTimeout(() => {
        const reason = new Error(`DeepSeek advisory timed out after ${timeoutMs}ms`);
        controller.abort(reason);
        resolve({ success: false, exitCode: 124, stdout: "", stderr: reason.message });
      }, timeoutMs);
    });
    result = await Promise.race([runPromise, timeoutPromise]);
  } catch (error: unknown) {
    result = { success: false, exitCode: 1, stdout: "", stderr: String(error) };
  } finally {
    if (timeout) clearTimeout(timeout);
    options.signal?.removeEventListener("abort", forwardAbort);
  }

  const success = result.success;
  const structured = success ? parseStructuredAdvisory(result.stdout) : undefined;
  const summary = structured?.summary ?? (success ? summarizeAdvisory(result.stdout) : "");
  const failureReason = success ? undefined : summarizeFailures([result]);
  return {
    success,
    result,
    summary,
    failureReason,
    structured,
    metadata: {
      provider: "deepseek",
      model: options.plan.model,
      modelTier: options.plan.tier,
      participation: "advisory",
      invocationKey: options.invocationKey,
      success,
      summary,
      failureReason,
    },
  };
}

function summarizeFailures(failures: TaskResult[]): string {
  if (failures.length === 0) return "";
  return failures
    .map((failure, index) => {
      const text = `${failure.stderr}\n${failure.stdout}`.trim().replace(/\s+/g, " ");
      return `attempt ${index + 1}: ${text || `exit ${failure.exitCode ?? "unknown"}`}`;
    })
    .join(" | ")
    .slice(0, 500);
}
