/**
 * Compute the wire (JSON Schema) representation of a tool's parameters and
 * convert TypeBox-style schemas into Zod for internal validation.
 *
 * Tools may author parameters in two shapes:
 *   1. Zod (canonical going forward) — converted to JSON Schema on demand.
 *   2. TypeBox / plain JSON Schema (legacy + extension compat) — used as-is.
 *
 * Both are normalized at the boundary so providers always receive JSON Schema
 * and the validator always runs against Zod.
 */

// We import the Zod *value* (z) for runtime APIs. Marker checks rely on the
// `_zod` symbol that every Zod v4 schema instance carries.
import { type ZodType, z } from "zod/v4";
import type { Tool, TSchema } from "../../types";

/** True when `value` is a Zod schema instance. */
export function isZodSchema(value: unknown): value is ZodType {
	return (
		typeof value === "object" &&
		value !== null &&
		// Zod v4 instances expose a `_zod` internal property with a `def` object.
		// Tagging on this marker keeps the check stable across Zod minor versions.
		// (`_zod` is part of Zod's documented internal contract used by introspection.)
		// We avoid checking constructor name because Zod ships multiple variants
		// (`ZodObject`, `ZodOptional`, etc.) and a tagged-union style check would
		// have to enumerate them all.
		"_zod" in value &&
		typeof (value as { _zod?: { def?: unknown } })._zod === "object"
	);
}

/** WeakMap cache: Zod schema instance -> JSON Schema object. */
const wireCache = new WeakMap<ZodType, Record<string, unknown>>();

/**
 * Post-process Zod-emitted JSON Schema so it matches the wire shape providers
 * already expect from TypeBox-authored tools:
 *
 *   - Drop the `$schema` URL (providers parse the body, not the metadata).
 *   - Make fields with a `default` non-required (TypeBox/JSON-Schema semantics
 *     treat defaulted fields as optional; Zod inverts this and keeps them
 *     required at the input boundary, then materializes the default).
 *   - Strip the noisy safe-integer bounds Zod injects for `z.number().int()`.
 */
function postProcess(schema: Record<string, unknown>): Record<string, unknown> {
	delete schema.$schema;
	walk(schema);
	return schema;
}

const SAFE_INTEGER_MAX = Number.MAX_SAFE_INTEGER;
const SAFE_INTEGER_MIN = Number.MIN_SAFE_INTEGER;

function walk(node: unknown): void {
	if (Array.isArray(node)) {
		for (const child of node) walk(child);
		return;
	}
	if (!node || typeof node !== "object") return;
	const obj = node as Record<string, unknown>;

	// Drop noise injected for `z.number().int()`.
	if (obj.type === "integer") {
		if (obj.minimum === SAFE_INTEGER_MIN) delete obj.minimum;
		if (obj.maximum === SAFE_INTEGER_MAX) delete obj.maximum;
	}

	// Make defaulted properties non-required.
	if (Array.isArray(obj.required) && obj.properties && typeof obj.properties === "object") {
		const properties = obj.properties as Record<string, unknown>;
		const required = obj.required as string[];
		const filtered = required.filter(name => {
			const propertySchema = properties[name];
			if (!propertySchema || typeof propertySchema !== "object") return true;
			return !("default" in (propertySchema as Record<string, unknown>));
		});
		if (filtered.length !== required.length) {
			if (filtered.length === 0) {
				delete obj.required;
			} else {
				obj.required = filtered;
			}
		}
	}

	for (const child of Object.values(obj)) walk(child);
}

/** Convert a Zod schema into the JSON Schema shape providers consume. */
export function zodToWireSchema(schema: ZodType): Record<string, unknown> {
	let json = wireCache.get(schema);
	if (json) return json;
	// `target: "draft-2020-12"` matches what Anthropic's `input_schema` validator
	// requires out of the box; our other provider sanitizers (OpenAI strict,
	// Google, Anthropic CCA) already handle the superset structurally.
	const raw = z.toJSONSchema(schema, { target: "draft-2020-12" }) as Record<string, unknown>;
	json = postProcess(raw);
	wireCache.set(schema, json);
	return json;
}

/**
 * Resolve a tool's parameters to a JSON Schema object suitable for sending
 * over the wire. Zod schemas are converted (and cached); legacy TypeBox / raw
 * JSON Schema parameters are returned unchanged.
 */
export function toolWireSchema(tool: Tool): Record<string, unknown> {
	const params: TSchema = tool.parameters;
	if (isZodSchema(params)) {
		return zodToWireSchema(params);
	}
	return params as unknown as Record<string, unknown>;
}
