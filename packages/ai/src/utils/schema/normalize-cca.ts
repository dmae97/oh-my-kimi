import { logger } from "@oh-my-pi/pi-utils";
import { areJsonValuesEqual, mergePropertySchemas } from "./equality";
import { CLOUD_CODE_ASSIST_SHARED_SCHEMA_KEYS, CLOUD_CODE_ASSIST_TYPE_SPECIFIC_KEYS } from "./fields";
import { isValidJsonSchema } from "./meta-validator";
import { sanitizeSchemaForCCA } from "./sanitize-google";
import type { JsonObject } from "./types";
import { isJsonObject } from "./types";

/** Copy all keys from a schema except the specified combiner key. */
export function copySchemaWithout(schema: JsonObject, combiner: string): JsonObject {
	const { [combiner]: _, ...rest } = schema;
	return rest;
}

/**
 * Claude via Cloud Code Assist (`parameters` path) can reject schemas that keep
 * object variant combiners, so flatten object-only unions into one object shape.
 */
function mergeObjectCombinerVariants(schema: JsonObject, combiner: "anyOf" | "oneOf"): JsonObject {
	const variantsRaw = schema[combiner];
	if (!Array.isArray(variantsRaw) || variantsRaw.length === 0) {
		return schema;
	}

	const variants: JsonObject[] = [];
	for (const entry of variantsRaw) {
		if (!isJsonObject(entry)) {
			return schema;
		}
		const variantType = entry.type;
		const hasObjectShape =
			isJsonObject(entry.properties) ||
			Array.isArray(entry.required) ||
			Object.hasOwn(entry, "additionalProperties");
		if (variantType === undefined && !hasObjectShape) {
			return schema;
		}
		if (variantType !== undefined && variantType !== "object") {
			return schema;
		}
		if (entry.properties !== undefined && !isJsonObject(entry.properties)) {
			return schema;
		}
		if (entry.required !== undefined && !Array.isArray(entry.required)) {
			return schema;
		}
		variants.push(entry);
	}

	const mergedProperties: JsonObject = {};
	const ownProperties = isJsonObject(schema.properties) ? schema.properties : {};
	for (const [name, propertySchema] of Object.entries(ownProperties)) {
		mergedProperties[name] = propertySchema;
	}

	for (const variant of variants) {
		const properties = isJsonObject(variant.properties) ? variant.properties : {};
		for (const [name, propertySchema] of Object.entries(properties)) {
			const existingSchema = mergedProperties[name];
			mergedProperties[name] =
				existingSchema === undefined ? propertySchema : mergePropertySchemas(existingSchema, propertySchema);
		}
	}

	const nextSchema = copySchemaWithout(schema, combiner);

	nextSchema.type = "object";
	nextSchema.properties = mergedProperties;

	// Compute intersection of all variants' required arrays
	let requiredIntersection: string[] | undefined;
	for (const variant of variants) {
		const variantRequired = Array.isArray(variant.required)
			? variant.required.filter((r): r is string => typeof r === "string")
			: [];
		if (requiredIntersection === undefined) {
			requiredIntersection = [...variantRequired];
		} else {
			const reqSet = new Set(variantRequired);
			requiredIntersection = requiredIntersection.filter(r => reqSet.has(r));
		}
	}
	const parentRequired = Array.isArray(schema.required)
		? schema.required.filter((r): r is string => typeof r === "string")
		: [];
	const ownPropertyNames = new Set(Object.keys(ownProperties));
	const safeRequired = new Set<string>();
	for (const name of requiredIntersection ?? []) {
		if (name in mergedProperties) safeRequired.add(name);
	}
	for (const name of parentRequired) {
		if (ownPropertyNames.has(name) && name in mergedProperties) {
			safeRequired.add(name);
		}
	}
	const requiredInPropertyOrder = Object.keys(mergedProperties).filter(name => safeRequired.has(name));
	if (requiredInPropertyOrder.length > 0) {
		nextSchema.required = requiredInPropertyOrder;
	} else {
		delete nextSchema.required;
	}

	return nextSchema;
}

/**
 * Collapse anyOf/oneOf with distinct typed variants into a single-type schema.
 * Picks the first non-null type as a scalar. This is lossy for multi-type unions
 * (e.g., string|number|null narrows to string), but CCA requires a scalar type field
 * and an uncollapsed anyOf would be rejected by the CCA API at runtime.
 */
