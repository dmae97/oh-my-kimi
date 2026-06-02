/**
 * Compute the wire (JSON Schema) representation of a tool's parameters and
 * convert TypeBox-style schemas into Zod for internal validation.
 *
 * Tools may author parameters in two shapes:
 *   1. Zod (canonical going forward) — converted to JSON Schema on demand.
 *   2. TypeBox / plain JSON Schema (legacy + extension compat) — upgraded to
 *      draft 2020-12 without converting through Zod.
 *
 * Both are normalized at the boundary so providers and validators see the same
 * JSON Schema dialect.
 */

// We import the Zod *value* (z) for runtime APIs. Marker checks rely on the
// `_zod` symbol that every Zod v4 schema instance carries.
import { type ZodType, z } from "zod/v4";
import type { Tool, TSchema } from "../../types";
import { upgradeJsonSchemaTo202012 } from "./draft";
import { stamp } from "./stamps";

/**
 * True when `value` is a live Zod schema instance.
 *
 * The check is stricter than "has a `_zod` property" because a JSON
 * round-trip preserves the `_zod` key as a plain object and would otherwise
 * fool the predicate — see issue #1101, where MCP servers ship
 * `JSON.stringify(zodSchemaInstance)` as a tool's `inputSchema` and the
 * resulting plain object then explodes `z.toJSONSchema` because the prototype
 * (and every Zod parsing method) is gone.
 *
 * Live Zod instances always carry a `.parse` function on the prototype;
 * impostors do not.
 */
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
		typeof (value as { _zod?: { def?: unknown } })._zod === "object" &&
		// Reject JSON-roundtripped objects that kept the `_zod` key but lost the
		// prototype. Real instances have `.parse` on the prototype chain.
		typeof (value as { parse?: unknown }).parse === "function"
	);
}

/** Symbol-stamped caches keyed by schema object identity. */
const kZodWireSchema = Symbol("pi.schema.zod.wire");
const kJsonWireSchema = Symbol("pi.schema.json.wire");

/**
 * Post-process Zod-emitted JSON Schema so it matches the wire shape providers
 * already expect from TypeBox-authored tools:
 *
 *   - Drop the `$schema` URL (providers parse the body, not the metadata).
 *   - Make fields with a `default` non-required (TypeBox/JSON-Schema semantics
 *     treat defaulted fields as optional; Zod inverts this and keeps them
 *     required at the input boundary, then materializes the default).
 *   - Strip the noisy safe-integer bounds Zod injects for `z.number().int()`.
 *
 * The empty-schema normalization (`{}` → `true`, see `normalizeEmptySchemas`)
 * runs separately from `toolWireSchema` so both Zod and TypeBox tools get it.
 */
function postProcess(schema: Record<string, unknown>): Record<string, unknown> {
	delete schema.$schema;
	walk(schema, true);
	normalizeEmptySchemas(schema);
	return schema;
}

function postProcessJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
	walk(schema, false);
	normalizeEmptySchemas(schema);
	return schema;
}

const SAFE_INTEGER_MAX = Number.MAX_SAFE_INTEGER;
const SAFE_INTEGER_MIN = Number.MIN_SAFE_INTEGER;
const NULLABLE_SCALAR_TYPES = new Set(["string", "number", "integer", "boolean"]);

const SCHEMA_DEFINING_SIBLING_KEYS = new Set([
	"$ref",
	"additionalProperties",
	"allOf",
	"anyOf",
	"const",
	"contains",
	"enum",
	"if",
	"items",
	"not",
	"oneOf",
	"patternProperties",
	"prefixItems",
	"properties",
	"propertyNames",
	"then",
	"else",
	"unevaluatedItems",
	"unevaluatedProperties",
]);

function isSchemaRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasSchemaDefiningSibling(schema: Record<string, unknown>): boolean {
	for (const key in schema) {
		if (key !== "anyOf" && SCHEMA_DEFINING_SIBLING_KEYS.has(key)) return true;
	}
	return false;
}

function isNullVariant(schema: Record<string, unknown>): boolean {
	return schema.type === "null" && Object.keys(schema).length === 1;
}

function isScalarVariant(schema: Record<string, unknown>): schema is Record<string, unknown> & { type: string } {
	return typeof schema.type === "string" && NULLABLE_SCALAR_TYPES.has(schema.type);
}

function hasIntegerType(type: unknown): boolean {
	return type === "integer" || (Array.isArray(type) && type.includes("integer"));
}

function rewriteNullableScalarAnyOf(schema: Record<string, unknown>): void {
	if (hasSchemaDefiningSibling(schema)) return;
	const variants = schema.anyOf;
	if (!Array.isArray(variants) || variants.length !== 2) return;

	let scalarVariant: Record<string, unknown> | undefined;
	let scalarType: string | undefined;
	let sawNull = false;
	for (const variant of variants) {
		if (!isSchemaRecord(variant)) return;
		if (isNullVariant(variant)) {
			if (sawNull) return;
			sawNull = true;
			continue;
		}
		if (!isScalarVariant(variant) || scalarVariant) return;
		scalarVariant = variant;
		scalarType = variant.type;
	}
	if (!sawNull || !scalarVariant || !scalarType) return;

	delete schema.anyOf;
	for (const key in scalarVariant) {
		if (key !== "type" && !Object.hasOwn(schema, key)) schema[key] = scalarVariant[key];
	}
	schema.type = [scalarType, "null"];
}

