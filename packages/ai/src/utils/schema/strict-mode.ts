import { $flag } from "@oh-my-pi/pi-utils";
import { type ZodType, z } from "zod/v4";
import { upgradeJsonSchemaTo202012 } from "./draft";
import { areJsonValuesEqual } from "./equality";
import { COMBINATOR_KEYS, NON_STRUCTURAL_SCHEMA_KEYS } from "./fields";
import { enter, epochNext, exit, once, stamp } from "./stamps";
import { isJsonObject } from "./types";

/**
 * Creates a string enum schema compatible with Google's API and other providers
 * that don't support anyOf/const patterns.
 *
 * @example
 * const OperationSchema = StringEnum(["add", "subtract", "multiply", "divide"], {
 *   description: "The operation to perform"
 * });
 *
 * type Operation = z.infer<typeof OperationSchema>; // "add" | "subtract" | ...
 */
export function StringEnum<const T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number]; examples?: readonly T[number][] },
): ZodType<T[number]> {
	if (values.length === 0) {
		throw new Error("StringEnum requires at least one allowed value");
	}
	const tuple = values as unknown as [string, ...string[]];
	let schema: z.ZodTypeAny = z.enum(tuple);
	if (options?.description) {
		schema = schema.describe(options.description);
	}
	if (options?.default !== undefined) {
		schema = schema.default(options.default);
	}
	if (options?.examples?.length) {
		schema = schema.meta({ examples: [...options.examples] });
	}
	return schema as ZodType<T[number]>;
}

export const NO_STRICT = $flag("PI_NO_STRICT");
/**
 * Per-schema-object memoization slot. The result of `tryEnforceStrictSchema`
 * is stamped directly onto the input via `stamp(target, kStrictSchema, …)`
 * so repeated calls (different providers, retries, batching) reuse the same
 * computed pair without re-walking the tree.
 */
const kStrictSchema = Symbol("pi.schema.strict");

/**
 * Detect schemas that strict mode *cannot* represent.
 *
 * Strict mode requires closed object shapes — every property is declared in
 * `properties` and listed in `required`. That is incompatible with:
 *  - `patternProperties` (open keyset matched by regex),
 *  - `additionalProperties: true` or `additionalProperties: <schema>` (open
 *    keyset with optional further constraint).
 *
 * This check recurses into every place a child schema may live (properties,
 * items/prefixItems, combinator branches, $defs) so a single offender deep
 * in the tree disqualifies the whole schema. Used to fail-open early in
 * `tryEnforceStrictSchema` rather than throwing during enforcement.
 */
function hasUnrepresentableStrictObjectMap(schema: Record<string, unknown>, epoch: number = epochNext()): boolean {
	if (!once(schema, epoch)) return false;

	let hasPatternProperties = false;
	if (isJsonObject(schema.patternProperties)) {
		for (const _ in schema.patternProperties) {
			hasPatternProperties = true;
			break;
		}
	}
	const additionalPropertiesValue = schema.additionalProperties;
	const hasSchemaAdditionalProperties = additionalPropertiesValue === true || isJsonObject(additionalPropertiesValue);
	if (hasPatternProperties || hasSchemaAdditionalProperties) {
		return true;
	}

	if (isJsonObject(schema.properties)) {
		const properties = schema.properties;
		for (const k in properties) {
			const propertySchema = properties[k];
			if (isJsonObject(propertySchema) && hasUnrepresentableStrictObjectMap(propertySchema, epoch)) {
				return true;
			}
		}
	}

	if (isJsonObject(schema.items)) {
		if (hasUnrepresentableStrictObjectMap(schema.items, epoch)) {
			return true;
		}
	} else if (Array.isArray(schema.items)) {
		for (const itemSchema of schema.items) {
			if (isJsonObject(itemSchema) && hasUnrepresentableStrictObjectMap(itemSchema, epoch)) {
				return true;
			}
		}
	}
	if (Array.isArray(schema.prefixItems)) {
		for (const itemSchema of schema.prefixItems) {
			if (isJsonObject(itemSchema) && hasUnrepresentableStrictObjectMap(itemSchema, epoch)) {
				return true;
			}
		}
	}

	for (const key of COMBINATOR_KEYS) {
		const variants = schema[key];
		if (!Array.isArray(variants)) continue;
		for (const variant of variants) {
			if (isJsonObject(variant) && hasUnrepresentableStrictObjectMap(variant, epoch)) {
				return true;
			}
		}
	}

	for (const defsKey of ["$defs", "definitions"] as const) {
		const defs = schema[defsKey];
		if (!isJsonObject(defs)) continue;
		for (const k in defs) {
			const defSchema = defs[k];
			if (isJsonObject(defSchema) && hasUnrepresentableStrictObjectMap(defSchema, epoch)) {
				return true;
			}
		}
	}

	return false;
}
/**
 * First pass of strict-mode preparation.
 *
 * Rewrites everything strict mode forbids into something it accepts:
 *  - Drops non-structural keywords (`format`, `pattern`, `examples`, …),
 *    `const`, `nullable`, and `additionalProperties` (re-added by
 *    `enforceStrictSchema` as `false`).
 *  - `type: [a, b]` → `anyOf: [{type: a, …}, {type: b, …}]`, copying only the
 *    keywords each variant can use (e.g. `properties` stays only on the
 *    object variant).
 *  - `const` → single-entry `enum`.
 *  - Description carries a `(default: X)` suffix so the model still sees the
 *    documented default after the keyword is stripped.
 *  - `nullable: true` wraps the whole node in `anyOf:[T,{type:"null"}]`.
 *
 * Recurses into properties, items, prefixItems, combinators, and $defs. The
 * `cache` WeakMap dedupes shared subgraphs; the `epoch` is the cycle guard.
 */
