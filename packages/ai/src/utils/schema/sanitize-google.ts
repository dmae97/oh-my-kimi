/**
 * Provider-specific JSON Schema sanitizers used in the request path.
 *
 * Google's Schema proto, Cloud Code Assist's Claude bridge, and MCP/AJV
 * validation all reject different subsets of standard JSON Schema. Rather
 * than ship three near-identical walkers, this module exposes a shared
 * `sanitizeSchemaImpl` parameterised by an options bag, plus three thin
 * wrappers that fix the option set for each target.
 */
import { dereferenceJsonSchema } from "./dereference";
import { upgradeJsonSchemaTo202012 } from "./draft";
import { areJsonValuesEqual } from "./equality";
import { UNSUPPORTED_SCHEMA_FIELDS } from "./fields";
import { epochNext, once } from "./stamps";

/**
 * Options that pin the behavior of `sanitizeSchemaImpl`.
 *
 * - `insideProperties`: true when we are walking the children of a `properties`
 *   object. Keys at that level are property *names*, not JSON-Schema keywords —
 *   so the "strip unsupported keyword" rule must not apply.
 * - `normalizeTypeArrayToNullable`: convert `type: ["string","null"]` to
 *   `type: "string"` + `nullable: true`. Required for Google's proto; left off
 *   for MCP which keeps standard JSON Schema shapes.
 * - `stripNullableKeyword`: remove `nullable` entirely. CCA forbids the
 *   keyword; Google keeps it.
 * - `unsupportedFields`: provider-specific keyword blacklist.
 * - `epoch`: shared cycle guard (see `stamps.ts`).
 */
interface SanitizeSchemaOptions {
	insideProperties: boolean;
	normalizeTypeArrayToNullable: boolean;
	stripNullableKeyword: boolean;
	unsupportedFields: Record<string, true>;
	epoch: number;
	/**
	 * Apply snake_case → camelCase field renames at every node. Mirrors
	 * python-genai/_transformers.py:745-752. Safe to enable for any provider
	 * that consumes camelCase JSON Schema.
	 */
	normalizeFieldNames: boolean;
	/**
	 * Apply `handle_null_fields` (python-genai/_transformers.py:584-640):
	 * `{type:'null'}` → `{nullable:true}` and collapse `anyOf` null variants
	 * into a nullable parent (flattening single-survivor unions). Google-only.
	 * The CCA pipeline relies on the un-collapsed `anyOf` / `type:null` shape
	 * surviving sanitize so it can make its own required/optional decisions.
	 */
	collapseNullFields: boolean;
	/**
	 * Auto-populate `propertyOrdering` on multi-property objects. Mirrors
	 * python-genai/_transformers.py:817-822 (Gemini structured-output ordering).
	 */
	autoPropertyOrdering: boolean;
}

/**
 * Spelling normalization applied at the top of every schema node before any
 * other processing. Mirrors python-genai/_transformers.py:745-752 — accepts
 * snake_case spellings that pydantic / hand-written dicts may use and rewrites
 * them to the canonical camelCase form. Insertion order is preserved.
 */
const SNAKE_TO_CAMEL_RENAMES: Record<string, string> = {
	additional_properties: "additionalProperties",
	any_of: "anyOf",
	prefix_items: "prefixItems",
	property_ordering: "propertyOrdering",
};

/**
 * Returns `obj` unchanged when no renamable key is present; otherwise returns
 * a fresh shallow-copy with snake_case keys rewritten. The collision rule
 * matches upstream (`pop(from)` → `set(to)`): snake_case wins over an
 * existing camelCase entry, matching python-genai/_transformers.py:751.
 */
function applySnakeCaseRenames(obj: Record<string, unknown>): Record<string, unknown> {
	let needsRename = false;
	for (const k in SNAKE_TO_CAMEL_RENAMES) {
		if (Object.hasOwn(obj, k)) {
			needsRename = true;
			break;
		}
	}
	if (!needsRename) return obj;
	const out: Record<string, unknown> = {};
	for (const k in obj) {
		const renamed = SNAKE_TO_CAMEL_RENAMES[k];
		if (renamed !== undefined && Object.hasOwn(obj, k)) {
			out[renamed] = obj[k];
		} else if (!(k in SNAKE_TO_CAMEL_RENAMES) && !Object.hasOwn(out, k)) {
			out[k] = obj[k];
		}
	}
	// Copy non-renamed keys that the loop skipped because of the rename guard.
	for (const k in obj) {
		if (k in SNAKE_TO_CAMEL_RENAMES) continue;
		if (!Object.hasOwn(out, k)) out[k] = obj[k];
	}
	return out;
}

