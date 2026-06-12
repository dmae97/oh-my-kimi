/**
 * KimiApiRuntime — Moonshot API runtime adapter.
 * Previously misnamed as KimiWireRuntime; this is an HTTP API adapter, not wire protocol.
 *
 * Calls https://api.moonshot.cn/v1/chat/completions directly.
 */

import type {
  AgentRuntime,
  AgentRunResult,
  AgentResult,
  AgentTask,
  RuntimeCapabilities,
  RuntimeHealth,
  TokenUsage,
  ToolCallRecord,
} from "./agent-runtime.js";
import type { ContextCapsule } from "./context-capsule.js";
import { capsuleToTask } from "./context-broker-converter.js";
import { buildProviderToolPayload } from "./provider-tool-contracts.js";
import { repairToolCalls, type ToolCallRepairResult } from "./tool-call-repair.js";

interface MoonshotChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

interface MoonshotTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
}

interface MoonshotStreamDelta {
  content?: string;
  reasoning_content?: string;
  role?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: "function";
    function?: { name?: string; arguments?: string };
  }>;
}

interface MoonshotStreamChoice {
  delta: MoonshotStreamDelta;
  finish_reason?: string | null;
  index: number;
}

interface MoonshotStreamResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: MoonshotStreamChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface MoonshotMessage {
  role: string;
  content: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

interface MoonshotNonStreamChoice {
  message: MoonshotMessage;
  finish_reason?: string | null;
  index: number;
}

interface MoonshotNonStreamResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: MoonshotNonStreamChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface ToolCallMapResult {
  readonly toolCalls?: readonly ToolCallRecord[];
  readonly repair: {
    readonly suppressed: readonly string[];
    readonly ignored: readonly string[];
  };
}

function mapToolCalls(
  apiToolCalls:
    | Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>
    | undefined,
  context: {
    readonly allowedToolNames: ReadonlySet<string>;
    readonly toolContracts: readonly { name: string }[];
    readonly reasoningContent?: string;
    readonly visibleContent?: string;
  },
): ToolCallMapResult {
  const repaired: ToolCallRepairResult = repairToolCalls({
    declaredCalls: (apiToolCalls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    })),
    reasoningContent: context.reasoningContent,
    visibleContent: context.visibleContent,
    allowedToolNames: context.allowedToolNames,
    toolContracts: context.toolContracts,
  });
  return {
    toolCalls: repaired.calls.length > 0
      ? repaired.calls.map((call) => ({
          name: call.name,
          input: call.input,
          output: undefined,
          durationMs: 0,
          success: false,
        }))
      : undefined,
    repair: {
      suppressed: repaired.suppressed,
      ignored: repaired.ignored,
    },
  };
}

export interface KimiApiRuntimeOptions {
  id?: string;
  priority?: number;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** @deprecated Wire-client option, ignored by HTTP adapter */
  cwd?: string;
  /** @deprecated Wire-client option, used only to read KIMI_API_KEY */
  env?: NodeJS.ProcessEnv;
  /** @deprecated Wire-client option, ignored by HTTP adapter */
  agentFile?: string;
  /** @deprecated Wire-client option, ignored by HTTP adapter */
  configFile?: string;
  /** @deprecated Wire-client option, ignored by HTTP adapter */
  mcpConfigFile?: string;
  /** @deprecated Wire-client option, ignored by HTTP adapter */
  timeoutMs?: number;
  /** @deprecated Wire-client option, ignored by HTTP adapter */
  enabled?: boolean;
}

/** @deprecated Use KimiApiRuntimeOptions instead */
export type KimiWireRuntimeOptions = KimiApiRuntimeOptions;

export function createKimiApiRuntime(options: KimiApiRuntimeOptions = {}): AgentRuntime {
  const env = options.env ?? process.env;
  return new KimiApiRuntime({
    apiKey: options.apiKey ?? env.KIMI_API_KEY,
    model: options.model ?? env.KIMI_MODEL,
    baseUrl: options.baseUrl ?? env.KIMI_BASE_URL,
  });
}

/** @deprecated Use createKimiApiRuntime instead */
export const createKimiWireRuntime = createKimiApiRuntime;

export class KimiApiRuntime implements AgentRuntime {
  readonly id: string;
  readonly kind = "api";
  readonly priority: number;
  readonly capabilities: RuntimeCapabilities = {
    read: true,
    write: false,
    shell: false,
    mcp: false,
    patch: false,
    review: true,
    merge: false,
    vision: true,
    supportsStreaming: true,
    supportsStructuredOutput: false,
    supportsToolCalling: true,
  };

  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(options: KimiApiRuntimeOptions = {}) {
    this.id = options.id ?? "kimi-api";
    this.priority = options.priority ?? 90;
    this.apiKey = options.apiKey ?? process.env.KIMI_API_KEY;
    this.model = options.model ?? process.env.KIMI_MODEL ?? "kimi-k2-6";
    this.baseUrl = (options.baseUrl ?? "https://api.moonshot.cn/v1").replace(/\/+$/, "");
  }

