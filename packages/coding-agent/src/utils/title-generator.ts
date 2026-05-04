/**
 * Generate session titles using a smol, fast model.
 */
import * as path from "node:path";

import { type Api, completeSimple, type Model } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import titleSystemPrompt from "../prompts/system/title-system.md" with { type: "text" };

const TITLE_SYSTEM_PROMPT = prompt.render(titleSystemPrompt);

const DEFAULT_TERMINAL_TITLE = "π";
const TERMINAL_TITLE_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

const MAX_INPUT_CHARS = 2000;

function getTitleModel(registry: ModelRegistry, settings: Settings, currentModel?: Model<Api>): Model<Api> | undefined {
	const availableModels = registry.getAvailable();
	if (availableModels.length === 0) return undefined;

	const titleModel = resolveRoleSelection(["commit", "smol"], settings, availableModels, registry)?.model;
	if (titleModel) return titleModel;

	if (currentModel) return currentModel;

	return undefined;
}

/**
 * Generate a title for a session based on the first user message.
 *
 * @param firstMessage The first user message
 * @param registry Model registry
 * @param settings Settings used to resolve the smol role
 * @param sessionId Optional session id for sticky API key selection
 */
export async function generateSessionTitle(
	firstMessage: string,
	registry: ModelRegistry,
	settings: Settings,
	sessionId?: string,
	currentModel?: Model<Api>,
): Promise<string | null> {
	const model = getTitleModel(registry, settings, currentModel);
	if (!model) {
		logger.debug("title-generator: no title model found");
		return null;
	}

	// Truncate message if too long
	const truncatedMessage =
		firstMessage.length > MAX_INPUT_CHARS ? `${firstMessage.slice(0, MAX_INPUT_CHARS)}…` : firstMessage;
	const userMessage = `<user-message>
${truncatedMessage}
</user-message>`;

	const apiKey = await registry.getApiKey(model, sessionId);
	if (!apiKey) {
		logger.debug("title-generator: no API key for smol model", {
			provider: model.provider,
			id: model.id,
		});
		return null;
	}

	// Title generation is a 3-6 word task; force reasoning off so reasoning models
	// don't burn the entire output budget on internal thinking and return an empty
	// string. With reasoning disabled, 30 tokens of output is plenty.
	const request = {
		model: `${model.provider}/${model.id}`,
		systemPrompt: TITLE_SYSTEM_PROMPT,
		userMessage,
		maxTokens: 30,
	};
	logger.debug("title-generator: request", request);

	try {
		const response = await completeSimple(
			model,
			{
				systemPrompt: [request.systemPrompt],
				messages: [{ role: "user", content: request.userMessage, timestamp: Date.now() }],
			},
			{
				apiKey,
				maxTokens: 30,
				disableReasoning: true,
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

		return title.replace(/^["']|["']$/g, "").replace(/[.!?]$/, "");
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
	process.stdout.write(`\x1b]0;${sanitizeTerminalTitlePart(title) ?? DEFAULT_TERMINAL_TITLE}\x07`);
}

export function setSessionTerminalTitle(sessionName: string | undefined, cwd?: string): void {
	setTerminalTitle(formatSessionTerminalTitle(sessionName, cwd));
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
