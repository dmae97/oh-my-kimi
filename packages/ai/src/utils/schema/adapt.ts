import { tryEnforceStrictSchema } from "./strict-mode";
import type { JsonObject } from "./types";
/**
 * Consolidated helper for OpenAI-style strict schema enforcement.
 *
 * Each provider computes its own `strict` boolean (logic differs), then calls
 * this to handle the tryEnforceStrictSchema dance uniformly:
 * - If `strict` is false, passes the schema through unchanged.
 * - If `strict` is true, attempts to enforce strict mode; falls back to
 *   non-strict if the schema isn't representable.
 */
export function adaptSchemaForStrict(
	schema: Record<string, unknown>,
	strict: boolean,
): { schema: Record<string, unknown>; strict: boolean } {
	if (!strict) {
		return { schema, strict: false };
	}

	return tryEnforceStrictSchema(schema);
}

/**
 * OpenAI Responses rejects `oneOf` in tool schemas even when strict mode is
 * disabled. Non-strict schemas can still use `anyOf`, so preserve the union
 * shape by recursively rewriting `oneOf` branches to `anyOf`.
 */
export function sanitizeSchemaForOpenAIResponses(schema: JsonObject): JsonObject {
	return rewriteOneOfToAnyOf(schema) as JsonObject;
}

function rewriteOneOfToAnyOf(value: unknown): unknown {
	if (Array.isArray(value)) {
		let changed = false;
		const rewritten = value.map(item => {
			const next = rewriteOneOfToAnyOf(item);
			if (next !== item) changed = true;
			return next;
		});
		return changed ? rewritten : value;
	}

	if (!value || typeof value !== "object") {
		return value;
	}

	const input = value as Record<string, unknown>;
	let changed = false;
	const output: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(input)) {
		if (key === "oneOf") {
			changed = true;
			continue;
		}
		const next = rewriteOneOfToAnyOf(child);
		if (next !== child) changed = true;
		output[key] = next;
	}

	if (Array.isArray(input.oneOf)) {
		const rewrittenOneOf = rewriteOneOfToAnyOf(input.oneOf);
		const existingAnyOf = output.anyOf;
		output.anyOf = Array.isArray(existingAnyOf)
			? [...existingAnyOf, ...(rewrittenOneOf as unknown[])]
			: rewrittenOneOf;
	}

	return changed ? output : value;
}