function collapseMixedTypeCombinerVariants(schema: JsonObject, combiner: "anyOf" | "oneOf"): JsonObject {
	const variantsRaw = schema[combiner];
	if (!Array.isArray(variantsRaw) || variantsRaw.length === 0) {
		return schema;
	}

	const seenTypes = new Set<string>();
	const variantTypes: string[] = [];
	const mergedVariantFields: JsonObject = {};
	for (const entry of variantsRaw) {
		if (!isJsonObject(entry) || typeof entry.type !== "string") {
			return schema;
		}

		const variantType = entry.type;
		if (seenTypes.has(variantType)) {
			return schema;
		}

		const allowedKeys = CLOUD_CODE_ASSIST_TYPE_SPECIFIC_KEYS[variantType];
		if (!allowedKeys) {
			return schema;
		}

		for (const [key, variantValue] of Object.entries(entry)) {
			if (key === "type") continue;
			if (!allowedKeys.has(key) && !CLOUD_CODE_ASSIST_SHARED_SCHEMA_KEYS.has(key)) {
				return schema;
			}

			const existingValue = mergedVariantFields[key];
			if (existingValue !== undefined && !areJsonValuesEqual(existingValue, variantValue)) {
				return schema;
			}
			mergedVariantFields[key] = variantValue;
		}

		seenTypes.add(variantType);
		variantTypes.push(variantType);
	}

	if (variantTypes.length < 2 || variantTypes.every(type => type === "object")) {
		return schema;
	}

	const nextSchema = copySchemaWithout(schema, combiner);

	const nonNullTypes = variantTypes.filter(t => t !== "null");
	// Lossy: when multiple non-null types exist we pick the first. CCA requires
	// a scalar type and keeping the anyOf would cause an API rejection at runtime.
	nextSchema.type = nonNullTypes[0] ?? variantTypes[0];
	for (const [key, value] of Object.entries(mergedVariantFields)) {
		const existingValue = nextSchema[key];
		if (existingValue !== undefined && !areJsonValuesEqual(existingValue, value)) {
			return schema;
		}
		if (existingValue === undefined) {
			nextSchema[key] = value;
		}
	}
	return nextSchema;
}

/**
 * Collapse anyOf/oneOf where all variants share the same primitive type.
 * E.g. anyOf: [{type: "string", desc: "A"}, {type: "string", desc: "B"}] -> {type: "string", desc: "A"}
 * Claude via CCA rejects any remaining anyOf/oneOf, so pick first variant.
 * Note: constraints from non-first variants are silently dropped.
 */
function collapseSameTypeCombinerVariants(schema: JsonObject, combiner: "anyOf" | "oneOf"): JsonObject {
	const variantsRaw = schema[combiner];
	if (!Array.isArray(variantsRaw) || variantsRaw.length === 0) return schema;
	let commonType: string | undefined;
	let firstEntry: JsonObject | undefined;
	for (const entry of variantsRaw) {
		if (!isJsonObject(entry) || typeof entry.type !== "string") return schema;
		if (commonType === undefined) {
			commonType = entry.type;
			firstEntry = entry;
		} else if (entry.type !== commonType) return schema;
	}
	if (!firstEntry) return schema;
	const nextSchema = copySchemaWithout(schema, combiner);
	for (const [key, value] of Object.entries(firstEntry)) {
		if (!(key in nextSchema)) nextSchema[key] = value;
	}
	return nextSchema;
}

/**
 * Recursively strip any remaining anyOf/oneOf that collapseSameTypeCombinerVariants can handle.
 * This is needed because mergeObjectCombinerVariants can create new anyOf in merged
 * properties AFTER the recursive normalization pass has already processed children.
 */
