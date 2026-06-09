import { $env, extractHttpStatusFromError } from "@oh-my-pi/pi-utils";
import { AzureOpenAI, APIConnectionTimeoutError as OpenAIConnectionTimeoutError } from "openai";
import type {
	Tool as OpenAITool,
	ResponseCreateParamsStreaming,
	ResponseInput,
	ResponseStreamEvent,
} from "openai/resources/responses/responses";
import { getEnvApiKey } from "../stream";
import type {
	AssistantMessage,
	Context,
	Model,
	RawSseEvent,
	ServiceTier,
	StreamFunction,
	StreamOptions,
	Tool,
	ToolChoice,
} from "../types";
import { normalizeSystemPrompts } from "../utils";
import { createAbortSourceTracker } from "../utils/abort";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { finalizeErrorMessage, type RawHttpRequestDump } from "../utils/http-inspector";
import {
	getOpenAIStreamFirstEventTimeoutMs,
	getOpenAIStreamIdleTimeoutMs,
	iterateWithIdleTimeout,
} from "../utils/idle-iterator";
import { sanitizeSchemaForOpenAIResponses, toolWireSchema } from "../utils/schema";
import { createSdkStreamRequestOptions } from "../utils/sdk-stream-timeout";
import { notifyRawSseEvent } from "../utils/sse-debug";
import { mapToOpenAIResponsesToolChoice } from "../utils/tool-choice";
import { getOpenAIResponsesCacheSessionId } from "./openai-responses";
import {
	appendResponsesToolResultMessages,
	applyCommonResponsesSamplingParams,
	applyResponsesReasoningParams,
	convertResponsesAssistantMessage,
	convertResponsesInputContent,
	createInitialResponsesAssistantMessage,
	isOpenAIResponsesProgressEvent,
	normalizeResponsesToolCallIdForTransform,
	processResponsesStream,
	repairOrphanResponsesToolCalls,
} from "./openai-responses-shared";
import { transformMessages } from "./transform-messages";

const DEFAULT_AZURE_API_VERSION = "v1";
const AZURE_OPENAI_RESPONSES_FIRST_EVENT_TIMEOUT_MESSAGE =
	"Azure OpenAI responses stream timed out while waiting for the first event";

export function parseAzureDeploymentNameMap(value: string | undefined): Map<string, string> {
	const map = new Map<string, string>();
	if (!value) return map;
	for (const entry of value.split(",")) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		const [modelId, deploymentName] = trimmed.split("=", 2);
		if (!modelId || !deploymentName) continue;
		map.set(modelId.trim(), deploymentName.trim());
	}
	return map;
}

function resolveDeploymentName(model: Model<"azure-openai-responses">, options?: AzureOpenAIResponsesOptions): string {
	if (options?.azureDeploymentName) {
		return options.azureDeploymentName;
	}
	const mappedDeployment = parseAzureDeploymentNameMap($env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP).get(model.id);
	return mappedDeployment ?? model.id;
}

// Azure OpenAI Responses-specific options
export interface AzureOpenAIResponsesOptions extends StreamOptions {
	reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh";
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	azureApiVersion?: string;
	azureResourceName?: string;
	azureBaseUrl?: string;
	azureDeploymentName?: string;
	toolChoice?: ToolChoice;
	serviceTier?: ServiceTier;
}

type AzureOpenAIResponsesSamplingParams = ResponseCreateParamsStreaming & {
	top_p?: number;
	top_k?: number;
	min_p?: number;
	presence_penalty?: number;
	repetition_penalty?: number;
};

async function* observeDecodedAzureResponsesEvents(
	events: AsyncIterable<ResponseStreamEvent>,
	observer: (event: RawSseEvent) => void,
): AsyncGenerator<ResponseStreamEvent> {
	for await (const event of events) {
		const data = JSON.stringify(event);
		// Reconstructed from decoded SDK event; not literal wire bytes.
		notifyRawSseEvent(observer, { event: event.type, data, raw: [`event: ${event.type}`, `data: ${data}`] });
		yield event;
	}
}

/**
 * Generate function for Azure OpenAI Responses API
 */
