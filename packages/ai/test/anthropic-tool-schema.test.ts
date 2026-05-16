import { describe, expect, it } from "bun:test";
import { normalizeAnthropicToolSchema } from "@oh-my-pi/pi-ai/providers/anthropic";

describe("normalizeAnthropicToolSchema", () => {
	it("strips minimum/maximum/exclusive*/multipleOf on number nodes", () => {
		const schema = {
			type: "object",
			properties: {
				temperature: {
					type: "number",
					minimum: 0,
					maximum: 1,
					exclusiveMinimum: 0,
					exclusiveMaximum: 1,
					multipleOf: 0.1,
				},
			},
		};
		const out = normalizeAnthropicToolSchema(schema) as {
			properties: { temperature: Record<string, unknown> };
		};
		expect(out.properties.temperature).toEqual({ type: "number" });
	});

	it("strips numeric range keywords on integer nodes", () => {
		const schema = {
			type: "object",
			properties: {
				count: { type: "integer", minimum: 0, maximum: 100, multipleOf: 1 },
			},
		};
		const out = normalizeAnthropicToolSchema(schema) as {
			properties: { count: Record<string, unknown> };
		};
		expect(out.properties.count).toEqual({ type: "integer" });
	});

	it("strips numeric range keywords on union-type nodes that include number", () => {
		const schema = {
			type: "object",
			properties: {
				value: { type: ["number", "null"], minimum: 0, maximum: 10 },
			},
		};
		const out = normalizeAnthropicToolSchema(schema) as {
			properties: { value: Record<string, unknown> };
		};
		expect(out.properties.value).toEqual({ type: ["number", "null"] });
	});

	it("preserves numeric range keywords on non-numeric nodes", () => {
		const schema = {
			type: "object",
			properties: {
				name: { type: "string", minLength: 1 },
			},
		};
		const out = normalizeAnthropicToolSchema(schema) as {
			properties: { name: Record<string, unknown> };
		};
		// minLength is not in the unsupported list so it stays; only verifying we don't
		// accidentally trip the numeric branch for string nodes.
		expect(out.properties.name).toEqual({ type: "string", minLength: 1 });
	});
});
