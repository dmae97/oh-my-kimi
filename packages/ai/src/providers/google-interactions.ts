import { parseGeminiModel } from "@oh-my-pi/pi-catalog/identity";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { fetchWithRetry, readSseJson } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import type {
	AssistantMessage,
	Context,
	FetchImpl,
	ImageContent,
	Message,
	Model,
	ProviderSessionState,
	TextContent,
	ToolCall,
	Usage,
} from "../types";
import { shouldSendServiceTier } from "../types";
import { normalizeSystemPrompts } from "../utils";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { convertTools, type GoogleSharedStreamOptions, type GoogleThinkingLevel } from "./google-shared";

type GoogleInteractionsApi = "google-generative-ai" | "google-vertex";
type GoogleInteractionsModel = Model<GoogleInteractionsApi>;
type GoogleOptions = GoogleSharedStreamOptions;

const GOOGLE_INTERACTIONS_STATE_KEY = "google-interactions-state";

/** Provider session state storing the last Gemini Interactions response id. */
export interface GoogleInteractionsProviderSessionState extends ProviderSessionState {
	lastInteractionId?: string;
}

/** Conversation anchor for continuing an Interactions turn from a prior assistant response. */
export interface InteractionAnchor {
	id?: string;
	messageIndex?: number;
}

type InteractionContent = { type: "text"; text: string } | { type: "image"; data: string; mime_type: string };

interface InteractionUserInputStep {
	type: "user_input";
	content: InteractionContent[];
}

interface InteractionModelOutputStep {
	type: "model_output";
	content: InteractionContent[];
}

