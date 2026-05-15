/**
 * Hand-rolled JSON Schema meta-validator.
 *
 * Replaces a singleton `Ajv2020.validateSchema` call with a tiny structural
 * pass that covers every JSON Schema keyword the rest of the codebase
 * actually emits.  The full meta-schema is not necessary because:
 *
 *  1. Tool schemas are authored either with Zod (validated by Zod itself) or
 *     TypeBox (which already constructs structurally-correct JSON Schema).
 *  2. The transform pipeline in `normalize-cca.ts` / `compatibility.ts`
 *     mutates schemas in narrow, known ways. The meta-check just guards
 *     against gross structural breakage introduced by those transforms.
 *
 * Returns `true` if the schema is well-formed enough for downstream
 * consumers, otherwise `false`. Unknown keywords are accepted (forward
 * compatibility); known keywords are checked for their expected shape.
 */

type Json = unknown;

function isPlainObject(value: Json): value is Record<string, Json> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const TYPE_NAMES = new Set<string>(["string", "number", "integer", "boolean", "object", "array", "null"]);

/**
 * Validate a single sub-schema node.  Recurses into combinators, property
 * maps, and items lists.  Anything unrecognized is left untouched.
 */
function checkNode(node: Json, seen: WeakSet<object>): boolean {
	// Boolean schemas (`true` / `false`) are valid JSON Schema.
	if (node === true || node === false) return true;
	if (!isPlainObject(node)) return false;
	if (seen.has(node)) return true;
	seen.add(node);

	// `type` must be a known type name or a non-empty array of them.
	if ("type" in node) {
		const t = node.type;
		if (typeof t === "string") {
			if (!TYPE_NAMES.has(t)) return false;
		} else if (Array.isArray(t)) {
			if (t.length === 0) return false;
			for (const entry of t) {
				if (typeof entry !== "string" || !TYPE_NAMES.has(entry)) return false;
			}
		} else {
			return false;
		}
	}

	// Combinators must be arrays of sub-schemas.
	for (const key of ["anyOf", "oneOf", "allOf"] as const) {
		if (key in node) {
			const value = node[key];
			if (!Array.isArray(value)) return false;
			for (const branch of value) {
				if (!checkNode(branch, seen)) return false;
			}
		}
	}

	// `not` is a single sub-schema.
	if ("not" in node && !checkNode(node.not, seen)) return false;

	// `properties` / `patternProperties` are objects of sub-schemas.
	for (const key of ["properties", "patternProperties", "$defs", "definitions"] as const) {
		if (key in node) {
			const map = node[key];
			if (!isPlainObject(map)) return false;
			for (const sub of Object.values(map)) {
				if (!checkNode(sub, seen)) return false;
			}
		}
	}

	// `required` is an array of unique strings.
	if ("required" in node) {
		const value = node.required;
		if (!Array.isArray(value)) return false;
		for (const entry of value) {
			if (typeof entry !== "string") return false;
		}
	}

	// `items` may be a sub-schema (single) or an array of sub-schemas (tuple).
	if ("items" in node) {
		const items = node.items;
		if (Array.isArray(items)) {
			for (const entry of items) {
				if (!checkNode(entry, seen)) return false;
			}
		} else if (!checkNode(items, seen)) return false;
	}

	// `additionalProperties` may be boolean or sub-schema.
	if ("additionalProperties" in node) {
		const value = node.additionalProperties;
		if (typeof value !== "boolean" && !checkNode(value, seen)) return false;
	}

	// `additionalItems` follows the same rule.
	if ("additionalItems" in node) {
		const value = node.additionalItems;
		if (typeof value !== "boolean" && !checkNode(value, seen)) return false;
	}

	// `enum` must be a non-empty array.
	if ("enum" in node) {
		if (!Array.isArray(node.enum) || node.enum.length === 0) return false;
	}

	return true;
}

/**
 * Validate that `schema` is structurally a valid JSON Schema (subset). Used
 * in CCA-claude validation where the full AJV meta-check used to live.
 */
export function isValidJsonSchema(schema: unknown): boolean {
	try {
		return checkNode(schema, new WeakSet<object>());
	} catch {
		return false;
	}
}
