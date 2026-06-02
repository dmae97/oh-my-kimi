import { describe, expect, it } from "bun:test";
import { normalizeAnthropicToolSchema } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Tool } from "@oh-my-pi/pi-ai/types";
import {
	decontaminateZodInstance,
	isZodSchema,
	normalizeEmptySchemas,
	normalizeSchemaForCCA,
	normalizeSchemaForGoogle,
	toolWireSchema,
	zodToWireSchema,
} from "@oh-my-pi/pi-ai/utils/schema";
import { z } from "zod/v4";

describe("isZodSchema", () => {
	it("accepts a live Zod instance", () => {
		expect(isZodSchema(z.object({ a: z.string() }))).toBe(true);
		expect(isZodSchema(z.string())).toBe(true);
		expect(isZodSchema(z.enum({ a: "a", b: "b" }))).toBe(true);
	});

	// Regression: issue #1101. Before tightening, `isZodSchema` returned true
	// for `JSON.parse(JSON.stringify(zodSchema))` because the `_zod` property
	// (and its object value) survived the round-trip — even though every Zod
	// method had been stripped along with the prototype. The relaxed predicate
	// fed garbage into `z.toJSONSchema` and (when callers bypassed conversion)
	// shipped the raw Zod internals to Anthropic's strict validator.
	it("rejects a JSON-roundtripped Zod schema (prototype lost)", () => {
		const impostor = JSON.parse(JSON.stringify(z.object({ a: z.string() })));
		expect(isZodSchema(impostor)).toBe(false);
	});

	it("rejects the raw gitnexus_impact.direction payload from issue #1101", () => {
		const impostor = {
			def: { type: "enum", entries: { upstream: "upstream", downstream: "downstream" } },
			type: "enum",
			enum: { upstream: "upstream", downstream: "downstream" },
			options: ["upstream", "downstream"],
		};
		expect(isZodSchema(impostor)).toBe(false);
	});

	it("rejects plain JSON Schema objects", () => {
		expect(isZodSchema({ type: "object", properties: {} })).toBe(false);
		expect(isZodSchema({ type: "string" })).toBe(false);
	});

	it("rejects non-objects", () => {
		expect(isZodSchema(null)).toBe(false);
		expect(isZodSchema(undefined)).toBe(false);
		expect(isZodSchema("string")).toBe(false);
		expect(isZodSchema(42)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// zodToWireSchema — empty-schema normalization (issue #1179)
// ---------------------------------------------------------------------------

describe("zodToWireSchema — empty-schema normalization", () => {
	it("converts z.unknown() additionalProperties from {} to true (z.record case)", () => {
		// Grammar-constrained samplers treat {} as "emit empty object" rather than
		// "any JSON value". Normalizing to `true` lets models emit strings.
		const schema = z.object({ extra: z.record(z.string(), z.unknown()) });
		const wire = zodToWireSchema(schema);
		const extra = (wire.properties as Record<string, unknown>).extra as Record<string, unknown>;
		expect(extra.additionalProperties).toBe(true);
	});

	it("converts z.unknown() items from {} to true (z.array case)", () => {
		const schema = z.object({ items: z.array(z.unknown()) });
		const wire = zodToWireSchema(schema);
		const items = (wire.properties as Record<string, unknown>).items as Record<string, unknown>;
		expect(items.items).toBe(true);
	});

	it("converts z.unknown() property schemas from {} to true", () => {
		const schema = z.object({ meta: z.unknown() });
		const wire = zodToWireSchema(schema);
		const meta = (wire.properties as Record<string, unknown>).meta;
		expect(meta).toBe(true);
	});

	it("does not touch non-empty schemas or boolean values", () => {
		const schema = z.object({ name: z.string() });
		const wire = zodToWireSchema(schema);
		const name = (wire.properties as Record<string, unknown>).name as Record<string, unknown>;
		expect(name.type).toBe("string");
		expect(name.additionalProperties).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// normalizeEmptySchemas — provider-agnostic post-pipeline normalization
// ---------------------------------------------------------------------------

describe("normalizeEmptySchemas", () => {
	it("normalizes {} in additionalProperties / items / property values / combiner branches", () => {
		const schema: Record<string, unknown> = {
			type: "object",
			properties: { meta: {}, items: { type: "array", items: {} } },
			additionalProperties: {},
			anyOf: [{}, { type: "string" }],
		};
		normalizeEmptySchemas(schema);
		expect(schema).toEqual({
			type: "object",
			properties: { meta: true, items: { type: "array", items: true } },
			additionalProperties: true,
			anyOf: [true, { type: "string" }],
		});
	});

	it("leaves non-empty schemas and boolean values alone", () => {
		const schema: Record<string, unknown> = {
			type: "object",
			additionalProperties: { type: "string" },
			unevaluatedProperties: false,
		};
		normalizeEmptySchemas(schema);
		expect(schema).toEqual({
			type: "object",
			additionalProperties: { type: "string" },
			unevaluatedProperties: false,
		});
	});
});

// ---------------------------------------------------------------------------
// toolWireSchema — covers both Zod and TypeBox paths (issue #1179)
// ---------------------------------------------------------------------------

describe("toolWireSchema — empty-schema normalization across both paths", () => {
	function zodTool(parameters: z.ZodType): Tool {
		return { name: "t", description: "", parameters, async execute() {} } as unknown as Tool;
	}
	function jsonTool(parameters: Record<string, unknown>): Tool {
		return { name: "t", description: "", parameters, async execute() {} } as unknown as Tool;
	}

	it("normalizes {} → true for Zod tools (z.record(z.string(), z.unknown()))", () => {
		const wire = toolWireSchema(zodTool(z.object({ extra: z.record(z.string(), z.unknown()) })));
		const extra = (wire.properties as Record<string, unknown>).extra as Record<string, unknown>;
		expect(extra.additionalProperties).toBe(true);
	});

	it("normalizes {} → true for TypeBox / raw JSON Schema tools", () => {
		const wire = toolWireSchema(
			jsonTool({
				type: "object",
				properties: { extra: { type: "object", additionalProperties: {} } },
				required: [],
			}),
		);
		const extra = (wire.properties as Record<string, unknown>).extra as Record<string, unknown>;
		expect(extra.additionalProperties).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Provider downstream behavior with normalized `additionalProperties: true`
// (issue #1179 — verify Google and Anthropic don't break)
// ---------------------------------------------------------------------------

describe("provider normalizers on normalized open-record schemas", () => {
	const wire = zodToWireSchema(
		z.object({
			action: z.enum(["apply", "discard"]),
			extra: z.record(z.string(), z.unknown()).optional(),
		}),
	);

	it("Anthropic preserves additionalProperties: true so strict-mode opt-out still fires", () => {
		// `normalizeAnthropicStrictSchemaNode` rejects nodes where additionalProperties !== false.
		// With normalization, the value is `true` (was `{}`); still !== false, so strict opts out.
		const out = normalizeAnthropicToolSchema(wire) as Record<string, unknown>;
		const extra = (out.properties as Record<string, unknown>).extra as Record<string, unknown>;
		expect(extra.additionalProperties).toBe(true);
	});

	it("Google strips additionalProperties entirely (UNSUPPORTED_SCHEMA_FIELDS)", () => {
		// Pre-existing behavior — Google never sees the open-record marker either way.
		// `additionalProperties: true` is removed just like `additionalProperties: {}` was.
		const out = normalizeSchemaForGoogle(wire) as Record<string, unknown>;
		const extra = (out.properties as Record<string, unknown>).extra as Record<string, unknown>;
		expect(extra).not.toHaveProperty("additionalProperties");
	});

	it("CCA (Claude on Cloud Code Assist) strips additionalProperties entirely", () => {
		const out = normalizeSchemaForCCA(wire) as Record<string, unknown>;
		const extra = (out.properties as Record<string, unknown>).extra as Record<string, unknown>;
		expect(extra).not.toHaveProperty("additionalProperties");
	});
});

// ---------------------------------------------------------------------------
// decontaminateZodInstance — nullable wrapping of non-scalar inner schemas
// ---------------------------------------------------------------------------

describe("decontaminateZodInstance — nullable union", () => {
	it("z.union([z.string(), z.number()]).nullable() produces a null-tolerant schema", () => {
		// Round-trip strips Zod methods; decontaminateZodInstance must then inject null.
		const roundTripped = JSON.parse(JSON.stringify(z.union([z.string(), z.number()]).nullable()));
		const out = decontaminateZodInstance(roundTripped) as Record<string, unknown>;
		// The union inner schema surfaces as an anyOf shape (no scalar `type`), so
		// nullable wrapping must produce { anyOf: [..., { type: "null" }] }.
		const toleratesNull =
			(Array.isArray(out.type) && (out.type as string[]).includes("null")) ||
			(Array.isArray(out.anyOf) &&
				(out.anyOf as unknown[]).some(
					b => typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "null",
				));
		expect(toleratesNull).toBe(true);
	});
});
