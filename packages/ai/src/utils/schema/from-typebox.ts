/**
 * Convert a plain JSON Schema object (OpenAPI / draft-07 style) into a Zod schema.
 *
 * Internal validation runs against Zod; parameters may be authored as Zod directly
 * or supplied as JSON Schema (legacy extension payloads). This helper turns JSON
 * Schema into Zod once at validation boundary and caches by object identity.
 *
 * Delegates to `z.fromJSONSchema` — no dedicated TypeBox dependency at runtime.
 */

import { type ZodType, z } from "zod/v4";

/** WeakMap cache so repeated registrations of the same JSON Schema object reuse the Zod result. */
const cache = new WeakMap<object, ZodType>();

/**
 * Convert JSON Schema (plain object) to a Zod schema. Returns a cached
 * value when called repeatedly with the same source object.
 */
export function fromTypeBox(schema: Record<string, unknown> | unknown): ZodType {
	if (typeof schema === "object" && schema !== null) {
		const cached = cache.get(schema as object);
		if (cached) return cached;
		// Pass the schema through Zod's JSON Schema importer. We pass through
		// any non-standard keys; Zod silently ignores unknown keywords.
		const zodSchema = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]) as ZodType;
		cache.set(schema as object, zodSchema);
		return zodSchema;
	}
	// Defensive fallback — the validator only ever calls this with object
	// schemas, but if someone hands us a scalar we return an `unknown` Zod
	// schema so callers don't crash mid-pipeline.
	return z.unknown() as unknown as ZodType;
}
