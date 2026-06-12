/**
 * OMK Provider Runner — Advisory execution wrappers
 * Extracted from provider-task-runner.ts to break God Module coupling
 */

import type { TaskResult, TaskRunner } from "../../contracts/orchestration.js";
import type { TaskRunContext } from "../../contracts/worker-context.js";
import type { DagNode } from "../../orchestration/dag.js";
import type { ProviderAssistMetadata, ProviderId, ProviderModelRef } from "../types.js";
import { providerModelEnv } from "./env.js";
import { providerExceptionResult, summarizeAdvisory, summarizeFailures } from "./results.js";

export async function runGenericProviderAdvisory(options: {
  node: DagNode;
  env: Record<string, string>;
  runner: TaskRunner;
  routeReason: string;
  modelRef?: ProviderModelRef;
  invocationKey: string;
  traceEnv: Record<string, string>;
  signal?: AbortSignal;
  context?: TaskRunContext;
  authorityProvider: ProviderId;
}): Promise<{ success: boolean; result: TaskResult; summary: string; failureReason?: string; metadata: ProviderAssistMetadata }> {
  let result: TaskResult;
  try {
    result = await options.runner.run(options.node, {
      ...options.env,
      ...options.traceEnv,
      ...providerModelEnv(options.modelRef),
      OMK_PROVIDER: options.modelRef?.provider ?? "external",
      OMK_PROVIDER_REQUESTED: options.modelRef?.provider ?? "external",
      OMK_PROVIDER_FALLBACK: options.authorityProvider,
      OMK_PROVIDER_ROUTE_REASON: options.routeReason,
      OMK_PROVIDER_AUTHORITY: "advisory",
    }, options.signal, options.context);
  } catch (error: unknown) {
    result = providerExceptionResult(error);
  }
  const success = result.success;
  const summary = success ? summarizeAdvisory(result.stdout) : "";
  const failureReason = success ? undefined : summarizeFailures([result]);
  return {
    success,
    result,
    summary,
    failureReason,
    metadata: {
      provider: options.modelRef?.provider ?? "external",
      model: options.modelRef?.model,
      participation: "advisory",
      invocationKey: options.invocationKey,
      success,
      summary,
      failureReason,
    },
  };
}
