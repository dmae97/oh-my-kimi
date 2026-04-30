/**
 * Lazy provider module loading.
 *
 * Each provider module is loaded only when its stream function is first called.
 * This avoids eagerly importing heavy SDK dependencies (e.g., @anthropic-ai/sdk,
 * openai) at startup. The loaded module promise is cached so subsequent calls
 * reuse the same import.
 *
 * NOTE: stream.ts currently imports providers directly, so this file is not yet
 * wired into the main streaming path. It provides the infrastructure for lazy
 * loading that can be integrated when stream.ts is refactored.
 */
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	OptionsForApi,
} from "../types";
import { AssistantMessageEventStream as EventStreamImpl } from "../utils/event-stream";
import type { BedrockOptions } from "./amazon-bedrock";
import type { AnthropicOptions } from "./anthropic";
import type { AzureOpenAIResponsesOptions } from "./azure-openai-responses";
import type { CursorOptions } from "./cursor";
import type { GoogleOptions } from "./google";
import type { GoogleGeminiCliOptions } from "./google-gemini-cli";
import type { GoogleVertexOptions } from "./google-vertex";
import type { OllamaChatOptions } from "./ollama";
import type { OpenAICodexResponsesOptions } from "./openai-codex-responses";
import type { OpenAICompletionsOptions } from "./openai-completions";
import type { OpenAIResponsesOptions } from "./openai-responses";

// ---------------------------------------------------------------------------
// Lazy provider module shape
// ---------------------------------------------------------------------------

interface LazyProviderModule<TApi extends Api> {
	stream: (model: Model<TApi>, context: Context, options: OptionsForApi<TApi>) => AsyncIterable<AssistantMessageEvent>;
}

interface AnthropicProviderModule {
	streamAnthropic: (
		model: Model<"anthropic-messages">,
		context: Context,
		options: AnthropicOptions,
	) => AssistantMessageEventStream;
}

interface AzureOpenAIResponsesProviderModule {
	streamAzureOpenAIResponses: (
		model: Model<"azure-openai-responses">,
		context: Context,
		options: AzureOpenAIResponsesOptions,
	) => AssistantMessageEventStream;
}

interface GoogleProviderModule {
	streamGoogle: (
		model: Model<"google-generative-ai">,
		context: Context,
		options: GoogleOptions,
	) => AssistantMessageEventStream;
}

interface GoogleGeminiCliProviderModule {
	streamGoogleGeminiCli: (
		model: Model<"google-gemini-cli">,
		context: Context,
		options: GoogleGeminiCliOptions,
	) => AssistantMessageEventStream;
}

interface GoogleVertexProviderModule {
	streamGoogleVertex: (
		model: Model<"google-vertex">,
		context: Context,
		options: GoogleVertexOptions,
	) => AssistantMessageEventStream;
}

interface OpenAICodexResponsesProviderModule {
	streamOpenAICodexResponses: (
		model: Model<"openai-codex-responses">,
		context: Context,
		options: OpenAICodexResponsesOptions,
	) => AssistantMessageEventStream;
}

interface OpenAICompletionsProviderModule {
	streamOpenAICompletions: (
		model: Model<"openai-completions">,
		context: Context,
		options: OpenAICompletionsOptions,
	) => AssistantMessageEventStream;
}

interface OpenAIResponsesProviderModule {
	streamOpenAIResponses: (
		model: Model<"openai-responses">,
		context: Context,
		options: OpenAIResponsesOptions,
	) => AssistantMessageEventStream;
}

interface OllamaProviderModule {
	streamOllama: (
		model: Model<"ollama-chat">,
		context: Context,
		options: OllamaChatOptions,
	) => AssistantMessageEventStream;
}

interface CursorProviderModule {
	streamCursor: (
		model: Model<"cursor-agent">,
		context: Context,
		options: CursorOptions,
	) => AssistantMessageEventStream;
}

interface BedrockProviderModule {
	streamBedrock: (
		model: Model<"bedrock-converse-stream">,
		context: Context,
		options: BedrockOptions,
	) => AssistantMessageEventStream;
}

// ---------------------------------------------------------------------------
// Module-level lazy promise caches
// ---------------------------------------------------------------------------

const importNodeOnlyProvider = (specifier: string): Promise<unknown> => import(specifier);