/** Keys whose values are a single JSON Schema (not an array or map). */
const SCHEMA_VALUE_KEYS = [
	"additionalProperties",
	"unevaluatedProperties",
	"unevaluatedItems",
	"items",
	"contains",
	"propertyNames",
	"if",
	"then",
	"else",
	"not",
] as const;

/** Keys whose values are a map of `{ key: Schema }` entries. */
const SCHEMA_MAP_KEYS = ["properties", "patternProperties", "$defs", "definitions"] as const;

/** Keys whose values are an array of schemas. */
const SCHEMA_ARRAY_KEYS = ["anyOf", "oneOf", "allOf", "prefixItems"] as const;

/** True when `val` is a plain empty object `{}`. */
function isEmptyObject(val: unknown): val is Record<string, never> {
	if (val === null || typeof val !== "object" || Array.isArray(val)) return false;
	return Object.keys(val).length === 0;
}

function walk(node: unknown, zodCleanup: boolean): void {
	if (Array.isArray(node)) {
		for (const child of node) walk(child, zodCleanup);
		return;
	}
	if (!node || typeof node !== "object") return;
	const obj = node as Record<string, unknown>;
	rewriteNullableScalarAnyOf(obj);

	if (zodCleanup) {
		// Drop noise injected for `z.number().int()`.
		if (hasIntegerType(obj.type)) {
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
	}

	for (const k in obj) walk(obj[k], zodCleanup);
}

/**
 * Normalize `{}` (empty JSON Schema = `z.unknown()` / unconstrained value) to
 * boolean `true` in every schema-valued position. JSON Schema draft 2020-12
 * §4.3.1: `{}` and `true` are semantically equivalent ("any JSON value").
 * Grammar-constrained samplers (llama.cpp, etc.) treat the object form as
 * "generate an empty object" rather than "any JSON value", causing open-typed
 * fields like `extra.title` (from `z.record(z.string(), z.unknown())`) to
 * always emit `{}` instead of the intended string/number/etc. (issue #1179).
 *
 * Mutates in place. Provider-agnostic — applied to every tool wire schema so
 * Anthropic, Google, OpenAI, Ollama, Bedrock, and Cursor all see the
 * normalized form, regardless of whether the source was Zod or TypeBox.
 */
export function normalizeEmptySchemas(node: unknown): void {
	if (Array.isArray(node)) {
		for (const child of node) normalizeEmptySchemas(child);
		return;
	}
	if (!node || typeof node !== "object") return;
	const obj = node as Record<string, unknown>;

	for (const key of SCHEMA_VALUE_KEYS) {
		if (Object.hasOwn(obj, key) && isEmptyObject(obj[key])) obj[key] = true;
	}
	for (const mapKey of SCHEMA_MAP_KEYS) {
		const map = obj[mapKey];
		if (map !== null && typeof map === "object" && !Array.isArray(map)) {
			for (const k in map as Record<string, unknown>) {
				if (isEmptyObject((map as Record<string, unknown>)[k])) (map as Record<string, unknown>)[k] = true;
			}
		}
	}
	for (const arrKey of SCHEMA_ARRAY_KEYS) {
		const arr = obj[arrKey];
		if (Array.isArray(arr)) {
			for (let i = 0; i < arr.length; i++) {
				if (isEmptyObject(arr[i])) arr[i] = true;
			}
		}
	}

	for (const k in obj) normalizeEmptySchemas(obj[k]);
}

/** Convert a Zod schema into the JSON Schema shape providers consume. */
export function zodToWireSchema(schema: ZodType): Record<string, unknown> {
	return stamp(schema, kZodWireSchema, s => {
		// `target: "draft-2020-12"` matches what Anthropic's `input_schema` validator
		// requires out of the box; our other provider sanitizers (OpenAI strict,
		// Google, Anthropic CCA) already handle the superset structurally.
		const raw = z.toJSONSchema(s, { target: "draft-2020-12" }) as Record<string, unknown>;
		return postProcess(raw);
	});
}

/**
 * Resolve a tool's parameters to a JSON Schema object suitable for sending
 * over the wire. Zod schemas are converted (and cached); legacy TypeBox / raw
 * JSON Schema parameters are upgraded to draft 2020-12 (and cached).
 *
 * Zod schemas also receive Zod-artifact cleanup; both branches normalize
 * schema-valued positions and nullable scalar unions.
 */
export function toolWireSchema(tool: Tool): Record<string, unknown> {
	const params: TSchema = tool.parameters;
	if (isZodSchema(params)) return zodToWireSchema(params);
	return stamp(params as Record<string, unknown>, kJsonWireSchema, p => {
		const upgraded = upgradeJsonSchemaTo202012(p) as Record<string, unknown>;
		return postProcessJsonSchema(upgraded);
	});
}
