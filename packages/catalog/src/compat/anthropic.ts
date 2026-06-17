/**
 * Anthropic-messages compat builder — the anthropic-side analogue of
 * `./openai`. Runs exactly once per model (from `buildModel`); detect-time
 * defaults come from provider ids, strict host checks, and model-id
 * classification, with explicit spec overrides assigned on top.
 */
import { modelMatchesHost } from "../hosts";
import {
	hasOpus47ApiRestrictions,
	isAnthropicFableOrMythosModel,
	supportsMidConversationSystemMessages,
} from "../identity/family";
import type { ModelSpec, ResolvedAnthropicCompat } from "../types";
import { applyCompatOverrides } from "./apply";

const OFFICIAL_ANTHROPIC_URL = "https://api.anthropic.com";

/**
 * Official first-party Anthropic API. A missing baseUrl is official on purpose:
 * request dispatch falls back to `https://api.anthropic.com`. This is the one
 * auth-sensitive host check — OAuth credentials are attached based on it — so
 * it requires the exact origin or a path boundary (`/`) after it; a bare
 * prefix check would accept lookalikes like `https://api.anthropic.com.evil.com`.
 */
export function isOfficialAnthropicApiUrl(baseUrl?: string): boolean {
	if (!baseUrl) return true;
	const lower = baseUrl.toLowerCase();
	return lower === OFFICIAL_ANTHROPIC_URL || lower.startsWith(`${OFFICIAL_ANTHROPIC_URL}/`);
}

/** Build the resolved anthropic-messages compat record for a model spec. */
export function buildAnthropicCompat(spec: ModelSpec<"anthropic-messages">): ResolvedAnthropicCompat {
	const baseUrl = spec.baseUrl;
	const official = isOfficialAnthropicApiUrl(baseUrl);
	// Z.AI's Anthropic-compatible proxy lives at `api.z.ai/api/anthropic`.
	const isZai = modelMatchesHost(spec, "zai");
	// GitHub Copilot's Anthropic-compatible proxy (api.githubcopilot.com/v1/messages)
	// rejects the per-tool `eager_input_streaming` field with
	// `tools.0.custom.eager_input_streaming: Extra inputs are not permitted` and
	// doesn't whitelist the `fine-grained-tool-streaming-2025-05-14` beta either
	// (issue #2558), so eager tool-input streaming is unavailable on this host.
	const isCopilot = modelMatchesHost(spec, "githubCopilot");
	const compat: ResolvedAnthropicCompat = {
		officialEndpoint: official,
		disableStrictTools: false,
		disableAdaptiveThinking: false,
		supportsEagerToolInputStreaming: !isCopilot,
		// Long cache retention is only sent to the official API by default;
		// proxies opt in explicitly via `compat.supportsLongCacheRetention: true`.
		supportsLongCacheRetention: official,
		// First-party Claude API only. Bedrock/Vertex/Foundry and other
		// Anthropic-compatible gateways reject mid-conversation system roles, so
		// detection requires the canonical api.anthropic.com host plus a
		// supported model id.
		supportsMidConversationSystem: official && supportsMidConversationSystemMessages(spec.id),
		supportsForcedToolChoice: !isAnthropicFableOrMythosModel(spec.id),
		// Opus 4.7+ and Fable/Mythos reject temperature/top_p/top_k with a 400.
		supportsSamplingParams: !hasOpus47ApiRestrictions(spec.id),
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
		replayUnsignedThinking: isZai || modelMatchesHost(spec, "deepseekFamily") || (spec.reasoning && !official),
		escapeBuiltinToolNames: modelMatchesHost(spec, "umans"),
	};
	applyCompatOverrides(compat, spec.compat);
	return compat;
}