export function stripResidualCombiners(value: unknown, seen = new WeakSet<object>()): unknown {
	if (Array.isArray(value)) {
		if (seen.has(value)) return [];
		seen.add(value);
		return value.map(entry => stripResidualCombiners(entry, seen));
	}
	if (!isJsonObject(value)) return value;
	if (seen.has(value)) return {};
	seen.add(value);
	const result: JsonObject = {};
	for (const [key, entry] of Object.entries(value)) {
		result[key] = stripResidualCombiners(entry, seen);
	}
	let current: JsonObject = result;
	let changed = true;
	while (changed) {
		changed = false;
		for (const combiner of ["anyOf", "oneOf"] as const) {
			const sameType = collapseSameTypeCombinerVariants(current, combiner);
			if (sameType !== current) {
				current = sameType;
				changed = true;
			}
			const mixed = collapseMixedTypeCombinerVariants(current, combiner);
			if (mixed !== current) {
				current = mixed;
				changed = true;
			}
		}
	}
	return current;
}

function normalizeSchemaForCCA(value: unknown, seen?: WeakSet<object>): unknown {
	if (!seen) seen = new WeakSet();
	if (Array.isArray(value)) {
		if (seen.has(value)) return [];
		seen.add(value);
		return value.map(entry => normalizeSchemaForCCA(entry, seen));
	}
	if (!isJsonObject(value)) {
		return value;
	}
	if (seen.has(value)) return {};
	seen.add(value);

	const normalized: JsonObject = {};
	for (const [key, entry] of Object.entries(value)) {
		normalized[key] = normalizeSchemaForCCA(entry, seen);
	}

	const mergedAnyOf = mergeObjectCombinerVariants(normalized, "anyOf");
	const collapsedAnyOf = collapseMixedTypeCombinerVariants(mergedAnyOf, "anyOf");
	const sameTypeAnyOf = collapseSameTypeCombinerVariants(collapsedAnyOf, "anyOf");
	const mergedOneOf = mergeObjectCombinerVariants(sameTypeAnyOf, "oneOf");
	const collapsedOneOf = collapseMixedTypeCombinerVariants(mergedOneOf, "oneOf");
	return collapseSameTypeCombinerVariants(collapsedOneOf, "oneOf");
}

interface NullableExtractionResult {
	schema: unknown;
	nullable: boolean;
}

function extractNullableUnionSchema(schema: unknown): NullableExtractionResult {
	if (!isJsonObject(schema)) {
		return { schema, nullable: false };
	}

	if (schema.nullable === true) {
		const nextSchema = { ...schema };
		delete nextSchema.nullable;
		return { schema: nextSchema, nullable: true };
	}

	if (Array.isArray(schema.type)) {
		const typeVariants = schema.type.filter((entry): entry is string => typeof entry === "string");
		const nonNullTypes = typeVariants.filter(entry => entry !== "null");
		if (typeVariants.includes("null") && nonNullTypes.length === 1) {
			const nextSchema = { ...schema, type: nonNullTypes[0] };
			return { schema: nextSchema, nullable: true };
		}
	}

	for (const combiner of ["anyOf", "oneOf"] as const) {
		const variantsRaw = schema[combiner];
		if (!Array.isArray(variantsRaw)) continue;

		let hasNullVariant = false;
		const nonNullVariants: unknown[] = [];
		for (const variant of variantsRaw) {
			if (isJsonObject(variant) && variant.type === "null" && Object.keys(variant).length === 1) {
				hasNullVariant = true;
				continue;
			}
			nonNullVariants.push(variant);
		}

		if (!hasNullVariant || nonNullVariants.length !== 1 || !isJsonObject(nonNullVariants[0])) {
			continue;
		}

		const nextSchema = copySchemaWithout(schema, combiner);
		for (const [key, value] of Object.entries(nonNullVariants[0])) {
			const existingValue = nextSchema[key];
			if (existingValue !== undefined && !areJsonValuesEqual(existingValue, value)) {
				return { schema, nullable: false };
			}
			if (existingValue === undefined) {
				nextSchema[key] = value;
			}
		}
		return { schema: nextSchema, nullable: true };
	}

	return { schema, nullable: false };
}

interface NullableNormalizationResult {
	schema: unknown;
	nullable: boolean;
}

