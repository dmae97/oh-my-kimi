import type { Context } from "../types.ts";
import { shortHash } from "../utils/hash.ts";
import { canonicalJsonStringify, stableTools } from "./tool-schema.ts";

/** Return a valid UTF-16 cache boundary or undefined when the full prompt is dynamic. */
export function resolveSystemPromptCacheBoundary(context: Context): number | undefined {
	if (context.systemPromptCacheBoundaryBypass) return undefined;
	const prompt = context.systemPrompt;
	const boundary = context.systemPromptCacheBoundary;
	if (
		!prompt ||
		!Number.isSafeInteger(boundary) ||
		boundary === undefined ||
		boundary <= 0 ||
		boundary > prompt.length
	) {
		return undefined;
	}
	return boundary;
}

/**
 * Derive a low-cardinality cache-affinity key from the stable prompt prefix and
 * canonical tool schemas. Dynamic prompt suffixes and session ids are excluded
 * so equivalent sessions can share provider-side prefix caches.
 */
export function deriveContextPromptCacheKey(context: Context, scope: string): string | undefined {
	const boundary = resolveSystemPromptCacheBoundary(context);
	if (boundary === undefined || !context.systemPrompt) return undefined;

	const tools = stableTools(context.tools ?? []).map((tool) => ({
		description: tool.description,
		name: tool.name,
		parameters: tool.parameters,
	}));
	const fingerprint = canonicalJsonStringify({
		prefix: context.systemPrompt.slice(0, boundary),
		scope,
		tools,
		version: 1,
	});
	return `omk-${shortHash(fingerprint)}`;
}
