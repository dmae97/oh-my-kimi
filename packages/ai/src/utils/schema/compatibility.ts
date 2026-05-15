import {
	CCA_UNSUPPORTED_SCHEMA_FIELDS,
	COMBINATOR_KEYS,
	NON_STRUCTURAL_SCHEMA_KEYS,
	UNSUPPORTED_SCHEMA_FIELDS,
} from "./fields";
import { isValidJsonSchema } from "./meta-validator";
import { isJsonObject, type JsonObject } from "./types";

export type SchemaCompatibilityProvider = "openai-strict" | "google" | "cloud-code-assist-claude";

export interface SchemaCompatibilityViolation {
	path: string;
	rule: string;
	message: string;
	key?: string;
	value?: unknown;
}

export interface SchemaCompatibilityResult {
	provider: SchemaCompatibilityProvider;
	compatible: boolean;
	violations: SchemaCompatibilityViolation[];
}

export interface StrictSchemaEnforcementResult {
	schema: Record<string, unknown>;
	strict: boolean;
}

const STRICT_FORBIDDEN_KEYS = new Set([...NON_STRUCTURAL_SCHEMA_KEYS, "const", "nullable"]);
const GOOGLE_FORBIDDEN_KEYS = new Set([...UNSUPPORTED_SCHEMA_FIELDS, "const"]);
const CCA_FORBIDDEN_KEYS = new Set([...CCA_UNSUPPORTED_SCHEMA_FIELDS, "const"]);

const NON_SCHEMA_CONTAINER_ARRAY_KEYS = new Set(["enum", "required", "examples", "type"]);
const NON_SCHEMA_CONTAINER_OBJECT_KEYS = new Set(["const", "default", "example"]);

interface TraversalState {
	path: string;
}

function createViolation(
	path: string,
	rule: string,
	message: string,
	key?: string,
	value?: unknown,
): SchemaCompatibilityViolation {
	return {
		path,
		rule,
		message,
		...(key === undefined ? {} : { key }),
		...(value === undefined ? {} : { value }),
	};
}

function walkSchema(
	value: unknown,
	state: TraversalState,
	visitNode: (node: JsonObject, state: TraversalState) => void,
): void {
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			walkSchema(value[index], { path: `${state.path}[${index}]` }, visitNode);
		}
		return;
	}

	if (!isJsonObject(value)) {
		return;
	}

	visitNode(value, state);

	for (const [key, entry] of Object.entries(value)) {
		if (key === "properties" || key === "$defs" || key === "definitions" || key === "dependentSchemas") {
			if (isJsonObject(entry)) {
				for (const [name, child] of Object.entries(entry)) {
					walkSchema(child, { path: `${state.path}.${key}.${name}` }, visitNode);
				}
			}
			continue;
		}

		if (NON_SCHEMA_CONTAINER_ARRAY_KEYS.has(key) || NON_SCHEMA_CONTAINER_OBJECT_KEYS.has(key)) {
			continue;
		}

		if (Array.isArray(entry)) {
			for (let index = 0; index < entry.length; index++) {
				walkSchema(entry[index], { path: `${state.path}.${key}[${index}]` }, visitNode);
			}
			continue;
		}

		if (isJsonObject(entry)) {
			walkSchema(entry, { path: `${state.path}.${key}` }, visitNode);
		}
	}
}

function validateStrictNode(node: JsonObject, state: TraversalState): SchemaCompatibilityViolation[] {
	const violations: SchemaCompatibilityViolation[] = [];

	for (const [key, value] of Object.entries(node)) {
		if (!STRICT_FORBIDDEN_KEYS.has(key)) {
			continue;
		}

		violations.push(
			createViolation(
				`${state.path}.${key}`,
				"strict-forbidden-key",
				`Strict schema contains forbidden key "${key}"`,
				key,
				value,
			),
		);
	}

	const hasCombinator = COMBINATOR_KEYS.some(key => Array.isArray(node[key]));
	const hasRef = typeof node.$ref === "string";
	const hasNot = isJsonObject(node.not);
	if (node.type === undefined && !hasCombinator && !hasRef && !hasNot) {
		violations.push(
			createViolation(
				state.path,
				"strict-unrepresentable-node",
				"Strict schema node must declare type, combinator, $ref, or not",
			),
		);
	}

	const isObjectNode = node.type === "object" || isJsonObject(node.properties);
	if (!isObjectNode) {
		return violations;
	}

	if (node.additionalProperties !== false) {
		violations.push(
			createViolation(
				`${state.path}.additionalProperties`,
				"strict-object-additional-properties",
				"Strict object schema must set additionalProperties to false",
				"additionalProperties",
				node.additionalProperties,
			),
		);
	}

	if (!isJsonObject(node.properties)) {
		violations.push(
			createViolation(
				`${state.path}.properties`,
				"strict-object-properties",
				"Strict object schema must provide an object-valued properties map",
				"properties",
				node.properties,
			),
		);
		return violations;
	}

	const propertyNames = Object.keys(node.properties);
	const requiredValues = Array.isArray(node.required)
		? node.required.filter((entry): entry is string => typeof entry === "string")
		: [];
	const requiredSet = new Set(requiredValues);

	for (const propertyName of propertyNames) {
		if (requiredSet.has(propertyName)) {
			continue;
		}
		violations.push(
			createViolation(
				`${state.path}.required`,
				"strict-object-required",
				`Strict object schema must require property "${propertyName}"`,
				"required",
				node.required,
			),
		);
	}

	const propertyNameSet = new Set(propertyNames);
	for (const requiredKey of requiredValues) {
		if (propertyNameSet.has(requiredKey)) {
			continue;
		}
		violations.push(
			createViolation(
				`${state.path}.required`,
				"strict-object-required-extra",
				`Strict object schema requires non-existent property "${requiredKey}"`,
				"required",
				node.required,
			),
		);
	}

	return violations;
}

