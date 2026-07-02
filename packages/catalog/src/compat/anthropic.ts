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

/** Mirrors `compat/openai.ts`; native-only host gating is the caller's responsibility. */
const KIMI_K27_CODE_MODEL_PATTERN = /(?:^|\/)kimi[-._]?k2(?:[._-]?|p)7[-._]?code(?:[-._]?highspeed)?$/i;

function matchesKimiK27CodeFamily(spec: ModelSpec<"anthropic-messages">): boolean {
	if (KIMI_K27_CODE_MODEL_PATTERN.test(spec.id)) return true;
	return spec.id === "kimi-for-coding" && /k2\.?7 code/i.test(spec.name ?? "");
}

/** Build the resolved anthropic-messages compat record for a model spec. */
export function buildAnthropicCompat(spec: ModelSpec<"anthropic-messages">): ResolvedAnthropicCompat {
	const baseUrl = spec.baseUrl;
	const official = isOfficialAnthropicApiUrl(baseUrl);
	// Z.AI's Anthropic-compatible proxy lives at `api.z.ai/api/anthropic`.
	const isZai = modelMatchesHost(spec, "zai");
	// GitHub Copilot's `anthropic-messages` proxy (api.githubcopilot.com/v1/messages)
	// rejects the per-tool `eager_input_streaming` field with
	// `tools.0.custom.eager_input_streaming: Extra inputs are not permitted` and
	// doesn't whitelist the `fine-grained-tool-streaming-2025-05-14` beta either
	// (issue #2558), so eager tool-input streaming is unavailable on this host.
	const isCopilot = modelMatchesHost(spec, "githubCopilot");
	// ZenMux's `anthropic-messages` route (zenmux.ai/api/anthropic) forwards to
	// signature-enforcing Anthropic — same failure class as GitHub Copilot #2851
	// (issue #4192).
	const isZenmux = modelMatchesHost(spec, "zenmux");
	const requiresThinkingEnabled = modelMatchesHost(spec, "moonshotNative") && matchesKimiK27CodeFamily(spec);
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
		supportsForcedToolChoice: !requiresThinkingEnabled && !isAnthropicFableOrMythosModel(spec.id),
		// Opus 4.7+ and Fable/Mythos reject temperature/top_p/top_k with a 400.
		supportsSamplingParams: !hasOpus47ApiRestrictions(spec.id),
		// Z.AI workaround (issue #814): its proxy deserializes tool_result blocks
		// into a class that reads `.id`.
		requiresToolResultId: isZai,
		requiresThinkingEnabled,
		// Official Anthropic enforces signature-based thinking-chain integrity, so
		// unsigned thinking blocks must stay text there. Anthropic-compatible
		// reasoning endpoints commonly emit unsigned thinking blocks while still
		// expecting them back as `type: "thinking"` on continuation; demoting them
		// loses the reasoning chain and can destabilize the next tool-call
		// arguments (#2005). Known non-signing hosts (Z.AI, DeepSeek) are also
		// preserved for compatibility.
		//
		// GitHub Copilot's `anthropic-messages` proxy and ZenMux's Anthropic route
		// are excluded: both forward to signature-enforcing Anthropic and return
		// full thinking signatures, so they are SIGNING endpoints. Replaying a
		// stripped/unsigned thinking block as `signature: ""` there 400s the whole
		// request ("Invalid signature") — most visibly when a checkpoint/branch-
		// return turn's end_turn-bound signature is stripped on replay (issues
		// #2851, #4192). Treating them like official Anthropic degrades such
		// blocks to text instead, which the API accepts.
		replayUnsignedThinking:
			!isCopilot &&
			!isZenmux &&
			(isZai || modelMatchesHost(spec, "deepseekFamily") || (spec.reasoning && !official)),
		escapeBuiltinToolNames: modelMatchesHost(spec, "umans"),
	};
	applyCompatOverrides(compat, spec.compat);
	return compat;
}
