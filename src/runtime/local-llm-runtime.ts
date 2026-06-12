/**
 * LocalLlmRuntime — local LLM via OpenAI-compatible chat completions API.
 *
 * Connects to llama.cpp server, llama-server, vllm, or any
 * local OpenAI-compatible endpoint (/v1/chat/completions).
 * Supports SSE streaming and reasoning_content.
 */

import type {
  AgentRuntime,
  AgentRunResult,
  AgentResult,
  AgentTask,
  RuntimeCapabilities,
  RuntimeHealth,
  TokenUsage,
} from "./agent-runtime.js";
import type { ContextCapsule } from "./context-capsule.js";
import { capsuleToTask } from "./context-broker-converter.js";
import { sanitizeUserVisibleOutput } from "../util/user-visible-output.js";

interface LocalLlmChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface LocalLlmStreamDelta {
  content?: string;
  reasoning_content?: string;
  role?: string;
}

interface LocalLlmStreamChoice {
  delta: LocalLlmStreamDelta;
  finish_reason?: string | null;
  index: number;
}

interface LocalLlmStreamResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: LocalLlmStreamChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface LocalLlmRuntimeOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

export class LocalLlmRuntime implements AgentRuntime {
  readonly id = "local-llm";
  readonly kind = "api";
  readonly priority = 35;
  readonly capabilities: RuntimeCapabilities = {
    read: true,
    write: false,
    shell: false,
    mcp: false,
    patch: false,
    review: true,
    merge: false,
    vision: false,
    supportsStreaming: true,
    supportsStructuredOutput: false,
    supportsToolCalling: false,
  };

  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(options: LocalLlmRuntimeOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.LOCAL_LLM_API_KEY ?? "not-needed";
    this.model = options.model ?? process.env.LOCAL_LLM_MODEL ?? "qwen3-coder-30b-a3b";
    this.baseUrl = (options.baseUrl ?? process.env.LOCAL_LLM_BASE_URL ?? "http://localhost:8080/v1").replace(/\/+$/, "");
  }

  supports(capsule: ContextCapsule): boolean {
    const requiredCapabilities = capsule.node.routing?.assignedProviderCapabilities ?? [];
    if (
      requiredCapabilities.some((capability) =>
        ["write", "patch", "shell", "mcp", "merge", "vision"].includes(capability)
      )
    ) return false;
    if (capsule.node.routing?.requiresToolCalling) return false;
    return true;
  }

  async health(): Promise<RuntimeHealth> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(`${this.baseUrl}/models`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return {
        runtimeId: this.id,
        available: resp.ok,
        reason: resp.ok ? undefined : `Local LLM returned ${resp.status}`,
        checkedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        runtimeId: this.id,
        available: false,
        reason: `Local LLM not reachable: ${err instanceof Error ? err.message : String(err)}`,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  async runNode(capsule: ContextCapsule, signal: AbortSignal): Promise<AgentRunResult> {
    try {
      const task = await capsuleToTask(capsule, signal);
      const result = await this.execute(task);
      return {
        success: result.exitCode === 0,
        exitCode: result.exitCode,
        stdout: result.output,
        stderr: "",
        metadata: {
          runtime: this.id,
          ...(result.thinking && { thinking: result.thinking }),
          ...(result.tokenUsage && { tokenUsage: result.tokenUsage as TokenUsage }),
        },
      };
    } catch (err) {
      const errorMsg = String(err);
      return {
        success: false,
        exitCode: 1,
        stdout: "",
        stderr: errorMsg,
        metadata: { runtime: this.id, error: errorMsg },
      };
    }
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    if (
      task.capabilities.write ||
      task.capabilities.patch ||
      task.capabilities.shell ||
      task.capabilities.mcp ||
      task.capabilities.merge ||
      task.capabilities.toolCalling
    ) {
      return {
        output: "",
        exitCode: 1,
        thinking: "",
        metadata: {
          error: "local-llm is advisory/read-only and does not receive write, shell, MCP, merge, patch, or tool-calling authority",
          authorityMode: "advisory",
        },
      };
    }

    const messages: LocalLlmChatMessage[] = [];
    if (task.context.system) {
      messages.push({ role: "system", content: task.context.system });
    }
    messages.push({ role: "user", content: task.prompt });

    const body: Record<string, unknown> = {
      model: task.context.providerModel ?? task.context.env?.OMK_PROVIDER_MODEL ?? this.model,
      messages,
      stream: true,
    };

    if (task.capabilities.maxTokens) {
      body.max_tokens = task.capabilities.maxTokens;
    }

    try {
      const timeoutMs = Number(process.env.OMK_PROVIDER_TIMEOUT_MS ?? "300000");
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = task.context.abortSignal
        ? AbortSignal.any([task.context.abortSignal, timeoutSignal])
        : timeoutSignal;

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        return {
          output: "",
          exitCode: 1,
          thinking: "",
          metadata: { error: `Local LLM API error ${response.status}: ${errorText}` },
        };
      }

      return this.parseStreamResponse(response, task.context.onOutput);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return {
          output: "",
          exitCode: 130,
          thinking: "",
          metadata: { error: "Request aborted" },
        };
      }
      return {
        output: "",
        exitCode: 1,
        thinking: "",
        metadata: { error: String(err) },
      };
    }
  }

  private async parseStreamResponse(
    response: Response,
    onOutput?: (text: string) => void,
  ): Promise<AgentResult> {
    const reader = response.body?.getReader();
    if (!reader) {
      return {
        output: "",
        exitCode: 1,
        thinking: "",
        metadata: { error: "No response body for stream" },
      };
    }

    const decoder = new TextDecoder();
    let output = "";
    let reasoning = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === "data: [DONE]") continue;
          if (!trimmed.startsWith("data: ")) continue;

          const jsonStr = trimmed.slice(6);
          let parsed: LocalLlmStreamResponse;
          try {
            parsed = JSON.parse(jsonStr) as LocalLlmStreamResponse;
          } catch {
            continue;
          }

          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) {
            output += delta.content;
            onOutput?.(sanitizeUserVisibleOutput(delta.content));
          }
          if (delta?.reasoning_content) {
            reasoning += delta.reasoning_content;
          }
          if (parsed.usage) {
            inputTokens = parsed.usage.prompt_tokens;
            outputTokens = parsed.usage.completion_tokens;
            totalTokens = parsed.usage.total_tokens;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return {
      output,
      exitCode: 0,
      thinking: reasoning || undefined,
      tokenUsage:
        totalTokens > 0
          ? { inputTokens, outputTokens, totalTokens }
          : undefined,
    };
  }
}