export function sanitizeSchemaForStrictMode(
	schema: Record<string, unknown>,
	epoch: number = epochNext(),
	cache: WeakMap<Record<string, unknown>, Record<string, unknown>> = new WeakMap(),
	root: Record<string, unknown> = schema,
): Record<string, unknown> {
	const cached = cache.get(schema);
	if (cached) return cached;
	if (!once(schema, epoch)) return {};

	// Pre-pass: unravel `$ref` with sibling keys by inlining the resolved def.
	// OpenAI strict mode forbids `{$ref, description, ...}`; the SDK resolves
	// and merges, with sibling keys taking precedence over the ref'd def.
	// Cite: openai-python/src/openai/lib/_pydantic.py:96-110 (`_ensure_strict_json_schema`)
	if (typeof schema.$ref === "string") {
		let hasSibling = false;
		for (const k in schema) {
			if (k !== "$ref" && Object.hasOwn(schema, k)) {
				hasSibling = true;
				break;
			}
		}
		if (hasSibling) {
			const resolved = resolveStrictRef(root, schema.$ref);
			if (resolved !== undefined) {
				// Sibling keys on the schema override keys from the resolved def.
				const merged: Record<string, unknown> = { ...resolved };
				for (const k in schema) {
					if (k === "$ref" || !Object.hasOwn(schema, k)) continue;
					merged[k] = schema[k];
				}
				const result = sanitizeSchemaForStrictMode(merged, epoch, cache, root);
				cache.set(schema, result);
				return result;
			}
		}
	}

	// Pre-pass: collapse single-element `allOf` by inlining its sole entry.
	// SDK semantics: `json_schema.update(ensured(all_of[0]))` — the inlined
	// entry's keys WIN over original sibling keys, then `allOf` is dropped.
	// Cite: openai-python/src/openai/lib/_pydantic.py:79-83
	{
		const allOf = schema.allOf;
		if (Array.isArray(allOf) && allOf.length === 1 && isJsonObject(allOf[0])) {
			const merged: Record<string, unknown> = { ...schema };
			delete merged.allOf;
			const sole = allOf[0] as Record<string, unknown>;
			for (const k in sole) {
				if (Object.hasOwn(sole, k)) merged[k] = sole[k];
			}
			const result = sanitizeSchemaForStrictMode(merged, epoch, cache, root);
			cache.set(schema, result);
			return result;
		}
	}

	const typeValue = schema.type;
	if (Array.isArray(typeValue)) {
		const typeVariants = typeValue.filter((entry): entry is string => typeof entry === "string");
		const schemaWithoutType = { ...schema };
		delete schemaWithoutType.type;

		const sanitizedWithoutType = sanitizeSchemaForStrictMode(schemaWithoutType, epoch, cache, root);
		if (typeVariants.length === 0) {
			cache.set(schema, sanitizedWithoutType);
			return sanitizedWithoutType;
		}
		// Build one variant schema per type. Each variant keeps only the keywords
		// relevant to that type — object-only keywords stay on the object variant,
		// array-only keywords on the array variant, etc.

		const variants = typeVariants.map(variantType => {
			const variantSchema: Record<string, unknown> = { ...sanitizedWithoutType, type: variantType };
			if (variantType !== "object") {
				delete variantSchema.properties;
				delete variantSchema.required;
				delete variantSchema.additionalProperties;
			}
			if (variantType !== "array") {
				delete variantSchema.items;
			}
			return sanitizeSchemaForStrictMode(variantSchema, epoch, cache, root);
		});

		if (variants.length === 1) {
			cache.set(schema, variants[0] as Record<string, unknown>);
			return variants[0] as Record<string, unknown>;
		}

		const result = {
			anyOf: variants,
		};
		cache.set(schema, result);
		return result;
	}
	// Scalar `type`: walk the keys, rewriting or stripping per strict-mode rules.

	const sanitized: Record<string, unknown> = {};
	cache.set(schema, sanitized);
	for (const key in schema) {
		const value = schema[key];
		if (key in NON_STRUCTURAL_SCHEMA_KEYS || key === "type" || key === "const" || key === "nullable") {
			continue;
		}
		// `properties` map — recurse into each property schema.

		if (key === "properties" && isJsonObject(value)) {
			const properties: Record<string, unknown> = {};
			for (const propertyName in value) {
				const propertySchema = value[propertyName];
				properties[propertyName] = isJsonObject(propertySchema)
					? sanitizeSchemaForStrictMode(propertySchema, epoch, cache, root)
					: propertySchema;
			}
			sanitized.properties = properties;
			continue;
		}
		// `items` can be schema, tuple-array, or scalar boolean — recurse where applicable.

		if (key === "items") {
			if (isJsonObject(value)) {
				sanitized.items = sanitizeSchemaForStrictMode(value, epoch, cache, root);
			} else if (Array.isArray(value)) {
				sanitized.items = value.map(entry =>
					isJsonObject(entry) ? sanitizeSchemaForStrictMode(entry, epoch, cache, root) : entry,
				);
			} else {
				sanitized.items = value;
			}
			continue;
		}
		// `prefixItems` is always an array of schemas (draft 2020-12).

		if (key === "prefixItems" && Array.isArray(value)) {
			sanitized.prefixItems = value.map(entry =>
				isJsonObject(entry) ? sanitizeSchemaForStrictMode(entry, epoch, cache, root) : entry,
			);
			continue;
		}
		// `anyOf`/`oneOf`/`allOf` arrays — recurse into each branch.

		if (COMBINATOR_KEYS.includes(key as (typeof COMBINATOR_KEYS)[number]) && Array.isArray(value)) {
			sanitized[key] = value.map(entry =>
				isJsonObject(entry) ? sanitizeSchemaForStrictMode(entry, epoch, cache, root) : entry,
			);
			continue;
		}
		// Definition maps — recurse into each named schema.

		if ((key === "$defs" || key === "definitions") && isJsonObject(value)) {
			const defs: Record<string, unknown> = {};
			for (const definitionName in value) {
				const definitionSchema = value[definitionName];
				defs[definitionName] = isJsonObject(definitionSchema)
					? sanitizeSchemaForStrictMode(definitionSchema, epoch, cache, root)
					: definitionSchema;
			}
			sanitized[key] = defs;
			continue;
		}
		// `additionalProperties` is owned by `enforceStrictSchema`, which sets it to false.

		if (key === "additionalProperties") {
			continue;
		}

		if (key === "description" && typeof value === "string" && schema.default !== undefined) {
			// Preserve `default:` info for strict-mode providers that strip the keyword.
			// Inline as `(default: X)` text in the description, matching the convention for
			// runtime-placeholder defaults (e.g. `cwd`) that cannot live in the keyword form.
			const defaultVal = schema.default;
			const formatted = typeof defaultVal === "string" ? defaultVal : JSON.stringify(defaultVal);
			sanitized.description = value.includes("(default:") ? value : `${value} (default: ${formatted})`;
			continue;
		}

		sanitized[key] = value;
	}
	// Post-pass: re-derive `type` and turn dropped keywords into a representable shape.

	if (Object.hasOwn(schema, "const")) {
		const constVal = schema.const;
		const existingEnum = Array.isArray(sanitized.enum) ? sanitized.enum : [];
		if (!existingEnum.some(v => areJsonValuesEqual(v, constVal))) {
			existingEnum.push(constVal);
		}
		sanitized.enum = existingEnum;
	}

	// Preserve the original scalar type after the strip-and-rebuild loop.
	if (typeof typeValue === "string") {
		sanitized.type = typeValue;
	}

	if (sanitized.type === undefined && isJsonObject(sanitized.properties)) {
		sanitized.type = "object";
	}

	if (sanitized.type === undefined && (sanitized.items !== undefined || sanitized.prefixItems !== undefined)) {
		sanitized.type = "array";
	}

	// Last-resort inference: a bare `enum` with homogeneous primitives gets a `type`.
	if (sanitized.type === undefined && Array.isArray(sanitized.enum)) {
		let inferredType: "null" | "string" | "number" | "boolean" | undefined;
		let conflicting = false;
		for (const v of sanitized.enum) {
			const t =
				v === null
					? "null"
					: typeof v === "string"
						? "string"
						: typeof v === "number"
							? "number"
							: typeof v === "boolean"
								? "boolean"
								: undefined;
			if (t === undefined) continue;
			if (inferredType === undefined) inferredType = t;
			else if (inferredType !== t) {
				conflicting = true;
				break;
			}
		}
		if (!conflicting && inferredType !== undefined) {
			sanitized.type = inferredType;
		}
	}

	// `nullable: true` was stripped above — re-introduce it as an `anyOf` wrapper.
	if (schema.nullable === true) {
		const { nullable: _, ...withoutNullable } = sanitized;
		return { anyOf: [withoutNullable, { type: "null" }] };
	}

	return sanitized;
}

