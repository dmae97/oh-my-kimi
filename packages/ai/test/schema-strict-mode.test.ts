import { describe, expect, it } from "bun:test";
import { enforceStrictSchema, sanitizeSchemaForStrictMode, tryEnforceStrictSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { Type } from "@sinclair/typebox";

describe("sanitizeSchemaForStrictMode", () => {
	it("infers object type, strips non-structural keywords, and converts const to enum", () => {
		const schema = {
			properties: {
				token: {
					const: "abc",
					minLength: 3,
					format: "email",
				},
			},
			required: ["token"],
			format: "uuid",
			pattern: "[a-z]+",
		} as Record<string, unknown>;

		const sanitized = sanitizeSchemaForStrictMode(schema);
		const properties = sanitized.properties as Record<string, Record<string, unknown>>;
		const tokenSchema = properties.token;

		expect(sanitized.type).toBe("object");
		expect(sanitized.format).toBeUndefined();
		expect(sanitized.pattern).toBeUndefined();
		expect(tokenSchema.enum).toEqual(["abc"]);
		expect(tokenSchema.const).toBeUndefined();
		expect(tokenSchema.minLength).toBeUndefined();
		expect(tokenSchema.format).toBeUndefined();
	});

	it("strips unsupported object-key constraints like propertyNames", () => {
		const schema = {
			type: "object",
			properties: {
				metadata: {
					type: "object",
					properties: { value: { type: "string" } },
					required: ["value"],
					propertyNames: { type: "string" },
					minProperties: 1,
				},
			},
			required: ["metadata"],
			propertyNames: { type: "string" },
		} as Record<string, unknown>;

		const sanitized = sanitizeSchemaForStrictMode(schema);
		const properties = sanitized.properties as Record<string, Record<string, unknown>>;
		const metadataSchema = properties.metadata;

		expect(sanitized.propertyNames).toBeUndefined();
		expect((metadataSchema as Record<string, unknown>).propertyNames).toBeUndefined();
		expect((metadataSchema as Record<string, unknown>).minProperties).toBeUndefined();
	});
	it("normalizes type arrays into anyOf variants and cleans non-object branches", () => {
		const schema = {
			type: ["object", "null"],
			properties: {
				data: { type: "string" },
			},
			required: ["data"],
			minLength: 1,
		} as Record<string, unknown>;

		const sanitized = sanitizeSchemaForStrictMode(schema);
		expect(Array.isArray(sanitized.anyOf)).toBe(true);

		const variants = sanitized.anyOf as Array<Record<string, unknown>>;
		const objectVariant = variants.find(variant => variant.type === "object");
		const nullVariant = variants.find(variant => variant.type === "null");

		expect(objectVariant).toBeDefined();
		expect(nullVariant).toEqual({ type: "null" });
		expect((objectVariant as Record<string, unknown>).required).toEqual(["data"]);
		expect((objectVariant as Record<string, unknown>).properties).toEqual({ data: { type: "string" } });
	});

	it("keeps existing anyOf constraints inside each normalized type variant", () => {
		const schema = {
			type: ["object", "null"],
			anyOf: [
				{
					type: "object",
					properties: { kind: { const: "ok" } },
					required: ["kind"],
				},
			],
		} as Record<string, unknown>;

		const sanitized = sanitizeSchemaForStrictMode(schema);
		const variants = sanitized.anyOf as Array<Record<string, unknown>>;
		const objectVariant = variants.find(variant => variant.type === "object");
		const nullVariant = variants.find(variant => variant.type === "null");

		expect(variants).toHaveLength(2);
		expect(objectVariant).toBeDefined();
		expect(nullVariant).toBeDefined();
		expect(Array.isArray((objectVariant as Record<string, unknown>).anyOf)).toBe(true);
		expect(Array.isArray((nullVariant as Record<string, unknown>).anyOf)).toBe(true);
		expect(((objectVariant as Record<string, unknown>).anyOf as unknown[]).length).toBe(1);
		expect(((nullVariant as Record<string, unknown>).anyOf as unknown[]).length).toBe(1);
	});
	it("inlines `default` value into `description` before stripping it", () => {
		const schema = {
			type: "number",
			description: "Timeout in seconds",
			default: 60,
		} as Record<string, unknown>;

		const sanitized = sanitizeSchemaForStrictMode(schema);

		expect(sanitized.default).toBeUndefined();
		expect(sanitized.description).toBe("Timeout in seconds (default: 60)");
	});

	it("preserves `default` for various primitive types when inlining", () => {
		const numberSchema = sanitizeSchemaForStrictMode({
			type: "number",
			description: "n",
			default: 0,
		});
		const boolSchema = sanitizeSchemaForStrictMode({
			type: "boolean",
			description: "flag",
			default: true,
		});
		const stringSchema = sanitizeSchemaForStrictMode({
			type: "string",
			description: "path",
			default: "cwd",
		});

		expect(numberSchema.description).toBe("n (default: 0)");
		expect(boolSchema.description).toBe("flag (default: true)");
		expect(stringSchema.description).toBe("path (default: cwd)");
	});

	it("does not double-inline when description already mentions `(default:`", () => {
		const schema = {
			type: "number",
			description: "Timeout in seconds (default: 60)",
			default: 60,
		} as Record<string, unknown>;

		const sanitized = sanitizeSchemaForStrictMode(schema);

		expect(sanitized.description).toBe("Timeout in seconds (default: 60)");
		expect(sanitized.default).toBeUndefined();
	});

	it("strips `default` when no sibling description exists (no synthesis)", () => {
		const schema = {
			type: "number",
			default: 60,
		} as Record<string, unknown>;

		const sanitized = sanitizeSchemaForStrictMode(schema);

		expect(sanitized.default).toBeUndefined();
		expect(sanitized.description).toBeUndefined();
	});

	it("inlines falsy and null defaults without treating them as absent", () => {
		const boolFalse = sanitizeSchemaForStrictMode({
			type: "boolean",
			description: "flag",
			default: false,
		});
		const emptyStr = sanitizeSchemaForStrictMode({
			type: "string",
			description: "name",
			default: "",
		});
		const nullDefault = sanitizeSchemaForStrictMode({
			type: "string",
			description: "value",
			default: null,
		});

		expect(boolFalse.description).toBe("flag (default: false)");
		expect(boolFalse.default).toBeUndefined();
		expect(emptyStr.description).toBe("name (default: )");
		expect(emptyStr.default).toBeUndefined();
		expect(nullDefault.description).toBe("value (default: null)");
		expect(nullDefault.default).toBeUndefined();
	});

	it("inlines defaults on nested object properties via recursion", () => {
		const schema = {
			type: "object",
			properties: {
				outer: {
					type: "object",
					properties: {
						retries: {
							type: "number",
							description: "retry count",
							default: 3,
						},
					},
					required: ["retries"],
				},
			},
			required: ["outer"],
		} as Record<string, unknown>;

		const sanitized = sanitizeSchemaForStrictMode(schema);
		const outer = (sanitized.properties as Record<string, Record<string, unknown>>).outer;
		const retries = (outer.properties as Record<string, Record<string, unknown>>).retries;

		expect(retries.default).toBeUndefined();
		expect(retries.description).toBe("retry count (default: 3)");
	});

	it("inlines defaults through the type-array (nullable) branch", () => {
		const schema = {
			type: ["number", "null"],
			description: "timeout",
			default: 60,
		} as Record<string, unknown>;

		const sanitized = sanitizeSchemaForStrictMode(schema);
		const variants = sanitized.anyOf as Array<Record<string, unknown>>;
		const numberVariant = variants.find(v => v.type === "number");

		expect(numberVariant).toBeDefined();
		expect((numberVariant as Record<string, unknown>).default).toBeUndefined();
		expect((numberVariant as Record<string, unknown>).description).toBe("timeout (default: 60)");
	});
});

describe("enforceStrictSchema", () => {
	it("converts optional properties to nullable schemas and requires all object keys", () => {
		const schema = Type.Object({
			requiredText: Type.String(),
			optionalCount: Type.Optional(Type.Number()),
		});

		const strict = enforceStrictSchema(schema as unknown as Record<string, unknown>);
		const properties = strict.properties as Record<string, Record<string, unknown>>;

		expect(strict.required).toEqual(["requiredText", "optionalCount"]);
		expect((properties.requiredText.type as string) === "string").toBe(true);
		const optionalVariants = (properties.optionalCount.anyOf as Array<{ type?: string }>).map(v => v.type);
		expect(optionalVariants).toEqual(["number", "null"]);
	});

	it("never emits undefined as a schema type", () => {
		const schema = Type.Object({
			questions: Type.Array(
				Type.Object({
					id: Type.String(),
					recommended: Type.Optional(Type.Number()),
				}),
			),
		});

		const strict = enforceStrictSchema(schema as unknown as Record<string, unknown>);
		const serialized = JSON.stringify(strict);

		expect(serialized.includes('"undefined"')).toBe(false);
		expect(serialized.includes('"null"')).toBe(true);
	});

	it("normalizes malformed object nodes that declare required keys without properties", () => {
		const schema = {
			type: "object",
			required: ["data"],
		} as Record<string, unknown>;

		const strict = enforceStrictSchema(schema);

		expect(strict.properties).toEqual({});
		expect(strict.required).toEqual([]);
		expect(strict.additionalProperties).toBe(false);
	});

	it("repairs malformed object branches nested under anyOf", () => {
		const schema = {
			type: "object",
			properties: {
				result: {
					anyOf: [
						{ type: "object", required: ["data"] },
						{ type: "object", properties: { error: { type: "string" } }, required: ["error"] },
					],
				},
			},
			required: ["result"],
		} as Record<string, unknown>;

		const strict = enforceStrictSchema(schema);
		const rootProps = strict.properties as Record<string, Record<string, unknown>>;
		const resultSchema = rootProps.result;
		const branches = resultSchema.anyOf as Array<Record<string, unknown>>;
		const malformedBranch = branches[0];
		const validBranch = branches[1];

		expect(malformedBranch.properties).toEqual({});
		expect(malformedBranch.required).toEqual([]);
		expect(malformedBranch.additionalProperties).toBe(false);
		expect(validBranch.required).toEqual(["error"]);
		expect(validBranch.additionalProperties).toBe(false);
	});

	it("reuses enforced object schemas across shared branches", () => {
		const sharedTaskSchema = {
			type: "object",
			properties: {
				content: { type: "string" },
				notes: { type: "string" },
			},
			required: ["content"],
		} as Record<string, unknown>;
		const schema = {
			type: "object",
			properties: {
				primary: {
					type: "array",
					items: sharedTaskSchema,
				},
				secondary: {
					anyOf: [{ type: "array", items: sharedTaskSchema }, { type: "null" }],
				},
			},
			required: ["primary", "secondary"],
		} as Record<string, unknown>;

		const strict = enforceStrictSchema(schema);
		const rootProperties = strict.properties as Record<string, Record<string, unknown>>;
		const primaryItems = rootProperties.primary.items as Record<string, unknown>;
		const secondaryBranches = rootProperties.secondary.anyOf as Array<Record<string, unknown>>;
		const secondaryItems = secondaryBranches[0]?.items as Record<string, unknown>;

		expect(primaryItems.additionalProperties).toBe(false);
		expect(primaryItems.required).toEqual(["content", "notes"]);
		expect(secondaryItems.additionalProperties).toBe(false);
		expect(secondaryItems.required).toEqual(["content", "notes"]);
		expect(secondaryItems.properties).toEqual(primaryItems.properties);
	});

	it("treats type arrays containing object as object schemas via tryEnforceStrictSchema", () => {
		const schema = {
			type: ["object", "null"],
			properties: { value: { type: "string" } },
			required: ["value"],
		} as Record<string, unknown>;

		const result = tryEnforceStrictSchema(schema);

		expect(result.strict).toBe(true);
		// sanitizeSchemaForStrictMode splits type arrays into anyOf variants
		const branches = result.schema.anyOf as Array<Record<string, unknown>>;
		expect(branches).toHaveLength(2);

		const objectBranch = branches.find(b => b.type === "object") as Record<string, unknown>;
		const nullBranch = branches.find(b => b.type === "null");
		expect(objectBranch).toBeDefined();
		expect(nullBranch).toBeDefined();

		// enforceStrictSchema applied object constraints to the object variant
		expect(objectBranch.additionalProperties).toBe(false);
		expect(objectBranch.required).toEqual(["value"]);
		const properties = objectBranch.properties as Record<string, Record<string, unknown>>;
		expect(properties.value.type).toBe("string");
	});
});

describe("tryEnforceStrictSchema", () => {
	it("sanitizes strict schemas by stripping unsupported format keywords", () => {
		const schema = {
			type: "object",
			properties: {
				url: { type: "string", format: "uri" },
			},
			required: ["url"],
			format: "uuid",
		} as Record<string, unknown>;

		const result = tryEnforceStrictSchema(schema);
		const properties = result.schema.properties as Record<string, Record<string, unknown>>;

		expect(result.strict).toBe(true);
		expect(result.schema.format).toBeUndefined();
		expect(properties.url.format).toBeUndefined();
		expect(properties.url.type).toBe("string");
	});
	it("sanitizes propertyNames so strict mode stays enabled", () => {
		const schema = {
			type: "object",
			properties: {
				tags: {
					type: "object",
					properties: { key: { type: "string" } },
					required: ["key"],
					propertyNames: { type: "string" },
				},
			},
			required: ["tags"],
			propertyNames: { type: "string" },
		} as Record<string, unknown>;

		const result = tryEnforceStrictSchema(schema);
		const properties = result.schema.properties as Record<string, Record<string, unknown>>;
		const tagsSchema = properties.tags;

		expect(result.strict).toBe(true);
		expect(result.schema.propertyNames).toBeUndefined();
		expect((tagsSchema as Record<string, unknown>).propertyNames).toBeUndefined();
	});
	it("downgrades to non-strict mode when strict enforcement throws", () => {
		const circularSchema: Record<string, unknown> = {
			type: "object",
			properties: {},
		};
		(circularSchema.properties as Record<string, unknown>).self = circularSchema;

		const result = tryEnforceStrictSchema(circularSchema);

		expect(result.strict).toBe(false);
		expect(result.schema).toBe(circularSchema);
	});

	it("keeps strict mode enabled for valid schemas", () => {
		const schema = {
			type: "object",
			properties: { value: { type: "string" } },
			required: ["value"],
		} as Record<string, unknown>;

		const result = tryEnforceStrictSchema(schema);

		expect(result.strict).toBe(true);
		expect(result.schema.additionalProperties).toBe(false);
		expect(result.schema.required).toEqual(["value"]);
	});
	it("degrades to non-strict when array items is an empty schema", () => {
		const schema = {
			type: "object",
			properties: {
				slide_instructions: { items: {}, type: "array" },
			},
			required: ["slide_instructions"],
		} as Record<string, unknown>;

		const result = tryEnforceStrictSchema(schema);

		expect(result.strict).toBe(false);
		expect(result.schema).toBe(schema);
	});

	it("keeps shared object schemas strict-compatible after adaptation", () => {
		const sharedTaskSchema = Type.Object({
			content: Type.String(),
			status: Type.Optional(Type.String()),
			notes: Type.Optional(Type.String()),
		});
		const schema = Type.Object({
			ops: Type.Array(
				Type.Union([
					Type.Object({
						op: Type.Literal("replace"),
						tasks: Type.Array(sharedTaskSchema),
					}),
					Type.Object({
						op: Type.Literal("update"),
						tasks: Type.Optional(Type.Array(sharedTaskSchema)),
					}),
				]),
			),
		});

		const result = tryEnforceStrictSchema(schema as unknown as Record<string, unknown>);
		const rootProperties = result.schema.properties as Record<string, Record<string, unknown>>;
		const opBranches = ((rootProperties.ops.items as Record<string, unknown>).anyOf ?? []) as Array<
			Record<string, unknown>
		>;
		const replaceTasks = ((opBranches[0]?.properties as Record<string, Record<string, unknown>>)?.tasks?.items ??
			{}) as Record<string, unknown>;
		const updateTasks = (
			((opBranches[1]?.properties as Record<string, Record<string, unknown>>)?.tasks?.anyOf ?? []) as Array<
				Record<string, unknown>
			>
		)[0]?.items as Record<string, unknown>;

		expect(result.strict).toBe(true);
		expect(replaceTasks.additionalProperties).toBe(false);
		expect(replaceTasks.required).toEqual(["content", "status", "notes"]);
		expect(updateTasks.additionalProperties).toBe(false);
		expect(updateTasks.required).toEqual(["content", "status", "notes"]);
	});
});
