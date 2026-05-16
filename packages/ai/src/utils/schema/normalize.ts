/**
 * Provider-specific JSON Schema normalization used in the request path.
 *
 * Google's Schema proto, Cloud Code Assist's Claude bridge, and MCP/AJV
 * validation all reject different subsets of standard JSON Schema. This module
 * exposes one option-driven core plus thin dispatchers that pin the option set
 * for each target.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { dereferenceJsonSchema } from "./dereference";
import { upgradeJsonSchemaTo202012 } from "./draft";
import { areJsonValuesEqual, mergePropertySchemas } from "./equality";
import {
	CLOUD_CODE_ASSIST_SHARED_SCHEMA_KEYS,
	CLOUD_CODE_ASSIST_TYPE_SPECIFIC_KEYS,
	LIFTABLE_TO_DESCRIPTION_FIELDS,
	UNSUPPORTED_SCHEMA_FIELDS,
} from "./fields";
import { isValidJsonSchema } from "./meta-validator";
import { type DescriptionSpillFormat, spillToDescription } from "./spill";
import { epochNext, once } from "./stamps";
import type { JsonObject } from "./types";
import { isJsonObject } from "./types";

export type ResidualSchemaIncompatibility = "type-array" | "type-null" | "nullable" | "combiners";

export interface NormalizeSchemaOptions {
	unsupportedFields: (key: string) => boolean;
	normalizeFieldNames: boolean;
	collapseNullFields: boolean;
	normalizeTypeArrayToNullable: boolean;
	stripNullableKeyword: boolean;
	autoPropertyOrdering: boolean;
	ensureObjectProperties: boolean;
	liftStrippedToDescription:
		| false
		| {
				keys?: (key: string) => boolean;
				format?: DescriptionSpillFormat;
		  };
	mergeObjectCombiners: boolean;
	collapseSameTypeCombiners: boolean;
	collapseMixedTypeCombiners: boolean;
	stripResidualCombinersFixpoint: boolean;
	extractNullableFromUnions: boolean;
	rejectResidualIncompatibilities?: ReadonlyArray<ResidualSchemaIncompatibility>;
	validateAndFallback?: { fallback: unknown };
}

interface NormalizeSchemaWalkOptions extends NormalizeSchemaOptions {
	insideProperties: boolean;
	epoch: number;
}

interface ResidualIncompatibilityChecks {
	typeArray: boolean;
	typeNull: boolean;
	nullable: boolean;
	combiners: boolean;
}

const SNAKE_TO_CAMEL_RENAMES = new Map<string, string>([
	["additional_properties", "additionalProperties"],
	["any_of", "anyOf"],
	["prefix_items", "prefixItems"],
	["property_ordering", "propertyOrdering"],
]);

const JSON_SCHEMA_COMBINERS = ["anyOf", "oneOf"] as const;
const CCA_FORBIDDEN_COMBINERS = new Set(["anyOf", "oneOf", "allOf"]);

const CLOUD_CODE_ASSIST_CLAUDE_FALLBACK_SCHEMA = {
	type: "object",
	properties: {},
} as const;

function isGoogleUnsupportedSchemaField(key: string): boolean {
	return Object.hasOwn(UNSUPPORTED_SCHEMA_FIELDS, key);
}

function isMcpUnsupportedSchemaField(key: string): boolean {
	return key === "$schema";
}

function isDefaultLiftableToDescriptionField(key: string): boolean {
	return Object.hasOwn(LIFTABLE_TO_DESCRIPTION_FIELDS, key);
}

/**
 * Returns `obj` unchanged when no renamable key is present; otherwise returns
 * a fresh shallow-copy with snake_case keys rewritten. The collision rule
 * matches upstream (`pop(from)` → `set(to)`): snake_case wins over an
 * existing camelCase entry, matching python-genai/_transformers.py:751.
 */
function applySnakeCaseRenames(obj: JsonObject): JsonObject {
	let needsRename = false;
	for (const k in obj) {
		if (!Object.hasOwn(obj, k)) continue;
		if (SNAKE_TO_CAMEL_RENAMES.has(k)) {
			needsRename = true;
			break;
		}
	}
	if (!needsRename) return obj;
	const out: JsonObject = {};
	for (const k in obj) {
		if (!Object.hasOwn(obj, k)) continue;
		const renamed = SNAKE_TO_CAMEL_RENAMES.get(k);
		if (renamed !== undefined) {
			out[renamed] = obj[k];
		} else if (!outHasOwn(out, k)) {
			out[k] = obj[k];
		}
	}
	return out;
}