  supports(capsule: ContextCapsule): boolean {
    if (!this.apiKey) return false;
    const requiredCapabilities = capsule.node.routing?.assignedProviderCapabilities ?? [];
    if (
      requiredCapabilities.some((capability) =>
        ["write", "patch", "shell", "mcp", "merge"].includes(capability)
      )
    ) return false;
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
      reason: available ? undefined : "KIMI_API_KEY is not set",
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
          ...(result.metadata && { ...result.metadata }),
        },
        toolCalls: result.toolCalls,
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
        metadata: { error: "KIMI_API_KEY is not set" },
      };
    }
    if (
      task.capabilities.write ||
      task.capabilities.patch ||
      task.capabilities.shell ||
      task.capabilities.mcp ||
      task.capabilities.merge
    ) {
      return {
        output: "",
        exitCode: 1,
        thinking: "",
        metadata: {
          error: `${this.id} is advisory/read-only and does not receive write, shell, MCP, merge, or patch authority`,
          authorityMode: "advisory",
        },
      };
    }

    const messages: MoonshotChatMessage[] = [];
    if (task.context.system) {
      messages.push({ role: "system", content: task.context.system });
    }
    messages.push({ role: "user", content: task.prompt });

    const providerTools = task.capabilities.toolCalling
      ? buildProviderToolPayload(task.tools.available)
      : buildProviderToolPayload([]);
    const tools: MoonshotTool[] = providerTools.tools as MoonshotTool[];

    const useStreaming = task.capabilities.streaming ?? true;

    const body: Record<string, unknown> = {
      model: task.context.providerModel ?? task.context.env?.OMK_PROVIDER_MODEL ?? this.model,
      messages,
      stream: useStreaming,
    };

    if (tools.length > 0) {
      body.tools = tools;
    }

    if (task.capabilities.maxTokens) {
      body.max_tokens = task.capabilities.maxTokens;
    }

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: task.context.abortSignal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        return {
          output: "",
          exitCode: 1,
          thinking: "",
          metadata: { error: `Moonshot API error ${response.status}: ${errorText}` },
        };
      }

      if (useStreaming) {
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

      const payload = (await response.json()) as MoonshotNonStreamResponse;
      const choice = payload.choices?.[0];
      const content = choice?.message?.content ?? "";
      const reasoning = choice?.message?.reasoning_content ?? "";
      const usage = payload.usage;
      const mappedToolCalls = mapToolCalls(choice?.message?.tool_calls, {
        allowedToolNames: new Set(providerTools.contracts.map((contract) => contract.name)),
        toolContracts: providerTools.contracts,
        reasoningContent: reasoning,
        visibleContent: content,
      });

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
        toolCalls: mappedToolCalls.toolCalls,
        metadata: {
          model: payload.model,
          finishReason: choice?.finish_reason ?? null,
          toolPlaneHash: providerTools.toolPlaneHash,
          toolContracts: providerTools.contracts,
          toolCallRepair: mappedToolCalls.repair,
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
    metadata: { toolPlaneHash: string; toolContracts: readonly { name: string }[] },
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
    let model = "";
    let finishReason: string | null = null;

    const toolCallAccumulator = new Map<
      number,
      { id?: string; type?: string; name?: string; arguments: string }
    >();

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
          let parsed: MoonshotStreamResponse;
          try {
            parsed = JSON.parse(jsonStr) as MoonshotStreamResponse;
          } catch {
            continue;
          }

          if (parsed.model) model = parsed.model;
          const choice = parsed.choices?.[0];
          if (choice?.finish_reason != null) {
            finishReason = choice.finish_reason;
          }

          const delta = choice?.delta;
          if (delta?.content) {
            output += delta.content;
          }
          if (delta?.reasoning_content) {
            reasoning += delta.reasoning_content;
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              const existing = toolCallAccumulator.get(idx) ?? { arguments: "" };
              if (tc.id) existing.id = tc.id;
              if (tc.type) existing.type = tc.type;
              if (tc.function?.name) existing.name = tc.function.name;
              if (tc.function?.arguments) existing.arguments += tc.function.arguments;
              toolCallAccumulator.set(idx, existing);
            }
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

    const streamedToolCalls: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }> = [];
    for (let i = 0; i < toolCallAccumulator.size; i++) {
      const acc = toolCallAccumulator.get(i);
      if (acc && acc.id && acc.name) {
        streamedToolCalls.push({
          id: acc.id,
          type: "function",
          function: { name: acc.name, arguments: acc.arguments },
        });
      }
    }

    const mappedToolCalls = mapToolCalls(streamedToolCalls, {
      allowedToolNames: new Set(metadata.toolContracts.map((contract) => contract.name)),
      toolContracts: metadata.toolContracts,
      reasoningContent: reasoning,
      visibleContent: output,
    });

    return {
      output,
      exitCode: 0,
      thinking: reasoning || undefined,
      tokenUsage:
        totalTokens > 0
          ? { inputTokens, outputTokens, totalTokens }
          : undefined,
      toolCalls: mappedToolCalls.toolCalls,
      metadata: {
        model,
        finishReason,
        ...metadata,
        toolCallRepair: mappedToolCalls.repair,
      },
    };
  }
}
