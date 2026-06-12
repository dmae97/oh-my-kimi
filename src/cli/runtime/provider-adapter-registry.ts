/**
 * ProviderAdapterRegistry — provider-neutral adapter registry.
 *
 * Replaces Kimi-specific hardcoding with a pluggable adapter pattern.
 * Each provider (kimi, deepseek, openai, codex, opencode, etc.) registers an adapter.
 */

import type { ProviderAdapter } from "./types.js";

const adapters = new Map<string, ProviderAdapter>();

/**
 * Register a provider adapter.
 */
export function registerProviderAdapter(adapter: ProviderAdapter): void {
  adapters.set(adapter.name, adapter);
}

/**
 * Get a provider adapter by name.
 */
export function getProviderAdapter(name: string): ProviderAdapter | undefined {
  return adapters.get(name);
}

/**
 * List all registered provider adapters.
 */
export function listProviderAdapters(): readonly ProviderAdapter[] {
  return [...adapters.values()];
}

/**
 * Check if a provider adapter is registered.
 */
export function hasProviderAdapter(name: string): boolean {
  return adapters.has(name);
}

/**
 * Get the best available provider adapter based on requirements.
 */
export function selectProviderAdapter(options: {
  readonly preferProvider?: string;
  readonly requireToolCalling?: boolean;
  readonly requireMcp?: boolean;
  readonly requireStreaming?: boolean;
}): ProviderAdapter | undefined {
  // Preferred provider first
  if (options.preferProvider) {
    const preferred = adapters.get(options.preferProvider);
    if (preferred && meetsRequirements(preferred, options)) {
      return preferred;
    }
  }

  // Find first adapter that meets requirements
  for (const adapter of adapters.values()) {
    if (meetsRequirements(adapter, options)) {
      return adapter;
    }
  }

  // Fallback: any adapter
  return adapters.values().next().value;
}

function meetsRequirements(
  adapter: ProviderAdapter,
  options: {
    readonly requireToolCalling?: boolean;
    readonly requireMcp?: boolean;
    readonly requireStreaming?: boolean;
  }
): boolean {
  if (options.requireToolCalling && !adapter.supportsToolCalling) return false;
  if (options.requireMcp && !adapter.supportsMcp) return false;
  if (options.requireStreaming && !adapter.supportsStreaming) return false;
  return true;
}