function validateGoogleNode(node: JsonObject, state: TraversalState): SchemaCompatibilityViolation[] {
	const violations: SchemaCompatibilityViolation[] = [];

	for (const [key, value] of Object.entries(node)) {
		if (!GOOGLE_FORBIDDEN_KEYS.has(key)) {
			continue;
		}
		violations.push(
			createViolation(
				`${state.path}.${key}`,
				"google-forbidden-key",
				`Google schema contains unsupported key "${key}"`,
				key,
				value,
			),
		);
	}

	if (Array.isArray(node.type)) {
		violations.push(
			createViolation(
				`${state.path}.type`,
				"google-type-array",
				"Google schema type must be a scalar string, not an array",
				"type",
				node.type,
			),
		);
	}

	return violations;
}

function validateCloudCodeAssistNode(node: JsonObject, state: TraversalState): SchemaCompatibilityViolation[] {
	const violations: SchemaCompatibilityViolation[] = [];

	for (const [key, value] of Object.entries(node)) {
		if (CCA_FORBIDDEN_KEYS.has(key)) {
			violations.push(
				createViolation(
					`${state.path}.${key}`,
					"cca-forbidden-key",
					`Cloud Code Assist schema contains unsupported key "${key}"`,
					key,
					value,
				),
			);
		}
	}

	if (Array.isArray(node.type)) {
		violations.push(
			createViolation(
				`${state.path}.type`,
				"cca-type-array",
				"Cloud Code Assist schema forbids array-valued type",
				"type",
				node.type,
			),
		);
	}

	if (node.type === "null") {
		violations.push(
			createViolation(
				`${state.path}.type`,
				"cca-null-type",
				'Cloud Code Assist schema forbids type: "null"',
				"type",
				node.type,
			),
		);
	}

	if (Object.hasOwn(node, "nullable")) {
		violations.push(
			createViolation(
				`${state.path}.nullable`,
				"cca-nullable-key",
				"Cloud Code Assist schema forbids nullable keyword",
				"nullable",
				node.nullable,
			),
		);
	}

	for (const key of COMBINATOR_KEYS) {
		if (Array.isArray(node[key])) {
			violations.push(
				createViolation(
					`${state.path}.${key}`,
					"cca-combiner",
					`Cloud Code Assist schema forbids ${key}`,
					key,
					node[key],
				),
			);
		}
	}

	return violations;
}

function validateCloudCodeAssistSchema(schema: unknown): SchemaCompatibilityViolation[] {
	if (isValidJsonSchema(schema)) {
		return [];
	}
	return [
		createViolation(
			"root",
			"cca-meta-schema-validation",
			"Cloud Code Assist schema is not a structurally valid JSON Schema",
		),
	];
}

export function validateSchemaCompatibility(
	schema: unknown,
	provider: SchemaCompatibilityProvider,
): SchemaCompatibilityResult {
	const violations: SchemaCompatibilityViolation[] = [];

	switch (provider) {
		case "openai-strict": {
			walkSchema(schema, { path: "root" }, (node, state) => {
				violations.push(...validateStrictNode(node, state));
			});
			break;
		}
		case "google": {
			walkSchema(schema, { path: "root" }, (node, state) => {
				violations.push(...validateGoogleNode(node, state));
			});
			break;
		}
		case "cloud-code-assist-claude": {
			walkSchema(schema, { path: "root" }, (node, state) => {
				violations.push(...validateCloudCodeAssistNode(node, state));
			});
			violations.push(...validateCloudCodeAssistSchema(schema));
			break;
		}
	}

	return {
		provider,
		compatible: violations.length === 0,
		violations,
	};
}

export function validateStrictSchemaEnforcement(
	originalSchema: Record<string, unknown>,
	result: StrictSchemaEnforcementResult,
): SchemaCompatibilityResult {
	if (result.strict) {
		return validateSchemaCompatibility(result.schema, "openai-strict");
	}

	const violations: SchemaCompatibilityViolation[] = [];
	if (result.schema !== originalSchema) {
		violations.push(
			createViolation(
				"root",
				"strict-fail-open-original-schema",
				"Strict fail-open must return the original schema object when strict=false",
			),
		);
	}

	return {
		provider: "openai-strict",
		compatible: violations.length === 0,
		violations,
	};
}