let anthropicProviderModulePromise: Promise<LazyProviderModule<"anthropic-messages">> | undefined;
let azureOpenAIResponsesProviderModulePromise: Promise<LazyProviderModule<"azure-openai-responses">> | undefined;
let googleProviderModulePromise: Promise<LazyProviderModule<"google-generative-ai">> | undefined;
let googleGeminiCliProviderModulePromise: Promise<LazyProviderModule<"google-gemini-cli">> | undefined;
let googleVertexProviderModulePromise: Promise<LazyProviderModule<"google-vertex">> | undefined;
let openAICodexResponsesProviderModulePromise: Promise<LazyProviderModule<"openai-codex-responses">> | undefined;
let openAICompletionsProviderModulePromise: Promise<LazyProviderModule<"openai-completions">> | undefined;
let openAIResponsesProviderModulePromise: Promise<LazyProviderModule<"openai-responses">> | undefined;
let ollamaProviderModulePromise: Promise<LazyProviderModule<"ollama-chat">> | undefined;
let cursorProviderModulePromise: Promise<LazyProviderModule<"cursor-agent">> | undefined;
let bedrockProviderModuleOverride: LazyProviderModule<"bedrock-converse-stream"> | undefined;
let bedrockProviderModulePromise: Promise<LazyProviderModule<"bedrock-converse-stream">> | undefined;

export function setBedrockProviderModule(module: BedrockProviderModule): void {
	bedrockProviderModuleOverride = {
		stream: module.streamBedrock,
	};
}

// ---------------------------------------------------------------------------
// Stream forwarding / error helpers
// ---------------------------------------------------------------------------

function hasFinalResult(
	source: AsyncIterable<AssistantMessageEvent>,
): source is AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> } {
	return typeof (source as { result?: unknown }).result === "function";
}

function forwardStream<TApi extends Api>(
	target: EventStreamImpl,
	source: AsyncIterable<AssistantMessageEvent>,
	model: Model<TApi>,
): void {
	(async () => {
		try {
			for await (const event of source) {
				target.push(event);
			}
			if (hasFinalResult(source)) {
				target.end(await source.result());
			} else {
				target.end();
			}
		} catch (error) {
			const message = createLazyLoadErrorMessage(model, error);
			target.push({ type: "error", reason: "error", error: message });
			target.end(message);
		}
	})();
}

function createLazyLoadErrorMessage<TApi extends Api>(model: Model<TApi>, error: unknown): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

// ---------------------------------------------------------------------------
// Generic lazy stream factory
// ---------------------------------------------------------------------------

function createLazyStream<TApi extends Api>(
	loadModule: () => Promise<LazyProviderModule<TApi>>,
): (model: Model<TApi>, context: Context, options: OptionsForApi<TApi>) => EventStreamImpl {
	return (model, context, options) => {
		const outer = new EventStreamImpl();

		loadModule()
			.then(module => {
				const inner = module.stream(model, context, options);
				forwardStream(outer, inner, model);
			})
			.catch(error => {
				const message = createLazyLoadErrorMessage(model, error);
				outer.push({ type: "error", reason: "error", error: message });
				outer.end(message);
			});

		return outer;
	};
}

// ---------------------------------------------------------------------------
// Module loaders (one per provider, cached via ||=)
// ---------------------------------------------------------------------------

function loadAnthropicProviderModule(): Promise<LazyProviderModule<"anthropic-messages">> {
	anthropicProviderModulePromise ||= import("./anthropic").then(module => {
		const provider = module as AnthropicProviderModule;
		return { stream: provider.streamAnthropic };
	});
	return anthropicProviderModulePromise;
}

function loadAzureOpenAIResponsesProviderModule(): Promise<LazyProviderModule<"azure-openai-responses">> {
	azureOpenAIResponsesProviderModulePromise ||= import("./azure-openai-responses").then(module => {
		const provider = module as AzureOpenAIResponsesProviderModule;
		return { stream: provider.streamAzureOpenAIResponses };
	});
	return azureOpenAIResponsesProviderModulePromise;
}

function loadGoogleProviderModule(): Promise<LazyProviderModule<"google-generative-ai">> {
	googleProviderModulePromise ||= import("./google").then(module => {
		const provider = module as GoogleProviderModule;
		return { stream: provider.streamGoogle };
	});
	return googleProviderModulePromise;
}

