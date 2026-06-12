import type { RuntimeId } from "./agent-runtime.js";

const PROVIDER_TO_RUNTIME: Record<string, RuntimeId> = {
  kimi: "kimi-api",
  deepseek: "deepseek-api",
  codex: "codex-cli",
  qwen: "qwen-api",
  openrouter: "openrouter-api",
  gemini: "gemini-cli",
  claude: "claude-code",
};

export function providerToRuntimeId(provider: string): RuntimeId {
  return PROVIDER_TO_RUNTIME[provider] ?? `${provider}-adapter`;
}

export function runtimeIdToProvider(runtimeId: RuntimeId): string {
  const entry = Object.entries(PROVIDER_TO_RUNTIME).find(([, rid]) => rid === runtimeId);
  return entry?.[0] ?? runtimeId.replace(/-adapter$/, "").replace(/-cli$/, "").replace(/-api$/, "");
}

export interface LegacyProviderDecision {
  provider: string;
  reason: string;
  fallbackProvider?: string;
  confidence: number;
}

export function legacyProviderToRuntimeIds(decision: LegacyProviderDecision): {
  selectedRuntime: RuntimeId;
  candidateRuntimes: RuntimeId[];
  fallbackChain: RuntimeId[];
} {
  const selectedRuntime = providerToRuntimeId(decision.provider);
  const fallbackChain = decision.fallbackProvider
    ? [providerToRuntimeId(decision.fallbackProvider)]
    : [];

  return {
    selectedRuntime,
    candidateRuntimes: [selectedRuntime, ...fallbackChain],
    fallbackChain,
  };
}
