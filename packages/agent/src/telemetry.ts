/**
 * OpenTelemetry instrumentation for the agent loop.
 *
 * Implements the OpenTelemetry GenAI semantic conventions
 * (https://opentelemetry.io/docs/specs/semconv/gen-ai/) plus the
 * Sentry-AI / OpenInference superset attributes that downstream observability
 * UIs (Sentry, Langfuse, Phoenix, Honeycomb, Datadog) need to render an
 * agent run end-to-end.
 *
 * Span hierarchy emitted by the loop:
 *
 *   invoke_agent {agent.name}         (one per runLoop, op = gen_ai.operation.invoke_agent)
 *   ├── chat {model}                  (one per LLM call, op = gen_ai.operation.chat)
 *   ├── execute_tool {tool.name}      (one per tool call, op = gen_ai.operation.execute_tool)
 *   └── ...
 *
 * The `handoff` operation is emitted via the public {@link recordHandoff}
 * helper for hosts that route work between named agents.
 *
 * Activation is opt-in: callers pass an {@link AgentTelemetryConfig} on
 * `AgentLoopConfig.telemetry`. When unset, every helper short-circuits and
 * the loop performs zero tracer lookups. When set but no OTEL SDK is
 * registered, `@opentelemetry/api` returns a no-op tracer and all calls are
 * cheap pass-throughs.
 */

import type { AssistantMessage, Message, Model, ServiceTier, StopReason, ToolChoice, Usage } from "@oh-my-pi/pi-ai";
import {
	type Attributes,
	type AttributeValue,
	context,
	type Span,
	SpanKind,
	SpanStatusCode,
	type Tracer,
	trace,
} from "@opentelemetry/api";
import type { AgentTool } from "./types";

/** Default tracer name. Override via {@link AgentTelemetryConfig.tracerName}. */
export const DEFAULT_TRACER_NAME = "@oh-my-pi/pi-agent-core";

/** Env var matching the OTEL semconv content-capture toggle. */
const CONTENT_CAPTURE_ENV = "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT";

/**
 * GenAI semantic-convention attribute keys grouped by operation. Hoisted so
 * call sites stay typo-proof and easy to grep.
 */
export const GenAIAttr = {
	// Common identifiers
	System: "gen_ai.system",
	ProviderName: "gen_ai.provider.name",
	OperationName: "gen_ai.operation.name",
	ConversationId: "gen_ai.conversation.id",
	OutputType: "gen_ai.output.type",
	// Agent identity
	AgentId: "gen_ai.agent.id",
	AgentName: "gen_ai.agent.name",
	AgentDescription: "gen_ai.agent.description",
	AgentStepNumber: "gen_ai.agent.step.number",
	AgentStepCount: "gen_ai.agent.step.count",
	// Request shape
	RequestModel: "gen_ai.request.model",
	RequestMaxTokens: "gen_ai.request.max_tokens",
	RequestTemperature: "gen_ai.request.temperature",
	RequestTopP: "gen_ai.request.top_p",
	RequestTopK: "gen_ai.request.top_k",
	RequestFrequencyPenalty: "gen_ai.request.frequency_penalty",
	RequestPresencePenalty: "gen_ai.request.presence_penalty",
	RequestStopSequences: "gen_ai.request.stop_sequences",
	RequestSeed: "gen_ai.request.seed",
	RequestChoiceCount: "gen_ai.request.choice.count",
	RequestServiceTier: "gen_ai.request.service_tier",
	RequestReasoningEffort: "gen_ai.request.reasoning.effort",
	RequestToolChoice: "gen_ai.request.tool.choice",
	RequestAvailableTools: "gen_ai.request.available_tools",
	// Response shape
	ResponseModel: "gen_ai.response.model",
	ResponseId: "gen_ai.response.id",
	ResponseFinishReasons: "gen_ai.response.finish_reasons",
	ResponseServiceTier: "gen_ai.response.service_tier",
	// Usage
	UsageInputTokens: "gen_ai.usage.input_tokens",
	UsageOutputTokens: "gen_ai.usage.output_tokens",
	UsageInputTokensCached: "gen_ai.usage.input_tokens.cached",
	UsageInputTokensCacheWrite: "gen_ai.usage.input_tokens.cache_write",
	UsageOutputTokensReasoning: "gen_ai.usage.output_tokens.reasoning",
	UsageTotalTokens: "gen_ai.usage.total_tokens",
	UsageServerSideTools: "gen_ai.usage.server_tool_requests",
	// Tools
	ToolCallId: "gen_ai.tool.call.id",
	ToolName: "gen_ai.tool.name",
	ToolDescription: "gen_ai.tool.description",
	ToolType: "gen_ai.tool.type",
	ToolCallArguments: "gen_ai.tool.call.arguments",
	ToolCallResult: "gen_ai.tool.call.result",
	// Content capture (opt-in)
	InputMessages: "gen_ai.input.messages",
	OutputMessages: "gen_ai.output.messages",
	SystemInstructions: "gen_ai.system_instructions",
	// Cost (vendor extension; matches Sentry-AI + Langfuse conventions)
	CostEstimatedUsd: "gen_ai.cost.estimated_usd",
	CostInputUsd: "gen_ai.cost.input_usd",
	CostOutputUsd: "gen_ai.cost.output_usd",
	CostUnavailableReason: "gen_ai.cost.unavailable_reason",
	// Errors
	ErrorType: "error.type",
} as const;