interface InteractionFunctionCallStep {
	type: "function_call";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

interface InteractionFunctionResultStep {
	type: "function_result";
	name: string;
	call_id: string;
	result: InteractionContent[];
	is_error?: boolean;
}

interface InteractionThoughtStep {
	type: "thought";
	summary?: InteractionContent[];
	signature?: string;
}

interface InteractionThoughtSummaryDelta {
	type: "thought_summary";
	content?: InteractionContent;
}

interface InteractionThoughtSignatureDelta {
	type: "thought_signature";
	signature?: string;
}

interface InteractionArgumentsDelta {
	type: "arguments_delta";
	arguments?: string;
}

interface PendingInteractionToolCall {
	id: string;
	name: string;
	argumentsText: string;
	argumentsObject: Record<string, unknown>;
}

type InteractionInputStep =
	| InteractionUserInputStep
	| InteractionModelOutputStep
	| InteractionFunctionCallStep
	| InteractionFunctionResultStep;

type InteractionStep =
	| InteractionModelOutputStep
	| InteractionFunctionCallStep
	| InteractionFunctionResultStep
	| InteractionThoughtStep
	| InteractionUserInputStep;

type InteractionThinkingLevel = "minimal" | "low" | "medium" | "high";

interface InteractionGenerationConfig {
	temperature?: number;
	top_p?: number;
	top_k?: number;
	min_p?: number;
	presence_penalty?: number;
	frequency_penalty?: number;
	repetition_penalty?: number;
	max_output_tokens?: number;
	thinking_level?: InteractionThinkingLevel;
	thinking_budget?: number;
}

interface GoogleInteractionRequest {
	model: string;
	input: InteractionInputStep[];
	stream: true;
	previous_interaction_id?: string;
	system_instruction?: string;
	tools?: { functionDeclarations: Record<string, unknown>[] }[];
	store?: boolean;
	generation_config?: InteractionGenerationConfig;
	service_tier?: string;
}

interface InteractionUsage {
	total_input_tokens?: number;
	total_cached_tokens?: number;
	total_output_tokens?: number;
	total_thought_tokens?: number;
	total_tokens?: number;
}

interface InteractionResource {
	id?: string;
	status?: string;
	usage?: InteractionUsage;
}

interface InteractionStreamMetadata {
	total_usage?: InteractionUsage;
}

interface InteractionSseEvent {
	event_type?: string;
	index?: number;
	step?: InteractionStep;
	delta?:
		| InteractionContent
		| InteractionFunctionCallStep
		| InteractionThoughtStep
		| InteractionThoughtSummaryDelta
		| InteractionThoughtSignatureDelta
		| InteractionArgumentsDelta;
	interaction?: InteractionResource;
	interaction_id?: string;
	status?: string;
	metadata?: InteractionStreamMetadata;
	error?: { message?: string; code?: string | number };
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function getGoogleInteractionsState(
	providerSessionState: Map<string, ProviderSessionState> | undefined,
	create: boolean,
): GoogleInteractionsProviderSessionState | undefined {
	if (!providerSessionState) return undefined;
	const existing = providerSessionState.get(GOOGLE_INTERACTIONS_STATE_KEY) as
		| GoogleInteractionsProviderSessionState
		| undefined;
	if (existing || !create) return existing;
	const state: GoogleInteractionsProviderSessionState = { close: () => {} };
	providerSessionState.set(GOOGLE_INTERACTIONS_STATE_KEY, state);
	return state;
}

function interactionContentFromText(text: string): InteractionContent[] {
	return text.length === 0 ? [] : [{ type: "text", text }];
}

function interactionContentFromParts(parts: readonly (TextContent | ImageContent)[]): InteractionContent[] {
	const content: InteractionContent[] = [];
	for (const part of parts) {
		if (part.type === "text") {
			if (part.text.length > 0) content.push({ type: "text", text: part.text });
		} else {
			content.push({ type: "image", data: part.data, mime_type: part.mimeType });
		}
	}
	return content;
}

function userInputStepFromMessage(message: Extract<Message, { role: "user" | "developer" }>): InteractionUserInputStep {
	const content =
		typeof message.content === "string"
			? interactionContentFromText(message.content)
			: interactionContentFromParts(message.content);
	return { type: "user_input", content };
}

function functionResultStepFromMessage(
	message: Extract<Message, { role: "toolResult" }>,
): InteractionFunctionResultStep {
	const result = interactionContentFromParts(message.content);
	return {
		type: "function_result",
		name: message.toolName,
		call_id: message.toolCallId,
		result: result.length > 0 ? result : [{ type: "text", text: "" }],
		...(message.isError ? { is_error: true } : {}),
	};
}

function appendAssistantInteractionSteps(message: AssistantMessage, steps: InteractionInputStep[]): void {
	let modelContent: InteractionContent[] = [];
	const flushModelContent = (): void => {
		if (modelContent.length === 0) return;
		steps.push({ type: "model_output", content: modelContent });
		modelContent = [];
	};

	for (const block of message.content) {
		if (block.type === "text") {
			if (block.text.length > 0) modelContent.push({ type: "text", text: block.text });
		} else if (block.type === "toolCall") {
			flushModelContent();
			steps.push({ type: "function_call", id: block.id, name: block.name, arguments: block.arguments });
		}
	}
	flushModelContent();
}

function interactionMessagesAfterAnchor(
	messages: readonly Message[],
	anchorIndex: number | undefined,
): readonly Message[] {
	return anchorIndex === undefined ? messages : messages.slice(anchorIndex + 1);
}

function buildInteractionInput(context: Context, anchorIndex: number | undefined): InteractionInputStep[] {
	const input: InteractionInputStep[] = [];
	for (const message of interactionMessagesAfterAnchor(context.messages, anchorIndex)) {
		if (message.role === "user" || message.role === "developer") {
			const step = userInputStepFromMessage(message);
			if (step.content.length > 0) input.push(step);
		} else if (message.role === "toolResult") {
			input.push(functionResultStepFromMessage(message));
		} else if (anchorIndex === undefined) {
			appendAssistantInteractionSteps(message, input);
		}
	}
	return input.length > 0 ? input : [{ type: "user_input", content: [{ type: "text", text: "" }] }];
}

function toInteractionThinkingLevel(level: GoogleThinkingLevel): InteractionThinkingLevel | undefined {
	switch (level) {
		case "MINIMAL":
			return "minimal";
		case "LOW":
			return "low";
		case "MEDIUM":
			return "medium";
		case "HIGH":
			return "high";
		case "THINKING_LEVEL_UNSPECIFIED":
			return undefined;
	}
}

function buildInteractionGenerationConfig(options: GoogleOptions | undefined): InteractionGenerationConfig | undefined {
	const config: InteractionGenerationConfig = {};
	if (options?.temperature !== undefined) config.temperature = options.temperature;
	if (options?.topP !== undefined) config.top_p = options.topP;
	if (options?.topK !== undefined) config.top_k = options.topK;
	if (options?.minP !== undefined) config.min_p = options.minP;
	if (options?.presencePenalty !== undefined) config.presence_penalty = options.presencePenalty;
	if (options?.frequencyPenalty !== undefined) config.frequency_penalty = options.frequencyPenalty;
	if (options?.repetitionPenalty !== undefined) config.repetition_penalty = options.repetitionPenalty;
	if (options?.maxTokens !== undefined) config.max_output_tokens = options.maxTokens;
	if (options?.thinking?.level !== undefined) {
		const thinkingLevel = toInteractionThinkingLevel(options.thinking.level);
		if (thinkingLevel !== undefined) config.thinking_level = thinkingLevel;
	} else if (options?.thinking?.budgetTokens !== undefined) {
		config.thinking_budget = options.thinking.budgetTokens;
	}
	return Object.keys(config).length > 0 ? config : undefined;
}

function buildInteractionRequest(
	model: GoogleInteractionsModel,
	context: Context,
	options: GoogleOptions | undefined,
	anchor: InteractionAnchor,
): GoogleInteractionRequest {
	const systemInstruction = normalizeSystemPrompts(context.systemPrompt).join("\n\n");
	const generationConfig = buildInteractionGenerationConfig(options);
	return {
		model: model.id,
		input: buildInteractionInput(context, anchor.messageIndex),
		stream: true,
		...(anchor.id !== undefined ? { previous_interaction_id: anchor.id } : {}),
		...(systemInstruction.length > 0 ? { system_instruction: systemInstruction } : {}),
		...(context.tools && context.tools.length > 0 ? { tools: convertTools(context.tools, model) } : {}),
		...(options?.storeInteraction !== undefined ? { store: options.storeInteraction } : {}),
		...(generationConfig !== undefined ? { generation_config: generationConfig } : {}),
		...(shouldSendServiceTier(options?.serviceTier, model.provider) ? { service_tier: options?.serviceTier } : {}),
	};
}

function applyInteractionUsage(
	model: GoogleInteractionsModel,
	output: AssistantMessage,
	usage: InteractionUsage,
): void {
	const thinkingTokens = usage.total_thought_tokens ?? 0;
	output.usage = {
		input: (usage.total_input_tokens ?? 0) - (usage.total_cached_tokens ?? 0),
		output: (usage.total_output_tokens ?? 0) + thinkingTokens,
		cacheRead: usage.total_cached_tokens ?? 0,
		cacheWrite: 0,
		totalTokens: usage.total_tokens ?? 0,
		...(thinkingTokens > 0 ? { reasoningTokens: thinkingTokens } : {}),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, output.usage);
}

function parseInteractionFunctionCall(value: unknown): InteractionFunctionCallStep | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (record.type !== "function_call") return undefined;
	if (typeof record.id !== "string" || typeof record.name !== "string") return undefined;
	const args = record.arguments;
	return {
		type: "function_call",
		id: record.id,
		name: record.name,
		arguments: args && typeof args === "object" && !Array.isArray(args) ? { ...args } : {},
	};
}

function pendingToolCallFromStep(call: InteractionFunctionCallStep): PendingInteractionToolCall {
	return {
		id: call.id,
		name: call.name,
		argumentsText: "",
		argumentsObject: call.arguments,
	};
}

function parseInteractionArguments(text: string): Record<string, unknown> {
	if (text.trim().length === 0) return {};
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { ...parsed };
	} catch {
		return {};
	}
	return {};
}

