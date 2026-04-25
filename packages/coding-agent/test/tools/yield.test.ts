import { describe, expect, it } from "bun:test";
import type { Tool, ToolCall } from "@oh-my-pi/pi-ai/types";
import { enforceStrictSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { YieldTool } from "@oh-my-pi/pi-coding-agent/tools/yield";

function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

function toRecord(value: unknown): Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function getSuccessDataSchema(parameters: Record<string, unknown>): Record<string, unknown> {
	const resultSchema = toRecord(toRecord(parameters.properties).result);
	const variants = Array.isArray(resultSchema.anyOf) ? resultSchema.anyOf : [];
	for (const variant of variants) {
		const variantRecord = toRecord(variant);
		const variantProperties = toRecord(variantRecord.properties);
		if ("data" in variantProperties) {
			return toRecord(variantProperties.data);
		}
	}
	throw new Error("Missing success variant with data schema");
}

describe("YieldTool", () => {
	it("exposes top-level object parameters with required result union", () => {
		const tool = new YieldTool(createSession());
		const schema = tool.parameters as {
			type?: string;
			properties?: Record<string, unknown>;
			required?: string[];
		};
		expect(schema.type).toBe("object");
		expect(Object.keys(schema.properties ?? {})).toEqual(["result"]);
		expect(schema.required).toEqual(["result"]);
	});

	it("accepts success payload with data", async () => {
		const tool = new YieldTool(createSession());
		const result = await tool.execute("call-1", { result: { data: { ok: true } } } as never);
		expect(result.details).toEqual({ data: { ok: true }, status: "success", error: undefined });
	});

	it("accepts aborted payload with error only", async () => {
		const tool = new YieldTool(createSession());
		const result = await tool.execute("call-2", { result: { error: "blocked" } } as never);
		expect(result.details).toEqual({ data: undefined, status: "aborted", error: "blocked" });
	});

	it("accepts arbitrary data when outputSchema is null", async () => {
		const tool = new YieldTool(createSession({ outputSchema: null }));
		const result = await tool.execute("call-null", { result: { data: { nested: { x: 1 }, ok: true } } } as never);
		expect(result.details).toEqual({
			data: { nested: { x: 1 }, ok: true },
			status: "success",
			error: undefined,
		});
	});

	it("treats outputSchema true as unconstrained and accepts primitive and array data", async () => {
		const tool = new YieldTool(createSession({ outputSchema: true }));
		const dataSchema = getSuccessDataSchema(tool.parameters as unknown as Record<string, unknown>);

		expect(dataSchema.type).toBeUndefined();
		const primitiveResult = await tool.execute("call-true-number", { result: { data: 42 } } as never);
		expect(primitiveResult.details).toEqual({ data: 42, status: "success", error: undefined });

		const arrayResult = await tool.execute("call-true-array", { result: { data: ["ok", 1, false] } } as never);
		expect(arrayResult.details).toEqual({
			data: ["ok", 1, false],
			status: "success",
			error: undefined,
		});
	});
	it("repairs strict schema generation for required-only object output schemas", () => {
		const tool = new YieldTool(
			createSession({
				outputSchema: {
					type: "object",
					required: ["data"],
				},
			}),
		);
		const strictParameters = enforceStrictSchema(tool.parameters as unknown as Record<string, unknown>);
		const dataSchema = getSuccessDataSchema(strictParameters);

		expect(tool.strict).toBe(true);
		expect(dataSchema.properties).toEqual({});
		expect(dataSchema.required).toEqual([]);
		expect(dataSchema.additionalProperties).toBe(false);
	});

	it("normalizes object/null type arrays into strict-compatible data variants", () => {
		const tool = new YieldTool(
			createSession({
				outputSchema: {
					type: ["object", "null"],
					properties: {
						name: { type: "string" },
					},
					required: ["name"],
				},
			}),
		);
		const dataSchema = getSuccessDataSchema(tool.parameters as unknown as Record<string, unknown>);
		expect(tool.strict).toBe(true);
		expect(Array.isArray(dataSchema.anyOf)).toBe(true);

		const variants = dataSchema.anyOf as Array<Record<string, unknown>>;
		const objectVariant = variants.find(variant => variant.type === "object");
		const nullVariant = variants.find(variant => variant.type === "null");

		expect(objectVariant).toBeDefined();
		expect((objectVariant as Record<string, unknown>).properties).toEqual({ name: { type: "string" } });
		expect((objectVariant as Record<string, unknown>).required).toEqual(["name"]);
		expect(nullVariant).toEqual({ type: "null" });
	});

	it("converts mixed JTD and JSON Schema output definitions into provider-valid schemas", async () => {
		const tool = new YieldTool(
			createSession({
				outputSchema: {
					type: "object",
					properties: {
						results: {
							type: "array",
							elements: {
								properties: {
									issue: { type: "int32" },
								},
							},
						},
					},
					required: ["results"],
				},
			}),
		);
		const dataSchema = getSuccessDataSchema(tool.parameters as unknown as Record<string, unknown>);
		const resultsSchema = toRecord(toRecord(dataSchema.properties).results);
		const issueSchema = toRecord(toRecord(toRecord(resultsSchema.items).properties).issue);

		expect(resultsSchema.type).toBe("array");
		expect(resultsSchema.items).toBeDefined();
		expect(resultsSchema.elements).toBeUndefined();
		expect(issueSchema.type).toBe("integer");

		await expect(
			tool.execute("call-mixed-valid", { result: { data: { results: [{ issue: 185 }] } } } as never),
		).resolves.toBeDefined();
		await expect(
			tool.execute("call-mixed-invalid", { result: { data: { results: [{ issue: "185" }] } } } as never),
		).rejects.toThrow("Output does not match schema");
	});
	it("supports $defs/$ref output schemas by inlining definitions and degrades after first runtime failure", async () => {
		const outputSchema = {
			$defs: {
				A: {
					type: "object",
					properties: {
						kind: { const: "A" },
						token: { type: "string", minLength: 10 },
					},
					required: ["kind", "token"],
					additionalProperties: false,
				},
			},
			anyOf: [
				{ $ref: "#/$defs/A" },
				{
					type: "object",
					properties: {
						kind: { const: "B" },
						n: { type: "integer", minimum: 10 },
					},
					required: ["kind", "n"],
					additionalProperties: false,
				},
			],
		};
		const tool = new YieldTool(createSession({ outputSchema }));
		const parametersRecord = tool.parameters as unknown as Record<string, unknown>;
		// $defs should NOT be in parameters — refs are inlined
		expect(parametersRecord.$defs).toBeUndefined();
		const dataSchema = getSuccessDataSchema(parametersRecord);
		// The inlined anyOf[0] should be the A definition (not a $ref)
		const anyOfVariants = dataSchema.anyOf as Array<Record<string, unknown>>;
		expect(anyOfVariants).toBeDefined();
		expect(anyOfVariants[0].$ref).toBeUndefined();
		expect(toRecord(anyOfVariants[0].properties).kind).toBeDefined();

		const toolDefinition: Tool = {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		};
		const firstCall: ToolCall = {
			type: "toolCall",
			id: "call-ref-1",
			name: tool.name,
			arguments: { result: { data: { kind: "A", token: "x" } } },
		};
		// validateToolArguments should succeed (no $ref to resolve)
		const firstArgs = validateToolArguments(toolDefinition, firstCall);
		// Runtime AJV still validates the original schema — token too short
		await expect(tool.execute("call-ref-1", firstArgs as never)).rejects.toThrow("Output does not match schema");

		const secondCall: ToolCall = {
			type: "toolCall",
			id: "call-ref-2",
			name: tool.name,
			arguments: { result: { data: { kind: "A", token: "x" } } },
		};
		const secondArgs = validateToolArguments(toolDefinition, secondCall);
		const secondResult = await tool.execute("call-ref-2", secondArgs as never);
		expect(secondResult.content).toEqual([
			{
				type: "text",
				text: "Result submitted (schema validation overridden after 2 failed attempt(s)).",
			},
		]);
	});
	it("falls back to unconstrained object data when output schema is invalid", async () => {
		const tool = new YieldTool(
			createSession({
				outputSchema: {
					type: "object",
					properties: {
						value: { type: "not-a-real-json-schema-type" },
					},
					required: ["value"],
				},
			}),
		);
		const dataSchema = getSuccessDataSchema(tool.parameters as unknown as Record<string, unknown>);
		const dataSchemaProperties = toRecord(dataSchema.properties);

		expect(dataSchema.type).toBe("object");
		expect(dataSchemaProperties.value).toBeUndefined();
		expect(Object.keys(dataSchemaProperties)).toHaveLength(0);

		const result = await tool.execute("call-invalid-schema", {
			result: { data: { value: 123, nested: { ok: true } } },
		} as never);
		expect(result.details).toEqual({
			data: { value: 123, nested: { ok: true } },
			status: "success",
			error: undefined,
		});
	});
	it("falls back to unconstrained data schema when output schema is circular", async () => {
		const circularSchema: Record<string, unknown> = { type: "object" };
		circularSchema.self = circularSchema;

		const tool = new YieldTool(createSession({ outputSchema: circularSchema }));
		const dataSchema = getSuccessDataSchema(tool.parameters as unknown as Record<string, unknown>);

		expect(tool.strict).toBe(false);
		expect(dataSchema.type).toBe("object");

		const result = await tool.execute("call-circular-schema", { result: { data: { ok: true } } } as never);
		expect(result.details).toEqual({ data: { ok: true }, status: "success", error: undefined });
	});

	it("falls back to unconstrained data schema when output schema is deeply nested", async () => {
		const buildDeepSchema = (depth: number): Record<string, unknown> => {
			const root: Record<string, unknown> = {
				type: "object",
				properties: {},
				required: ["next"],
			};
			let current = root;

			for (let i = 0; i < depth; i++) {
				const next: Record<string, unknown> = {
					type: "object",
					properties: {},
					required: ["next"],
				};
				const currentProperties = toRecord(current.properties);
				currentProperties.next = next;
				current.properties = currentProperties;
				current = next;
			}

			current.properties = { value: { type: "string" } };
			current.required = ["value"];
			return root;
		};

		const tool = new YieldTool(createSession({ outputSchema: buildDeepSchema(20_000) }));
		const dataSchema = getSuccessDataSchema(tool.parameters as unknown as Record<string, unknown>);

		expect(tool.strict).toBe(false);
		expect(dataSchema.type).toBe("object");

		const result = await tool.execute("call-deep-schema", { result: { data: { nested: true } } } as never);
		expect(result.details).toEqual({ data: { nested: true }, status: "success", error: undefined });
	});

	it("handles non-object output schemas without blocking successful result submission", async () => {
		for (const outputSchema of [[], 123, false]) {
			const tool = new YieldTool(createSession({ outputSchema }));
			const result = await tool.execute("call-non-object-schema", {
				result: { data: { value: outputSchema } },
			} as never);
			expect(result.details).toEqual({
				data: { value: outputSchema },
				status: "success",
				error: undefined,
			});
		}
	});
	it("keeps runtime validation against the original output schema", async () => {
		const outputSchema = {
			type: "object",
			properties: {
				token: {
					type: "string",
					minLength: 3,
				},
			},
			required: ["token"],
		};
		const tool = new YieldTool(createSession({ outputSchema }));
		const dataSchema = getSuccessDataSchema(tool.parameters as unknown as Record<string, unknown>);
		const tokenSchema = toRecord(toRecord(dataSchema.properties).token);

		expect(tokenSchema.minLength).toBeUndefined();
		await expect(tool.execute("call-short", { result: { data: { token: "ab" } } } as never)).rejects.toThrow(
			"Output does not match schema",
		);

		const result = await tool.execute("call-long", { result: { data: { token: "abcd" } } } as never);
		expect(result.details).toEqual({ data: { token: "abcd" }, status: "success", error: undefined });
	});

	it("throws on first schema validation failure and accepts non-conforming data on second failure", async () => {
		const outputSchema = {
			type: "object",
			properties: {
				token: {
					type: "string",
					minLength: 3,
				},
			},
			required: ["token"],
		};
		const tool = new YieldTool(createSession({ outputSchema }));

		await expect(tool.execute("call-short-1", { result: { data: { token: "ab" } } } as never)).rejects.toThrow(
			"Output does not match schema",
		);

		const secondResult = await tool.execute("call-short-2", { result: { data: { token: "ab" } } } as never);
		expect(secondResult.details).toEqual({ data: { token: "ab" }, status: "success", error: undefined });
		expect(secondResult.content).toEqual([
			{
				type: "text",
				text: "Result submitted (schema validation overridden after 2 failed attempt(s)).",
			},
		]);
	});

	it("keeps schema degradation counter at zero when submissions are valid", async () => {
		const outputSchema = {
			type: "object",
			properties: {
				token: {
					type: "string",
					minLength: 3,
				},
			},
			required: ["token"],
		};
		const tool = new YieldTool(createSession({ outputSchema }));

		const firstResult = await tool.execute("call-valid-1", { result: { data: { token: "abcd" } } } as never);
		expect(firstResult.content).toEqual([{ type: "text", text: "Result submitted." }]);

		const secondResult = await tool.execute("call-valid-2", { result: { data: { token: "abcde" } } } as never);
		expect(secondResult.content).toEqual([{ type: "text", text: "Result submitted." }]);

		await expect(
			tool.execute("call-invalid-after-valid", { result: { data: { token: "ab" } } } as never),
		).rejects.toThrow("Output does not match schema");
	});

	it("still throws structural errors after schema validation has been degraded", async () => {
		const outputSchema = {
			type: "object",
			properties: {
				token: {
					type: "string",
					minLength: 3,
				},
			},
			required: ["token"],
		};
		const tool = new YieldTool(createSession({ outputSchema }));

		await expect(tool.execute("call-struct-1", { result: { data: { token: "ab" } } } as never)).rejects.toThrow(
			"Output does not match schema",
		);
		await expect(
			tool.execute("call-struct-2", { result: { data: { token: "ab" } } } as never),
		).resolves.toBeDefined();

		await expect(tool.execute("call-struct-missing", {} as never)).rejects.toThrow(
			"result must be an object containing either data or error",
		);
	});
	it("rejects submissions without a result object", async () => {
		const tool = new YieldTool(createSession());
		await expect(tool.execute("call-3", {} as never)).rejects.toThrow(
			"result must be an object containing either data or error",
		);
	});
	it("sets lenientArgValidation so agent-loop bypasses validation errors", () => {
		const tool = new YieldTool(createSession());
		expect(tool.lenientArgValidation).toBe(true);
	});
});