/**
 * `handle_null_fields` (python-genai/_transformers.py:584-640) applied at the
 * parent level BEFORE child recursion — matches upstream's call order at
 * `process_schema` line 768. Returns a new object when changes apply, the
 * original reference otherwise (zero-allocation fast path).
 */
function preHandleNullFields(obj: JsonObject): JsonObject {
	if (obj.type === "null") {
		const out: JsonObject = {};
		for (const k in obj) {
			if (!Object.hasOwn(obj, k) || k === "type") continue;
			out[k] = obj[k];
		}
		out.nullable = true;
		return out;
	}
	if (!Array.isArray(obj.anyOf)) return obj;
	const variants = obj.anyOf as unknown[];
	let sawNull = false;
	const kept: unknown[] = [];
	for (const v of variants) {
		if (isJsonObject(v) && v.type === "null") {
			sawNull = true;
			continue;
		}
		kept.push(v);
	}
	if (!sawNull) return obj;
	const out: JsonObject = {};
	for (const k in obj) {
		if (Object.hasOwn(obj, k)) out[k] = obj[k];
	}
	out.nullable = true;
	if (kept.length === 0) {
		delete out.anyOf;
	} else if (kept.length === 1 && isJsonObject(kept[0])) {
		delete out.anyOf;
		const only = kept[0];
		for (const k in only) {
			if (Object.hasOwn(only, k) && !outHasOwn(out, k)) out[k] = only[k];
		}
	} else {
		out.anyOf = kept;
	}
	return out;
}

function outHasOwn(obj: JsonObject, key: string): boolean {
	return Object.hasOwn(obj, key);
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

function pushStrippedDescriptionEntry(
	spill: Array<[string, unknown]> | undefined,
	key: string,
	value: unknown,
	options: NormalizeSchemaWalkOptions,
): Array<[string, unknown]> | undefined {
	const lift = options.liftStrippedToDescription;
	if (!lift) return spill;
	const isLiftable = lift.keys ?? isDefaultLiftableToDescriptionField;
	if (!isLiftable(key)) return spill;
	const next = spill ?? [];
	next.push([key, value]);
	return next;
}

function applyDescriptionSpill(
	result: JsonObject,
	spill: Array<[string, unknown]> | undefined,
	options: NormalizeSchemaWalkOptions,
): void {
	const lift = options.liftStrippedToDescription;
	if (!lift || spill === undefined) return;
	spillToDescription(result, spill, lift.format ?? "spill");
}

function normalizeSchemaNode(value: unknown, options: NormalizeSchemaWalkOptions): unknown {
	if (Array.isArray(value)) {
		if (!once(value, options.epoch)) return [];
		return value.map(entry => normalizeSchemaNode(entry, options));
	}
	if (!isJsonObject(value)) {
		return value;
	}
	if (!once(value, options.epoch)) return {};
	let obj = options.normalizeFieldNames && !options.insideProperties ? applySnakeCaseRenames(value) : value;
	if (options.collapseNullFields && !options.insideProperties) {
		obj = preHandleNullFields(obj);
	}
	const result: JsonObject = {};
	let spill: Array<[string, unknown]> | undefined;
	for (const combiner of JSON_SCHEMA_COMBINERS) {
		if (!Array.isArray(obj[combiner])) continue;
		const variants = obj[combiner] as JsonObject[];
		const allHaveConst = variants.every(v => isJsonObject(v) && "const" in v);
		if (!allHaveConst || variants.length === 0) continue;

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
				if (inferredTypes.includes("null") && nonNullTypeSet.size === 1) {
					result.type = nonNullInferredTypes[0];
					if (!options.stripNullableKeyword) {
						result.nullable = true;
					}
				}
			}
		}

		for (const key in obj) {
			if (!Object.hasOwn(obj, key) || key === combiner || outHasOwn(result, key)) continue;
			const entry = obj[key];
			if (!options.insideProperties && options.unsupportedFields(key)) {
				spill = pushStrippedDescriptionEntry(spill, key, entry, options);
				continue;
			}
			if (options.stripNullableKeyword && key === "nullable") continue;
			result[key] = normalizeSchemaNode(entry, {
				...options,
				insideProperties: key === "properties",
			});
		}
		applyDescriptionSpill(result, spill, options);
		return applyNodePostProcessing(result, options);
	}

	let constValue: unknown;
	for (const key in obj) {
		if (!Object.hasOwn(obj, key)) continue;
		const entry = obj[key];
		if (!options.insideProperties && options.unsupportedFields(key)) {
			spill = pushStrippedDescriptionEntry(spill, key, entry, options);
			continue;
		}
		if (options.stripNullableKeyword && key === "nullable") continue;
		if (key === "const") {
			constValue = entry;
			continue;
		}
		result[key] = normalizeSchemaNode(entry, {
			...options,
			insideProperties: key === "properties",
		});
	}

	if (options.normalizeTypeArrayToNullable && Array.isArray(result.type)) {
		const types = (result.type as unknown[]).filter((t): t is string => typeof t === "string");
		const nonNull = types.filter(t => t !== "null");
		if (types.includes("null") && !options.stripNullableKeyword) {
			result.nullable = true;
		}
		result.type = nonNull[0] ?? types[0];
	}
	if (constValue !== undefined) {
		const existingEnum = Array.isArray(result.enum) ? result.enum : [];
		pushEnumValue(existingEnum, constValue);
		result.enum = existingEnum;
		if (!result.type) {
			result.type = inferJsonSchemaTypeFromValue(constValue);
		}
	}

	if (options.collapseNullFields && result.type === "null") {
		delete result.type;
		if (!options.stripNullableKeyword) result.nullable = true;
	}

	if (
		options.autoPropertyOrdering &&
		result.type === "object" &&
		!outHasOwn(result, "propertyOrdering") &&
		isJsonObject(result.properties)
	) {
		const props = result.properties;
		const keys: string[] = [];
		for (const k in props) {
			if (Object.hasOwn(props, k)) keys.push(k);
		}
		if (keys.length > 1) result.propertyOrdering = keys;
	}

	if (options.ensureObjectProperties && result.type === "object" && !outHasOwn(result, "properties")) {
		result.properties = {};
	}

	applyDescriptionSpill(result, spill, options);
	return applyNodePostProcessing(result, options);
}

