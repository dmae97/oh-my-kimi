/**
 * Generate session titles using a smol, fast model.
 */
import * as path from "node:path";

import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { type Api, completeSimple, type Model } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import titleSystemPrompt from "../prompts/system/title-system.md" with { type: "text" };
import { toReasoningEffort } from "../thinking";

const TITLE_SYSTEM_PROMPT = prompt.render(titleSystemPrompt);

const DEFAULT_TERMINAL_TITLE = "π";
const TERMINAL_TITLE_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

const MAX_INPUT_CHARS = 3_500;
const MAX_TITLE_CHARS = 80;
const SESSION_DISPLAY_ID_LENGTH = 6;
const MIN_GENERATED_TITLE_WORDS = 2;
const MAX_GENERATED_TITLE_WORDS = 5;
export type SessionTitleSource = "auto" | "user";
// OMP_STATUS_DEV_SESSION_PREFIX_V1

const GENERIC_TITLE_WORDS = new Set([
	"a",
	"about",
	"again",
	"an",
	"and",
	"chat",
	"conversation",
	"continue",
	"for",
	"help",
	"it",
	"later",
	"more",
	"new",
	"next",
	"now",
	"on",
	"please",
	"session",
	"task",
	"the",
	"this",
	"to",
	"we",
]);

/** Matches the title a tool-choice-less model wraps in `<title>...</title>`. */
const TITLE_MARKER_RE = /<title>([\s\S]*?)<\/title>/i;

/**
 * Whether the model honors a forced `tool_choice` so the `set_title` tool can be
 * required. Providers/models that reject forced tool calls (chat-completions
 * hosts without `tool_choice` support, Claude Fable/Mythos) can't be made to
 * emit a structured call, so the caller falls back to marker-wrapped text.
 */
function modelSupportsForcedToolChoice(model: Model<Api>): boolean {
	// `compat` is a union across APIs and `supportsToolChoice` lives only on the
	// OpenAI-completions variant, so read both flags through a structural view.
	const compat = model.compat as { supportsToolChoice?: boolean; supportsForcedToolChoice?: boolean } | undefined;
	if (!compat) return true;
	// A forced tool call first requires sending `tool_choice` at all. Hosts that
	// drop the parameter entirely (`supportsToolChoice: false`, e.g. direct
	// DeepSeek reasoning) can never be forced even when they otherwise accept
	// forced values, so this veto wins over `supportsForcedToolChoice`.
	if (compat.supportsToolChoice === false) return false;
	if (typeof compat.supportsForcedToolChoice === "boolean") return compat.supportsForcedToolChoice;
	if (typeof compat.supportsToolChoice === "boolean") return compat.supportsToolChoice;
	return true;
}

export interface GenerateSessionTitleOptions {
	signal?: AbortSignal;
}

interface TitleModelSelection {
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	fromRole: boolean;
}

function getTitleModel(
	registry: ModelRegistry,
	settings: Settings,
	currentModel?: Model<Api>,
): TitleModelSelection | undefined {
	const availableModels = registry.getAvailable();
	if (availableModels.length === 0) return undefined;

	const titleModel = resolveRoleSelection(["title", "smol", "commit"], settings, availableModels, registry);
	if (titleModel) return { ...titleModel, fromRole: true };

	if (currentModel) return { model: currentModel, fromRole: false };

	return undefined;
}

/**
 * Generate a short title for a session based on the current user/task context.
 *
 * @param titleContext Latest user prompt and optional plan/activity context
 * @param registry Model registry
 * @param settings Settings used to resolve title/smol role models
 * @param sessionId Optional session id for sticky API key selection
 * @param currentModel Current model (used as fallback title model)
 * @param metadataResolver Optional resolver evaluated after credential selection
 *   to produce request metadata (e.g. user_id for session attribution). Using a
 *   resolver instead of a pre-evaluated value ensures the metadata's account_uuid
 *   reflects the credential actually selected for this request.
 * @param options Optional abort signal for dynamic title refreshes
 */