/** GenAI operation names — values for {@link GenAIAttr.OperationName}. */
export const GenAIOperation = {
	Chat: "chat",
	ExecuteTool: "execute_tool",
	InvokeAgent: "invoke_agent",
	Handoff: "handoff",
	GenerateContent: "generate_content",
	TextCompletion: "text_completion",
	CreateAgent: "create_agent",
	Embeddings: "embeddings",
} as const;

export type GenAIOperationName = (typeof GenAIOperation)[keyof typeof GenAIOperation];

/** Identifies which agent span a callback is reporting on. */
export type TelemetrySpanKind = "invoke_agent" | "chat" | "execute_tool" | "handoff";

/**
 * Aggregated usage + cost surface passed to {@link AgentTelemetryConfig.costEstimator}.
 * Mirrors the bucketed shape we already emit as span attributes so the
 * estimator never has to re-derive cache-read vs cache-write breakdowns.
 */
export interface ChatUsageSnapshot {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly totalTokens: number;
	readonly cachedInputTokens: number | undefined;
	readonly cacheWriteTokens: number | undefined;
	readonly reasoningOutputTokens: number | undefined;
}

/** Context passed to the cost estimator. */
export interface CostEstimatorContext {
	readonly provider: string;
	readonly model: string;
	readonly serviceTier: ServiceTier | undefined;
	readonly usage: ChatUsageSnapshot;
}

/**
 * Cost estimator result.
 *
 *   { usd: number }                — cost is known; emitted as gen_ai.cost.estimated_usd
 *   { unavailable: string }        — cost is intentionally unknown; emitted as
 *                                    gen_ai.cost.unavailable_reason
 *   undefined                      — no opinion; nothing emitted
 */
export type CostEstimate =
	| { readonly usd: number; readonly inputUsd?: number; readonly outputUsd?: number }
	| { readonly unavailable: string };

/** Identity recorded on every invoke_agent and on emitted handoff spans. */
export interface AgentIdentity {
	readonly id?: string;
	readonly name?: string;
	readonly description?: string;
}

/** Context passed to {@link AgentTelemetryConfig.onSpanStart} / `onSpanEnd`. */
export interface TelemetryHookContext {
	readonly span: Span;
	readonly kind: TelemetrySpanKind;
	readonly model: Model | undefined;
	readonly agent: AgentIdentity | undefined;
	readonly conversationId: string | undefined;
	/** Per-step number on chat spans (0-indexed); undefined on other kinds. */
	readonly stepNumber?: number;
	/** Tool call info on execute_tool spans. */
	readonly toolCallId?: string;
	readonly toolName?: string;
}

/**
 * Opt-in OpenTelemetry configuration accepted by the agent loop.
 *
 * All fields are optional. Passing the empty object `{}` enables
 * instrumentation with sensible defaults. Pass `undefined` (or omit the
 * `telemetry` field entirely) to disable everything — the loop performs zero
 * tracer lookups in that case.
 */
