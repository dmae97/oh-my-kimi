/**
 * Anthropic-messages compatibility detection and resolution — the
 * anthropic-side analogue of `./openai`. Detect-time defaults come from
 * provider ids, strict URL checks, and model-id classification; explicit
 * `model.compat` overrides always win.
 */
import { isAnthropicFableOrMythosModel, supportsMidConversationSystemMessages } from "../model-thinking";
import type { AnthropicCompat, Model } from "../types";

/**
 * Official first-party Anthropic API check (https + exact host). A missing
 * baseUrl is official on purpose: request dispatch falls back to
 * `https://api.anthropic.com`. Strict URL parsing (not substring) because the
 * callers gate auth flows and body mutations on it.
 */
export function isOfficialAnthropicApiUrl(baseUrl?: string): boolean {
	if (!baseUrl) return true;
	try {
		const url = new URL(baseUrl);
		return url.protocol.toLowerCase() === "https:" && url.hostname.toLowerCase() === "api.anthropic.com";
	} catch {
		return false;
	}
}

/** Z.AI's Anthropic-compatible proxy (`api.z.ai/api/anthropic`), strict-host matched. */
function isZaiAnthropicUrl(baseUrl: string | undefined): boolean {
	if (!baseUrl) return false;
	try {
		return new URL(baseUrl).hostname.toLowerCase() === "api.z.ai";
	} catch {
		return false;
	}
}

/** DeepSeek-operated host, strict-host matched (`api.deepseek.com` or any `*.deepseek.com`). */
function isDeepseekHostUrl(baseUrl: string | undefined): boolean {
	if (!baseUrl) return false;
	try {
		const hostname = new URL(baseUrl).hostname.toLowerCase();
		return hostname === "api.deepseek.com" || hostname.endsWith(".deepseek.com");
	} catch {
		return false;
	}
}

export type ResolvedAnthropicCompat = Required<AnthropicCompat>;

/**
 * Detect anthropic-messages compatibility defaults from provider/baseUrl/model id.
 * @param resolvedBaseUrl - Effective request base URL when it differs from
 *                          `model.baseUrl` (e.g. an options-level override).
 */
export function detectAnthropicCompat(
	model: Model<"anthropic-messages">,
	resolvedBaseUrl?: string,
): ResolvedAnthropicCompat {
	const baseUrl = resolvedBaseUrl ?? model.baseUrl;
	const isZai = model.provider === "zai" || isZaiAnthropicUrl(baseUrl);
	return {
		disableStrictTools: false,
		disableAdaptiveThinking: false,
		supportsEagerToolInputStreaming: true,
		supportsLongCacheRetention: true,
		// First-party Claude API only. Bedrock/Vertex/Foundry and other
		// Anthropic-compatible gateways reject mid-conversation system roles, so
		// detection requires the canonical api.anthropic.com host plus a
		// supported model id.
		supportsMidConversationSystem:
			isOfficialAnthropicApiUrl(model.baseUrl) && supportsMidConversationSystemMessages(model.id),
		supportsForcedToolChoice: !isAnthropicFableOrMythosModel(model.id),
		// Z.AI workaround (issue #814): its proxy deserializes tool_result blocks
		// into a class that reads `.id`.
		requiresToolResultId: isZai,
		// Official Anthropic enforces signature-based thinking-chain integrity, so
		// unsigned thinking blocks must stay text there. Anthropic-compatible
		// reasoning endpoints commonly emit unsigned thinking blocks while still
		// expecting them back as `type: "thinking"` on continuation; demoting them
		// loses the reasoning chain and can destabilize the next tool-call
		// arguments (#2005). Known non-signing hosts (Z.AI, DeepSeek) are also
		// preserved for compatibility.
		replayUnsignedThinking:
			isZai ||
			model.provider === "deepseek" ||
			isDeepseekHostUrl(baseUrl) ||
			(model.reasoning && !isOfficialAnthropicApiUrl(baseUrl)),
	};
}

/** Layer explicit `model.compat` overrides onto the detected anthropic defaults. */
export function resolveAnthropicCompat(
	model: Model<"anthropic-messages">,
	resolvedBaseUrl?: string,
): ResolvedAnthropicCompat {
	const detected = detectAnthropicCompat(model, resolvedBaseUrl);
	const compat = model.compat;
	if (!compat) return detected;
	return {
		disableStrictTools: compat.disableStrictTools ?? detected.disableStrictTools,
		disableAdaptiveThinking: compat.disableAdaptiveThinking ?? detected.disableAdaptiveThinking,
		supportsEagerToolInputStreaming:
			compat.supportsEagerToolInputStreaming ?? detected.supportsEagerToolInputStreaming,
		supportsLongCacheRetention: compat.supportsLongCacheRetention ?? detected.supportsLongCacheRetention,
		supportsMidConversationSystem: compat.supportsMidConversationSystem ?? detected.supportsMidConversationSystem,
		supportsForcedToolChoice: compat.supportsForcedToolChoice ?? detected.supportsForcedToolChoice,
		requiresToolResultId: compat.requiresToolResultId ?? detected.requiresToolResultId,
		replayUnsignedThinking: compat.replayUnsignedThinking ?? detected.replayUnsignedThinking,
	};
}
