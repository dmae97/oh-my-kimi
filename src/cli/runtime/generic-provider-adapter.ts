/**
 * GenericProviderAdapter — wraps the existing provider system into ProviderAdapter interface.
 *
 * This is the bridge between the old provider system and the new ProviderAdapter abstraction.
 * Each provider (kimi, deepseek, openai, etc.) can be wrapped with this adapter.
 */

import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderChunk,
} from "./types.js";

export interface GenericProviderAdapterOptions {
  readonly name: string;
  readonly supportsStreaming?: boolean;
  readonly supportsToolCalling?: boolean;
  readonly supportsMcp?: boolean;
  readonly sendFn: (request: ProviderRequest) => AsyncIterable<ProviderChunk>;
  readonly abortFn?: () => void;
}

/**
 * Create a ProviderAdapter from a send function.
 * This is the simplest way to wrap an existing provider.
 */
export function createGenericProviderAdapter(
  options: GenericProviderAdapterOptions
): ProviderAdapter {
  return {
    name: options.name,
    supportsStreaming: options.supportsStreaming ?? true,
    supportsToolCalling: options.supportsToolCalling ?? false,
    supportsMcp: options.supportsMcp ?? false,
    send: options.sendFn,
    abort: options.abortFn,
  };
}

/**
 * Create a mock provider adapter for testing.
 */
export function createMockProviderAdapter(
  name: string = "mock",
  responses: string[] = ["OK"]
): ProviderAdapter {
  let responseIndex = 0;

  return {
    name,
    supportsStreaming: true,
    supportsToolCalling: false,
    supportsMcp: false,
    async *send(_request: ProviderRequest): AsyncIterable<ProviderChunk> {
      const response = responses[responseIndex % responses.length];
      responseIndex++;

      yield { type: "text", content: response };
      yield { type: "done" };
    },
  };
}