export interface AgentTelemetryConfig {
	/**
	 * Override the tracer instance. When omitted, the loop calls
	 * `trace.getTracer(tracerName ?? DEFAULT_TRACER_NAME)` lazily on first use.
	 */
	readonly tracer?: Tracer;
	/** Override the tracer name passed to `trace.getTracer`. */
	readonly tracerName?: string;
	/**
	 * Capture full request/response message payloads on chat spans and tool
	 * call argument/result payloads on execute_tool spans.
	 *
	 * Defaults to the value of the `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`
	 * env var (case-insensitive `true`/`1`/`yes`). Set `true`/`false` to override.
	 */
	readonly captureMessageContent?: boolean;
	/** Extra attributes merged onto every emitted span. */
	readonly attributes?: Attributes;
	/** Agent identity stamped onto invoke_agent + propagated to children. */
	readonly agent?: AgentIdentity;
	/**
	 * Conversation identifier. When omitted, the loop falls back to
	 * `AgentLoopConfig.sessionId` for the `gen_ai.conversation.id` attribute.
	 */
	readonly conversationId?: string;
	/**
	 * Per-step cost estimator. Synchronous on purpose — runs inside the chat
	 * span's finish path. Return `undefined` to emit no cost attribute.
	 */
	readonly costEstimator?: (input: CostEstimatorContext) => CostEstimate | undefined;
	/**
	 * Called immediately after a span starts. Use to stamp request-side
	 * context (user id, deployment id, route name) without forking the loop.
	 */
	readonly onSpanStart?: (ctx: TelemetryHookContext) => void;
	/**
	 * Called just before `span.end()`. Use to stamp response-side context
	 * that depends on the final result.
	 */
	readonly onSpanEnd?: (ctx: TelemetryHookContext) => void;
}

/**
 * Public handle used internally to thread the resolved tracer + config
 * through the loop. Constructed once per `agentLoop` invocation.
 */
export interface AgentTelemetry {
	readonly config: AgentTelemetryConfig;
	readonly tracer: Tracer;
	readonly captureMessageContent: boolean;
	readonly conversationId: string | undefined;
	readonly agent: AgentIdentity | undefined;
}

/** Lazily resolve the {@link AgentTelemetry} handle. Returns `undefined` when disabled. */
export function resolveTelemetry(
	config: AgentTelemetryConfig | undefined,
	sessionId: string | undefined,
): AgentTelemetry | undefined {
	if (!config) return undefined;
	const tracer = config.tracer ?? trace.getTracer(config.tracerName ?? DEFAULT_TRACER_NAME);
	return {
		config,
		tracer,
		captureMessageContent: config.captureMessageContent ?? readContentCaptureEnv(),
		conversationId: config.conversationId ?? sessionId,
		agent: config.agent,
	};
}

let contentCaptureEnvCache: boolean | undefined;
function readContentCaptureEnv(): boolean {
	if (contentCaptureEnvCache !== undefined) return contentCaptureEnvCache;
	const raw = process.env[CONTENT_CAPTURE_ENV];
	if (!raw) {
		contentCaptureEnvCache = false;
		return false;
	}
	const normalized = raw.trim().toLowerCase();
	contentCaptureEnvCache = normalized === "true" || normalized === "1" || normalized === "yes";
	return contentCaptureEnvCache;
}

/**
 * Start a span with the standard attribute envelope (provider, operation,
 * conversation, agent identity, user-supplied extras) pre-applied. Returns
 * `undefined` when telemetry is disabled.
 */
function startSpan(
	telemetry: AgentTelemetry | undefined,
	kind: TelemetrySpanKind,
	name: string,
	options: {
		readonly spanKind: SpanKind;
		readonly model?: Model;
		readonly parent?: Span;
		readonly attributes?: Attributes;
		readonly stepNumber?: number;
		readonly toolCallId?: string;
		readonly toolName?: string;
	},
): Span | undefined {
	if (!telemetry) return undefined;
	const attrs: Attributes = {};
	const operation = kindToOperation(kind);
	if (operation) attrs[GenAIAttr.OperationName] = operation;
	if (options.model) {
		attrs[GenAIAttr.RequestModel] = options.model.id;
		const provider = options.model.provider;
		if (provider) {
			attrs[GenAIAttr.System] = provider;
			attrs[GenAIAttr.ProviderName] = provider;
		}
	}
	if (telemetry.conversationId) {
		attrs[GenAIAttr.ConversationId] = telemetry.conversationId;
	}
	if (telemetry.agent) applyAgentAttributes(attrs, telemetry.agent);
	if (telemetry.config.attributes) Object.assign(attrs, telemetry.config.attributes);
	if (options.attributes) Object.assign(attrs, options.attributes);

	const ctx = options.parent ? trace.setSpan(context.active(), options.parent) : context.active();
	const span = telemetry.tracer.startSpan(name, { kind: options.spanKind, attributes: attrs }, ctx);
	telemetry.config.onSpanStart?.({
		span,
		kind,
		model: options.model,
		agent: telemetry.agent,
		conversationId: telemetry.conversationId,
		stepNumber: options.stepNumber,
		toolCallId: options.toolCallId,
		toolName: options.toolName,
	});
	return span;
}

