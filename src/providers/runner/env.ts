/**
 * OMK Provider Runner — Environment & metadata builders
 * Extracted from provider-task-runner.ts to break God Module coupling
 */

import type { DagNode } from "../../orchestration/dag.js";
import type {
  DeepSeekRoutePlan,
  ProviderModelRef,
  ProviderRouteDecision,
  ProviderTaskMetadata,
} from "../types.js";

export function providerTraceEnv(decision: ProviderRouteDecision, invocationKey: string): Record<string, string> {
  const env: Record<string, string> = {
    OMK_PROVIDER_ROUTE_CONFIDENCE: decision.confidence.toFixed(2),
    OMK_PROVIDER_INVOCATION_KEY: invocationKey,
  };
  const routeEnsemble = summarizeRouteEnsemble(decision.routeEnsemble);
  if (routeEnsemble) {
    env.OMK_PROVIDER_ROUTE_ENSEMBLE = routeEnsemble;
  }
  if (decision.deepseek) {
    env.OMK_DEEPSEEK_INVOCATION_KEY = invocationKey;
  }
  if (decision.providerModel) {
    env.OMK_PROVIDER_MODEL = decision.providerModel.model;
    env.OMK_PROVIDER_AUTHORITY = decision.providerModel.authority;
    env.OMK_PROVIDER_CAPABILITIES = decision.providerModel.capabilities.join(",");
  }
  return env;
}

function summarizeRouteEnsemble(decision: ProviderRouteDecision["routeEnsemble"]): string {
  const candidates = decision.candidates
    .map((candidate) => [
      candidate.id,
      candidate.score.toFixed(2),
      candidate.selected ? "selected" : undefined,
      candidate.veto ? "veto" : undefined,
    ].filter(Boolean).join(":"))
    .join(",");
  return [
    `winner=${decision.winner}`,
    `confidence=${decision.confidence.toFixed(2)}`,
    `quorum=${decision.quorum}/${decision.candidates.length}`,
    `candidates=${candidates}`,
  ].join(";").slice(0, 1200);
}

export function buildProviderInvocationKey(node: DagNode, decision: ProviderRouteDecision): string {
  const seed = [
    node.id,
    node.role,
    decision.provider,
    decision.deepseek?.model ?? decision.providerModel?.model ?? "kimi",
    decision.deepseek?.participation ?? decision.providerModel?.authority ?? "authoritative",
    decision.reason,
  ].join(":");
  return `omk-${stableHash(seed).toString(16).padStart(8, "0")}`;
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function deepseekRouteEnv(plan: DeepSeekRoutePlan | undefined): Record<string, string> {
  if (!plan) return {};
  return {
    OMK_DEEPSEEK_MODEL: plan.model,
    OMK_DEEPSEEK_MODEL_TIER: plan.tier,
    OMK_DEEPSEEK_PARTICIPATION: plan.participation,
    OMK_DEEPSEEK_REASONING_EFFORT: plan.reasoningEffort,
    OMK_DEEPSEEK_RATIO_BUCKET: String(plan.ratioBucket),
  };
}

export function deepseekMetadata(plan: DeepSeekRoutePlan | undefined): Partial<ProviderTaskMetadata> {
  if (!plan) return {};
  return {
    providerModel: plan.model,
    providerModelTier: plan.tier,
    providerParticipation: plan.participation,
    providerAuthority: plan.participation,
  };
}

export function providerModelEnv(modelRef: ProviderModelRef | undefined): Record<string, string> {
  if (!modelRef) return {};
  return {
    OMK_PROVIDER_MODEL: modelRef.model,
    OMK_PROVIDER_AUTHORITY: modelRef.authority,
    OMK_PROVIDER_CAPABILITIES: modelRef.capabilities.join(","),
  };
}

export function providerModelMetadata(modelRef: ProviderModelRef | undefined): Partial<ProviderTaskMetadata> {
  if (!modelRef) return {};
  return {
    providerModel: modelRef.model,
    providerParticipation: modelRef.authority === "authority" || modelRef.authority === "veto" ? undefined : modelRef.authority,
    providerAuthority: modelRef.authority,
    providerModelRef: modelRef,
  };
}
