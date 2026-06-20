import { describe, expect, test } from "bun:test";
import { buildParams, convertTools } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, Model, ModelSpec, Tool } from "@oh-my-pi/pi-ai/types";
import { findStrictToolSchemaViolation } from "@oh-my-pi/pi-ai/utils/schema";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { type } from "arktype";

function makeModel(): Model<"openai-responses"> {
	return buildModel({
		id: "gpt-5",
		name: "GPT-5",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	} as ModelSpec<"openai-responses">);
}

describe("findStrictToolSchemaViolation (#2652)", () => {
	test("flags a non-null enum on a null-typed node (nullable-enum shape)", () => {
		expect(findStrictToolSchemaViolation({ enum: ["A", "B"], type: "null" })).toBe("#/enum");
	});

	test("flags an enum on an array-typed node (enum-on-array shape)", () => {
		expect(findStrictToolSchemaViolation({ enum: [0, 1, 2], items: { type: "integer" }, type: "array" })).toBe(
			"#/enum",
		);
	});

	test("flags a const incompatible with its type (anyOf/const shape) with its path", () => {
		const schema = { anyOf: [{ const: 5, type: "string" }, { type: "null" }] };
		expect(findStrictToolSchemaViolation(schema)).toBe("#/anyOf/0/const");
	});

	test("reports the nested path to the offending node", () => {
		const schema = {
			type: "object",
			properties: { tag: { enum: ["x"], type: "null" } },
			required: ["tag"],
		};
		expect(findStrictToolSchemaViolation(schema)).toBe("#/properties/tag/enum");
	});

	test("accepts valid enum/const/type combinations, including nullable unions", () => {
		expect(findStrictToolSchemaViolation({ enum: ["a", "b"], type: "string" })).toBeNull();
		expect(findStrictToolSchemaViolation({ enum: ["a", null], type: ["string", "null"] })).toBeNull();
		expect(findStrictToolSchemaViolation({ const: 5, type: "integer" })).toBeNull();
		// An enum belongs on the array's items, which is valid.
		expect(findStrictToolSchemaViolation({ type: "array", items: { enum: [1, 2], type: "integer" } })).toBeNull();
		// enum without a declared type cannot contradict anything.
		expect(findStrictToolSchemaViolation({ enum: ["x"] })).toBeNull();
	});
});

const badTool: Tool = {
	name: "mcp__server__bad",
	description: "an MCP tool with an invalid nullable-enum schema",
	parameters: {
		type: "object",
		properties: { choice: { enum: ["A", "B"], type: "null" } },
		required: ["choice"],
		additionalProperties: false,
	} as unknown as Tool["parameters"],
};
const goodTool: Tool = {
	name: "read_file",
	description: "read a file",
	parameters: type({ path: "string" }),
};

describe("convertTools quarantine (#2652)", () => {
	test("drops only the tool with the provider-rejecting schema, keeping the rest", () => {
		const out = convertTools([goodTool, badTool], true, makeModel()) as Array<{ name: string }>;
		const names = out.map(t => t.name);
		expect(names).toContain("read_file");
		expect(names).not.toContain("mcp__server__bad");
		expect(out).toHaveLength(1);
	});

	test("emits every tool when all schemas are valid", () => {
		expect(convertTools([goodTool], true, makeModel())).toHaveLength(1);
	});

	test("reports the hidden tool name and the offending schema path", () => {
		const dropped: Array<{ name: string; path: string }> = [];
		convertTools([badTool], true, makeModel(), (name, path) => dropped.push({ name, path }));
		expect(dropped).toEqual([{ name: "mcp__server__bad", path: "#/properties/choice/enum" }]);
	});
});

describe("buildParams tool_choice reconciliation (#2652)", () => {
	function ctx(tools: Tool[]): Context {
		return { systemPrompt: [], messages: [], tools } as unknown as Context;
	}

	test("drops a forced tool_choice when the selected tool was quarantined", () => {
		const { params } = buildParams(
			makeModel(),
			ctx([goodTool, badTool]),
			{ toolChoice: { type: "tool", name: "mcp__server__bad" } },
			undefined,
		);
		expect((params.tools as Array<{ name: string }>).map(t => t.name)).toEqual(["read_file"]);
		expect(params.tool_choice).toBeUndefined();
	});

	test("drops a 'required' tool_choice when every tool was quarantined", () => {
		const { params } = buildParams(makeModel(), ctx([badTool]), { toolChoice: "required" }, undefined);
		expect(params.tools).toHaveLength(0);
		expect(params.tool_choice).toBeUndefined();
	});

	test("keeps tool_choice for a surviving forced tool", () => {
		const { params } = buildParams(
			makeModel(),
			ctx([goodTool, badTool]),
			{ toolChoice: { type: "tool", name: "read_file" } },
			undefined,
		);
		expect(params.tool_choice).toEqual({ type: "function", name: "read_file" });
	});
});