function kindToOperation(kind: TelemetrySpanKind): GenAIOperationName | undefined {
	switch (kind) {
		case "invoke_agent":
			return GenAIOperation.InvokeAgent;
		case "chat":
			return GenAIOperation.Chat;
		case "execute_tool":
			return GenAIOperation.ExecuteTool;
		case "handoff":
			return GenAIOperation.Handoff;
	}
}

function applyAgentAttributes(attrs: Attributes, agent: AgentIdentity): void {
	if (agent.id) attrs[GenAIAttr.AgentId] = agent.id;
	if (agent.name) attrs[GenAIAttr.AgentName] = agent.name;
	if (agent.description) attrs[GenAIAttr.AgentDescription] = agent.description;
}

/**
 * Start the outer `invoke_agent` span that wraps a full `runLoop` invocation.
 * Returns `undefined` when telemetry is disabled.
 */
export function startInvokeAgentSpan(telemetry: AgentTelemetry | undefined, model: Model): Span | undefined {
	const agentName = telemetry?.agent?.name;
	const name = agentName ? `invoke_agent ${agentName}` : "invoke_agent";
	return startSpan(telemetry, "invoke_agent", name, { spanKind: SpanKind.INTERNAL, model });
}

/** Stamp the final step count on the `invoke_agent` span. */
export function applyInvokeAgentFinish(span: Span | undefined, stepCount: number): void {
	if (!span) return;
	span.setAttribute(GenAIAttr.AgentStepCount, stepCount);
}

/**
 * Start a `chat` span representing one provider call. Parented under the
 * supplied `invoke_agent` span (or whatever is active if none is passed).
 */
export function startChatSpan(
	telemetry: AgentTelemetry | undefined,
	model: Model,
	options: {
		readonly parent?: Span;
		readonly stepNumber: number;
		readonly request: ChatRequestSnapshot;
	},
): Span | undefined {
	const span = startSpan(telemetry, "chat", `chat ${model.id}`, {
		spanKind: SpanKind.CLIENT,
		model,
		parent: options.parent,
		stepNumber: options.stepNumber,
		attributes: buildChatRequestAttributes(options.stepNumber, options.request),
	});
	if (span && telemetry?.captureMessageContent) {
		applyContentCaptureForRequest(span, options.request);
	}
	return span;
}

/** Mutable snapshot of every request-side field worth recording. */
export interface ChatRequestSnapshot {
	readonly maxTokens?: number;
	readonly temperature?: number;
	readonly topP?: number;
	readonly topK?: number;
	readonly frequencyPenalty?: number;
	readonly presencePenalty?: number;
	readonly stopSequences?: readonly string[];
	readonly seed?: number;
	readonly serviceTier?: ServiceTier;
	readonly reasoningEffort?: string;
	readonly toolChoice?: ToolChoice;
	readonly tools?: readonly { readonly name: string }[];
	readonly systemPrompt?: readonly string[];
	readonly messages?: readonly Message[];
}