/** Provider-specific URL, headers, and fetch implementation for an Interactions request. */
export interface GoogleInteractionsPlan {
	url: string;
	headers: Record<string, string>;
	fetch?: FetchImpl;
}

/**
 * Streams Gemini Interactions API model-mode responses for direct Google and Vertex providers.
 *
 * `fallback`, when supplied, is the legacy `:streamGenerateContent` stream factory. It runs
 * transparently — forwarding its events into this stream — when the Interactions attempt fails
 * before any content is emitted with a signal that the model/endpoint does not support
 * Interactions (HTTP 404/400). Provide it only for auto-selected Interactions requests so an
 * explicit `useInteractionsApi: true` still surfaces failures.
 */
export function streamGoogleInteractions<T extends GoogleInteractionsApi>(args: {
	model: Model<T>;
	context: Context;
	options: GoogleSharedStreamOptions | undefined;
	api: T;
	anchor: InteractionAnchor;
	state: GoogleInteractionsProviderSessionState | undefined;
	prepare: () => GoogleInteractionsPlan | Promise<GoogleInteractionsPlan>;
	fallback?: () => AssistantMessageEventStream;
}): AssistantMessageEventStream {
	const { model, context, options, anchor, state } = args;
	const stream = new AssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: args.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const storeInteraction = options?.storeInteraction !== false;

	void (async () => {
		let started = false;
		let sawTerminal = false;
		let currentTextBlock: TextContent | undefined;
		let currentThinkingBlock: Extract<AssistantMessage["content"][number], { type: "thinking" }> | undefined;
		let pendingThinkingSignature: string | undefined;
		const stepKinds = new Map<number, string>();
		const pendingToolCalls = new Map<number, PendingInteractionToolCall>();
		const ensureStarted = (): void => {
			if (started) return;
			stream.push({ type: "start", partial: output });
			started = true;
		};
		const endOpenBlocks = (): void => {
			if (currentTextBlock) {
				stream.push({
					type: "text_end",
					contentIndex: output.content.indexOf(currentTextBlock),
					content: currentTextBlock.text,
					partial: output,
				});
				currentTextBlock = undefined;
			}
			if (currentThinkingBlock) {
				stream.push({
					type: "thinking_end",
					contentIndex: output.content.indexOf(currentThinkingBlock),
					content: currentThinkingBlock.thinking,
					partial: output,
				});
				currentThinkingBlock = undefined;
			}
		};
		const emitText = (text: string): void => {
			if (text.length === 0) return;
			ensureStarted();
			if (!currentTextBlock) {
				if (currentThinkingBlock) endOpenBlocks();
				currentTextBlock = { type: "text", text: "" };
				output.content.push(currentTextBlock);
				stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
			}
			currentTextBlock.text += text;
			stream.push({
				type: "text_delta",
				contentIndex: output.content.indexOf(currentTextBlock),
				delta: text,
				partial: output,
			});
		};
		const applyThinkingSignature = (signature: string | undefined): void => {
			if (!signature) return;
			if (currentThinkingBlock) {
				currentThinkingBlock.thinkingSignature = signature;
			} else {
				pendingThinkingSignature = signature;
			}
		};
		const emitThinking = (text: string): void => {
			if (text.length === 0) return;
			ensureStarted();
			if (!currentThinkingBlock) {
				if (currentTextBlock) endOpenBlocks();
				currentThinkingBlock = { type: "thinking", thinking: "", thinkingSignature: pendingThinkingSignature };
				pendingThinkingSignature = undefined;
				output.content.push(currentThinkingBlock);
				stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
			}
			currentThinkingBlock.thinking += text;
			stream.push({
				type: "thinking_delta",
				contentIndex: output.content.indexOf(currentThinkingBlock),
				delta: text,
				partial: output,
			});
		};
		const emitToolCall = (call: InteractionFunctionCallStep): void => {
			ensureStarted();
			endOpenBlocks();
			const toolCall: ToolCall = {
				type: "toolCall",
				id: call.id,
				name: call.name,
				arguments: call.arguments,
			};
			output.content.push(toolCall);
			const contentIndex = output.content.length - 1;
			stream.push({ type: "toolcall_start", contentIndex, partial: output });
			stream.push({
				type: "toolcall_delta",
				contentIndex,
				delta: JSON.stringify(toolCall.arguments),
				partial: output,
			});
			stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
		};
		const emitPendingToolCall = (pending: PendingInteractionToolCall): void => {
			emitToolCall({
				type: "function_call",
				id: pending.id,
				name: pending.name,
				arguments:
					pending.argumentsText.length > 0
						? parseInteractionArguments(pending.argumentsText)
						: pending.argumentsObject,
			});
		};

		let prepared = false;
		try {
			const plan = await args.prepare();
			prepared = true;
			let requestBody: unknown = buildInteractionRequest(model, context, options, anchor);
			const replacement = await options?.onPayload?.(requestBody, model);
			if (replacement !== undefined) requestBody = replacement;
			const response = await fetchWithRetry(() => plan.url, {
				method: "POST",
				headers: {
					...plan.headers,
					"Content-Type": "application/json",
					Accept: "text/event-stream",
				},
				body: JSON.stringify(requestBody),
				signal: options?.signal,
				fetch: plan.fetch,
			});
			if (!response.ok) {
				const errorText = await response.text().catch(() => "");
				throw new AIError.GoogleApiError(
					`Google Interactions API error (${response.status}): ${errorText}`,
					response.status,
					{
						headers: response.headers,
					},
				);
			}
			if (!response.body) {
				throw new AIError.ProviderResponseError("Google Interactions API returned an empty response body", {
					provider: model.provider,
					kind: "empty-body",
				});
			}
			for await (const event of readSseJson<InteractionSseEvent>(response.body, options?.signal, sse =>
				options?.onSseEvent?.({ event: sse.event, data: sse.data, raw: [...sse.raw] }, model),
			)) {
				if (event.error) {
					throw new AIError.ProviderResponseError(event.error.message ?? "Google Interactions API stream error", {
						provider: model.provider,
						kind: "runtime",
					});
				}
				if (event.metadata?.total_usage) applyInteractionUsage(model, output, event.metadata.total_usage);
				if (event.event_type === "interaction.created") {
					if (storeInteraction && event.interaction?.id) output.responseId = event.interaction.id;
				} else if (event.event_type === "step.start" && event.index !== undefined && event.step) {
					stepKinds.set(event.index, event.step.type);
					const call = parseInteractionFunctionCall(event.step);
					if (call) {
						pendingToolCalls.set(event.index, pendingToolCallFromStep(call));
					} else if (event.step.type === "thought") {
						applyThinkingSignature(event.step.signature);
						for (const item of event.step.summary ?? []) {
							if (item.type === "text") emitThinking(item.text);
						}
					}
				} else if (event.event_type === "step.delta" && event.index !== undefined && event.delta) {
					const call = parseInteractionFunctionCall(event.delta);
					if (call) {
						pendingToolCalls.set(event.index, pendingToolCallFromStep(call));
					} else if (event.delta.type === "text") {
						if (stepKinds.get(event.index) === "thought") emitThinking(event.delta.text);
						else emitText(event.delta.text);
					} else if (event.delta.type === "thought_summary") {
						if (event.delta.content?.type === "text") emitThinking(event.delta.content.text);
					} else if (event.delta.type === "thought_signature") {
						applyThinkingSignature(event.delta.signature);
					} else if (event.delta.type === "arguments_delta") {
						const pending = pendingToolCalls.get(event.index);
						if (pending && event.delta.arguments) pending.argumentsText += event.delta.arguments;
					}
				} else if (event.event_type === "step.stop" && event.index !== undefined) {
					const stepKind = stepKinds.get(event.index);
					const pending = pendingToolCalls.get(event.index);
					if (pending) {
						emitPendingToolCall(pending);
						pendingToolCalls.delete(event.index);
					} else {
						endOpenBlocks();
						if (stepKind === "thought") pendingThinkingSignature = undefined;
					}
					stepKinds.delete(event.index);
				} else if (event.event_type === "interaction.completed" || event.event_type === "interaction.complete") {
					if (storeInteraction && event.interaction?.id) output.responseId = event.interaction.id;
					if (event.interaction?.usage) applyInteractionUsage(model, output, event.interaction.usage);
					for (const pending of pendingToolCalls.values()) emitPendingToolCall(pending);
					pendingToolCalls.clear();
					endOpenBlocks();
					output.stopReason =
						event.interaction?.status === "requires_action" ||
						output.content.some(block => block.type === "toolCall")
							? "toolUse"
							: "stop";
					if (storeInteraction && state) state.lastInteractionId = output.responseId;
					sawTerminal = true;
					ensureStarted();
					stream.push({ type: "done", reason: output.stopReason, message: output });
				}
			}
			if (!sawTerminal) {
				throw new AIError.ProviderResponseError("Google Interactions API stream ended without a terminal event", {
					provider: model.provider,
					kind: "incomplete-stream",
				});
			}
		} catch (error) {
			// Auto-selected Interactions degrades to `:streamGenerateContent` when no content has
			// streamed yet and the failure means Interactions can't serve this request — the bearer
			// credential couldn't be resolved (prepare threw) or the model/endpoint rejected it
			// (HTTP 404/400). Provider 401/403/429/5xx still surface. Mirrors the OpenAI Responses
			// `previous_response_id` fallback.
			const unsupported = error instanceof AIError.GoogleApiError && (error.status === 404 || error.status === 400);
			if (!started && args.fallback && !options?.signal?.aborted && (!prepared || unsupported)) {
				for await (const event of args.fallback()) stream.push(event);
				return;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
		}
	})();

	return stream;
}

function findAssistantInteractionAnchor(
	context: Context,
	interactionId: string,
	provider: string,
): InteractionAnchor | undefined {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (message?.role === "assistant" && message.provider === provider && message.responseId === interactionId) {
			return { id: interactionId, messageIndex: index };
		}
	}
	return undefined;
}

