/**
 * OpenAI Codex Web Search Provider
 *
 * Uses the configured Codex Responses transport for proxy/API-key setups and
 * the official ChatGPT backend for OAuth logins.
 */
import * as os from "node:os";
import {
	type AuthStorage,
	type FetchImpl,
	type Model,
	type OAuthAccess,
	withAuth,
	withOAuthAccess,
} from "@oh-my-pi/pi-ai";
import { applyCodexResponsesLiteShape } from "@oh-my-pi/pi-ai/providers/openai-codex/request-transformer";
import {
	createOpenAICodexCompatibilityMetadata,
	resolveCodexResponsesUrl,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import {
	CODEX_BASE_URL,
	CODEX_CLIENT_VERSION,
	getCodexAccountId,
	OPENAI_HEADER_VALUES,
	OPENAI_HEADERS,
} from "@oh-my-pi/pi-catalog/wire/codex";
import { $env, readSseJson } from "@oh-my-pi/pi-utils";
import packageJson from "../../../../package.json" with { type: "json" };
import type { ModelRegistry } from "../../../config/model-registry";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const FALLBACK_MODEL = "gpt-5.5";
const DEFAULT_MODEL_PREFERENCES = [
	"gpt-5.6-luna",
	"gpt-5.6-terra",
	"gpt-5.6-sol",
	"gpt-5.5",
	"gpt-5.4",
	"gpt-5-codex",
	"gpt-5",
	"gpt-5.3-codex",
	"gpt-5.2-codex",
	"gpt-5.1-codex",
	"gpt-5-codex-mini",
];
const DEFAULT_INSTRUCTIONS =
	"You are a helpful assistant with web search capabilities. Search the web to answer the user's question accurately and cite your sources.";

type CodexSearchModel = Model<"openai-codex-responses">;

interface CodexModelCandidate {
	modelId: string;
	catalogModel?: CodexSearchModel;
}

interface CodexSearchTransport {
	baseUrl: string;
	url: string;
	headers: Record<string, string>;
	customEndpoint: boolean;
}

interface CodexSearchResult {
	answer: string;
	sources: SearchSource[];
	model: string;
	requestId: string;
	usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}

function getBundledCodexModels(): CodexSearchModel[] {
	const models: CodexSearchModel[] = [];
	for (const model of getBundledModels("openai-codex")) {
		if (model.api === "openai-codex-responses") {
			models.push(model as CodexSearchModel);
		}
	}
	return models;
}

function getConfiguredModel(): CodexModelCandidate | undefined {
	const configuredModel = $env.PI_CODEX_WEB_SEARCH_MODEL?.trim();
	if (!configuredModel) return undefined;

	const catalogModel = getBundledCodexModels().find(model => model.id === configuredModel);
	return { modelId: configuredModel, ...(catalogModel ? { catalogModel } : {}) };
}

function getDefaultModelCandidates(): CodexModelCandidate[] {
	const bundledModels = getBundledCodexModels();
	const candidates: CodexModelCandidate[] = [];
	for (const modelId of DEFAULT_MODEL_PREFERENCES) {
		const catalogModel = bundledModels.find(model => model.id === modelId);
		if (catalogModel) candidates.push({ modelId, catalogModel });
	}

	if (candidates.length > 0) {
		return candidates;
	}

	const nonMini = bundledModels.find(model => !model.id.includes("mini") && !model.id.includes("spark"));
	if (nonMini) {
		return [{ modelId: nonMini.id, catalogModel: nonMini }];
	}

	const fallbackModel = bundledModels[0];
	return fallbackModel ? [{ modelId: fallbackModel.id, catalogModel: fallbackModel }] : [{ modelId: FALLBACK_MODEL }];
}

function shouldRetryWithNextDefaultModel(error: unknown): boolean {
	if (!(error instanceof SearchProviderError)) return false;
	if (error.provider !== "codex" || error.status !== 400) return false;
	return /model is not supported|requested model is not supported|not supported when using codex with a chatgpt account/i.test(
		error.message,
	);
}

export interface CodexSearchParams {
	signal?: AbortSignal;
	fetch?: FetchImpl;
	query: string;
	system_prompt?: string;
	num_results?: number;
	/** Search context size: controls how much web content to include */
	search_context_size?: "low" | "medium" | "high";
}

/** Codex API response structure */
interface CodexResponseItem {
	type: string;
	id?: string;
	role?: string;
	name?: string;
	call_id?: string;
	status?: string;
	arguments?: string;
	content?: CodexContentPart[];
	summary?: Array<{ type: string; text: string }>;
}

interface CodexContentPart {
	type: string;
	text?: string;
	annotations?: CodexAnnotation[];
}

interface CodexAnnotation {
	type: string;
	url?: string;
	title?: string;
	start_index?: number;
	end_index?: number;
}

interface CodexUsage {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
	input_tokens_details?: { cached_tokens?: number };
}

interface CodexResponse {
	id?: string;
	model?: string;
	status?: string;
	usage?: CodexUsage;
}

/**
 * Known Codex "image placeholder" answers — short prose the assistant emits in
 * place of a real answer when it produced a screenshot instead of text. These
 * carry no information, so callers treat them as non-answers and advance the
 * chain to a provider that returns text. Extend by adding the normalized
 * literal below; no regex tuning required.
 */
const IMAGE_PLACEHOLDER_ANSWERS: ReadonlySet<string> = new Set([
	"see attached image",
	"attached image",
	"see the attached image",
	"see image",
	"see image above",
	"image above",
	"see image below",
	"image below",
]);

function isImagePlaceholderAnswer(text: string): boolean {
	// Strip surrounding brackets/quotes and trailing punctuation, lowercase,
	// then match against the known-placeholder set.
	const normalized = text
		.trim()
		.replace(/^[[("'`*_]+/, "")
		.replace(/[\])"'`*_.!?]+$/, "")
		.trim()
		.toLowerCase();
	return IMAGE_PLACEHOLDER_ANSWERS.has(normalized);
}

function addSource(sources: SearchSource[], source: SearchSource): void {
	if (!sources.some(existing => existing.url === source.url)) {
		sources.push(source);
	}
}

function countCharacter(text: string, target: string): number {
	let count = 0;
	for (const char of text) {
		if (char === target) {
			count += 1;
		}
	}
	return count;
}

/**
 * Strips prose punctuation and unmatched closing delimiters from extracted URLs.
 * Codex often returns links in markdown or sentence text without structured annotations.
 */
function normalizeExtractedUrl(candidate: string): string | null {
	let url = candidate.trim();

	while (url.length > 0) {
		const lastCharacter = url.at(-1);
		if (!lastCharacter) break;
		if (/[.,!?;:'"]/u.test(lastCharacter)) {
			url = url.slice(0, -1);
			continue;
		}
		if (lastCharacter === ")" && countCharacter(url, ")") > countCharacter(url, "(")) {
			url = url.slice(0, -1);
			continue;
		}
		if (lastCharacter === "]" && countCharacter(url, "]") > countCharacter(url, "[")) {
			url = url.slice(0, -1);
			continue;
		}
		if (lastCharacter === "}" && countCharacter(url, "}") > countCharacter(url, "{")) {
			url = url.slice(0, -1);
			continue;
		}
		break;
	}

	if (!/^https?:\/\//.test(url)) {
		return null;
	}

	try {
		return new URL(url).toString();
	} catch {
		return null;
	}
}

function findMarkdownLinkUrlEnd(text: string, openParenIndex: number): number | null {
	let depth = 0;

	for (let index = openParenIndex; index < text.length; index += 1) {
		const character = text[index];
		if (!character || character === "\n") {
			return null;
		}
		if (character === "(") {
			depth += 1;
			continue;
		}
		if (character !== ")") {
			continue;
		}
		depth -= 1;
		if (depth === 0) {
			return index;
		}
		if (depth < 0) {
			return null;
		}
	}

	return null;
}

/**
 * Extracts citation sources from markdown links and bare URLs in the answer text.
 * Used as a fallback when the Codex response omits `url_citation` annotations.
 */
function extractTextSources(text: string): SearchSource[] {
	const sources: SearchSource[] = [];

	for (let index = 0; index < text.length; index += 1) {
		if (text[index] !== "[") {
			continue;
		}
		const titleEnd = text.indexOf("]", index + 1);
		if (titleEnd === -1 || text[titleEnd + 1] !== "(") {
			continue;
		}
		const urlEnd = findMarkdownLinkUrlEnd(text, titleEnd + 1);
		if (urlEnd === null) {
			continue;
		}
		const title = text.slice(index + 1, titleEnd).trim();
		const url = normalizeExtractedUrl(text.slice(titleEnd + 2, urlEnd));
		if (url) {
			addSource(sources, { title: title || url, url });
		}
		index = urlEnd;
	}

	for (const match of text.matchAll(/https?:\/\/\S+/g)) {
		const url = normalizeExtractedUrl(match[0] ?? "");
		if (!url) continue;
		addSource(sources, { title: url, url });
	}

	return sources;
}

/**
 * Resolve a Codex bearer + accountId through {@link AuthStorage} — the single
 * refresh authority. Returns `null` when no OAuth credential is configured,
 * when the credential cannot be refreshed (broker error, revoked token, etc.),
 * or when the access token carries no `chatgpt_account_id` claim.
 */
async function findCodexAuth(
	authStorage: AuthStorage,
	sessionId: string | undefined,
	signal: AbortSignal | undefined,
): Promise<{ access: OAuthAccess; accountId: string } | null> {
	const access = await authStorage.getOAuthAccess("openai-codex", sessionId, { signal });
	if (!access) return null;
	const accountId = access.accountId ?? getCodexAccountId(access.accessToken);
	if (!accountId) return null;
	return { access, accountId };
}

function resolveCodexSearchTransport(modelRegistry: ModelRegistry | undefined, modelId: string): CodexSearchTransport {
	const registryModel = modelRegistry?.find("openai-codex", modelId);
	const bundledModel = getBundledCodexModels().find(model => model.id === modelId);
	const providerBaseUrl = modelRegistry?.getProviderBaseUrl("openai-codex");
	let baseUrl = providerBaseUrl ?? registryModel?.baseUrl ?? CODEX_BASE_URL;
	if (registryModel?.baseUrl && registryModel.baseUrl !== (bundledModel?.baseUrl ?? CODEX_BASE_URL)) {
		baseUrl = registryModel.baseUrl;
	}

	const url = resolveCodexResponsesUrl(baseUrl);
	return {
		baseUrl,
		url,
		headers: {
			...(modelRegistry?.getProviderHeaders("openai-codex") ?? {}),
			...(registryModel?.headers ?? {}),
		},
		customEndpoint: url !== resolveCodexResponsesUrl(CODEX_BASE_URL),
	};
}

/**
 * Builds HTTP headers for Codex API requests.
 */
function buildCodexHeaders(
	accessToken: string,
	accountId: string | undefined,
	configuredHeaders: Record<string, string>,
): Headers {
	const headers = new Headers(configuredHeaders);
	headers.delete("x-api-key");
	headers.set("Authorization", `Bearer ${accessToken}`);
	if (accountId) {
		headers.set(OPENAI_HEADERS.ACCOUNT_ID, accountId);
	} else {
		headers.delete(OPENAI_HEADERS.ACCOUNT_ID);
	}
	headers.set(OPENAI_HEADERS.BETA, OPENAI_HEADER_VALUES.BETA_RESPONSES);
	headers.set(OPENAI_HEADERS.ORIGINATOR, OPENAI_HEADER_VALUES.ORIGINATOR_CODEX);
	headers.set(OPENAI_HEADERS.VERSION, CODEX_CLIENT_VERSION);
	headers.set("User-Agent", `pi/${packageJson.version} (${os.platform()} ${os.release()}; ${os.arch()})`);
	headers.set("Accept", "text/event-stream");
	headers.set("Content-Type", "application/json");
	return headers;
}

/**
 * Calls the Codex Responses API with web search tool enabled.
 * The caller provides the exact model id to send; retry / fallback policy
 * lives one layer up in `searchCodex()` so we can distinguish explicit user
 * overrides from the default ChatGPT-account model-selection path.
 */
async function callCodexSearch(
	auth: { accessToken: string; accountId?: string },
	query: string,
	options: {
		signal?: AbortSignal;
		systemPrompt?: string;
		searchContextSize?: "low" | "medium" | "high";
		model: CodexModelCandidate;
		sessionId?: string;
		fetch?: FetchImpl;
		transport: CodexSearchTransport;
	},
): Promise<CodexSearchResult> {
	const headers = buildCodexHeaders(auth.accessToken, auth.accountId, options.transport.headers);

	const requestedModel = options.model.modelId;
	const usesResponsesLite = options.model.catalogModel?.useResponsesLite === true;

	const body: Record<string, unknown> = {
		model: requestedModel,
		stream: true,
		store: false,
		input: [
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: query }],
			},
		],
		tools: [
			{
				type: "web_search",
				search_context_size: options.searchContextSize ?? "high",
			},
		],
		tool_choice: { type: "web_search" },
		instructions: options.systemPrompt ?? DEFAULT_INSTRUCTIONS,
	};
	if (usesResponsesLite) {
		const metadata = createOpenAICodexCompatibilityMetadata({
			sessionId: options.sessionId,
			requestKind: "turn",
			startNewTurn: true,
		});
		for (const name in metadata.headers) {
			const value = metadata.headers[name];
			if (value !== undefined) headers.set(name, value);
		}
		headers.set(OPENAI_HEADERS.RESPONSES_LITE, "true");
		body.client_metadata = metadata.clientMetadata;
		body.reasoning = { context: "all_turns" };
		applyCodexResponsesLiteShape(body);
	}

	const fetchImpl = options.fetch ?? fetch;
	const response = await fetchImpl(options.transport.url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: withHardTimeout(options.signal),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("codex", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError("codex", `Codex API error (${response.status}): ${errorText}`, response.status);
	}

	if (!response.body) {
		throw new SearchProviderError("codex", "Codex API returned no response body", 500);
	}

	// Parse SSE stream
	const answerParts: string[] = [];
	const streamedAnswerParts: string[] = [];
	const sources: SearchSource[] = [];
	let model = requestedModel;
	let requestId = "";
	let usage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;

	for await (const rawEvent of readSseJson<Record<string, unknown>>(response.body, options.signal)) {
		const eventType = typeof rawEvent.type === "string" ? rawEvent.type : "";
		if (!eventType) continue;

		if (eventType === "response.output_text.delta") {
			const delta = typeof rawEvent.delta === "string" ? rawEvent.delta : "";
			if (delta) {
				streamedAnswerParts.push(delta);
			}
		} else if (eventType === "response.output_item.done") {
			const item = rawEvent.item as CodexResponseItem | undefined;
			if (!item) continue;

			// Handle text message content and extract sources from annotations
			if (item.type === "message" && item.content) {
				for (const part of item.content) {
					if (part.type === "output_text" && part.text) {
						answerParts.push(part.text);

						// Extract sources from url_citation annotations
						if (part.annotations) {
							for (const annotation of part.annotations) {
								if (annotation.type === "url_citation" && annotation.url) {
									// Deduplicate by URL
									addSource(sources, { title: annotation.title ?? annotation.url, url: annotation.url });
								}
							}
						}
					}
				}
			}

			// Handle reasoning summary as part of answer
			if (item.type === "reasoning" && item.summary) {
				for (const part of item.summary) {
					if (part.type === "summary_text" && part.text) {
						answerParts.push(part.text);
					}
				}
			}
		} else if (eventType === "response.completed" || eventType === "response.done") {
			const resp = (rawEvent as { response?: CodexResponse }).response;
			if (resp) {
				if (resp.model) model = resp.model;
				if (resp.id) requestId = resp.id;
				if (resp.usage) {
					const cachedTokens = resp.usage.input_tokens_details?.cached_tokens ?? 0;
					usage = {
						inputTokens: (resp.usage.input_tokens ?? 0) - cachedTokens,
						outputTokens: resp.usage.output_tokens ?? 0,
						totalTokens: resp.usage.total_tokens ?? 0,
					};
				}
			}
		} else if (eventType === "error") {
			const code = (rawEvent as { code?: string }).code ?? "";
			const message = (rawEvent as { message?: string }).message ?? "Unknown error";
			throw new SearchProviderError("codex", `Codex error (${code}): ${message}`, 500);
		} else if (eventType === "response.failed") {
			const resp = (rawEvent as { response?: { error?: { message?: string } } }).response;
			const errorMessage = resp?.error?.message ?? "Request failed";
			throw new SearchProviderError("codex", `Codex request failed: ${errorMessage}`, 500);
		}
	}

	const finalAnswer = answerParts.join("\n\n").trim();
	const streamedAnswer = streamedAnswerParts.join("").trim();
	// Throw to advance the chain whenever Codex emitted nothing but image
	// placeholder prose — including the case where the streamed delta itself
	// is the placeholder (the model occasionally streams the same text it
	// publishes as the final output_text).
	const finalIsPlaceholder = finalAnswer.length > 0 && isImagePlaceholderAnswer(finalAnswer);
	const streamedIsPlaceholder = streamedAnswer.length > 0 && isImagePlaceholderAnswer(streamedAnswer);
	const hasFinalText = finalAnswer.length > 0 && !finalIsPlaceholder;
	const hasStreamedText = streamedAnswer.length > 0 && !streamedIsPlaceholder;
	if (!hasFinalText && !hasStreamedText && sources.length === 0) {
		throw new SearchProviderError("codex", "Codex returned image-only response", 502);
	}
	const answer = hasFinalText ? finalAnswer : hasStreamedText ? streamedAnswer : "";

	// Fallback: when Codex omits url_citation annotations, scrape markdown links
	// and bare URLs from the synthesized answer so callers still receive sources.
	if (sources.length === 0 && answer.length > 0) {
		for (const source of extractTextSources(answer)) {
			addSource(sources, source);
		}
	}

	return {
		answer,
		sources,
		model,
		requestId,
		usage,
	};
}

async function runCodexSearchCandidates(options: {
	auth: { accessToken: string; accountId?: string };
	params: SearchParams;
	modelCandidates: CodexModelCandidate[];
	modelWasConfigured: boolean;
	transport: CodexSearchTransport;
}): Promise<CodexSearchResult> {
	let lastError: unknown;
	for (let index = 0; index < options.modelCandidates.length; index += 1) {
		const candidate = options.modelCandidates[index];
		if (!candidate) continue;

		try {
			return await callCodexSearch(options.auth, options.params.query, {
				signal: options.params.signal,
				systemPrompt: options.params.systemPrompt,
				searchContextSize: "high",
				model: candidate,
				sessionId: options.params.sessionId,
				fetch: options.params.fetch,
				transport: options.transport,
			});
		} catch (error) {
			lastError = error;
			const isLastCandidate = index === options.modelCandidates.length - 1;
			if (options.modelWasConfigured || isLastCandidate || !shouldRetryWithNextDefaultModel(error)) {
				throw error;
			}
		}
	}
	throw lastError ?? new Error("Codex search failed without returning a result");
}

/**
 * Executes a web search using OpenAI Codex's built-in web search tool.
 *
 * Default-model behavior:
 * - If `PI_CODEX_WEB_SEARCH_MODEL` is set, use it exactly once and surface any
 *   upstream error verbatim.
 * - Otherwise prefer ChatGPT-account-safe bundled defaults (GPT-5.6 Luna,
 *   Terra, Sol, GPT-5.5, …) and retry the next candidate only when Codex
 *   returns the known 400 "model is not supported" family. This avoids
 *   selecting `gpt-5-codex-mini` first on ChatGPT accounts, which OpenAI
 *   rejects.
 */
export async function searchCodex(params: SearchParams): Promise<SearchResponse> {
	const configuredModel = getConfiguredModel();
	const modelCandidates = configuredModel ? [configuredModel] : getDefaultModelCandidates();
	const firstCandidate = modelCandidates[0];
	if (!firstCandidate) {
		throw new SearchProviderError("codex", "No Codex web search model is configured.");
	}
	const transport = resolveCodexSearchTransport(params.modelRegistry, firstCandidate.modelId);

	let result: CodexSearchResult;
	if (transport.customEndpoint) {
		// ModelRegistry resolves command-backed provider keys before consulting
		// its AuthStorage, so a lower-priority OAuth origin is irrelevant when
		// that command source is configured.
		const credentialSource = params.modelRegistry?.authStorage ?? params.authStorage;
		const credentialOrigin = credentialSource.getCredentialOrigin("openai-codex");
		const hasCommandBackedKey = params.modelRegistry?.hasCommandBackedApiKey("openai-codex") === true;
		if (!hasCommandBackedKey && (credentialOrigin?.kind === "oauth" || credentialOrigin?.kind === "env")) {
			throw new SearchProviderError(
				"codex",
				`Refusing to send official Codex OAuth credentials to custom endpoint ${transport.baseUrl}. Configure an API key for provider "openai-codex".`,
			);
		}

		const resolverOptions = {
			sessionId: params.sessionId,
			baseUrl: transport.baseUrl,
			modelId: firstCandidate.modelId,
		};
		const keyOrResolver = params.modelRegistry
			? params.modelRegistry.resolver("openai-codex", resolverOptions)
			: params.authStorage.resolver("openai-codex", resolverOptions);
		result = await withAuth(
			keyOrResolver,
			accessToken =>
				runCodexSearchCandidates({
					auth: { accessToken },
					params,
					modelCandidates,
					modelWasConfigured: configuredModel !== undefined,
					transport,
				}),
			{
				signal: params.signal,
				missingKeyMessage: 'Codex credentials not found. Configure an API key for provider "openai-codex".',
			},
		);
	} else {
		const seed = await findCodexAuth(params.authStorage, params.sessionId, params.signal);
		if (!seed) {
			throw new Error(
				"No Codex OAuth credentials found. Login with 'omp /login openai-codex' to enable Codex web search.",
			);
		}

		result = await withOAuthAccess(
			params.authStorage,
			"openai-codex",
			access => {
				// A refreshed/rotated credential can carry a different bearer and
				// ChatGPT account id than the seed used to select the first attempt.
				const accountId = access.accountId ?? getCodexAccountId(access.accessToken);
				if (!accountId) {
					throw new Error("Codex OAuth credential is missing a ChatGPT account id");
				}
				return runCodexSearchCandidates({
					auth: { accessToken: access.accessToken, accountId },
					params,
					modelCandidates,
					modelWasConfigured: configuredModel !== undefined,
					transport,
				});
			},
			{ sessionId: params.sessionId, signal: params.signal, seed: seed.access },
		);
	}

	let sources = result.sources;

	const numResults = params.numSearchResults ?? params.limit;
	if (numResults && sources.length > numResults) {
		sources = sources.slice(0, numResults);
	}

	return {
		provider: "codex",
		answer: result.answer || undefined,
		sources,
		usage: result.usage
			? {
					inputTokens: result.usage.inputTokens,
					outputTokens: result.usage.outputTokens,
					totalTokens: result.usage.totalTokens,
				}
			: undefined,
		model: result.model,
		requestId: result.requestId,
	};
}

/**
 * Checks whether Codex web search has an API key or OAuth credential.
 */
export async function hasCodexSearch(authStorage: AuthStorage): Promise<boolean> {
	return authStorage.hasAuth("openai-codex");
}

/** Search provider for OpenAI Codex web search. */
export class CodexProvider extends SearchProvider {
	readonly id = "codex";
	readonly label = "OpenAI";

	isAvailable(authStorage: AuthStorage): Promise<boolean> | boolean {
		return hasCodexSearch(authStorage);
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchCodex(params);
	}
}