function buildChatRequestAttributes(stepNumber: number, request: ChatRequestSnapshot): Attributes {
	const attrs: Attributes = {
		[GenAIAttr.AgentStepNumber]: stepNumber,
		[GenAIAttr.RequestChoiceCount]: 1,
		[GenAIAttr.OutputType]: "text",
	};
	if (request.maxTokens != null) attrs[GenAIAttr.RequestMaxTokens] = request.maxTokens;
	if (request.temperature != null) attrs[GenAIAttr.RequestTemperature] = request.temperature;
	if (request.topP != null) attrs[GenAIAttr.RequestTopP] = request.topP;
	if (request.topK != null) attrs[GenAIAttr.RequestTopK] = request.topK;
	if (request.frequencyPenalty != null) attrs[GenAIAttr.RequestFrequencyPenalty] = request.frequencyPenalty;
	if (request.presencePenalty != null) attrs[GenAIAttr.RequestPresencePenalty] = request.presencePenalty;
	if (request.seed != null) attrs[GenAIAttr.RequestSeed] = request.seed;
	if (request.stopSequences && request.stopSequences.length > 0) {
		attrs[GenAIAttr.RequestStopSequences] = [...request.stopSequences];
	}
	if (request.serviceTier) attrs[GenAIAttr.RequestServiceTier] = request.serviceTier;
	if (request.reasoningEffort) attrs[GenAIAttr.RequestReasoningEffort] = request.reasoningEffort;
	const toolChoice = serializeToolChoice(request.toolChoice);
	if (toolChoice) attrs[GenAIAttr.RequestToolChoice] = toolChoice;
	if (request.tools && request.tools.length > 0) {
		attrs[GenAIAttr.RequestAvailableTools] = request.tools.map(tool => tool.name);
	}
	return attrs;
}

function serializeToolChoice(toolChoice: ToolChoice | undefined): string | undefined {
	if (toolChoice == null) return undefined;
	if (typeof toolChoice === "string") return toolChoice;
	if (typeof toolChoice === "object") {
		// `{ type: "tool", name: "foo" }` shapes used across providers.
		if ("name" in toolChoice && typeof toolChoice.name === "string") return toolChoice.name;
		if ("type" in toolChoice && typeof toolChoice.type === "string") return toolChoice.type;
	}
	return undefined;
}

function applyContentCaptureForRequest(span: Span, request: ChatRequestSnapshot): void {
	if (request.systemPrompt && request.systemPrompt.length > 0) {
		span.setAttribute(GenAIAttr.SystemInstructions, JSON.stringify(request.systemPrompt));
	}
	if (request.messages && request.messages.length > 0) {
		span.setAttribute(GenAIAttr.InputMessages, JSON.stringify(request.messages));
	}
}

/**
 * Stamp the final response onto a chat span, fire the cost estimator hook,
 * and end the span. No-op when `span` is undefined.
 */
export function finishChatSpan(
	telemetry: AgentTelemetry | undefined,
	span: Span | undefined,
	message: AssistantMessage,
	options: { readonly stepNumber: number; readonly serviceTier?: ServiceTier },
): void {
	if (!span) return;
	applyChatResponseAttributes(span, message);
	applyUsageAttributes(span, message.usage);
	applyCostEstimate(telemetry, span, message, options.serviceTier);
	if (telemetry?.captureMessageContent) {
		span.setAttribute(GenAIAttr.OutputMessages, JSON.stringify([message]));
	}
	telemetry?.config.onSpanEnd?.({
		span,
		kind: "chat",
		model: undefined,
		agent: telemetry.agent,
		conversationId: telemetry.conversationId,
		stepNumber: options.stepNumber,
	});
	applyTerminalStatus(span, message.stopReason, message.errorMessage);
	span.end();
}

function applyChatResponseAttributes(span: Span, message: AssistantMessage): void {
	span.setAttribute(GenAIAttr.ResponseModel, message.model);
	if (message.responseId) span.setAttribute(GenAIAttr.ResponseId, message.responseId);
	const finishReason = mapStopReason(message.stopReason);
	if (finishReason) span.setAttribute(GenAIAttr.ResponseFinishReasons, [finishReason]);
}

function applyUsageAttributes(span: Span, usage: Usage | undefined): void {
	if (!usage) return;
	const inputTokens = usage.input ?? 0;
	const outputTokens = usage.output ?? 0;
	span.setAttribute(GenAIAttr.UsageInputTokens, inputTokens);
	span.setAttribute(GenAIAttr.UsageOutputTokens, outputTokens);
	const total = usage.totalTokens ?? inputTokens + outputTokens + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
	span.setAttribute(GenAIAttr.UsageTotalTokens, total);
	if (usage.cacheRead != null) span.setAttribute(GenAIAttr.UsageInputTokensCached, usage.cacheRead);
	if (usage.cacheWrite != null) span.setAttribute(GenAIAttr.UsageInputTokensCacheWrite, usage.cacheWrite);
	if (usage.reasoningTokens != null) {
		span.setAttribute(GenAIAttr.UsageOutputTokensReasoning, usage.reasoningTokens);
	}
	if (usage.server) {
		const sums = (usage.server.webSearch ?? 0) + (usage.server.webFetch ?? 0);
		if (sums > 0) span.setAttribute(GenAIAttr.UsageServerSideTools, sums);
	}
}

