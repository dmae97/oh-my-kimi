/**
 * DeepSeekRuntime — DeepSeek API runtime adapter.
 *
 * Calls https://api.deepseek.com/chat/completions directly.
 * Supports SSE streaming, tool calling, and reasoning_content.
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
import { buildProviderToolPayload } from "./provider-tool-contracts.js";

interface DeepSeekChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

interface DeepSeekTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
}

interface DeepSeekStreamDelta {
  content?: string;
  reasoning_content?: string;
  role?: string;
}

interface DeepSeekStreamChoice {
  delta: DeepSeekStreamDelta;
  finish_reason?: string | null;
  index: number;
}

interface DeepSeekStreamResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: DeepSeekStreamChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface DeepSeekMessage {
  role: string;
  content: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

interface DeepSeekChoice {
  message: DeepSeekMessage;
  finish_reason?: string | null;
  index: number;
}

interface DeepSeekResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: DeepSeekChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface DeepSeekRuntimeOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

export class DeepSeekRuntime implements AgentRuntime {
  readonly id = "deepseek-api";
  readonly kind = "api";
  readonly priority = 40;
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

  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(options: DeepSeekRuntimeOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY;
    this.model = options.model ?? process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
    this.baseUrl = (options.baseUrl ?? "https://api.deepseek.com").replace(/\/+$/, "");
  }

  supports(capsule: ContextCapsule): boolean {
    if (!this.apiKey) return false;
    const requiresVision = capsule.node.routing?.assignedProviderCapabilities?.includes("vision");
    if (requiresVision && !this.capabilities.vision) return false;
    const requiresToolCalling = capsule.node.routing?.requiresToolCalling;
    if (requiresToolCalling && !this.capabilities.supportsToolCalling) return false;
    return true;
  }

  async health(): Promise<RuntimeHealth> {
    const available = Boolean(this.apiKey);
    return {
      runtimeId: this.id,
      available,
      reason: available ? undefined : "DEEPSEEK_API_KEY is not set",
      checkedAt: new Date().toISOString(),
    };
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
    if (!this.apiKey) {
      return {
        output: "",
        exitCode: 1,
        thinking: "",
        metadata: { error: "DEEPSEEK_API_KEY is not set" },
      };
    }
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
          error: "DeepSeek is advisory/read-only and does not receive write, shell, MCP, merge, patch, or tool-calling authority",
          authorityMode: "advisory",
        },
      };
    }

    const messages: DeepSeekChatMessage[] = [];
    if (task.context.system) {
      messages.push({ role: "system", content: task.context.system });
    }
    messages.push({ role: "user", content: task.prompt });

    const providerTools = buildProviderToolPayload([]);
    const tools: DeepSeekTool[] = providerTools.tools as DeepSeekTool[];

    const body: Record<string, unknown> = {
      model: task.context.providerModel ?? task.context.env?.OMK_PROVIDER_MODEL ?? this.model,
      messages,
      stream: task.capabilities.streaming === true,
    };

    if (tools.length > 0) {
      body.tools = tools;
    }

    if (task.capabilities.maxTokens) {
      body.max_tokens = task.capabilities.maxTokens;
    }

    try {
      const timeoutMs = Number(process.env.OMK_PROVIDER_TIMEOUT_MS ?? "120000");
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
          metadata: {
            error: `DeepSeek API error ${response.status}: ${errorText}`,
            toolPlaneHash: providerTools.toolPlaneHash,
            toolContracts: providerTools.contracts,
          },
        };
      }

      if (task.capabilities.streaming === true) {
        return this.parseStreamResponse(response, {
          toolPlaneHash: providerTools.toolPlaneHash,
          toolContracts: providerTools.contracts,
        });
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream")) {
        return this.parseStreamResponse(response, {
          toolPlaneHash: providerTools.toolPlaneHash,
          toolContracts: providerTools.contracts,
        });
      }

      const payload = (await response.json()) as DeepSeekResponse;
      const choice = payload.choices?.[0];
      const content = choice?.message?.content ?? "";
      const reasoning = choice?.message?.reasoning_content ?? "";
      const usage = payload.usage;

      return {
        output: content,
        exitCode: 0,
        thinking: reasoning || undefined,
        tokenUsage: usage
          ? {
              inputTokens: usage.prompt_tokens,
              outputTokens: usage.completion_tokens,
              totalTokens: usage.total_tokens,
            }
          : undefined,
        metadata: {
          model: payload.model,
          finishReason: choice?.finish_reason ?? null,
          toolPlaneHash: providerTools.toolPlaneHash,
          toolContracts: providerTools.contracts,
        },
      };
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
    metadata: { toolPlaneHash: string; toolContracts: unknown },
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
          let parsed: DeepSeekStreamResponse;
          try {
            parsed = JSON.parse(jsonStr) as DeepSeekStreamResponse;
          } catch {
            continue;
          }

          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) {
            output += delta.content;
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
      metadata,
    };
  }
}
