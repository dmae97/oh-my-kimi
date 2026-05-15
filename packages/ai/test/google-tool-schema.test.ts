import { describe, expect, it } from "bun:test";
import { convertTools } from "@oh-my-pi/pi-ai/providers/google-shared";
import type { Model, TJsonSchema, Tool } from "@oh-my-pi/pi-ai/types";
import { sanitizeSchemaForCCA, sanitizeSchemaForGoogle } from "@oh-my-pi/pi-ai/utils/schema";

function createModel(id: string): Model<"google-gemini-cli"> {
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

describe("Cloud Code Assist Claude tool schema conversion", () => {
	it("strips nullable keyword and collapses type arrays for CCA Claude", () => {
		const schema = {
			type: "object",
			properties: {
				value: {
					type: ["string", "null"],
					nullable: true,
				},
			},
		} as unknown;

		// normalizeTypeArrayToNullable converts type array to scalar + nullable,
		// then stripNullableKeyword removes the nullable marker.
		expect(sanitizeSchemaForCCA(schema)).toEqual({
			type: "object",
			properties: {
				value: {
					type: "string",
				},
			},
		});
	});

	it("uses sanitized parameters for claude models with deterministic output", () => {
		const parameters = {
			type: "object",
			properties: {
				value: {
					type: ["string", "null"],
					nullable: true,
				},
			},
			required: ["value"],
		} as TJsonSchema;
		const tools: Tool[] = [{ name: "test_tool", description: "Test tool", parameters }];
		const model = createModel("claude-sonnet-4-5");

		const first = convertTools(tools, model);
		const second = convertTools(tools, model);
		const declaration = first?.[0]?.functionDeclarations[0] as Record<string, unknown>;

		expect(first).toEqual(second);
		expect(declaration.parameters).toEqual({
			type: "object",
			properties: {
				value: {
					type: "string",
				},
			},
			required: ["value"],
		});
		expect(declaration.parametersJsonSchema).toBeUndefined();
	});

	it("collapses mixed-type anyOf to first non-null type for claude parameters", () => {
		const parameters = {
			type: "object",
			properties: {
				lines: {
					anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }, { type: "null" }],
				},
			},
			required: ["lines"],
		} as TJsonSchema;
		const tools: Tool[] = [{ name: "test_tool", description: "Test tool", parameters }];
		const claudeModel = createModel("claude-sonnet-4-5");
		const geminiModel = createModel("gemini-2.5-pro");

		const claudeFirst = convertTools(tools, claudeModel);
		const claudeSecond = convertTools(tools, claudeModel);
		const claudeDeclaration = claudeFirst?.[0]?.functionDeclarations[0] as Record<string, unknown>;
		const geminiDeclaration = convertTools(tools, geminiModel)?.[0]?.functionDeclarations[0] as Record<
			string,
			unknown
		>;

		expect(claudeFirst).toEqual(claudeSecond);
		// Lossy collapse: array|string|null narrows to array (first non-null type)
		expect(claudeDeclaration.parameters).toEqual({
			type: "object",
			properties: {
				lines: {
					type: "array",
					items: { type: "string" },
				},
			},
			required: ["lines"],
		});
		expect(JSON.stringify(claudeDeclaration.parameters)).not.toContain('"anyOf"');
		expect(JSON.stringify(claudeDeclaration.parameters)).not.toContain('"oneOf"');
		expect(claudeDeclaration.parametersJsonSchema).toBeUndefined();
		expect(
			(geminiDeclaration.parametersJsonSchema as { properties?: Record<string, unknown> })?.properties?.lines,
		).toEqual((parameters as { properties: { lines: unknown } }).properties.lines);
	});

	it("collapses mixed anyOf with shared metadata for edit-style lines fields", () => {
		const parameters = {
			type: "object",
			properties: {
				edits: {
					type: "array",
					items: {
						type: "object",
						properties: {
							lines: {
								anyOf: [
									{
										type: "array",
										description: "content (preferred format)",
										items: { type: "string" },
									},
									{ type: "string" },
									{ type: "null" },
								],
							},
						},
					},
				},
			},
		} as TJsonSchema;
		const tools: Tool[] = [{ name: "edit", description: "Edit tool", parameters }];
		const model = createModel("claude-sonnet-4-5");

		const declaration = convertTools(tools, model)?.[0]?.functionDeclarations[0] as Record<string, unknown>;
		const linesSchema = ((
			(declaration.parameters as { properties?: Record<string, unknown> })?.properties?.edits as {
				items?: { properties?: Record<string, unknown> };
			}
		)?.items?.properties?.lines ?? null) as Record<string, unknown> | null;

		// Lossy collapse: array|string|null narrows to array (first non-null type)
		expect(linesSchema).toEqual({
			type: "array",
			description: "content (preferred format)",
			items: { type: "string" },
		});
		expect(JSON.stringify(declaration.parameters)).not.toContain('"anyOf"');
	});
	it("collapses mixed unions for todo_write-style nullable content fields", () => {
		const parameters = {
			type: "object",
			properties: {
				ops: {
					type: "array",
					items: {
						type: "object",
						properties: {
							content: {
								anyOf: [{ type: "string", description: "Updated task description" }, { type: "null" }],
							},
						},
					},
				},
			},
		} as TJsonSchema;
		const tools: Tool[] = [{ name: "todo_write", description: "Todo tool", parameters }];
		const model = createModel("claude-sonnet-4-5");

		const declaration = convertTools(tools, model)?.[0]?.functionDeclarations[0] as Record<string, unknown>;
		const contentSchema = ((
			(declaration.parameters as { properties?: Record<string, unknown> })?.properties?.ops as {
				items?: { properties?: Record<string, unknown> };
			}
		)?.items?.properties?.content ?? null) as Record<string, unknown> | null;

		// string|null collapses cleanly to string (single non-null type)
		expect(contentSchema).toEqual({
			type: "string",
			description: "Updated task description",
		});
		expect(JSON.stringify(declaration.parameters)).not.toContain('"anyOf"');
	});
	it("preserves nullable unions as optional properties instead of full fallback", () => {
		const parameters = {
			type: "object",
			properties: {
				value: {
					anyOf: [{ enum: ["A", "B"] }, { type: "null" }],
				},
			},
			required: ["value"],
		} as TJsonSchema;
		const tools: Tool[] = [{ name: "test_tool", description: "Test tool", parameters }];
		const claudeModel = createModel("claude-sonnet-4-5");
		const geminiModel = createModel("gemini-2.5-pro");

		const claudeDeclaration = convertTools(tools, claudeModel)?.[0]?.functionDeclarations[0] as Record<
			string,
			unknown
		>;
		const geminiDeclaration = convertTools(tools, geminiModel)?.[0]?.functionDeclarations[0] as Record<
			string,
			unknown
		>;

		expect(claudeDeclaration.parameters).toEqual({
			type: "object",
			properties: {
				value: { enum: ["A", "B"] },
			},
			required: [],
		});
		expect(JSON.stringify(claudeDeclaration.parameters)).not.toContain('"anyOf"');
		expect(
			(geminiDeclaration.parametersJsonSchema as { properties?: Record<string, unknown> })?.properties?.value,
		).toEqual((parameters as { properties: { value: unknown } }).properties.value);
	});

	it("falls back to minimal object schema when non-null unresolved unions remain for CCA Claude", () => {
		const parameters = {
			type: "object",
			properties: {
				value: {
					anyOf: [{ enum: ["A", "B"] }, { enum: ["C", "D"] }],
				},
			},
			required: ["value"],
		} as TJsonSchema;
		const tools: Tool[] = [{ name: "test_tool", description: "Test tool", parameters }];
		const claudeModel = createModel("claude-sonnet-4-5");

		const claudeDeclaration = convertTools(tools, claudeModel)?.[0]?.functionDeclarations[0] as Record<
			string,
			unknown
		>;

		expect(claudeDeclaration.parameters).toEqual({
			type: "object",
			properties: {},
		});
	});
	it("keeps google sanitizer behavior for non-claude schema path", () => {
		const schema = {
			type: "object",
			properties: {
				value: {
					type: ["string", "null"],
				},
			},
		} as unknown;

		expect(sanitizeSchemaForGoogle(schema)).toEqual({
			type: "object",
			properties: {
				value: {
					type: "string",
					nullable: true,
				},
			},
		});
	});
});