function applyCostEstimate(
	telemetry: AgentTelemetry | undefined,
	span: Span,
	message: AssistantMessage,
	serviceTier: ServiceTier | undefined,
): void {
	const estimator = telemetry?.config.costEstimator;
	if (!estimator) return;
	const usage = message.usage;
	if (!usage) return;
	const snapshot: ChatUsageSnapshot = {
		inputTokens: usage.input ?? 0,
		outputTokens: usage.output ?? 0,
		totalTokens: usage.totalTokens ?? 0,
		cachedInputTokens: usage.cacheRead,
		cacheWriteTokens: usage.cacheWrite,
		reasoningOutputTokens: usage.reasoningTokens,
	};
	const result = estimator({
		provider: message.provider,
		model: message.model,
		serviceTier,
		usage: snapshot,
	});
	if (!result) return;
	if ("unavailable" in result) {
		span.setAttribute(GenAIAttr.CostUnavailableReason, result.unavailable);
		return;
	}
	span.setAttribute(GenAIAttr.CostEstimatedUsd, result.usd);
	if (result.inputUsd != null) span.setAttribute(GenAIAttr.CostInputUsd, result.inputUsd);
	if (result.outputUsd != null) span.setAttribute(GenAIAttr.CostOutputUsd, result.outputUsd);
}

function mapStopReason(reason: StopReason | undefined): string | undefined {
	switch (reason) {
		case "stop":
			return "stop";
		case "length":
			return "length";
		case "toolUse":
			return "tool_calls";
		case "error":
		case "aborted":
			return "error";
		default:
			return undefined;
	}
}

function applyTerminalStatus(span: Span, stopReason: StopReason | undefined, errorMessage: string | undefined): void {
	if (stopReason === "error" || stopReason === "aborted") {
		span.setAttribute(GenAIAttr.ErrorType, stopReason);
		span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage ?? stopReason });
	}
}

/**
 * Start an `execute_tool` span representing one tool invocation. Parented
 * under the supplied `invoke_agent` span by default — pass `parent` to
 * override.
 */
export function startExecuteToolSpan(
	telemetry: AgentTelemetry | undefined,
	options: {
		readonly tool: AgentTool | undefined;
		readonly toolName: string;
		readonly toolCallId: string;
		readonly args: unknown;
		readonly parent?: Span;
	},
): Span | undefined {
	const attrs: Attributes = {
		[GenAIAttr.ToolName]: options.toolName,
		[GenAIAttr.ToolCallId]: options.toolCallId,
		[GenAIAttr.ToolType]: "function",
	};
	if (options.tool?.description) attrs[GenAIAttr.ToolDescription] = options.tool.description;
	const span = startSpan(telemetry, "execute_tool", `execute_tool ${options.toolName}`, {
		spanKind: SpanKind.INTERNAL,
		parent: options.parent,
		toolCallId: options.toolCallId,
		toolName: options.toolName,
		attributes: attrs,
	});
	if (span && telemetry?.captureMessageContent) {
		span.setAttribute(GenAIAttr.ToolCallArguments, safeJson(options.args));
	}
	return span;
}

/**
 * End an `execute_tool` span. `isError` true marks ERROR status; pass
 * `errorObject` (the thrown value) to record an exception with stack.
 */
