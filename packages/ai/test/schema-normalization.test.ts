import { describe, expect, it } from "bun:test";
import {
	enforceStrictSchema,
	mergeCompatibleEnumSchemas,
	prepareSchemaForCCA,
	sanitizeSchemaForCCA,
	sanitizeSchemaForGoogle,
	sanitizeSchemaForStrictMode,
	schemaNeedsDraft202012Upgrade,
	stripResidualCombiners,
	tryEnforceStrictSchema,
	upgradeJsonSchemaTo202012,
} from "@oh-my-pi/pi-ai/utils/schema";

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
// sanitizeSchemaForGoogle
// ---------------------------------------------------------------------------

describe("sanitizeSchemaForGoogle", () => {
	it("sets object type when converting an object const to an enum entry", () => {
		const sanitized = sanitizeSchemaForGoogle({
			const: { a: 1 },
		});

		expect(sanitized).toEqual({
			type: "object",
			properties: {},
			enum: [{ a: 1 }],
		});
	});

	it("deduplicates a deep-equal object const against an existing enum entry", () => {
		const sanitized = sanitizeSchemaForGoogle({
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
		const sanitized = sanitizeSchemaForGoogle({
			anyOf: [
				{ const: "A", type: "string" },
				{ const: 1, type: "number" },
				{ const: true, type: "boolean" },
			],
		}) as Record<string, unknown>;

		expect(sanitized.enum).toEqual(["A", 1, true]);
		expect(sanitized.type).toBeUndefined();
	});

	it("infers null type when const is null", () => {
		const sanitized = sanitizeSchemaForGoogle({ const: null }) as Record<string, unknown>;

		expect(sanitized.type).toBe("null");
		expect(sanitized.enum).toEqual([null]);
	});

	it("preserves a property schema literally named additionalProperties inside properties", () => {
		const sanitized = sanitizeSchemaForGoogle({
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

		expect(sanitizeSchemaForGoogle(schema)).toEqual(schema);
	});

	it("strips unresolved $ref and $defs entries for Google compatibility", () => {
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

		expect(sanitizeSchemaForGoogle(schema)).toEqual({
			type: "object",
			properties: {
				user: {},
			},
			required: ["user"],
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
// sanitizeSchemaForCCA and prepareSchemaForCCA
// ---------------------------------------------------------------------------

describe("sanitizeSchemaForCCA and prepareSchemaForCCA", () => {
	it("collapses same-type anyOf variants when mixed-type collapse bails out", () => {
		const prepared = prepareSchemaForCCA({
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
		const sanitized = sanitizeSchemaForCCA({
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
				},
			},
			required: ["config", "name"],
		});
	});

	it("does not retain stale required keys after an object-union anyOf merge", () => {
		const prepared = prepareSchemaForCCA({
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

		const normalized = prepareSchemaForCCA(schema) as {
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

		expect(() => prepareSchemaForCCA(circular)).not.toThrow();
		expect(prepareSchemaForCCA(circular)).toEqual({
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

		expect(prepareSchemaForCCA(ajvInvalid)).toEqual({
			type: "object",
			properties: {},
		});
	});
});

// ---------------------------------------------------------------------------
// Circular schema safety (sanitizeSchemaForGoogle + sanitizeSchemaForStrictMode)
// ---------------------------------------------------------------------------

describe("circular schema safety", () => {
	it("does not overflow the stack when either sanitizer encounters a self-referential object", () => {
		const circular: Record<string, unknown> = {
			type: "object",
			properties: {},
		};
		(circular.properties as Record<string, unknown>).self = circular;

		expect(() => sanitizeSchemaForGoogle(circular)).not.toThrow();
		expect(() => sanitizeSchemaForStrictMode(circular)).not.toThrow();
	});
});