/**
 * `handle_null_fields` (python-genai/_transformers.py:584-640) applied at the
 * parent level BEFORE child recursion — matches upstream's call order at
 * `process_schema` line 768. Returns a new object when changes apply, the
 * original reference otherwise (zero-allocation fast path).
 *
 * Rules:
 * - `{type:'null'}` → `{nullable:true}` (drop type, preserve siblings).
 * - `anyOf` containing any `{type:'null'}` variant → set `nullable:true` on
 *   parent and drop those variants. If a single non-null variant remains,
 *   flatten its keys into the parent and drop `anyOf` (upstream lines 636-640).
 */
function preHandleNullFields(obj: Record<string, unknown>): Record<string, unknown> {
	if (obj.type === "null") {
		const out: Record<string, unknown> = {};
		for (const k in obj) {
			if (Object.hasOwn(obj, k) && k !== "type") out[k] = obj[k];
		}
		out.nullable = true;
		return out;
	}
	if (!Array.isArray(obj.anyOf)) return obj;
	const variants = obj.anyOf as unknown[];
	let sawNull = false;
	const kept: unknown[] = [];
	for (const v of variants) {
		if (v && typeof v === "object" && !Array.isArray(v) && (v as Record<string, unknown>).type === "null") {
			sawNull = true;
			continue;
		}
		kept.push(v);
	}
	if (!sawNull) return obj;
	const out: Record<string, unknown> = {};
	for (const k in obj) {
		if (Object.hasOwn(obj, k)) out[k] = obj[k];
	}
	out.nullable = true;
	if (kept.length === 0) {
		delete out.anyOf;
	} else if (kept.length === 1) {
		delete out.anyOf;
		const only = kept[0] as Record<string, unknown>;
		for (const k in only) {
			if (Object.hasOwn(only, k) && !(k in out)) out[k] = only[k];
		}
	} else {
		out.anyOf = kept;
	}
	return out;
}

function inferJsonSchemaTypeFromValue(value: unknown): string | undefined {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	switch (typeof value) {
		case "string":
			return "string";
		case "number":
			return "number";
		case "boolean":
			return "boolean";
		case "object":
			return "object";
		default:
			return undefined;
	}
}

function pushEnumValue(values: unknown[], value: unknown): void {
	if (!values.some(existing => areJsonValuesEqual(existing, value))) {
		values.push(value);
	}
}

/**
 * Generic sanitizer core. Two phases:
 *   1. If a combiner (`anyOf`/`oneOf`) holds variants that are all `const`
 *      values, collapse it into an `enum`. Google/CCA do not accept
 *      `const`-in-combinator unions but do accept enums.
 *   2. Otherwise, walk the schema, stripping disallowed keywords and
 *      recursing into children. Standalone `const` values are converted to
 *      single-entry `enum` arrays.
 * Cycle-safe via `once(epoch)`; cycles short-circuit to `{}`/`[]`.
 */
