/**
 * Field classification sets for JSON Schema sanitization across providers.
 *
 * Each set serves a different provider need. They overlap intentionally —
 * co-locating them makes the overlap visible and maintainable.
 */

/**
 * Google Generative AI unsupported schema fields.
 * Stripped during sanitizeSchemaForGoogle / sanitizeSchemaForCCA.
 */
export const UNSUPPORTED_SCHEMA_FIELDS = new Set([
	"$schema",
	"$ref",
	"$defs",
	"$dynamicRef",
	"$dynamicAnchor",
	"examples",
	"prefixItems",
	"unevaluatedProperties",
	"unevaluatedItems",
	"patternProperties",
	"additionalProperties",
	"propertyNames",
	"minItems",
	"maxItems",
	"minLength",
	"maxLength",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"pattern",
	"format",
]);

/**
 * Non-structural schema keys stripped during OpenAI strict mode sanitization.
 * These are decorative/validation-only keywords that don't affect the structural
 * shape OpenAI's strict mode enforces.
 */
export const NON_STRUCTURAL_SCHEMA_KEYS = new Set([
	"format",
	"pattern",
	"minLength",
	"maxLength",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"minItems",
	"maxItems",
	"uniqueItems",
	"multipleOf",
	"$schema",
	"examples",
	"default",
	"title",
	"$comment",
	"if",
	"then",
	"else",
	"not",
	"unevaluatedProperties",
	"unevaluatedItems",
	"patternProperties",
	"propertyNames",
	"contains",
	"minContains",
	"maxContains",
	"dependentRequired",
	"dependentSchemas",
	"contentEncoding",
	"contentMediaType",
	"contentSchema",
	"deprecated",
	"readOnly",
	"writeOnly",
	"minProperties",
	"maxProperties",
	"$dynamicRef",
	"$dynamicAnchor",
]);

/**
 * Cloud Code Assist type-specific allowed keys per JSON Schema type.
 * Used when collapsing mixed-type combiner variants for CCA Claude.
 */
export const CLOUD_CODE_ASSIST_TYPE_SPECIFIC_KEYS: Record<string, ReadonlySet<string>> = {
	array: new Set([
		"items",
		"prefixItems",
		"contains",
		"minContains",
		"maxContains",
		"minItems",
		"maxItems",
		"uniqueItems",
		"unevaluatedItems",
	]),
	object: new Set([
		"properties",
		"required",
		"additionalProperties",
		"patternProperties",
		"propertyNames",
		"minProperties",
		"maxProperties",
		"dependentRequired",
		"dependentSchemas",
		"unevaluatedProperties",
	]),
	string: new Set(["minLength", "maxLength", "pattern", "format", "contentEncoding", "contentMediaType"]),
	number: new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]),
	integer: new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]),
	boolean: new Set(),
	null: new Set(),
};

/**
 * Cloud Code Assist shared schema keys allowed on any type.
 * Used alongside CLOUD_CODE_ASSIST_TYPE_SPECIFIC_KEYS for CCA combiner collapsing.
 */
export const CLOUD_CODE_ASSIST_SHARED_SCHEMA_KEYS = new Set([
	"title",
	"description",
	"default",
	"examples",
	"deprecated",
	"readOnly",
	"writeOnly",
	"$comment",
]);

/**
 * Combinator keys used across schema sanitization modules.
 * Defined once to avoid duplication in strict-mode.ts and normalize-cca.ts.
 */
export const COMBINATOR_KEYS = ["anyOf", "allOf", "oneOf"] as const;

/**
 * Cloud Code Assist Claude unsupported schema fields.
 * Much smaller than UNSUPPORTED_SCHEMA_FIELDS (Google) because CCA supports
 * validation keywords like additionalProperties, minLength, pattern, etc.
 * Meta/reference keywords plus object-key validators that CCA cannot resolve are stripped.
 */
export const CCA_UNSUPPORTED_SCHEMA_FIELDS = new Set([
	"$schema",
	"$ref",
	"$defs",
	"$dynamicRef",
	"$dynamicAnchor",
	"propertyNames",
]);
