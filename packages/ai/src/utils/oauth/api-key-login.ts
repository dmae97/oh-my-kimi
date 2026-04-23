/**
 * Shared factory for API-key-paste "login" flows.
 *
 * Several providers (Cerebras, Synthetic, Moonshot, Together, NanoGPT, ZenMux)
 * don't actually implement OAuth — they just ask the user to paste an API key,
 * optionally validate it, and return the trimmed key.
 */

import { validateApiKeyAgainstModelsEndpoint, validateOpenAICompatibleApiKey } from "./api-key-validation";
import type { OAuthController } from "./types";

type ChatCompletionsValidation = {
	kind: "chat-completions";
	provider: string;
	baseUrl: string;
	model: string;
};

type ModelsEndpointValidation = {
	kind: "models-endpoint";
	provider: string;
	modelsUrl: string;
};

export type ApiKeyLoginConfig = {
	/** Display name used in error messages, e.g. "Cerebras", "NanoGPT". */
	providerLabel: string;
	/** URL opened in browser for the user to grab their key. */
	authUrl: string;
	/** Instructions shown with the onAuth callback. */
	instructions: string;
	/** Prompt message shown when asking for the key paste. */
	promptMessage: string;
	/** Placeholder string for the prompt (e.g. "sk-...", "csk-..."). */
	placeholder: string;
	/** Validation strategy, or `null` to skip validation. */
	validation: ChatCompletionsValidation | ModelsEndpointValidation | null;
};

export function createApiKeyLogin(config: ApiKeyLoginConfig): (options: OAuthController) => Promise<string> {
	return async function login(options: OAuthController): Promise<string> {
		if (!options.onPrompt) {
			throw new Error(`${config.providerLabel} login requires onPrompt callback`);
		}

		options.onAuth?.({
			url: config.authUrl,
			instructions: config.instructions,
		});

		const apiKey = await options.onPrompt({
			message: config.promptMessage,
			placeholder: config.placeholder,
		});

		if (options.signal?.aborted) {
			throw new Error("Login cancelled");
		}

		const trimmed = apiKey.trim();
		if (!trimmed) {
			throw new Error("API key is required");
		}

		if (config.validation) {
			options.onProgress?.("Validating API key...");
			if (config.validation.kind === "chat-completions") {
				await validateOpenAICompatibleApiKey({
					provider: config.validation.provider,
					apiKey: trimmed,
					baseUrl: config.validation.baseUrl,
					model: config.validation.model,
					signal: options.signal,
				});
			} else {
				await validateApiKeyAgainstModelsEndpoint({
					provider: config.validation.provider,
					apiKey: trimmed,
					modelsUrl: config.validation.modelsUrl,
					signal: options.signal,
				});
			}
		}

		return trimmed;
	};
}