function sanitizeSchemaImpl(value: unknown, options: SanitizeSchemaOptions): unknown {
	if (Array.isArray(value)) {
		if (!once(value, options.epoch)) return [];
		return value.map(entry => sanitizeSchemaImpl(entry, options));
	}
	if (!value || typeof value !== "object") {
		return value;
	}
	if (!once(value as object, options.epoch)) return {};
	let obj =
		options.normalizeFieldNames && !options.insideProperties
			? applySnakeCaseRenames(value as Record<string, unknown>)
			: (value as Record<string, unknown>);
	if (options.collapseNullFields && !options.insideProperties) {
		obj = preHandleNullFields(obj);
	}
	const result: Record<string, unknown> = {};
	for (const combiner of ["anyOf", "oneOf"] as const) {
		if (Array.isArray(obj[combiner])) {
			const variants = obj[combiner] as Record<string, unknown>[];
			const allHaveConst = variants.every(v => v && typeof v === "object" && "const" in v);
			if (allHaveConst && variants.length > 0) {
				// Step 1a: collect deduped enum values from every variant's const.
				const dedupedEnum: unknown[] = [];
				for (const variant of variants) {
					pushEnumValue(dedupedEnum, variant.const);
				}
				result.enum = dedupedEnum;

				const explicitTypes = variants
					.map(variant => variant.type)
					.filter((variantType): variantType is string => typeof variantType === "string");
				const allHaveSameExplicitType =
					explicitTypes.length === variants.length &&
					explicitTypes.every(variantType => variantType === explicitTypes[0]);
				// Step 1b: pick a `type` for the synthesized enum. Prefer an explicit
				// type declared on every variant; otherwise infer from the values
				// themselves. Mixed types stay un-typed (Google accepts a bare enum).
				if (allHaveSameExplicitType && explicitTypes[0]) {
					result.type = explicitTypes[0];
				} else {
					const inferredTypes = dedupedEnum
						.map(enumValue => inferJsonSchemaTypeFromValue(enumValue))
						.filter((inferredType): inferredType is string => inferredType !== undefined);
					const inferredTypeSet = new Set(inferredTypes);
					if (inferredTypeSet.size === 1) {
						result.type = inferredTypes[0];
					} else {
						const nonNullInferredTypes = inferredTypes.filter(inferredType => inferredType !== "null");
						const nonNullTypeSet = new Set(nonNullInferredTypes);
						// nullable + single non-null type: collapse to scalar + nullable marker.
						if (inferredTypes.includes("null") && nonNullTypeSet.size === 1) {
							result.type = nonNullInferredTypes[0];
							if (!options.stripNullableKeyword) {
								result.nullable = true;
							}
						}
					}
				}

				// Step 1c: pull non-combiner siblings (description, etc.) through.
				// Copy description and other top-level fields (not the combiner)
				for (const key in obj) {
					const entry = obj[key];
					if (key !== combiner && !(key in result)) {
						result[key] = sanitizeSchemaImpl(entry, {
							...options,
							insideProperties: key === "properties",
						});
					}
				}
				return result;
			}
		}
	}
	// Phase 2: not a const-combiner — process keys one by one.
	let constValue: unknown;
	for (const key in obj) {
		const entry = obj[key];
		// Only strip unsupported schema keywords when NOT inside "properties" object
		// Inside "properties", keys are property names (e.g., "pattern") not schema keywords
		if (!options.insideProperties && key in options.unsupportedFields) continue;
		if (options.stripNullableKeyword && key === "nullable") continue;
		if (key === "const") {
			// `const` is converted to a single-entry `enum` after the loop so the
			// `type` inference can use it.
			constValue = entry;
			continue;
		}
		// When key is "properties", child keys are property names, not schema keywords
		result[key] = sanitizeSchemaImpl(entry, {
			...options,
			insideProperties: key === "properties",
		});
	}
	// Normalize array-valued "type" (e.g. ["string", "null"]) to a single type + nullable.
	// Google's Schema proto expects type to be a single enum string, not an array.
	if (options.normalizeTypeArrayToNullable && Array.isArray(result.type)) {
		const types = (result.type as unknown[]).filter((t): t is string => typeof t === "string");
		const nonNull = types.filter(t => t !== "null");
		if (types.includes("null") && !options.stripNullableKeyword) {
			result.nullable = true;
		}
		result.type = nonNull[0] ?? types[0];
	}
	if (constValue !== undefined) {
		// Convert const to enum, merging with existing enum if present
		const existingEnum = Array.isArray(result.enum) ? result.enum : [];
		pushEnumValue(existingEnum, constValue);
		result.enum = existingEnum;
		if (!result.type) {
			result.type = inferJsonSchemaTypeFromValue(constValue);
		}
	}

	// Defensive post-pass: covers cases where `type` became `'null'` AFTER
	// child processing (e.g. `type: ['null']` collapsed via normalizeTypeArrayToNullable).
	// Mirrors python-genai/_transformers.py:628-630.
	if (options.collapseNullFields && result.type === "null") {
		delete result.type;
		if (!options.stripNullableKeyword) result.nullable = true;
	}

	// Auto-populate `propertyOrdering` for objects with >1 property. Mirrors
	// python-genai/_transformers.py:817-822. Insertion order of `properties`
	// determines the emitted ordering, matching JS object-key iteration order.
	if (
		options.autoPropertyOrdering &&
		result.type === "object" &&
		!Object.hasOwn(result, "propertyOrdering") &&
		result.properties &&
		typeof result.properties === "object" &&
		!Array.isArray(result.properties)
	) {
		const props = result.properties as Record<string, unknown>;
		const keys: string[] = [];
		for (const k in props) {
			if (Object.hasOwn(props, k)) keys.push(k);
		}
		if (keys.length > 1) result.propertyOrdering = keys;
	}

	// Ensure object schemas have a properties field (some LLM providers require it)
	if (result.type === "object" && !("properties" in result)) {
		result.properties = {};
	}

	return result;
}

