/**
 * MimoApiRuntime — Xiaomi MiMo API runtime adapter.
 * Calls https://api.xiaomimimo.com/v1/chat/completions directly.
 * Extends KimiApiRuntime with MiMo-specific defaults.
 */

import { KimiApiRuntime, type KimiApiRuntimeOptions } from "./kimi-api-runtime.js";
import type { AgentRuntime } from "./agent-runtime.js";

export interface MimoApiRuntimeOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}

export function createMimoApiRuntime(options: MimoApiRuntimeOptions = {}): AgentRuntime {
  const env = options.env ?? process.env;
  return new MimoApiRuntime({
    apiKey: options.apiKey ?? env.MIMO_API_KEY,
    model: options.model ?? env.MIMO_MODEL,
    baseUrl: options.baseUrl ?? env.MIMO_BASE_URL,
  });
}

class MimoApiRuntime extends KimiApiRuntime {
  constructor(options: KimiApiRuntimeOptions = {}) {
    super({
      ...options,
      id: "mimo-api",
      priority: 95,
      baseUrl: options.baseUrl ?? "https://api.xiaomimimo.com/v1",
    });
  }
}