function latestAssistantInteractionAnchor(context: Context, provider: string): InteractionAnchor | undefined {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (message?.role === "assistant" && message.provider === provider && message.responseId) {
			return { id: message.responseId, messageIndex: index };
		}
	}
	return undefined;
}

function resolveInteractionAnchor(
	context: Context,
	explicitPreviousInteractionId: string | undefined,
	state: GoogleInteractionsProviderSessionState | undefined,
	provider: string,
): InteractionAnchor {
	if (explicitPreviousInteractionId !== undefined) {
		return (
			findAssistantInteractionAnchor(context, explicitPreviousInteractionId, provider) ?? {
				id: explicitPreviousInteractionId,
			}
		);
	}
	const lineageAnchor = latestAssistantInteractionAnchor(context, provider);
	if (lineageAnchor) return lineageAnchor;
	if (state?.lastInteractionId)
		return findAssistantInteractionAnchor(context, state.lastInteractionId, provider) ?? {};
	return {};
}

/**
 * Whether a model is served by the Gemini Interactions API. Interactions is a Gemini 3-era
 * transport, so the catalog subset that supports it is Gemini 3.0+. Older Gemini and non-Gemini
 * ids keep `:streamGenerateContent`, which covers the full catalog.
 */
export function modelSupportsInteractions(model: Pick<Model, "id">): boolean {
	const parsed = parseGeminiModel(model.id);
	return parsed !== null && parsed.version.major >= 3;
}

