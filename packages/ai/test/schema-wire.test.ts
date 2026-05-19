import { describe, expect, it } from "bun:test";
import { isZodSchema, zodToWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
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
