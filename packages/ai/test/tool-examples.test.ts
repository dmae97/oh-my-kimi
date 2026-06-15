import { describe, expect, it } from "bun:test";
import { renderToolExamples } from "../src/grammar/examples";
import type { InbandTool } from "../src/grammar/types";

describe("renderToolExamples", () => {
	it("renders call example in anthropic format", () => {
		const tool: InbandTool = {
			name: "find",
			description: "Find files.",
			parameters: {
				type: "object",
				properties: {
					paths: { type: "array", items: { type: "string" } },
				},
				required: ["paths"],
			},
			examples: [
				{
					caption: "Find files",
					call: { paths: ["src/**/*.ts"] },
				},
			],
		};

		const rendered = renderToolExamples(tool, "anthropic");
		expect(rendered).toContain("<examples>");
		expect(rendered).toContain("# Find files");
		expect(rendered).toContain('<invoke name="find">');
		expect(rendered).toContain('<parameter name="paths"');
		expect(rendered).toContain("</examples>");
	});

	it("renders call example in pi format", () => {
		const tool: InbandTool = {
			name: "find",
			description: "Find files.",
			parameters: {
				type: "object",
				properties: {
					paths: { type: "array", items: { type: "string" } },
				},
				required: ["paths"],
			},
			examples: [
				{
					caption: "Find files",
					call: { paths: ["src/**/*.ts"] },
				},
			],
		};

		const rendered = renderToolExamples(tool, "pi");
		expect(rendered).toContain("<call:find>");
		expect(rendered).toContain("<paths>");
		expect(rendered).toContain("src/**/*.ts");
	});

	it("renders call example in hermes format", () => {
		const tool: InbandTool = {
			name: "find",
			description: "Find files.",
			parameters: {
				type: "object",
				properties: {
					paths: { type: "array", items: { type: "string" } },
				},
				required: ["paths"],
			},
			examples: [
				{
					caption: "Find files",
					call: { paths: ["src/**/*.ts"] },
				},
			],
		};

		const rendered = renderToolExamples(tool, "hermes");
		expect(rendered).toContain("<tool_call>");
		expect(rendered).toContain('"name":"find"');
		expect(rendered).toContain('"paths"');
	});

	it("renders harmony call example as bare JSON without the message envelope", () => {
		const tool: InbandTool = {
			name: "irc",
			description: "IRC.",
			parameters: {
				type: "object",
				properties: {
					op: { type: "string" },
					to: { type: "string" },
					message: { type: "string" },
				},
				required: ["op"],
			},
			examples: [
				{
					caption: "Broadcast",
					call: { op: "send", to: "all", message: "hi" },
				},
			],
		};

		const rendered = renderToolExamples(tool, "harmony");
		expect(rendered).toContain('{"op":"send","to":"all","message":"hi"}');
		// The verbose harmony envelope must be stripped inside <example> blocks.
		expect(rendered).not.toContain("<|start|>");
		expect(rendered).not.toContain("<|channel|>");
		expect(rendered).not.toContain("<|message|>");
		expect(rendered).not.toContain("<|call|>");
	});

	it("returns empty string for empty examples", () => {
		const tool: InbandTool = {
			name: "find",
			description: "Find files.",
			parameters: { type: "object", properties: {} },
			examples: [],
		};

		expect(renderToolExamples(tool, "anthropic")).toBe("");
	});

	it("renders compare examples with WRONG and RIGHT", () => {
		const tool: InbandTool = {
			name: "find",
			description: "Find files.",
			parameters: {
				type: "object",
				properties: {
					paths: { type: "array", items: { type: "string" } },
				},
				required: ["paths"],
			},
			examples: [
				{
					caption: "Avoid broad scans",
					bad: { paths: ["**/*.ts"] },
					good: { paths: ["src/**/*.ts"] },
				},
			],
		};

		const rendered = renderToolExamples(tool, "anthropic");
		expect(rendered).toContain("WRONG:");
		expect(rendered).toContain("RIGHT:");
		expect(rendered).toContain('<parameter name="paths"');
		expect(rendered).toContain('["**/*.ts"]');
	});

	it("injects the intent-field placeholder when intentField is provided", () => {
		const tool: InbandTool = {
			name: "find",
			description: "Find files.",
			parameters: {
				type: "object",
				properties: {
					_i: { type: "string" },
					paths: { type: "array", items: { type: "string" } },
				},
				required: ["_i", "paths"],
			},
			examples: [
				{
					caption: "Find files",
					call: { paths: ["src/**/*.ts"] },
				},
			],
		};

		const rendered = renderToolExamples(tool, "anthropic", "_i");
		expect(rendered).toContain('<parameter name="_i"');
		expect(rendered).toContain("…");
		// Placeholder leads the args, matching schema-injection order.
		expect(rendered.indexOf('name="_i"')).toBeLessThan(rendered.indexOf('name="paths"'));
	});

	it("omits the intent-field placeholder when intentField is undefined", () => {
		const tool: InbandTool = {
			name: "find",
			description: "Find files.",
			parameters: {
				type: "object",
				properties: { paths: { type: "array", items: { type: "string" } } },
				required: ["paths"],
			},
			examples: [{ caption: "Find files", call: { paths: ["src/**/*.ts"] } }],
		};

		expect(renderToolExamples(tool, "anthropic")).not.toContain("_i");
	});
});
