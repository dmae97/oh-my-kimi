import { $flag } from "@oh-my-pi/pi-utils";
import { type TUnsafe, Type } from "@sinclair/typebox";
import { areJsonValuesEqual } from "./equality";
import { COMBINATOR_KEYS, NON_STRUCTURAL_SCHEMA_KEYS } from "./fields";
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
 * type Operation = Static<typeof OperationSchema>; // "add" | "subtract" | "multiply" | "divide"
 */
export function StringEnum<const T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: values as unknown as string[],
		...(options?.description && { description: options.description }),
		...(options?.default && { default: options.default }),
	});
}

export const NO_STRICT = $flag("PI_NO_STRICT");

const strictSchemaCache = new WeakMap<Record<string, unknown>, { schema: Record<string, unknown>; strict: boolean }>();
function hasUnrepresentableStrictObjectMap(schema: Record<string, unknown>, seen?: WeakSet<object>): boolean {
	if (!seen) seen = new WeakSet();
	if (seen.has(schema)) return false;
	seen.add(schema);

	const hasPatternProperties =
		isJsonObject(schema.patternProperties) && Object.keys(schema.patternProperties).length > 0;
	const additionalPropertiesValue = schema.additionalProperties;
	const hasSchemaAdditionalProperties = additionalPropertiesValue === true || isJsonObject(additionalPropertiesValue);
	if (hasPatternProperties || hasSchemaAdditionalProperties) {
		return true;
	}

	if (isJsonObject(schema.properties)) {
		for (const propertySchema of Object.values(schema.properties)) {
			if (isJsonObject(propertySchema) && hasUnrepresentableStrictObjectMap(propertySchema, seen)) {
				return true;
			}
		}
	}

	if (isJsonObject(schema.items)) {
		if (hasUnrepresentableStrictObjectMap(schema.items, seen)) {
			return true;
		}
	} else if (Array.isArray(schema.items)) {
		for (const itemSchema of schema.items) {
			if (isJsonObject(itemSchema) && hasUnrepresentableStrictObjectMap(itemSchema, seen)) {
				return true;
			}
		}
	}

	for (const key of COMBINATOR_KEYS) {
		const variants = schema[key];
		if (!Array.isArray(variants)) continue;
		for (const variant of variants) {
			if (isJsonObject(variant) && hasUnrepresentableStrictObjectMap(variant, seen)) {
				return true;
			}
		}
	}

	for (const defsKey of ["$defs", "definitions"] as const) {
		const defs = schema[defsKey];
		if (!isJsonObject(defs)) continue;
		for (const defSchema of Object.values(defs)) {
			if (isJsonObject(defSchema) && hasUnrepresentableStrictObjectMap(defSchema, seen)) {
				return true;
			}
		}
	}

	return false;
}
export function sanitizeSchemaForStrictMode(
	schema: Record<string, unknown>,
	seen?: WeakSet<object>,
	cache?: WeakMap<Record<string, unknown>, Record<string, unknown>>,
): Record<string, unknown> {
	if (!seen) seen = new WeakSet();
	if (!cache) cache = new WeakMap();
	const cached = cache.get(schema);
	if (cached) return cached;
	if (seen.has(schema)) return {};
	seen.add(schema);
	const typeValue = schema.type;
	if (Array.isArray(typeValue)) {
		const typeVariants = typeValue.filter((entry): entry is string => typeof entry === "string");
		const schemaWithoutType = { ...schema };
		delete schemaWithoutType.type;

		const sanitizedWithoutType = sanitizeSchemaForStrictMode(schemaWithoutType, seen, cache);
		if (typeVariants.length === 0) {
			cache.set(schema, sanitizedWithoutType);
			seen.delete(schema);
			return sanitizedWithoutType;
		}

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
			return sanitizeSchemaForStrictMode(variantSchema, seen, cache);
		});

		if (variants.length === 1) {
			cache.set(schema, variants[0] as Record<string, unknown>);
			seen.delete(schema);
			return variants[0] as Record<string, unknown>;
		}

		const result = {
			anyOf: variants,
		};
		cache.set(schema, result);
		seen.delete(schema);
		return result;
	}

	const sanitized: Record<string, unknown> = {};
	cache.set(schema, sanitized);
	for (const [key, value] of Object.entries(schema)) {
		if (NON_STRUCTURAL_SCHEMA_KEYS.has(key) || key === "type" || key === "const" || key === "nullable") {
			continue;
		}

		if (key === "properties" && isJsonObject(value)) {
			const properties = Object.fromEntries(
				Object.entries(value).map(([propertyName, propertySchema]) => [
					propertyName,
					isJsonObject(propertySchema) ? sanitizeSchemaForStrictMode(propertySchema, seen, cache) : propertySchema,
				]),
			);
			sanitized.properties = properties;
			continue;
		}

		if (key === "items") {
			if (isJsonObject(value)) {
				sanitized.items = sanitizeSchemaForStrictMode(value, seen, cache);
			} else if (Array.isArray(value)) {
				sanitized.items = value.map(entry =>
					isJsonObject(entry) ? sanitizeSchemaForStrictMode(entry, seen, cache) : entry,
				);
			} else {
				sanitized.items = value;
			}
			continue;
		}

		if (COMBINATOR_KEYS.includes(key as (typeof COMBINATOR_KEYS)[number]) && Array.isArray(value)) {
			sanitized[key] = value.map(entry =>
				isJsonObject(entry) ? sanitizeSchemaForStrictMode(entry, seen, cache) : entry,
			);
			continue;
		}

		if ((key === "$defs" || key === "definitions") && isJsonObject(value)) {
			sanitized[key] = Object.fromEntries(
				Object.entries(value).map(([definitionName, definitionSchema]) => [
					definitionName,
					isJsonObject(definitionSchema)
						? sanitizeSchemaForStrictMode(definitionSchema, seen, cache)
						: definitionSchema,
				]),
			);
			continue;
		}

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

	if (Object.hasOwn(schema, "const")) {
		const constVal = schema.const;
		const existingEnum = Array.isArray(sanitized.enum) ? sanitized.enum : [];
		if (!existingEnum.some(v => areJsonValuesEqual(v, constVal))) {
			existingEnum.push(constVal);
		}
		sanitized.enum = existingEnum;
	}

	if (typeof typeValue === "string") {
		sanitized.type = typeValue;
	}

	if (sanitized.type === undefined && isJsonObject(sanitized.properties)) {
		sanitized.type = "object";
	}

	if (sanitized.type === undefined && sanitized.items !== undefined) {
		sanitized.type = "array";
	}

	if (sanitized.type === undefined && Array.isArray(sanitized.enum)) {
		const enumTypes = new Set(
			sanitized.enum
				.map(v =>
					v === null
						? "null"
						: typeof v === "string"
							? "string"
							: typeof v === "number"
								? "number"
								: typeof v === "boolean"
									? "boolean"
									: undefined,
				)
				.filter((t): t is "null" | "string" | "number" | "boolean" => t !== undefined),
		);
		if (enumTypes.size === 1) {
			sanitized.type = [...enumTypes][0];
		}
	}

	if (schema.nullable === true) {
		const { nullable: _, ...withoutNullable } = sanitized;
		seen.delete(schema);
		return { anyOf: [withoutNullable, { type: "null" }] };
	}

	seen.delete(schema);
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
	seen?: WeakSet<object>,
	cache?: WeakMap<Record<string, unknown>, Record<string, unknown>>,
): Record<string, unknown> {
	if (!seen) seen = new WeakSet();
	if (!cache) cache = new WeakMap();
	if (seen.has(schema)) {
		throw new Error("Schema contains a circular object graph — cannot enforce strict mode");
	}
	const cached = cache.get(schema);
	if (cached) {
		return cached;
	}
	seen.add(schema);
	const result = { ...schema };
	cache.set(schema, result);
	const isObjectType = result.type === "object";
	if (isObjectType) {
		result.additionalProperties = false;
		const propertiesValue = result.properties;
		const props =
			propertiesValue != null && typeof propertiesValue === "object" && !Array.isArray(propertiesValue)
				? (propertiesValue as Record<string, unknown>)
				: {};
		const originalRequired = new Set(
			Array.isArray(result.required)
				? result.required.filter((value): value is string => typeof value === "string")
				: [],
		);
		const strictProperties = Object.fromEntries(
			Object.entries(props).map(([key, value]) => {
				const processed =
					value != null && typeof value === "object" && !Array.isArray(value)
						? enforceStrictSchema(value as Record<string, unknown>, seen, cache)
						: value;
				// Optional property — wrap as nullable so strict mode accepts it
				if (!originalRequired.has(key)) {
					// Don't double-wrap if already nullable
					if (
						isJsonObject(processed) &&
						Array.isArray(processed.anyOf) &&
						processed.anyOf.some(v => isJsonObject(v) && v.type === "null")
					) {
						return [key, processed];
					}
					return [key, { anyOf: [processed, { type: "null" }] }];
				}
				return [key, processed];
			}),
		);
		result.properties = strictProperties;
		result.required = Object.keys(strictProperties);
	}
	if (result.items != null && typeof result.items === "object") {
		if (Array.isArray(result.items)) {
			result.items = result.items.map(entry =>
				entry != null && typeof entry === "object" && !Array.isArray(entry)
					? enforceStrictSchema(entry as Record<string, unknown>, seen, cache)
					: entry,
			);
		} else {
			result.items = enforceStrictSchema(result.items as Record<string, unknown>, seen, cache);
		}
	}
	for (const key of COMBINATOR_KEYS) {
		if (Array.isArray(result[key])) {
			result[key] = (result[key] as unknown[]).map(entry =>
				entry != null && typeof entry === "object" && !Array.isArray(entry)
					? enforceStrictSchema(entry as Record<string, unknown>, seen, cache)
					: entry,
			);
		}
	}
	for (const defsKey of ["$defs", "definitions"] as const) {
		if (result[defsKey] != null && typeof result[defsKey] === "object" && !Array.isArray(result[defsKey])) {
			const defs = result[defsKey] as Record<string, unknown>;
			result[defsKey] = Object.fromEntries(
				Object.entries(defs).map(([name, def]) => [
					name,
					def != null && typeof def === "object" && !Array.isArray(def)
						? enforceStrictSchema(def as Record<string, unknown>, seen, cache)
						: def,
				]),
			);
		}
	}
	// Strict mode requires every schema node to declare a concrete type (or combinator/$ref).
	// Schemas like `{}` (match anything) or `{items: {}}` are not representable in strict mode.
	if (
		result.type === undefined &&
		result.$ref === undefined &&
		!COMBINATOR_KEYS.some(key => Array.isArray(result[key])) &&
		!isJsonObject(result.not)
	) {
		throw new Error("Schema node has no type, combinator, or $ref — cannot enforce strict mode");
	}
	seen.delete(schema);
	return result;
}

export function tryEnforceStrictSchema(schema: Record<string, unknown>): {
	schema: Record<string, unknown>;
	strict: boolean;
} {
	const cached = strictSchemaCache.get(schema);
	if (cached) {
		return cached;
	}

	try {
		if (hasUnrepresentableStrictObjectMap(schema)) {
			throw new Error("Schema uses dynamic object keys that are not representable in strict mode");
		}
		const sanitized = sanitizeSchemaForStrictMode(schema);
		const result = { schema: enforceStrictSchema(sanitized), strict: true };
		strictSchemaCache.set(schema, result);
		return result;
	} catch {
		const result = { schema, strict: false };
		strictSchemaCache.set(schema, result);
		return result;
	}
}