function normalizeNullablePropertiesForCloudCodeAssist(
	value: unknown,
	isPropertySchema = false,
	seen?: WeakSet<object>,
): NullableNormalizationResult {
	if (!seen) seen = new WeakSet();
	if (Array.isArray(value)) {
		if (seen.has(value)) {
			return { schema: [], nullable: false };
		}
		seen.add(value);
		return {
			schema: value.map(entry => normalizeNullablePropertiesForCloudCodeAssist(entry, false, seen).schema),
			nullable: false,
		};
	}
	if (!isJsonObject(value)) {
		return { schema: value, nullable: false };
	}
	if (seen.has(value)) {
		return { schema: {}, nullable: false };
	}
	seen.add(value);

	const normalized: JsonObject = {};
	for (const [key, entry] of Object.entries(value)) {
		normalized[key] = normalizeNullablePropertiesForCloudCodeAssist(entry, false, seen).schema;
	}

	if (isJsonObject(normalized.properties)) {
		const required = new Set(
			Array.isArray(normalized.required)
				? normalized.required.filter((entry): entry is string => typeof entry === "string")
				: [],
		);
		const nextProperties: JsonObject = {};
		for (const [name, propertySchema] of Object.entries(normalized.properties)) {
			const normalizedProperty = normalizeNullablePropertiesForCloudCodeAssist(propertySchema, true, seen);
			nextProperties[name] = normalizedProperty.schema;
			if (normalizedProperty.nullable) {
				required.delete(name);
			}
		}
		normalized.properties = nextProperties;
		if (Array.isArray(normalized.required)) {
			normalized.required = Array.from(required);
		}
	}

	if (!isPropertySchema) {
		return { schema: normalized, nullable: false };
	}

	return extractNullableUnionSchema(normalized);
}

/**
 * Keep validation synchronous in this request path.
 * Replaces the previous AJV-based meta-schema check with a tiny
 * structural validator that catches the failure modes the CCA pipeline
 * actually produces.
 */
function isValidCCASchema(schema: unknown): boolean {
	return isValidJsonSchema(schema);
}

/** See COMBINATOR_KEYS in fields.ts — CCA forbids all three combiners. */
const CCA_FORBIDDEN_COMBINERS = new Set(["anyOf", "oneOf", "allOf"] as const);

function hasResidualCloudCodeAssistIncompatibilities(value: unknown, seen = new WeakSet<object>()): boolean {
	if (Array.isArray(value)) {
		if (seen.has(value)) return false;
		seen.add(value);
		return value.some(entry => hasResidualCloudCodeAssistIncompatibilities(entry, seen));
	}
	if (!isJsonObject(value)) {
		return false;
	}
	if (seen.has(value)) {
		return false;
	}
	seen.add(value);

	if (Array.isArray(value.type) || value.type === "null") {
		return true;
	}
	if (Object.hasOwn(value, "nullable")) {
		return true;
	}
	for (const combiner of CCA_FORBIDDEN_COMBINERS) {
		if (Array.isArray(value[combiner])) {
			return true;
		}
	}
	for (const entry of Object.values(value)) {
		if (hasResidualCloudCodeAssistIncompatibilities(entry, seen)) {
			return true;
		}
	}
	return false;
}
const CLOUD_CODE_ASSIST_CLAUDE_FALLBACK_SCHEMA = {
	type: "object",
	properties: {},
} as const;

/**
 * Prepare schema for Claude on Cloud Code Assist:
 * sanitize -> normalize union objects -> validate -> fallback.
 *
 * Fallback is per-tool and fail-open to avoid rejecting the entire request when
 * one tool schema is invalid.
 */
export function prepareSchemaForCCA(value: unknown): unknown {
	const sanitized = sanitizeSchemaForCCA(value);
	const pass1 = normalizeSchemaForCCA(sanitized);
	// Second pass: strip anyOf/oneOf created by mergeObjectCombinerVariants during pass1
	const normalized = stripResidualCombiners(pass1);
	const nullableNormalized = normalizeNullablePropertiesForCloudCodeAssist(normalized).schema;
	if (hasResidualCloudCodeAssistIncompatibilities(nullableNormalized)) {
		logger.debug("CCA schema has residual incompatibilities, using fallback");
		return CLOUD_CODE_ASSIST_CLAUDE_FALLBACK_SCHEMA;
	}
	if (isValidCCASchema(nullableNormalized)) {
		return nullableNormalized;
	}
	logger.debug("CCA schema failed validation, using fallback");
	return CLOUD_CODE_ASSIST_CLAUDE_FALLBACK_SCHEMA;
}