function loadGoogleGeminiCliProviderModule(): Promise<LazyProviderModule<"google-gemini-cli">> {
	googleGeminiCliProviderModulePromise ||= import("./google-gemini-cli").then(module => {
		const provider = module as GoogleGeminiCliProviderModule;
		return { stream: provider.streamGoogleGeminiCli };
	});
	return googleGeminiCliProviderModulePromise;
}

function loadGoogleVertexProviderModule(): Promise<LazyProviderModule<"google-vertex">> {
	googleVertexProviderModulePromise ||= import("./google-vertex").then(module => {
		const provider = module as GoogleVertexProviderModule;
		return { stream: provider.streamGoogleVertex };
	});
	return googleVertexProviderModulePromise;
}

function loadOpenAICodexResponsesProviderModule(): Promise<LazyProviderModule<"openai-codex-responses">> {
	openAICodexResponsesProviderModulePromise ||= import("./openai-codex-responses").then(module => {
		const provider = module as OpenAICodexResponsesProviderModule;
		return { stream: provider.streamOpenAICodexResponses };
	});
	return openAICodexResponsesProviderModulePromise;
}

function loadOpenAICompletionsProviderModule(): Promise<LazyProviderModule<"openai-completions">> {
	openAICompletionsProviderModulePromise ||= import("./openai-completions").then(module => {
		const provider = module as OpenAICompletionsProviderModule;
		return { stream: provider.streamOpenAICompletions };
	});
	return openAICompletionsProviderModulePromise;
}

function loadOpenAIResponsesProviderModule(): Promise<LazyProviderModule<"openai-responses">> {
	openAIResponsesProviderModulePromise ||= import("./openai-responses").then(module => {
		const provider = module as OpenAIResponsesProviderModule;
		return { stream: provider.streamOpenAIResponses };
	});
	return openAIResponsesProviderModulePromise;
}

function loadOllamaProviderModule(): Promise<LazyProviderModule<"ollama-chat">> {
	ollamaProviderModulePromise ||= import("./ollama").then(module => {
		const provider = module as OllamaProviderModule;
		return { stream: provider.streamOllama };
	});
	return ollamaProviderModulePromise;
}

function loadCursorProviderModule(): Promise<LazyProviderModule<"cursor-agent">> {
	cursorProviderModulePromise ||= import("./cursor").then(module => {
		const provider = module as CursorProviderModule;
		return { stream: provider.streamCursor };
	});
	return cursorProviderModulePromise;
}

function loadBedrockProviderModule(): Promise<LazyProviderModule<"bedrock-converse-stream">> {
	if (bedrockProviderModuleOverride) {
		return Promise.resolve(bedrockProviderModuleOverride);
	}
	bedrockProviderModulePromise ||= importNodeOnlyProvider("./amazon-bedrock").then(module => {
		const provider = module as BedrockProviderModule;
		return { stream: provider.streamBedrock };
	});
	return bedrockProviderModulePromise;
}

// ---------------------------------------------------------------------------
// Lazy stream function exports
//
// These use the same names as the direct provider stream functions. When
// stream.ts is updated to import from this module instead of individual
// providers, the lazy loading will take effect on the main code path.
// ---------------------------------------------------------------------------

export const streamAnthropic = createLazyStream(loadAnthropicProviderModule);
export const streamAzureOpenAIResponses = createLazyStream(loadAzureOpenAIResponsesProviderModule);
export const streamGoogle = createLazyStream(loadGoogleProviderModule);
export const streamGoogleGeminiCli = createLazyStream(loadGoogleGeminiCliProviderModule);
export const streamGoogleVertex = createLazyStream(loadGoogleVertexProviderModule);
export const streamOpenAICodexResponses = createLazyStream(loadOpenAICodexResponsesProviderModule);
export const streamOpenAICompletions = createLazyStream(loadOpenAICompletionsProviderModule);
export const streamOpenAIResponses = createLazyStream(loadOpenAIResponsesProviderModule);
export const streamCursor = createLazyStream(loadCursorProviderModule);
export const streamOllama = createLazyStream(loadOllamaProviderModule);

export const streamBedrock = createLazyStream(loadBedrockProviderModule);
