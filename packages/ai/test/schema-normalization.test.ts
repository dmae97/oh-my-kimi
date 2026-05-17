import { describe, expect, it } from "bun:test";
import { buildRequest } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import { convertTools } from "@oh-my-pi/pi-ai/providers/google-shared";
import type { Context, Model, TJsonSchema, Tool } from "@oh-my-pi/pi-ai/types";
import {
	enforceStrictSchema,
	mergeCompatibleEnumSchemas,
	normalizeSchemaForCCA,
	normalizeSchemaForGoogle,
	normalizeSchemaForMCP,
	sanitizeSchemaForOpenAIResponses,
	sanitizeSchemaForStrictMode,
	schemaNeedsDraft202012Upgrade,
	stripResidualCombiners,
	tryEnforceStrictSchema,
	upgradeJsonSchemaTo202012,
} from "@oh-my-pi/pi-ai/utils/schema";

function createGoogleCliModel(id: string): Model<"google-gemini-cli"> {
	return {
		id,
		name: id,
		api: "google-gemini-cli",
		provider: "google-antigravity",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

// ---------------------------------------------------------------------------
// mergeCompatibleEnumSchemas
// ---------------------------------------------------------------------------

describe("mergeCompatibleEnumSchemas", () => {
	it("deduplicates object-valued enum members by deep equality", () => {
		const existing = { type: "object", enum: [{ x: 1 }] };
		const incoming = { type: "object", enum: [{ x: 1 }] };

		expect(mergeCompatibleEnumSchemas(existing, incoming)).toEqual({
			type: "object",
			enum: [{ x: 1 }],
		});
	});

	it("deduplicates structurally equal nested enum values and appends novel ones", () => {
		const existing = {
			type: "object",
			enum: [{ kind: "A", payload: { level: 1 } }],
		};
		const incoming = {
			type: "object",
			enum: [
				{ kind: "A", payload: { level: 1 } },
				{ kind: "B", payload: { level: 2 } },
			],
		};

		const merged = mergeCompatibleEnumSchemas(existing, incoming);

		expect(merged).toEqual({
			type: "object",
			enum: [
				{ kind: "A", payload: { level: 1 } },
				{ kind: "B", payload: { level: 2 } },
			],
		});
	});
});

// ---------------------------------------------------------------------------
// sanitizeSchemaForStrictMode
// ---------------------------------------------------------------------------

describe("sanitizeSchemaForStrictMode", () => {
	it("converts nullable keyword to explicit null union", () => {
		const sanitized = sanitizeSchemaForStrictMode({
			type: "string",
			nullable: true,
		});

		expect(sanitized).toEqual({
			anyOf: [{ type: "string" }, { type: "null" }],
		});
	});

	it("hoists description to the wrapper when wrapping `nullable: true` as an anyOf", () => {
		// Sanitize-side nullable wrap mirrors the optional-property wrap shape
		// produced by `enforceStrictSchema`: description lives on the wrapper,
		// branches stay bare. Both top-level entry points share this contract
		// so downstream consumers don't have to special-case which path produced
		// the nullable union.
		const sanitized = sanitizeSchemaForStrictMode({
			type: "string",
			nullable: true,
			description: "label",
		});

		expect(sanitized).toEqual({
			anyOf: [{ type: "string" }, { type: "null" }],
			description: "label",
		});
	});

	it("strips not branches", () => {
		const schema = {
			type: "object",
			not: {
				type: "object",
				properties: { token: { const: "secret" } },
				required: ["token"],
			},
		} as Record<string, unknown>;

		const sanitized = sanitizeSchemaForStrictMode(schema);

		expect(sanitized.not).toBeUndefined();
	});

	it("merges const into existing enum instead of overwriting", () => {
		const schema = {
			type: "string",
			enum: ["A", "B"],
			const: "C",
		} as Record<string, unknown>;

		const sanitized = sanitizeSchemaForStrictMode(schema);

		expect(sanitized.enum).toEqual(["A", "B", "C"]);
	});
});

// ---------------------------------------------------------------------------
// upgradeJsonSchemaTo202012
// ---------------------------------------------------------------------------

describe("upgradeJsonSchemaTo202012", () => {
	it("infers draft-07 tuple and dependency keywords without a $schema URI", () => {
		const schema = {
			type: "object",
			properties: {
				definitions: { type: "string" },
				tuple: {
					type: "array",
					items: [{ type: "string" }, { type: "integer" }],
					additionalItems: false,
				},
				gated: {
					type: "object",
					dependencies: {
						a: ["b"],
						c: { required: ["d"] },
					},
				},
			},
			definitions: {
				Ref: { type: "string" },
			},
		};

		expect(schemaNeedsDraft202012Upgrade(schema)).toBe(true);
		expect(upgradeJsonSchemaTo202012(schema)).toEqual({
			type: "object",
			properties: {
				definitions: { type: "string" },
				tuple: {
					type: "array",
					prefixItems: [{ type: "string" }, { type: "integer" }],
					items: false,
				},
				gated: {
					type: "object",
					dependentRequired: { a: ["b"] },
					dependentSchemas: { c: { required: ["d"] } },
				},
			},
			$defs: {
				Ref: { type: "string" },
			},
		});
	});

	it("returns unchanged schemas by identity when no draft upgrade is needed", () => {
		const schema = { type: "object", properties: { name: { type: "string" } } };

		expect(schemaNeedsDraft202012Upgrade(schema)).toBe(false);
		expect(upgradeJsonSchemaTo202012(schema)).toBe(schema);
	});
});

// ---------------------------------------------------------------------------
// normalizeSchemaForGoogle
// ---------------------------------------------------------------------------

describe("normalizeSchemaForGoogle", () => {
	it("sets object type when converting an object const to an enum entry", () => {
		const sanitized = normalizeSchemaForGoogle({
			const: { a: 1 },
		});

		expect(sanitized).toEqual({
			type: "object",
			properties: {},
			enum: [{ a: 1 }],
		});
	});

	it("deduplicates a deep-equal object const against an existing enum entry", () => {
		const sanitized = normalizeSchemaForGoogle({
			type: "object",
			enum: [{ a: 1 }],
			const: { a: 1 },
		});

		expect(sanitized).toEqual({
			type: "object",
			properties: {},
			enum: [{ a: 1 }],
		});
	});

	it("does not stamp a wrong scalar type when const variants span multiple primitive types", () => {
		const sanitized = normalizeSchemaForGoogle({
			anyOf: [
				{ const: "A", type: "string" },
				{ const: 1, type: "number" },
				{ const: true, type: "boolean" },
			],
		}) as Record<string, unknown>;

		expect(sanitized.enum).toEqual(["A", 1, true]);
		expect(sanitized.type).toBeUndefined();
	});

	it("collapses inferred null type to nullable when const is null", () => {
		// After python-genai parity (handle_null_fields), bare `type: 'null'` is
		// folded into `nullable: true` so the schema is OpenAPI-compatible.
		const sanitized = normalizeSchemaForGoogle({ const: null }) as Record<string, unknown>;

		expect(sanitized.type).toBeUndefined();
		expect(sanitized.nullable).toBe(true);
		expect(sanitized.enum).toEqual([null]);
	});

	it("preserves a property schema literally named additionalProperties inside properties", () => {
		const sanitized = normalizeSchemaForGoogle({
			type: "object",
			properties: {
				additionalProperties: false,
				name: { type: "string" },
			},
		}) as Record<string, unknown>;

		const properties = sanitized.properties as Record<string, unknown>;
		expect(Object.hasOwn(properties, "additionalProperties")).toBe(true);
		expect(properties.additionalProperties).toBe(false);
	});

	it("preserves boolean schemas for a single property literally named additionalProperties", () => {
		const schema = {
			type: "object",
			properties: {
				additionalProperties: false,
			},
			required: ["additionalProperties"],
		} as const;

		expect(normalizeSchemaForGoogle(schema)).toEqual(schema);
	});

	it("inlines local $ref / $defs entries for Google compatibility", () => {
		// Mirrors python-genai/_transformers.py:754-774 ($defs inlining via
		// `process_schema`) and tests/transformers/test_schema.py::
		// test_process_schema_order_properties_propagates_into_defs.
		const schema = {
			type: "object",
			properties: {
				user: { $ref: "#/$defs/User" },
			},
			required: ["user"],
			$defs: {
				User: {
					type: "object",
					properties: {
						id: { type: "string" },
					},
					required: ["id"],
				},
			},
		} as const;

		expect(normalizeSchemaForGoogle(schema)).toEqual({
			type: "object",
			properties: {
				user: {
					type: "object",
					properties: {
						id: { type: "string" },
					},
					required: ["id"],
				},
			},
			required: ["user"],
		});
	});

	it("lifts stripped validation keywords into description", () => {
		const normalized = normalizeSchemaForGoogle({
			type: "string",
			pattern: "^\\d+$",
			minLength: 1,
			maxLength: 8,
			description: "ID",
		}) as Record<string, unknown>;

		expect(normalized.pattern).toBeUndefined();
		expect(normalized.minLength).toBeUndefined();
		expect(normalized.maxLength).toBeUndefined();
		expect(normalized.description).toBe('ID\n\n{pattern: "^\\\\d+$", minLength: 1, maxLength: 8}');
	});
});

// ---------------------------------------------------------------------------
// normalizeSchemaForMCP
// ---------------------------------------------------------------------------

describe("normalizeSchemaForMCP", () => {
	it("keeps validation keywords without mutating description", () => {
		const normalized = normalizeSchemaForMCP({
			type: "string",
			pattern: "^\\d+$",
			minLength: 1,
			description: "ID",
		}) as Record<string, unknown>;

		expect(normalized).toEqual({
			type: "string",
			pattern: "^\\d+$",
			minLength: 1,
			description: "ID",
		});
	});
});

// ---------------------------------------------------------------------------
// sanitizeSchemaForOpenAIResponses
// ---------------------------------------------------------------------------

describe("sanitizeSchemaForOpenAIResponses", () => {
	it("adds empty properties to object schemas without rewriting literal payloads", () => {
		const literal = { type: "object", oneOf: [{ const: "literal" }] };
		const schema = {
			type: "object",
			properties: {
				nested: { type: "object" },
				union: {
					oneOf: [{ type: "object" }],
				},
			},
			oneOf: [{ type: "object" }],
			enum: [literal],
			const: literal,
			default: literal,
			examples: [literal],
		};

		expect(sanitizeSchemaForOpenAIResponses(schema)).toEqual({
			type: "object",
			properties: {
				nested: { type: "object", properties: {} },
				union: {
					anyOf: [{ type: "object", properties: {} }],
				},
			},
			enum: [literal],
			const: literal,
			default: literal,
			examples: [literal],
			anyOf: [{ type: "object", properties: {} }],
		});
	});
});

// ---------------------------------------------------------------------------
// enforceStrictSchema and tryEnforceStrictSchema
// ---------------------------------------------------------------------------

describe("enforceStrictSchema and tryEnforceStrictSchema", () => {
	it("keeps strict mode enabled for an enum-only root schema by inferring a concrete type", () => {
		const result = tryEnforceStrictSchema({
			enum: ["draft", "published"],
		});

		expect(result.strict).toBe(true);
		expect(result.schema).toEqual({
			type: "string",
			enum: ["draft", "published"],
		});
	});

	it("keeps strict mode enabled for a const-only root schema by inferring a concrete type", () => {
		const result = tryEnforceStrictSchema({ const: 7 });

		expect(result.strict).toBe(true);
		expect(result.schema).toEqual({
			type: "number",
			enum: [7],
		});
	});

	it("infers array type when items is present without an explicit type", () => {
		const result = tryEnforceStrictSchema({
			items: { type: "string" },
		});

		expect(result.strict).toBe(true);
		expect(result.schema).toEqual({
			type: "array",
			items: { type: "string" },
		});
	});

	it("recurses into $defs and definitions when enforcing strict rules", () => {
		const schema = {
			type: "object",
			properties: {
				payload: { $ref: "#/$defs/Payload" },
				legacy: { $ref: "#/definitions/Legacy" },
			},
			required: ["payload", "legacy"],
			$defs: {
				Payload: {
					type: "object",
					properties: { value: { type: "string" } },
					required: [],
				},
			},
			definitions: {
				Legacy: {
					type: "object",
					properties: { count: { type: "number" } },
					required: [],
				},
			},
		} as Record<string, unknown>;

		const strict = enforceStrictSchema(schema);
		const defs = strict.$defs as Record<string, Record<string, unknown>>;
		const definitions = strict.definitions as Record<string, Record<string, unknown>>;

		expect(defs.Payload.additionalProperties).toBe(false);
		expect(definitions.Legacy.additionalProperties).toBe(false);
		expect(defs.Payload.required).toEqual(["value"]);
		expect(definitions.Legacy.required).toEqual(["count"]);
	});

	it("enforces strict object constraints inside tuple items", () => {
		const schema = {
			type: "array",
			prefixItems: [
				{ type: "string" },
				{
					type: "object",
					properties: {
						id: { type: "string" },
						nickname: { type: "string" },
					},
					required: ["id"],
				},
			],
		} as Record<string, unknown>;

		const result = tryEnforceStrictSchema(schema);
		const tupleItems = result.schema.prefixItems as Array<Record<string, unknown>>;
		const tupleObjectItem = tupleItems[1] as Record<string, unknown>;
		const tupleProperties = tupleObjectItem.properties as Record<string, Record<string, unknown>>;

		expect(result.strict).toBe(true);
		expect(tupleObjectItem.additionalProperties).toBe(false);
		expect(tupleObjectItem.required).toEqual(["id", "nickname"]);
		expect(tupleProperties.nickname).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
	});
});

// ---------------------------------------------------------------------------
// stripResidualCombiners
// ---------------------------------------------------------------------------

describe("stripResidualCombiners", () => {
	it("collapses identical anyOf variants to the underlying type", () => {
		const stripped = stripResidualCombiners({
			anyOf: [
				{ type: "string", minLength: 1 },
				{ type: "string", minLength: 1 },
			],
			oneOf: [
				{ type: "string", pattern: "^a" },
				{ type: "string", pattern: "^a" },
			],
		}) as Record<string, unknown>;

		expect(stripped.type).toBe("string");
		expect(stripped.anyOf).toBeUndefined();
		expect(stripped.oneOf).toBeUndefined();
		expect(stripped.minLength).toBe(1);
		expect(stripped.pattern).toBe("^a");
	});

	it("strips residual combiners to a fixpoint at the same node", () => {
		const normalized = stripResidualCombiners({
			anyOf: [
				{ type: "string", description: "A" },
				{ type: "string", description: "B" },
			],
			oneOf: [{ type: "number" }, { type: "number" }],
		}) as Record<string, unknown>;

		expect(normalized.anyOf).toBeUndefined();
		expect(normalized.oneOf).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// normalizeSchemaForCCA
// ---------------------------------------------------------------------------

describe("normalizeSchemaForCCA", () => {
	it("collapses same-type anyOf variants when mixed-type collapse bails out", () => {
		const prepared = normalizeSchemaForCCA({
			type: "object",
			properties: {
				value: {
					anyOf: [
						{ type: "string", description: "first" },
						{ type: "string", minLength: 2 },
					],
				},
			},
			required: ["value"],
		}) as {
			properties?: Record<string, Record<string, unknown>>;
		};

		const valueSchema = prepared.properties?.value;
		expect(valueSchema?.type).toBe("string");
		expect(valueSchema?.anyOf).toBeUndefined();
	});

	it("applies Google unsupported-key stripping before CCA-specific normalization", () => {
		const sanitized = normalizeSchemaForCCA({
			type: "object",
			additionalProperties: false,
			properties: {
				config: {
					type: "object",
					additionalProperties: false,
				},
				name: {
					type: "string",
					minLength: 2,
					pattern: "^[a-z]+$",
				},
			},
			required: ["config", "name"],
		});

		expect(sanitized).toEqual({
			type: "object",
			properties: {
				config: {
					type: "object",
					properties: {},
				},
				name: {
					type: "string",
					description: '{minLength: 2, pattern: "^[a-z]+$"}',
				},
			},
			required: ["config", "name"],
		});
	});

	it("lifts stripped validation keywords into description", () => {
		const normalized = normalizeSchemaForCCA({
			type: "string",
			pattern: "^\\d+$",
			minLength: 1,
			maxLength: 8,
			description: "ID",
		}) as Record<string, unknown>;

		expect(normalized.pattern).toBeUndefined();
		expect(normalized.minLength).toBeUndefined();
		expect(normalized.maxLength).toBeUndefined();
		expect(normalized.description).toBe('ID\n\n{pattern: "^\\\\d+$", minLength: 1, maxLength: 8}');
	});

	it("uses the same merged object output in shared and gemini-cli Antigravity paths", () => {
		const parameters = {
			anyOf: [
				{
					type: "object",
					properties: {
						shared: { type: "string" },
						a: { type: "string" },
					},
					required: ["shared"],
				},
				{
					type: "object",
					properties: {
						shared: { type: "string" },
						b: { type: "number" },
					},
					required: ["shared"],
				},
			],
		} as TJsonSchema;
		const tools: Tool[] = [{ name: "merge_test", description: "Merge test", parameters }];

		const sharedTools = convertTools(tools, createGoogleCliModel("claude-sonnet-4-5"));
		const sharedDeclaration = sharedTools?.[0]?.functionDeclarations[0] as Record<string, unknown>;

		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: 0 }],
			tools,
		};
		const antigravityRequest = buildRequest(createGoogleCliModel("gemini-2.5-pro"), context, "project", {}, true);
		const antigravityDeclaration = antigravityRequest.request.tools?.[0]?.functionDeclarations[0] as Record<
			string,
			unknown
		>;

		const expected = {
			type: "object",
			properties: {
				shared: { type: "string" },
				a: { type: "string" },
				b: { type: "number" },
			},
			required: ["shared"],
		};
		expect(sharedDeclaration.parameters).toEqual(expected);
		expect(antigravityDeclaration.parameters).toEqual(expected);
		expect(antigravityDeclaration.parameters).toEqual(sharedDeclaration.parameters);
		expect(antigravityDeclaration.parametersJsonSchema).toBeUndefined();
	});

	it("does not retain stale required keys after an object-union anyOf merge", () => {
		const prepared = normalizeSchemaForCCA({
			required: ["a"],
			anyOf: [
				{
					type: "object",
					properties: { a: { type: "string" } },
					required: ["a"],
				},
				{
					type: "object",
					properties: { b: { type: "number" } },
					required: ["b"],
				},
			],
		}) as Record<string, unknown>;

		expect(prepared).toEqual({
			type: "object",
			properties: {
				a: { type: "string" },
				b: { type: "number" },
			},
		});
	});

	it("preserves required intersection when merging object anyOf variants with overlapping keys", () => {
		const schema = {
			type: "object",
			properties: {
				profile: {
					anyOf: [
						{
							type: "object",
							properties: {
								id: { type: "string" },
								name: { type: "string" },
							},
							required: ["id", "name"],
						},
						{
							type: "object",
							properties: {
								id: { type: "string" },
								age: { type: "number" },
							},
							required: ["id", "age"],
						},
					],
				},
			},
			required: ["profile"],
		} as const;

		const normalized = normalizeSchemaForCCA(schema) as {
			properties?: {
				profile?: {
					type?: string;
					properties?: Record<string, unknown>;
					required?: string[];
				};
			};
		};
		const profile = normalized.properties?.profile;

		expect(profile?.type).toBe("object");
		expect(Object.keys(profile?.properties ?? {}).sort()).toEqual(["age", "id", "name"]);
		expect(profile?.required).toEqual(["id"]);
	});

	it("does not recurse infinitely when preparing a schema with a circular object graph", () => {
		const circular: Record<string, unknown> = {
			type: "object",
			properties: {},
		};
		(circular.properties as Record<string, unknown>).self = circular;

		expect(() => normalizeSchemaForCCA(circular)).not.toThrow();
		expect(normalizeSchemaForCCA(circular)).toEqual({
			type: "object",
			properties: {
				self: {},
			},
		});
	});

	it("falls back to an empty object schema when the normalized schema is AJV-invalid", () => {
		const ajvInvalid = {
			type: "invalid-type-token",
		} as Record<string, unknown>;

		expect(normalizeSchemaForCCA(ajvInvalid)).toEqual({
			type: "object",
			properties: {},
		});
	});
});

// ---------------------------------------------------------------------------
// Circular schema safety (normalizeSchemaForGoogle + sanitizeSchemaForStrictMode)
// ---------------------------------------------------------------------------

describe("circular schema safety", () => {
	it("does not overflow the stack when either sanitizer encounters a self-referential object", () => {
		const circular: Record<string, unknown> = {
			type: "object",
			properties: {},
		};
		(circular.properties as Record<string, unknown>).self = circular;

		expect(() => normalizeSchemaForGoogle(circular)).not.toThrow();
		expect(() => sanitizeSchemaForStrictMode(circular)).not.toThrow();
	});
});
