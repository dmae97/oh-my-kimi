import { upgradeJsonSchemaTo202012 } from "./draft";
import { tryEnforceStrictSchema } from "./strict-mode";
import type { JsonObject } from "./types";
/**
 * Consolidated helper for OpenAI-style strict schema enforcement.
 *
 * Each provider computes its own `strict` boolean (logic differs), then calls
 * this to handle the tryEnforceStrictSchema dance uniformly:
 * - Draft-07-shaped inputs are upgraded to draft 2020-12 first.
 * - If `strict` is false, passes the upgraded schema through unchanged.
 * - If `strict` is true, attempts to enforce strict mode; falls back to
 *   non-strict if the schema isn't representable.
 */
export function adaptSchemaForStrict(
	schema: Record<string, unknown>,
	strict: boolean,
): { schema: Record<string, unknown>; strict: boolean } {
	const upgraded = upgradeJsonSchemaTo202012(schema) as Record<string, unknown>;
	if (!strict) {
		return { schema: upgraded, strict: false };
	}

	return tryEnforceStrictSchema(upgraded);
}

const SCHEMA_MAP_KEYS: Record<string, true> = {
	properties: true,
	patternProperties: true,
	$defs: true,
	definitions: true,
	dependentSchemas: true,
};

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Remove the explicit JSON-Schema alias for open object maps.
 *
 * OpenAI/Google non-strict paths can stay unconstrained by omitting
 * `additionalProperties` (JSON Schema defaults it to true), while strict paths
 * must fail open before this helper runs. Schema-valued and `false`
 * declarations are meaningful and preserved.
 */
export function stripTrueAdditionalProperties(schema: Record<string, unknown>): Record<string, unknown> {
	return stripTrueAdditionalPropertiesNode(schema, new WeakMap()) as Record<string, unknown>;
}

function stripTrueAdditionalPropertiesSchemaMap(
	value: Record<string, unknown>,
	cache: WeakMap<object, unknown>,
): Record<string, unknown> {
	const cached = cache.get(value);
	if (cached !== undefined) return cached as Record<string, unknown>;

	const output: Record<string, unknown> = {};
	cache.set(value, output);
	let changed = false;
	for (const key in value) {
		const child = value[key];
		const next = stripTrueAdditionalPropertiesNode(child, cache);
		if (next !== child) changed = true;
		output[key] = next;
	}
	if (!changed) {
		cache.set(value, value);
		return value;
	}
	return output;
}

function stripTrueAdditionalPropertiesNode(value: unknown, cache: WeakMap<object, unknown>): unknown {
	if (Array.isArray(value)) {
		const cached = cache.get(value);
		if (cached !== undefined) return cached;

		const output: unknown[] = [];
		cache.set(value, output);
		let changed = false;
		for (const child of value) {
			const next = stripTrueAdditionalPropertiesNode(child, cache);
			if (next !== child) changed = true;
			output.push(next);
		}
		if (!changed) {
			cache.set(value, value);
			return value;
		}
		return output;
	}
	if (!isJsonObject(value)) return value;

	const cached = cache.get(value);
	if (cached !== undefined) return cached;

	const output: Record<string, unknown> = {};
	cache.set(value, output);
	let changed = false;
	for (const key in value) {
		const child = value[key];
		if (key === "additionalProperties" && child === true) {
			changed = true;
			continue;
		}
		const next =
			key in SCHEMA_MAP_KEYS && isJsonObject(child)
				? stripTrueAdditionalPropertiesSchemaMap(child, cache)
				: stripTrueAdditionalPropertiesNode(child, cache);
		if (next !== child) changed = true;
		output[key] = next;
	}
	if (!changed) {
		cache.set(value, value);
		return value;
	}
	return output;
}

/**
 * OpenAI Responses rejects `oneOf` in tool schemas even when strict mode is
 * disabled. Non-strict schemas can still use `anyOf`, so preserve the union
 * shape by recursively rewriting `oneOf` branches to `anyOf`.
 */
export function sanitizeSchemaForOpenAIResponses(schema: JsonObject): JsonObject {
	return rewriteOneOfToAnyOf(schema) as JsonObject;
}

/**
 * Recursively replace every `oneOf` keyword with `anyOf`. Identity-preserving:
 * returns the input reference unchanged when no rewrite occurred so callers
 * can dedupe via reference equality (and the strict-mode cache stays warm).
 * If a node has both `oneOf` and `anyOf`, the two are concatenated (the wire
 * payload accepts a single union; preserving both would not survive).
 */
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
	for (const key in input) {
		const child = input[key];
		// Skip `oneOf` here; it is re-emitted as `anyOf` after the loop so
		// neighboring `anyOf` entries can be folded in.
		if (key === "oneOf") {
			changed = true;
			continue;
		}
		const next = rewriteOneOfToAnyOf(child);
		if (next !== child) changed = true;
		output[key] = next;
	}

	// Re-emit `oneOf` content under `anyOf`, concatenating with any existing
	// `anyOf` branches in the original node.
	if (Array.isArray(input.oneOf)) {
		const rewrittenOneOf = rewriteOneOfToAnyOf(input.oneOf);
		const existingAnyOf = output.anyOf;
		output.anyOf = Array.isArray(existingAnyOf)
			? [...existingAnyOf, ...(rewrittenOneOf as unknown[])]
			: rewrittenOneOf;
	}

	return changed ? output : value;
}
