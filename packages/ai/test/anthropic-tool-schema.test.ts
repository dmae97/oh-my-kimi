import { describe, expect, it } from "bun:test";
import { normalizeAnthropicToolSchema } from "@oh-my-pi/pi-ai/providers/anthropic";

describe("normalizeAnthropicToolSchema", () => {
	it("demotes numeric range keywords on number nodes into description", () => {
		const out = normalizeAnthropicToolSchema({
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
		}) as { properties: { temperature: Record<string, unknown> } };
		expect(out.properties.temperature).toEqual({
			type: "number",
			description: "{minimum: 0, maximum: 1, exclusiveMinimum: 0, exclusiveMaximum: 1, multipleOf: 0.1}",
		});
	});

	it("demotes numeric range keywords on integer nodes into description", () => {
		const out = normalizeAnthropicToolSchema({
			type: "object",
			properties: {
				count: { type: "integer", minimum: 0, maximum: 100, multipleOf: 1 },
			},
		}) as { properties: { count: Record<string, unknown> } };
		expect(out.properties.count).toEqual({
			type: "integer",
			description: "{minimum: 0, maximum: 100, multipleOf: 1}",
		});
	});

	it("demotes numeric range keywords on union-type nodes that include number", () => {
		const out = normalizeAnthropicToolSchema({
			type: "object",
			properties: {
				value: { type: ["number", "null"], minimum: 0, maximum: 10 },
			},
		}) as { properties: { value: Record<string, unknown> } };
		expect(out.properties.value).toEqual({
			type: ["number", "null"],
			description: "{minimum: 0, maximum: 10}",
		});
	});

	it("appends spilled keywords to an existing description with a blank line", () => {
		const out = normalizeAnthropicToolSchema({
			type: "object",
			properties: {
				ratio: { type: "number", description: "A ratio", minimum: 0, maximum: 1 },
			},
		}) as { properties: { ratio: Record<string, unknown> } };
		expect(out.properties.ratio).toEqual({
			type: "number",
			description: "A ratio\n\n{minimum: 0, maximum: 1}",
		});
	});

	it("preserves numeric range keywords on non-numeric nodes", () => {
		const out = normalizeAnthropicToolSchema({
			type: "object",
			properties: { name: { type: "string", minLength: 1 } },
		}) as { properties: { name: Record<string, unknown> } };
		expect(out.properties.name).toEqual({ type: "string", minLength: 1 });
	});

	it("demotes universally-unsupported keywords (maxItems, patternProperties, propertyNames)", () => {
		const out = normalizeAnthropicToolSchema({
			type: "object",
			properties: {
				tags: { type: "array", items: { type: "string" }, maxItems: 5 },
			},
			patternProperties: { "^x-": { type: "string" } },
			propertyNames: { pattern: "^[a-z]+$" },
		}) as Record<string, unknown> & { description?: string; properties: { tags: Record<string, unknown> } };

		expect(out.properties.tags).toEqual({
			type: "array",
			items: { type: "string" },
			description: "{maxItems: 5}",
		});
		// Object-level unsupported keys also spill into the parent's description.
		expect(typeof out.description).toBe("string");
		expect(out.description).toContain("patternProperties");
		expect(out.description).toContain("propertyNames");
		expect(out).not.toHaveProperty("patternProperties");
		expect(out).not.toHaveProperty("propertyNames");
	});

	it("strips minItems from object nodes and records it in the description", () => {
		const out = normalizeAnthropicToolSchema({
			type: "object",
			minItems: 1,
			properties: { a: { type: "string" } },
		}) as Record<string, unknown>;
		expect(out).not.toHaveProperty("minItems");
		expect(out.description).toBe("{minItems: 1}");
	});

	it("keeps minItems on array nodes when it is 0 or 1, spills otherwise", () => {
		const out01 = normalizeAnthropicToolSchema({
			type: "array",
			items: { type: "string" },
			minItems: 1,
		}) as Record<string, unknown>;
		expect(out01.minItems).toBe(1);
		expect(out01).not.toHaveProperty("description");

		const out5 = normalizeAnthropicToolSchema({
			type: "array",
			items: { type: "string" },
			minItems: 5,
		}) as Record<string, unknown>;
		expect(out5).not.toHaveProperty("minItems");
		expect(out5.description).toBe("{minItems: 5}");
	});
});