/**
 * Resolves whether a Google provider call should use Interactions and which lineage anchor to send.
 *
 * Precedence: explicit `useInteractionsApi: false` always wins (force generateContent); otherwise
 * Interactions engages when explicitly requested, when continuing a stored interaction
 * (`previousInteractionId`/assistant lineage/session state), or when `autoEligible` (the
 * zero-config default for the capable model subset on the official endpoint). `auto` flags the
 * last case for the caller — it is the only mode that wires up the generateContent fallback.
 */
export function resolveInteractionDispatch(args: {
	context: Context;
	options: GoogleSharedStreamOptions | undefined;
	provider: string;
	autoEligible: boolean;
}): {
	useInteractions: boolean;
	auto: boolean;
	anchor: InteractionAnchor;
	state: GoogleInteractionsProviderSessionState | undefined;
} {
	const explicitPreviousInteractionId = args.options?.previousInteractionId;
	if (args.options?.storeInteraction === false && explicitPreviousInteractionId !== undefined) {
		throw new AIError.ConfigurationError(
			"Google Interactions API cannot combine storeInteraction:false with previousInteractionId.",
		);
	}
	const explicitOptOut = args.options?.useInteractionsApi === false;
	const explicitOptIn = args.options?.useInteractionsApi === true || explicitPreviousInteractionId !== undefined;
	const storageEnabled = args.options?.storeInteraction !== false;
	const existingState = storageEnabled
		? getGoogleInteractionsState(args.options?.providerSessionState, false)
		: undefined;
	const anchor = explicitOptOut
		? {}
		: resolveInteractionAnchor(args.context, explicitPreviousInteractionId, existingState, args.provider);
	const useInteractions = !explicitOptOut && (explicitOptIn || anchor.id !== undefined || args.autoEligible);
	const auto = useInteractions && !explicitOptIn;
	const interactionState =
		useInteractions && storageEnabled
			? getGoogleInteractionsState(
					args.options?.providerSessionState,
					args.options?.providerSessionState !== undefined,
				)
			: undefined;
	return { useInteractions, auto, anchor, state: interactionState };
}