export function finishExecuteToolSpan(
	telemetry: AgentTelemetry | undefined,
	span: Span | undefined,
	options: {
		readonly result?: unknown;
		readonly isError: boolean;
		readonly errorMessage?: string;
		readonly errorObject?: unknown;
		readonly toolCallId: string;
		readonly toolName: string;
	},
): void {
	if (!span) return;
	if (telemetry?.captureMessageContent && options.result !== undefined) {
		span.setAttribute(GenAIAttr.ToolCallResult, safeJson(options.result));
	}
	telemetry?.config.onSpanEnd?.({
		span,
		kind: "execute_tool",
		model: undefined,
		agent: telemetry.agent,
		conversationId: telemetry.conversationId,
		toolCallId: options.toolCallId,
		toolName: options.toolName,
	});
	if (options.errorObject instanceof Error) {
		span.recordException(options.errorObject);
		span.setAttribute(GenAIAttr.ErrorType, options.errorObject.name || "Error");
		span.setStatus({ code: SpanStatusCode.ERROR, message: options.errorObject.message });
	} else if (options.isError) {
		span.setAttribute(GenAIAttr.ErrorType, "tool_error");
		span.setStatus({ code: SpanStatusCode.ERROR, message: options.errorMessage ?? "tool returned error" });
	}
	span.end();
}

/** End an `invoke_agent` span, recording an error if one was thrown. */
export function finishInvokeAgentSpan(
	telemetry: AgentTelemetry | undefined,
	span: Span | undefined,
	options: { readonly stepCount: number; readonly errorObject?: unknown },
): void {
	if (!span) return;
	applyInvokeAgentFinish(span, options.stepCount);
	telemetry?.config.onSpanEnd?.({
		span,
		kind: "invoke_agent",
		model: undefined,
		agent: telemetry.agent,
		conversationId: telemetry.conversationId,
	});
	if (options.errorObject instanceof Error) {
		span.recordException(options.errorObject);
		span.setAttribute(GenAIAttr.ErrorType, options.errorObject.name || "Error");
		span.setStatus({ code: SpanStatusCode.ERROR, message: options.errorObject.message });
	}
	span.end();
}

/**
 * Run `fn` with `span` activated on the OTEL context. Spans created
 * downstream (provider HTTP clients, MCP tools, user code) attach as
 * children. No-op when `span` is undefined.
 *
 * Required because `tracer.startSpan` creates the span object but does not
 * activate it — without this wrapper, downstream spans attach to whatever
 * context was active before and the parent linkage we advertise is lost.
 */
export function runInActiveSpan<T>(span: Span | undefined, fn: () => Promise<T>): Promise<T> {
	if (!span) return fn();
	return context.with(trace.setSpan(context.active(), span), fn);
}

/**
 * Emit a one-shot `handoff` span describing a transition between two named
 * agents. Pass `parent` to make the span a child of an in-flight
 * invoke_agent span; otherwise the active context's span is used.
 */
export function recordHandoff(
	telemetry: AgentTelemetry | undefined,
	options: {
		readonly fromAgent: AgentIdentity | undefined;
		readonly toAgent: AgentIdentity;
		readonly parent?: Span;
		readonly attributes?: Attributes;
	},
): void {
	if (!telemetry) return;
	const attrs: Attributes = {};
	if (options.fromAgent?.name) attrs["gen_ai.handoff.from_agent.name"] = options.fromAgent.name;
	if (options.fromAgent?.id) attrs["gen_ai.handoff.from_agent.id"] = options.fromAgent.id;
	if (options.toAgent.name) attrs["gen_ai.handoff.to_agent.name"] = options.toAgent.name;
	if (options.toAgent.id) attrs["gen_ai.handoff.to_agent.id"] = options.toAgent.id;
	const name = options.toAgent.name
		? options.fromAgent?.name
			? `handoff ${options.fromAgent.name} → ${options.toAgent.name}`
			: `handoff to ${options.toAgent.name}`
		: "handoff";
	const span = startSpan(telemetry, "handoff", name, {
		spanKind: SpanKind.INTERNAL,
		parent: options.parent,
		attributes: { ...attrs, ...options.attributes },
	});
	if (!span) return;
	telemetry.config.onSpanEnd?.({
		span,
		kind: "handoff",
		model: undefined,
		agent: options.toAgent,
		conversationId: telemetry.conversationId,
	});
	span.end();
}

/**
 * Set a single attribute on a possibly-undefined span. Use when the caller
 * needs to attach context outside the standard helpers without a branch.
 */
export function setSpanAttribute(span: Span | undefined, key: string, value: AttributeValue): void {
	if (!span) return;
	span.setAttribute(key, value);
}

/** Re-exports so consumers can write hooks without depending on @opentelemetry/api directly. */
export { type Attributes, type Span, SpanKind, SpanStatusCode, type Tracer, trace };

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