function applyNodePostProcessing(schema: JsonObject, options: NormalizeSchemaWalkOptions): JsonObject {
	let current = schema;
	for (const combiner of JSON_SCHEMA_COMBINERS) {
		if (options.mergeObjectCombiners) current = mergeObjectCombinerVariants(current, combiner);
		if (options.collapseMixedTypeCombiners) current = collapseMixedTypeCombinerVariants(current, combiner);
		if (options.collapseSameTypeCombiners) current = collapseSameTypeCombinerVariants(current, combiner);
	}
	return current;
}

/** Copy all keys from a schema except the specified combiner key. */
export function copySchemaWithout(schema: JsonObject, combiner: string): JsonObject {
	const { [combiner]: _, ...rest } = schema;
	return rest;
}

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
	for (const name in ownProperties) {
		if (Object.hasOwn(ownProperties, name)) mergedProperties[name] = ownProperties[name];
	}

	for (const variant of variants) {
		const properties = isJsonObject(variant.properties) ? variant.properties : {};
		for (const name in properties) {
			if (!Object.hasOwn(properties, name)) continue;
			const propertySchema = properties[name];
			const existingSchema = mergedProperties[name];
			mergedProperties[name] =
				existingSchema === undefined ? propertySchema : mergePropertySchemas(existingSchema, propertySchema);
		}
	}

	const nextSchema = copySchemaWithout(schema, combiner);
	nextSchema.type = "object";
	nextSchema.properties = mergedProperties;

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
	const safeRequired = new Set<string>();
	for (const name of requiredIntersection ?? []) {
		if (Object.hasOwn(mergedProperties, name)) safeRequired.add(name);
	}
	for (const name of parentRequired) {
		if (Object.hasOwn(ownProperties, name) && Object.hasOwn(mergedProperties, name)) {
			safeRequired.add(name);
		}
	}
	const requiredInPropertyOrder: string[] = [];
	for (const name in mergedProperties) {
		if (Object.hasOwn(mergedProperties, name) && safeRequired.has(name)) requiredInPropertyOrder.push(name);
	}
	if (requiredInPropertyOrder.length > 0) {
		nextSchema.required = requiredInPropertyOrder;
	} else {
		delete nextSchema.required;
	}

	return nextSchema;
}

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

		for (const key in entry) {
			if (!Object.hasOwn(entry, key)) continue;
			const variantValue = entry[key];
			if (key === "type") continue;
			if (!Object.hasOwn(allowedKeys, key) && !Object.hasOwn(CLOUD_CODE_ASSIST_SHARED_SCHEMA_KEYS, key)) {
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
	nextSchema.type = nonNullTypes[0] ?? variantTypes[0];
	for (const key in mergedVariantFields) {
		if (!Object.hasOwn(mergedVariantFields, key)) continue;
		const value = mergedVariantFields[key];
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
	for (const key in firstEntry) {
		if (Object.hasOwn(firstEntry, key) && !outHasOwn(nextSchema, key)) nextSchema[key] = firstEntry[key];
	}
	return nextSchema;
}

/**
 * Recursively strip any remaining anyOf/oneOf that same-type or mixed-type
 * collapse can handle. This is needed because object-combiner merging can
 * create new anyOf in merged subtrees after child normalization already ran.
 */
export function stripResidualCombiners(value: unknown, epoch: number = epochNext()): unknown {
	if (Array.isArray(value)) {
		if (!once(value, epoch)) return [];
		return value.map(entry => stripResidualCombiners(entry, epoch));
	}
	if (!isJsonObject(value)) return value;
	if (!once(value, epoch)) return {};
	const result: JsonObject = {};
	for (const key in value) {
		if (Object.hasOwn(value, key)) result[key] = stripResidualCombiners(value[key], epoch);
	}
	let current: JsonObject = result;
	let changed = true;
	while (changed) {
		changed = false;
		for (const combiner of JSON_SCHEMA_COMBINERS) {
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

	for (const combiner of JSON_SCHEMA_COMBINERS) {
		const variantsRaw = schema[combiner];
		if (!Array.isArray(variantsRaw)) continue;

		let hasNullVariant = false;
		const nonNullVariants: unknown[] = [];
		for (const variant of variantsRaw) {
			if (isJsonObject(variant) && variant.type === "null") {
				let keyCount = 0;
				for (const k in variant) {
					if (!Object.hasOwn(variant, k)) continue;
					if (++keyCount > 1) break;
				}
				if (keyCount === 1) {
					hasNullVariant = true;
					continue;
				}
			}
			nonNullVariants.push(variant);
		}

		if (!hasNullVariant || nonNullVariants.length !== 1 || !isJsonObject(nonNullVariants[0])) {
			continue;
		}

		const nextSchema = copySchemaWithout(schema, combiner);
		const nonNullVariant = nonNullVariants[0];
		for (const key in nonNullVariant) {
			if (!Object.hasOwn(nonNullVariant, key)) continue;
			const value = nonNullVariant[key];
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
	epoch: number = epochNext(),
): NullableNormalizationResult {
	if (Array.isArray(value)) {
		if (!once(value, epoch)) {
			return { schema: [], nullable: false };
		}
		return {
			schema: value.map(entry => normalizeNullablePropertiesForCloudCodeAssist(entry, false, epoch).schema),
			nullable: false,
		};
	}
	if (!isJsonObject(value)) {
		return { schema: value, nullable: false };
	}
	if (!once(value, epoch)) {
		return { schema: {}, nullable: false };
	}

	const normalized: JsonObject = {};
	for (const key in value) {
		if (Object.hasOwn(value, key))
			normalized[key] = normalizeNullablePropertiesForCloudCodeAssist(value[key], false, epoch).schema;
	}

	if (isJsonObject(normalized.properties)) {
		const properties = normalized.properties;
		const required = new Set(
			Array.isArray(normalized.required)
				? normalized.required.filter((entry): entry is string => typeof entry === "string")
				: [],
		);
		const nextProperties: JsonObject = {};
		for (const name in properties) {
			if (!Object.hasOwn(properties, name)) continue;
			const normalizedProperty = normalizeNullablePropertiesForCloudCodeAssist(properties[name], true, epoch);
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

function createResidualIncompatibilityChecks(
	checks: ReadonlyArray<ResidualSchemaIncompatibility> | undefined,
): ResidualIncompatibilityChecks | undefined {
	if (!checks || checks.length === 0) return undefined;
	const result: ResidualIncompatibilityChecks = {
		typeArray: false,
		typeNull: false,
		nullable: false,
		combiners: false,
	};
	for (const check of checks) {
		switch (check) {
			case "type-array":
				result.typeArray = true;
				break;
			case "type-null":
				result.typeNull = true;
				break;
			case "nullable":
				result.nullable = true;
				break;
			case "combiners":
				result.combiners = true;
				break;
		}
	}
	return result;
}

function hasResidualSchemaIncompatibilities(
	value: unknown,
	checks: ResidualIncompatibilityChecks,
	epoch: number = epochNext(),
): boolean {
	if (Array.isArray(value)) {
		if (!once(value, epoch)) return false;
		return value.some(entry => hasResidualSchemaIncompatibilities(entry, checks, epoch));
	}
	if (!isJsonObject(value)) {
		return false;
	}
	if (!once(value, epoch)) {
		return false;
	}

	if (checks.typeArray && Array.isArray(value.type)) return true;
	if (checks.typeNull && value.type === "null") return true;
	if (checks.nullable && Object.hasOwn(value, "nullable")) return true;
	if (checks.combiners) {
		for (const combiner of CCA_FORBIDDEN_COMBINERS) {
			if (Array.isArray(value[combiner])) return true;
		}
	}
	for (const k in value) {
		if (!Object.hasOwn(value, k)) continue;
		if (hasResidualSchemaIncompatibilities(value[k], checks, epoch)) {
			return true;
		}
	}
	return false;
}

export function normalizeSchema(value: unknown, options: NormalizeSchemaOptions): unknown {
	const upgraded = upgradeJsonSchemaTo202012(value);
	const dereferenced = dereferenceJsonSchema(upgraded);
	let normalized = normalizeSchemaNode(dereferenced, {
		...options,
		insideProperties: false,
		epoch: epochNext(),
	});
	if (options.stripResidualCombinersFixpoint) {
		normalized = stripResidualCombiners(normalized);
	}
	if (options.extractNullableFromUnions) {
		normalized = normalizeNullablePropertiesForCloudCodeAssist(normalized).schema;
	}
	const residualChecks = createResidualIncompatibilityChecks(options.rejectResidualIncompatibilities);
	if (residualChecks && hasResidualSchemaIncompatibilities(normalized, residualChecks)) {
		logger.debug("Schema has residual provider incompatibilities, using fallback");
		return options.validateAndFallback?.fallback ?? normalized;
	}
	if (options.validateAndFallback && !isValidJsonSchema(normalized)) {
		logger.debug("Schema failed validation, using fallback");
		return options.validateAndFallback.fallback;
	}
	return normalized;
}

export function normalizeSchemaForGoogle(value: unknown): unknown {
	return normalizeSchema(value, {
		unsupportedFields: isGoogleUnsupportedSchemaField,
		normalizeFieldNames: true,
		collapseNullFields: true,
		normalizeTypeArrayToNullable: true,
		stripNullableKeyword: false,
		autoPropertyOrdering: true,
		ensureObjectProperties: true,
		liftStrippedToDescription: { format: "spill" },
		mergeObjectCombiners: false,
		collapseSameTypeCombiners: false,
		collapseMixedTypeCombiners: false,
		stripResidualCombinersFixpoint: false,
		extractNullableFromUnions: false,
	});
}

export function normalizeSchemaForCCA(value: unknown): unknown {
	return normalizeSchema(value, {
		unsupportedFields: isGoogleUnsupportedSchemaField,
		normalizeFieldNames: true,
		collapseNullFields: false,
		normalizeTypeArrayToNullable: true,
		stripNullableKeyword: true,
		autoPropertyOrdering: false,
		ensureObjectProperties: true,
		liftStrippedToDescription: { format: "spill" },
		mergeObjectCombiners: true,
		collapseSameTypeCombiners: true,
		collapseMixedTypeCombiners: true,
		stripResidualCombinersFixpoint: true,
		extractNullableFromUnions: true,
		rejectResidualIncompatibilities: ["type-array", "type-null", "nullable", "combiners"],
		validateAndFallback: { fallback: CLOUD_CODE_ASSIST_CLAUDE_FALLBACK_SCHEMA },
	});
}

export function normalizeSchemaForMCP(value: unknown): unknown {
	return normalizeSchema(value, {
		unsupportedFields: isMcpUnsupportedSchemaField,
		normalizeFieldNames: false,
		collapseNullFields: false,
		normalizeTypeArrayToNullable: false,
		stripNullableKeyword: true,
		autoPropertyOrdering: false,
		ensureObjectProperties: false,
		liftStrippedToDescription: false,
		mergeObjectCombiners: false,
		collapseSameTypeCombiners: false,
		collapseMixedTypeCombiners: false,
		stripResidualCombinersFixpoint: false,
		extractNullableFromUnions: false,
	});
}