export async function generateSessionTitle(
	titleContext: string,
	registry: ModelRegistry,
	settings: Settings,
	sessionId?: string,
	currentModel?: Model<Api>,
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined,
	options: GenerateSessionTitleOptions = {},
): Promise<string | null> {
	const titleModel = getTitleModel(registry, settings, currentModel);
	if (!titleModel) {
		logger.debug("title-generator: no title model found");
		return null;
	}

	const truncatedContext =
		titleContext.length > MAX_INPUT_CHARS ? `${titleContext.slice(0, MAX_INPUT_CHARS)}…` : titleContext;
	const userMessage = `<title-context>
${truncatedContext}
</title-context>`;

	const apiKey = await registry.getApiKey(titleModel.model, sessionId);
	if (!apiKey) {
		logger.debug("title-generator: no API key for smol model", {
			provider: titleModel.model.provider,
			id: titleModel.model.id,
		});
		return null;
	}
	// Resolve metadata after getApiKey so the session-sticky credential for this
	// request is already recorded; metadataResolver can then return the correct
	// account_uuid rather than the snapshot-at-call-site value.
	const metadata = metadataResolver?.(titleModel.model.provider);

	// Prefer configured title/smol/commit role thinking. Only the active-model
	// fallback disables reasoning, because it may be a high-thinking model chosen
	// for coding rather than a short utility title task.
	const request = {
		model: `${titleModel.model.provider}/${titleModel.model.id}`,
		systemPrompt: TITLE_SYSTEM_PROMPT,
		userMessage,
		maxTokens: 30,
	};
	logger.debug("title-generator: request", request);

	try {
		const response = await completeSimple(
			titleModel.model,
			{
				systemPrompt: [request.systemPrompt],
				messages: [{ role: "user", content: request.userMessage, timestamp: Date.now() }],
			},
			{
				apiKey,
				maxTokens: 30,
				...(titleModel.fromRole
					? { reasoning: toReasoningEffort(titleModel.thinkingLevel) }
					: { disableReasoning: true }),
				metadata,
				signal: options.signal,
			},
		);

		if (response.stopReason === "error") {
			logger.debug("title-generator: response error", {
				model: request.model,
				stopReason: response.stopReason,
				errorMessage: response.errorMessage,
			});
			return null;
		}

		let title = "";
		for (const content of response.content) {
			if (content.type === "text") {
				title += content.text;
			}
		}
		title = title.trim();

		logger.debug("title-generator: response", {
			model: request.model,
			title,
			usage: response.usage,
			stopReason: response.stopReason,
		});

		if (!title) {
			return null;
		}

		return normalizeGeneratedSessionTitle(title);
	} catch (err) {
		logger.debug("title-generator: error", {
			model: request.model,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

/**
 * Remove control characters so model-generated titles cannot inject terminal escapes.
 */
function sanitizeTerminalTitlePart(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const sanitized = value.replace(TERMINAL_TITLE_CONTROL_CHARS, "").trim();
	return sanitized || undefined;
}

function stripTitleWrapper(value: string): string {
	return value
		.replace(/^\s*(?:title|session title)\s*:\s*/i, "")
		.replace(/^\s*[-*•]+\s*/, "")
		.replace(/^\s*["'“”‘’]+/, "")
		.replace(/["'“”‘’]+\s*$/, "")
		.replace(/[.!?]+\s*$/, "")
		.trim();
}

export function normalizeGeneratedSessionTitle(value: string | undefined): string | null {
	const sanitized = sanitizeTerminalTitlePart(value);
	if (!sanitized) return null;

	const title = stripTitleWrapper(sanitized).replace(/\s+/g, " ").trim();
	if (!title) return null;

	const words = title.split(/\s+/).filter(Boolean);
	if (words.length < MIN_GENERATED_TITLE_WORDS) return null;
	const canonicalWords = words.map(word => word.toLowerCase().replace(/[^a-z0-9]+/g, "")).filter(Boolean);
	if (canonicalWords.length === 0 || canonicalWords.every(word => GENERIC_TITLE_WORDS.has(word))) return null;

	const capped = words.slice(0, MAX_GENERATED_TITLE_WORDS).join(" ");
	return capped.length > MAX_TITLE_CHARS ? `${capped.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…` : capped;
}

export function formatSessionDisplayId(sessionId: string | undefined | null): string {
	const sanitized = (sessionId ?? "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
	return sanitized.slice(-SESSION_DISPLAY_ID_LENGTH) || "new";
}

function isDevPiChannel(): boolean {
	const channel = process.env.PI_CHANNEL?.trim().toLowerCase();
	const configDir = process.env.PI_CONFIG_DIR?.trim();
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? "";
	return channel === "dev" || configDir === ".omp-dev" || /(^|[\\/])\.omp-dev([\\/]|$)/.test(agentDir);
}

export function formatSessionDisplayPrefix(sessionId: string | undefined | null): string {
	return `#${isDevPiChannel() ? "dev-" : ""}${formatSessionDisplayId(sessionId)}`;
}

export function resolveSessionDisplayTitle(
	sessionName: string | undefined,
	cwd?: string,
	titleSource?: SessionTitleSource,
): string {
	const sanitizedName = sanitizeTerminalTitlePart(sessionName);
	const title = titleSource === "user" ? sanitizedName : normalizeGeneratedSessionTitle(sanitizedName);
	return title ?? getFallbackTerminalTitle(cwd) ?? "conversation";
}

export function formatSessionDisplayTitle(
	sessionId: string | undefined | null,
	sessionName: string | undefined,
	cwd?: string,
	titleSource?: SessionTitleSource,
): string {
	const title = resolveSessionDisplayTitle(sessionName, cwd, titleSource);
	return `${formatSessionDisplayPrefix(sessionId)} ${title}`;
}

function getFallbackTerminalTitle(cwd: string | undefined): string | undefined {
	if (!cwd) return undefined;
	const resolvedCwd = path.resolve(cwd);
	const baseName = path.basename(resolvedCwd);
	if (!baseName || baseName === path.parse(resolvedCwd).root) return undefined;
	return sanitizeTerminalTitlePart(baseName);
}

export function formatSessionTerminalTitle(
	sessionName: string | undefined,
	cwd?: string,
	titleSource?: SessionTitleSource,
	sessionId?: string,
): string {
	const label = formatSessionDisplayTitle(sessionId, sessionName, cwd, titleSource);
	return `${DEFAULT_TERMINAL_TITLE}: ${label}`;
}

/**
 * Set the terminal title using OSC 0 (sets both tab and window title). Unsupported terminals ignore it.
 */
export function setTerminalTitle(title: string): void {
	process.stdout.write(`\x1b]0;${sanitizeTerminalTitlePart(title) ?? DEFAULT_TERMINAL_TITLE}\x07`);
}

export function setSessionTerminalTitle(
	sessionName: string | undefined,
	cwd?: string,
	titleSource?: SessionTitleSource,
	sessionId?: string,
): void {
	setTerminalTitle(formatSessionTerminalTitle(sessionName, cwd, titleSource, sessionId));
}

/**
 * Save the current terminal title on terminals that support xterm window ops.
 */
export function pushTerminalTitle(): void {
	process.stdout.write("\x1b[22;2t");
}

/**
 * Restore the previously saved terminal title on terminals that support xterm window ops.
 */
export function popTerminalTitle(): void {
	process.stdout.write("\x1b[23;2t");
}
