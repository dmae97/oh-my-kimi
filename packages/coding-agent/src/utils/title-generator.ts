/**
 * Generate session titles using a smol, fast model.
 */
import * as path from "node:path";

import { type Api, type AssistantMessage, completeSimple, type Model, type Tool } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";

import { resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import titleSystemPrompt from "../prompts/system/title-system.md" with { type: "text" };
import { ONLINE_TINY_TITLE_MODEL_KEY } from "../tiny/models";
import { formatTitleUserMessage, isLowSignalTitleInput, normalizeGeneratedTitle } from "../tiny/text";
import { tinyTitleClient } from "../tiny/title-client";

const TITLE_SYSTEM_PROMPT = prompt.render(titleSystemPrompt);

const DEFAULT_TERMINAL_TITLE = "π";
const TERMINAL_TITLE_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

export const TITLE_LOCAL_FALLBACK_DELAY_MS = 10_000;
const TITLE_MAX_TOKENS = 30;
const REASONING_SAFE_MAX_TOKENS = 1024;
const SET_TITLE_TOOL_NAME = "set_title";

const setTitleTool: Tool = {
	name: SET_TITLE_TOOL_NAME,
	description: "Set the generated session title.",
	parameters: {
		type: "object",
		properties: {
			title: {
				type: "string",
				description:
					'The generated session title, or exactly "none" when the message carries no concrete task yet.',
			},
		},
		required: ["title"],
		additionalProperties: false,
	},
};

function getTitleModel(registry: ModelRegistry, settings: Settings, currentModel?: Model<Api>): Model<Api> | undefined {
	const availableModels = registry.getAvailable();
	if (availableModels.length === 0) return undefined;

	const titleModel = resolveRoleSelection(["commit", "smol"], settings, availableModels, registry)?.model;
	if (titleModel) return titleModel;

	if (currentModel) return currentModel;

	return undefined;
}

export async function raceFirstNonNull<T>(
	primary: Promise<T | null>,
	startFallback: () => Promise<T | null>,
	delayMs: number = TITLE_LOCAL_FALLBACK_DELAY_MS,
	onPrimaryWinAfterFallback?: () => void,
): Promise<T | null> {
	const { promise, resolve } = Promise.withResolvers<T | null>();
	let resolved = false;
	let primarySettled = false;
	let fallbackStarted = false;
	let fallbackSettled = false;

	const resolveOnce = (value: T | null): void => {
		if (resolved) return;
		resolved = true;
		resolve(value);
	};
	const maybeResolveNull = (): void => {
		if (primarySettled && fallbackStarted && fallbackSettled) resolveOnce(null);
	};
	const startFallbackOnce = (): void => {
		if (fallbackStarted || resolved) return;
		fallbackStarted = true;
		let fallback: Promise<T | null>;
		try {
			fallback = startFallback();
		} catch {
			fallbackSettled = true;
			maybeResolveNull();
			return;
		}
		void fallback.then(
			value => {
				fallbackSettled = true;
				if (value !== null) resolveOnce(value);
				else maybeResolveNull();
			},
			() => {
				fallbackSettled = true;
				maybeResolveNull();
			},
		);
	};

	const timer = setTimeout(startFallbackOnce, delayMs);
	void primary.then(
		value => {
			primarySettled = true;
			clearTimeout(timer);
			if (value !== null) {
				if (fallbackStarted) onPrimaryWinAfterFallback?.();
				resolveOnce(value);
				return;
			}
			startFallbackOnce();
			maybeResolveNull();
		},
		() => {
			primarySettled = true;
			clearTimeout(timer);
			startFallbackOnce();
			maybeResolveNull();
		},
	);

	try {
		return await promise;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Generate a title for a session based on the first user message.
 *
 * @param firstMessage The first user message
 * @param registry Model registry
 * @param settings Settings used to resolve the smol role
 * @param sessionId Optional session id for sticky API key selection
 * @param currentModel Current model (used to derive title model)
 * @param metadataResolver Optional resolver evaluated after credential selection
 *   to produce request metadata (e.g. user_id for session attribution). Using a
 *   resolver instead of a pre-evaluated value ensures the metadata's account_uuid
 *   reflects the credential actually selected for this request.
 * @param customSystemPrompt Optional title-specific system prompt override
 */
export async function generateSessionTitle(
	firstMessage: string,
	registry: ModelRegistry,
	settings: Settings,
	sessionId?: string,
	currentModel?: Model<Api>,
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined,
	customSystemPrompt?: string,
): Promise<string | null> {
	// Defer titling for greetings / acknowledgements / empty input. The default
	// tiny title model can't reliably decline trivial input, so this happens
	// deterministically before any model is invoked; the caller retries on the
	// next user message while the session stays unnamed.
	if (isLowSignalTitleInput(firstMessage)) {
		logger.debug("title-generator: skipped low-signal input", { sessionId, reason: "low-signal" });
		return null;
	}

	const titleSystemPrompt = customSystemPrompt?.trim() || undefined;
	const tinyModel = settings.get("providers.tinyModel");
	if (tinyModel === ONLINE_TINY_TITLE_MODEL_KEY) {
		return generateTitleOnline(
			firstMessage,
			registry,
			settings,
			sessionId,
			currentModel,
			metadataResolver,
			undefined,
			titleSystemPrompt,
		);
	}

	const onlineAbortController = new AbortController();
	const localTitlePromise = titleSystemPrompt
		? tinyTitleClient.generate(tinyModel, firstMessage, { systemPrompt: titleSystemPrompt })
		: tinyTitleClient.generate(tinyModel, firstMessage);
	const localTitle = localTitlePromise.then(
		title => title || null,
		err => {
			logger.warn("title-generator: local model error", {
				sessionId,
				model: tinyModel,
				error: err instanceof Error ? err.message : String(err),
			});
			return null;
		},
	);
	const startOnline = (): Promise<string | null> =>
		generateTitleOnline(
			firstMessage,
			registry,
			settings,
			sessionId,
			currentModel,
			metadataResolver,
			onlineAbortController.signal,
			titleSystemPrompt,
		);

	return raceFirstNonNull(localTitle, startOnline, TITLE_LOCAL_FALLBACK_DELAY_MS, () => {
		onlineAbortController.abort();
	});
}

export async function generateTitleOnline(
	firstMessage: string,
	registry: ModelRegistry,
	settings: Settings,
	sessionId?: string,
	currentModel?: Model<Api>,
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined,
	signal?: AbortSignal,
	customSystemPrompt?: string,
): Promise<string | null> {
	const model = getTitleModel(registry, settings, currentModel);
	if (!model) {
		logger.warn("title-generator: no title model found", { sessionId, reason: "no-title-model" });
		return null;
	}

	const titleSystemPrompt = customSystemPrompt?.trim() || undefined;
	const systemPrompt = titleSystemPrompt ?? TITLE_SYSTEM_PROMPT;
	const userMessage = formatTitleUserMessage(firstMessage);
	const modelName = `${model.provider}/${model.id}`;
	const modelContext = {
		sessionId,
		provider: model.provider,
		id: model.id,
		model: modelName,
	};
	logger.debug("title-generator: start", modelContext);

	try {
		const apiKey = await registry.getApiKey(model, sessionId);
		if (!apiKey) {
			logger.warn("title-generator: no API key", { ...modelContext, reason: "missing-api-key" });
			return null;
		}
		// Resolve metadata after getApiKey so the session-sticky credential for this
		// request is already recorded; metadataResolver can then return the correct
		// account_uuid rather than the snapshot-at-call-site value.
		const metadata = metadataResolver?.(model.provider);

		// Title generation is a 3-7 word task, but some reasoning backends ignore
		// disableReasoning. Keep the normal cheap budget for non-reasoning models
		// while reserving enough output room for reasoning models to still emit
		// the forced tool call after any unavoidable thinking tokens.
		const maxTokens = model.reasoning ? Math.max(TITLE_MAX_TOKENS, REASONING_SAFE_MAX_TOKENS) : TITLE_MAX_TOKENS;
		logger.debug("title-generator: request", { ...modelContext, maxTokens });

		const response = await completeSimple(
			model,
			{
				systemPrompt: [systemPrompt],
				messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
				tools: [setTitleTool],
			},
			{
				apiKey: registry.resolver(model.provider, { sessionId, baseUrl: model.baseUrl, modelId: model.id }),
				maxTokens,
				disableReasoning: true,
				toolChoice: { type: "tool", name: SET_TITLE_TOOL_NAME },
				metadata,
				signal,
			},
		);

		if (response.stopReason === "error") {
			logger.warn("title-generator: response error", {
				...modelContext,
				reason: "provider-response-error",
				stopReason: response.stopReason,
				errorMessage: response.errorMessage,
			});
			return null;
		}

		const title = normalizeGeneratedTitle(extractGeneratedTitle(response.content));

		if (!title) {
			logger.debug("title-generator: no title returned", {
				...modelContext,
				reason: "model-returned-none",
				usage: response.usage,
				stopReason: response.stopReason,
			});
			return null;
		}

		logger.debug("title-generator: success", {
			...modelContext,
			title,
			usage: response.usage,
			stopReason: response.stopReason,
		});

		return title;
	} catch (err) {
		logger.warn("title-generator: error", {
			...modelContext,
			reason: "exception",
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

function extractGeneratedTitle(contentBlocks: AssistantMessage["content"]): string {
	let textTitle = "";
	for (const content of contentBlocks) {
		if (content.type === "toolCall" && content.name === SET_TITLE_TOOL_NAME) {
			const args = content.arguments as Record<string, unknown>;
			const title = args.title;
			return typeof title === "string" ? title.trim() : "";
		}
		if (content.type === "text") {
			textTitle += content.text;
		}
	}
	return textTitle.trim();
}

/**
 * Remove control characters so model-generated titles cannot inject terminal escapes.
 */
function sanitizeTerminalTitlePart(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const sanitized = value.replace(TERMINAL_TITLE_CONTROL_CHARS, "").trim();
	return sanitized || undefined;
}

function getFallbackTerminalTitle(cwd: string | undefined): string | undefined {
	if (!cwd) return undefined;
	const resolvedCwd = path.resolve(cwd);
	const baseName = path.basename(resolvedCwd);
	if (!baseName || baseName === path.parse(resolvedCwd).root) return undefined;
	return sanitizeTerminalTitlePart(baseName);
}

export function formatSessionTerminalTitle(sessionName: string | undefined, cwd?: string): string {
	const label = sanitizeTerminalTitlePart(sessionName) ?? getFallbackTerminalTitle(cwd);
	return label ? `${DEFAULT_TERMINAL_TITLE}: ${label}` : DEFAULT_TERMINAL_TITLE;
}

/**
 * Set the terminal title using OSC 0 (sets both tab and window title). Unsupported terminals ignore it.
 */
export function setTerminalTitle(title: string): void {
	if (!process.stdout.isTTY) return;
	process.stdout.write(`\x1b]0;${sanitizeTerminalTitlePart(title) ?? DEFAULT_TERMINAL_TITLE}\x07`);
}

export function setSessionTerminalTitle(sessionName: string | undefined, cwd?: string): void {
	setTerminalTitle(formatSessionTerminalTitle(sessionName, cwd));
}

/**
 * Save the current terminal title on terminals that support xterm window ops.
 */
export function pushTerminalTitle(): void {
	if (!process.stdout.isTTY) return;
	process.stdout.write("\x1b[22;2t");
}

/**
 * Restore the previously saved terminal title on terminals that support xterm window ops.
 */
export function popTerminalTitle(): void {
	if (!process.stdout.isTTY) return;
	process.stdout.write("\x1b[23;2t");
}
