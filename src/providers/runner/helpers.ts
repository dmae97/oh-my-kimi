/**
 * OMK Provider Runner — Shared routing helpers
 * Extracted from provider-task-runner.ts to break God Module coupling
 */

import type { ProviderId, ProviderRouteDecision } from "../types.js";

export function providerDisplayName(provider: ProviderId): string {
  if (provider === "deepseek") return "DeepSeek";
  if (provider === "qwen") return "Qwen";
  if (provider === "codex") return "Codex";
  if (provider === "openrouter") return "OpenRouter";
  if (provider === "kimi") return "Kimi";
  return provider;
}

export function isExternalProvider(provider: ProviderId, authorityProvider: ProviderId): boolean {
  return provider !== authorityProvider && provider !== "deepseek";
}

export function genericAdvisoryProviderForDecision(
  decision: ProviderRouteDecision,
  authorityProvider: ProviderId
): ProviderId | undefined {
  const modelRef = decision.providerModel;
  if (!modelRef) return undefined;
  const provider = modelRef.provider;
  if (isExternalProvider(provider, authorityProvider) && modelRef.authority === "advisory") return provider;
  return undefined;
}

export function requestedProviderForAuthorityDecision(
  decision: ProviderRouteDecision,
  authorityProvider: ProviderId
): ProviderId {
  const modelRef = decision.providerModel;
  if (!modelRef) return decision.provider;
  const provider = modelRef.provider;
  if (isExternalProvider(provider, authorityProvider) && modelRef.authority === "veto") return provider;
  return decision.provider;
}