/**
 * Recursively enforces JSON Schema constraints required by OpenAI/Codex strict mode:
 *   - `additionalProperties: false` on every object node
 *   - every key in `properties` present in `required`
 *
 * Properties absent from the original `required` array were TypeBox-optional.
 * They are made nullable (`anyOf: [T, { type: "null" }]`) so the model can
 * signal omission by outputting null rather than omitting the key entirely.
 *
 * @throws {Error} When a schema node has no `type`, array-based combinator
 *   (`anyOf`/`allOf`/`oneOf`), object-based combinator (`not`), or `$ref` —
 *   i.e. the node is not representable in strict mode. Prefer
 *   {@link tryEnforceStrictSchema} which catches this and degrades gracefully.
 */
export function enforceStrictSchema(
	schema: Record<string, unknown>,
	cache: WeakMap<Record<string, unknown>, Record<string, unknown>> = new WeakMap(),
): Record<string, unknown> {
	if (!enter(schema)) {
		throw new Error("Schema contains a circular object graph — cannot enforce strict mode");
	}
	try {
		const cached = cache.get(schema);
		if (cached) return cached;
		const result = { ...schema };
		cache.set(schema, result);
		return enforceStrictSchemaBody(schema, result, cache);
	} finally {
		exit(schema);
	}
}

