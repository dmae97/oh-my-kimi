import { getDomainProfile } from "./domain-loadouts.ts";
import { GROK_OAUTH_PROVIDER } from "./grok-playbook.ts";

/** Domain loadout id applied automatically when Grok OAuth provider is active. */
export const GROK_HARNESS_DOMAIN_ID = "grok-harness";

export const GROK_HARNESS_AUTO_APPLY_ENV = "OMK_GROK_HARNESS";

export const GROK_IMAGINE_MODEL_PREFIX = "grok-imagine-";

export type GrokModelRoute = "text-chat" | "imagine-tool-only";
export type GrokHarnessIntent = "code" | "debug" | "plan" | "image" | "media";

const SKILLS_BY_INTENT = {
	code: ["packages", "programming"],
	debug: ["packages", "debugging", "programming"],
	plan: ["packages", "adaptorch-route"],
	image: ["image-prompt"],
	media: ["image-prompt", "adaptorch-route"],
} as const satisfies Record<GrokHarnessIntent, readonly string[]>;

export class GrokImagineModelCompletionError extends Error {
	readonly name = "GrokImagineModelCompletionError";
	readonly modelId: string;
	readonly provider: string;

	constructor(modelId: string, provider: string) {
		super(
			`Grok Imagine model "${modelId}" is tool-only on ${provider}; select a text-chat Grok model for completions.`,
		);
		this.modelId = modelId;
		this.provider = provider;
	}
}

export function isGrokImagineModelId(id: string): boolean {
	return id.startsWith(GROK_IMAGINE_MODEL_PREFIX);
}

export function classifyGrokModelRoute(modelId: string): GrokModelRoute {
	if (isGrokImagineModelId(modelId)) {
		return "imagine-tool-only";
	}
	return "text-chat";
}

export function assertTextChatModelForCompletion(modelId: string, provider?: string): void {
	if (provider === GROK_OAUTH_PROVIDER && isGrokImagineModelId(modelId)) {
		throw new GrokImagineModelCompletionError(modelId, provider);
	}
}

export function recommendedSkillTierForIntent(intent: GrokHarnessIntent): readonly string[] {
	return SKILLS_BY_INTENT[intent];
}

export function isGrokOAuthProvider(provider: string | undefined): boolean {
	return provider === GROK_OAUTH_PROVIDER;
}

/**
 * When true (default), selecting native `xai` applies the `grok-harness` domain loadout
 * (skills/MCP/hooks/tool gate). Set `OMK_GROK_HARNESS=0` to disable.
 */
export function grokHarnessAutoApplyEnabled(
	env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>> = process.env,
): boolean {
	const raw = env[GROK_HARNESS_AUTO_APPLY_ENV]?.trim().toLowerCase();
	if (raw === "0" || raw === "false" || raw === "off" || raw === "no") {
		return false;
	}
	return true;
}

/** Routing prompt from the grok-harness domain profile (system prompt append). */
export function getGrokHarnessRoutingPromptAppend(): string | undefined {
	const profile = getDomainProfile(GROK_HARNESS_DOMAIN_ID);
	const text = profile.routingPrompt?.trim();
	return text && text.length > 0 ? text : undefined;
}