export const streamAzureOpenAIResponses: StreamFunction<"azure-openai-responses"> = (
	model: Model<"azure-openai-responses">,
	context: Context,
	options?: AzureOpenAIResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	// Start async processing
	(async () => {
		const startTime = Date.now();
		let firstTokenTime: number | undefined;
		const deploymentName = resolveDeploymentName(model, options);

		const output: AssistantMessage = createInitialResponsesAssistantMessage(
			"azure-openai-responses",
			model.provider,
			model.id,
		);
		let rawRequestDump: RawHttpRequestDump | undefined;
		const abortTracker = createAbortSourceTracker(options?.signal);
		const firstEventTimeoutAbortError = new Error(AZURE_OPENAI_RESPONSES_FIRST_EVENT_TIMEOUT_MESSAGE);
		const { requestAbortController, requestSignal } = abortTracker;
		const onSseEvent = options?.onSseEvent;
		const rawSseObserver = onSseEvent ? (event: RawSseEvent) => onSseEvent(event, model) : undefined;

		try {
			// Create Azure OpenAI client
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			const client = createClient(model, apiKey, options);
			const { baseUrl } = resolveAzureConfig(model, options);
			const params = buildParams(model, context, options, deploymentName);
			options?.onPayload?.(params);
			const idleTimeoutMs = options?.streamIdleTimeoutMs ?? getOpenAIStreamIdleTimeoutMs();
			const firstEventTimeoutMs =
				options?.streamFirstEventTimeoutMs ?? getOpenAIStreamFirstEventTimeoutMs(idleTimeoutMs);
			const requestTimeoutMs =
				firstEventTimeoutMs !== undefined && firstEventTimeoutMs > 0 ? firstEventTimeoutMs : undefined;
			rawRequestDump = {
				provider: model.provider,
				api: output.api,
				model: model.id,
				method: "POST",
				url: `${baseUrl}/responses`,
				body: params,
			};
			let requestTimeout: NodeJS.Timeout | undefined;
			if (requestTimeoutMs !== undefined) {
				requestTimeout = setTimeout(() => abortTracker.abortLocally(firstEventTimeoutAbortError), requestTimeoutMs);
			}
			let openaiStream: AsyncIterable<ResponseStreamEvent>;
			try {
				const requestOptions = createSdkStreamRequestOptions(requestSignal, requestTimeoutMs);
				openaiStream = await client.responses.create(params, requestOptions);
			} catch (error) {
				if (error instanceof OpenAIConnectionTimeoutError && !abortTracker.wasCallerAbort()) {
					throw firstEventTimeoutAbortError;
				}
				throw error;
			} finally {
				if (requestTimeout !== undefined) clearTimeout(requestTimeout);
			}
			stream.push({ type: "start", partial: output });

			const timedOpenaiStream = iterateWithIdleTimeout(openaiStream, {
				idleTimeoutMs,
				firstItemTimeoutMs: firstEventTimeoutMs,
				firstItemErrorMessage: AZURE_OPENAI_RESPONSES_FIRST_EVENT_TIMEOUT_MESSAGE,
				errorMessage: "Azure OpenAI responses stream stalled while waiting for the next event",
				onIdle: () => requestAbortController.abort(),
				onFirstItemTimeout: () => abortTracker.abortLocally(firstEventTimeoutAbortError),
				abortSignal: options?.signal,
				isProgressItem: isOpenAIResponsesProgressEvent,
			});
			let sawCompleted = false;
			const observedOpenaiStream = rawSseObserver
				? observeDecodedAzureResponsesEvents(timedOpenaiStream, rawSseObserver)
				: timedOpenaiStream;
			await processResponsesStream(observedOpenaiStream, output, stream, model, {
				onFirstToken: () => {
					if (!firstTokenTime) firstTokenTime = Date.now();
				},
				onCompleted: () => {
					sawCompleted = true;
				},
			});

			const firstEventTimeoutError = abortTracker.getLocalAbortReason();
			if (firstEventTimeoutError) {
				throw firstEventTimeoutError;
			}

			if (abortTracker.wasCallerAbort()) {
				throw new Error("Request was aborted");
			}

			if (!sawCompleted) {
				throw new Error("Azure OpenAI responses stream closed before response.completed was received");
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(output.errorMessage ?? "An unknown error occurred");
			}

			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) delete (block as { index?: number }).index;
			const firstEventTimeoutError = abortTracker.getLocalAbortReason();
			output.stopReason = abortTracker.wasCallerAbort() ? "aborted" : "error";
			output.errorStatus = extractHttpStatusFromError(error);
			output.errorMessage = firstEventTimeoutError?.message ?? (await finalizeErrorMessage(error, rawRequestDump));
			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

function normalizeAzureBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "");
}

function buildDefaultBaseUrl(resourceName: string): string {
	return `https://${resourceName}.openai.azure.com/openai/v1`;
}

function resolveAzureConfig(
	model: Model<"azure-openai-responses">,
	options?: AzureOpenAIResponsesOptions,
): { baseUrl: string; apiVersion: string } {
	const apiVersion = options?.azureApiVersion || $env.AZURE_OPENAI_API_VERSION || DEFAULT_AZURE_API_VERSION;

	const baseUrl = options?.azureBaseUrl?.trim() || $env.AZURE_OPENAI_BASE_URL?.trim() || undefined;
	const resourceName = options?.azureResourceName || $env.AZURE_OPENAI_RESOURCE_NAME;

	let resolvedBaseUrl = baseUrl;

	if (!resolvedBaseUrl && resourceName) {
		resolvedBaseUrl = buildDefaultBaseUrl(resourceName);
	}

	if (!resolvedBaseUrl && model.baseUrl) {
		resolvedBaseUrl = model.baseUrl;
	}

	if (!resolvedBaseUrl) {
		throw new Error(
			"Azure OpenAI base URL is required. Set AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME, or pass azureBaseUrl, azureResourceName, or model.baseUrl.",
		);
	}

	return {
		baseUrl: normalizeAzureBaseUrl(resolvedBaseUrl),
		apiVersion,
	};
}

function createClient(model: Model<"azure-openai-responses">, apiKey: string, options?: AzureOpenAIResponsesOptions) {
	if (!apiKey) {
		const envKey = $env.AZURE_OPENAI_API_KEY;
		if (!envKey) {
			throw new Error(
				"Azure OpenAI API key is required. Set AZURE_OPENAI_API_KEY environment variable or pass it as an argument.",
			);
		}
		apiKey = envKey;
	}

	const headers = { ...(model.headers ?? {}) };

	if (options?.headers) {
		Object.assign(headers, options.headers);
	}

	const { baseUrl, apiVersion } = resolveAzureConfig(model, options);

	const baseFetch = options?.fetch ?? fetch;
	return new AzureOpenAI({
		apiKey,
		apiVersion,
		dangerouslyAllowBrowser: true,
		maxRetries: 5,
		defaultHeaders: headers,
		baseURL: baseUrl,
		fetch: baseFetch,
	});
}

function buildParams(
	model: Model<"azure-openai-responses">,
	context: Context,
	options: AzureOpenAIResponsesOptions | undefined,
	deploymentName: string,
) {
	const messages = convertMessages(model, context, true);

	const params: AzureOpenAIResponsesSamplingParams = {
		model: deploymentName,
		input: messages,
		stream: true,
		prompt_cache_key: getOpenAIResponsesCacheSessionId(options),
		// Encrypted reasoning replay (applyResponsesReasoningParams) requires
		// stateless responses, matching the openai provider.
		store: false,
	};

	applyCommonResponsesSamplingParams(params, options, model);

	if (context.tools) {
		params.tools = convertTools(context.tools);
		if (options?.toolChoice) {
			params.tool_choice = mapToOpenAIResponsesToolChoice(options.toolChoice);
		}
	}

	applyResponsesReasoningParams(params, model, options, messages);

	return params;
}

function convertMessages(
	model: Model<"azure-openai-responses">,
	context: Context,
	strictResponsesPairing: boolean,
): ResponseInput {
	const messages: ResponseInput = [];
	const transformedMessages = transformMessages(context.messages, model, normalizeResponsesToolCallIdForTransform);
	const knownCallIds = new Set<string>();
	const customCallIds = new Set<string>();

	const systemPrompts = normalizeSystemPrompts(context.systemPrompt);
	if (systemPrompts.length > 0) {
		const role = model.reasoning && model.compat.supportsDeveloperRole ? "developer" : "system";
		for (const systemPrompt of systemPrompts) {
			messages.push({ role, content: systemPrompt });
		}
	}

	let msgIndex = 0;
	for (const msg of transformedMessages) {
		if (msg.role === "user" || msg.role === "developer") {
			const content = convertResponsesInputContent(msg.content, model.input.includes("image"));
			if (!content) continue;
			messages.push({
				role: "user",
				content: msg.role === "developer" && typeof msg.content === "string" ? msg.content.toWellFormed() : content,
			});
		} else if (msg.role === "assistant") {
			const outputItems = convertResponsesAssistantMessage(
				msg as AssistantMessage,
				model,
				msgIndex,
				knownCallIds,
				true,
				customCallIds,
			);
			if (outputItems.length === 0) continue;
			messages.push(...outputItems);
		} else if (msg.role === "toolResult") {
			appendResponsesToolResultMessages(messages, msg, model, strictResponsesPairing, knownCallIds, customCallIds);
		}
		msgIndex++;
	}

	return repairOrphanResponsesToolCalls(messages);
}

function convertTools(tools: Tool[]): OpenAITool[] {
	return tools.map(tool => ({
		type: "function",
		name: tool.name,
		description: tool.description || "",
		parameters: sanitizeSchemaForOpenAIResponses(toolWireSchema(tool)),
		strict: false,
	}));
}