function enforceStrictSchemaBody(
	_schema: Record<string, unknown>,
	result: Record<string, unknown>,
	cache: WeakMap<Record<string, unknown>, Record<string, unknown>>,
): Record<string, unknown> {
	const isObjectType = result.type === "object";
	if (isObjectType) {
		result.additionalProperties = false;
		const propertiesValue = result.properties;
		const props =
			propertiesValue != null && typeof propertiesValue === "object" && !Array.isArray(propertiesValue)
				? (propertiesValue as Record<string, unknown>)
				: {};
		const originalRequired = new Set<string>(
			Array.isArray(result.required)
				? result.required.filter((value): value is string => typeof value === "string")
				: [],
		);
		const strictProperties: Record<string, unknown> = {};
		for (const key in props) {
			const value = props[key];
			const processed =
				value != null && typeof value === "object" && !Array.isArray(value)
					? enforceStrictSchema(value as Record<string, unknown>, cache)
					: value;
			// Optional property — wrap as nullable so strict mode accepts it
			if (!originalRequired.has(key)) {
				// Don't double-wrap if already nullable
				if (
					isJsonObject(processed) &&
					Array.isArray(processed.anyOf) &&
					processed.anyOf.some(v => isJsonObject(v) && v.type === "null")
				) {
					strictProperties[key] = processed;
					continue;
				}
				if (isJsonObject(processed) && typeof processed.description === "string") {
					const { description, ...withoutDescription } = processed;
					strictProperties[key] = { anyOf: [withoutDescription, { type: "null" }], description };
					continue;
				}
				strictProperties[key] = { anyOf: [processed, { type: "null" }] };
				continue;
			}
			strictProperties[key] = processed;
		}
		result.properties = strictProperties;
		result.required = Object.keys(strictProperties);
	}
	if (result.items != null && typeof result.items === "object") {
		if (Array.isArray(result.items)) {
			result.items = result.items.map(entry =>
				entry != null && typeof entry === "object" && !Array.isArray(entry)
					? enforceStrictSchema(entry as Record<string, unknown>, cache)
					: entry,
			);
		} else {
			result.items = enforceStrictSchema(result.items as Record<string, unknown>, cache);
		}
	}
	if (Array.isArray(result.prefixItems)) {
		result.prefixItems = result.prefixItems.map(entry =>
			entry != null && typeof entry === "object" && !Array.isArray(entry)
				? enforceStrictSchema(entry as Record<string, unknown>, cache)
				: entry,
		);
	}
	for (const key of COMBINATOR_KEYS) {
		if (Array.isArray(result[key])) {
			result[key] = (result[key] as unknown[]).map(entry =>
				entry != null && typeof entry === "object" && !Array.isArray(entry)
					? enforceStrictSchema(entry as Record<string, unknown>, cache)
					: entry,
			);
		}
	}
	for (const defsKey of ["$defs", "definitions"] as const) {
		if (result[defsKey] != null && typeof result[defsKey] === "object" && !Array.isArray(result[defsKey])) {
			const defs = result[defsKey] as Record<string, unknown>;
			const nextDefs: Record<string, unknown> = {};
			for (const name in defs) {
				const def = defs[name];
				nextDefs[name] =
					def != null && typeof def === "object" && !Array.isArray(def)
						? enforceStrictSchema(def as Record<string, unknown>, cache)
						: def;
			}
			result[defsKey] = nextDefs;
		}
	}
	// Strict mode requires every schema node to declare a concrete type (or combinator/$ref/enum/const).
	// Schemas like `{}` (match anything) or `{items: {}}` are not representable in strict mode.
	if (
		result.type === undefined &&
		result.$ref === undefined &&
		result.enum === undefined &&
		result.const === undefined &&
		!COMBINATOR_KEYS.some(key => Array.isArray(result[key])) &&
		!isJsonObject(result.not)
	) {
		throw new Error("Schema node has no type, combinator, or $ref — cannot enforce strict mode");
	}
	return result;
}