/**
 * Sanitize a JSON Schema for Google's generative AI APIs by stripping unsupported
 * JSON Schema keywords and normalizing representable nullable/type patterns.
 *
 * Draft-07-shaped schemas are upgraded to 2020-12 before provider-specific
 * unsupported keywords are stripped. `$ref` is still stripped as unsupported;
 * callers that need references preserved must dereference before this path.
 */
export function sanitizeSchemaForGoogle(value: unknown): unknown {
	const upgraded = upgradeJsonSchemaTo202012(value);
	// Mirror python-genai/_transformers.py:754-766: inline `$defs` so the
	// downstream walk sees the resolved schema instead of dropping `$ref`.
	const dereferenced = dereferenceJsonSchema(upgraded);
	return sanitizeSchemaImpl(dereferenced, {
		insideProperties: false,
		normalizeTypeArrayToNullable: true,
		stripNullableKeyword: false,
		unsupportedFields: UNSUPPORTED_SCHEMA_FIELDS,
		epoch: epochNext(),
		normalizeFieldNames: true,
		collapseNullFields: true,
		autoPropertyOrdering: true,
	});
}

/**
 * Sanitize a JSON Schema for Cloud Code Assist Claude.
 * Starts from Google sanitizer behavior, then strips `nullable` markers.
 *
 * Draft-07-shaped schemas are upgraded to 2020-12 before provider-specific
 * unsupported keywords are stripped. `$ref` is still stripped as unsupported;
 * callers that need references preserved must dereference before this path.
 */
export function sanitizeSchemaForCCA(value: unknown): unknown {
	const upgraded = upgradeJsonSchemaTo202012(value);
	const dereferenced = dereferenceJsonSchema(upgraded);
	return sanitizeSchemaImpl(dereferenced, {
		insideProperties: false,
		normalizeTypeArrayToNullable: true,
		stripNullableKeyword: true,
		unsupportedFields: UNSUPPORTED_SCHEMA_FIELDS,
		epoch: epochNext(),
		normalizeFieldNames: true,
		// Leave null-field collapse to the CCA-specific pipeline downstream,
		// which needs the un-collapsed `anyOf` / `type:null` shape to make
		// per-property required/optional decisions.
		collapseNullFields: false,
		// CCA pipeline assembles its own ordering separately; leave off here.
		autoPropertyOrdering: false,
	});
}

/**
 * Fields stripped for MCP/AJV compatibility.
 * Only `$schema` — AJV throws on unrecognised meta-schema URIs
 * (e.g. draft 2020-12 emitted by schemars 1.x / rmcp 0.15+).
 */
const MCP_UNSUPPORTED_SCHEMA_FIELDS: Record<string, true> = { $schema: true };

/**
 * Sanitize a JSON Schema for MCP tool parameter validation (AJV compatibility).
 *
 * Strips only the minimal set of fields that cause AJV validation errors:
 * - `$schema`: AJV throws on unknown meta-schema URIs.
 * - `nullable`: OpenAPI 3.0 extension, not standard JSON Schema.
 *
 * Unlike the Google/CCA sanitizers this preserves validation keywords
 * (`pattern`, `format`, `additionalProperties`, etc.) and `$ref`/`$defs`.
 */
export function sanitizeSchemaForMCP(value: unknown): unknown {
	// Upgrade before dereferencing so legacy `definitions` refs become the
	// canonical `$defs` form, then inline refs for providers that drop `$defs`.
	const upgraded = upgradeJsonSchemaTo202012(value);
	const dereferenced = dereferenceJsonSchema(upgraded);
	return sanitizeSchemaImpl(dereferenced, {
		insideProperties: false,
		normalizeTypeArrayToNullable: false,
		stripNullableKeyword: true,
		unsupportedFields: MCP_UNSUPPORTED_SCHEMA_FIELDS,
		epoch: epochNext(),
		normalizeFieldNames: false,
		collapseNullFields: false,
		autoPropertyOrdering: false,
	});
}