export function tryEnforceStrictSchema(schema: Record<string, unknown>) {
	return stamp(schema, kStrictSchema, s => {
		const upgraded = upgradeJsonSchemaTo202012(s) as Record<string, unknown>;
		if (hasUnrepresentableStrictObjectMap(upgraded)) {
			return { schema: upgraded, strict: false };
		}
		try {
			const sanitized = sanitizeSchemaForStrictMode(upgraded);
			return { schema: enforceStrictSchema(sanitized), strict: true };
		} catch {
			return { schema: upgraded, strict: false };
		}
	});
}

/**
 * Resolve a JSON-pointer-style `$ref` against the root schema. Mirrors the
 * OpenAI SDK's `resolve_ref` helper: only local refs starting with `#/` are
 * supported, and each segment must dereference to a dictionary.
 * Cite: openai-python/src/openai/lib/_pydantic.py:118-129
 */
function resolveStrictRef(root: Record<string, unknown>, ref: string): Record<string, unknown> | undefined {
	if (!ref.startsWith("#/")) return undefined;
	const segments = ref.slice(2).split("/");
	let cursor: unknown = root;
	for (const raw of segments) {
		if (!isJsonObject(cursor)) return undefined;
		// JSON Pointer unescape: ~1 → "/", ~0 → "~" (must run in that order).
		const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
		cursor = cursor[segment];
	}
	return isJsonObject(cursor) ? cursor : undefined;
}
