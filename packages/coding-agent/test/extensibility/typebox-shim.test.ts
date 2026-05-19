import { describe, expect, it } from "bun:test";
import { isValidJsonSchema, toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { Type } from "../../src/extensibility/typebox";

describe("pi.typebox compatibility shim", () => {
	it("rejects extra properties when additionalProperties is false", () => {
		const schema = Type.Object({ path: Type.String() }, { additionalProperties: false });

		expect(schema.safeParse({ path: "README.md" }).success).toBe(true);
		expect(schema.safeParse({ path: "README.md", mode: "delete" }).success).toBe(false);
	});

	it("preserves numeric enum values from TypeScript enum objects", () => {
		const schema = Type.Enum({ 0: "Fast", 1: "Slow", Fast: 0, Slow: 1 });

		expect(schema.safeParse(0).success).toBe(true);
		expect(schema.safeParse(1).success).toBe(true);
		expect(schema.safeParse("Fast").success).toBe(false);
	});

	it("enforces and emits uniqueItems for arrays", () => {
		const schema = Type.Array(Type.String(), { uniqueItems: true });
		const wire = toolWireSchema({ name: "files", description: "", parameters: schema });

		expect(schema.safeParse(["a.ts", "b.ts"]).success).toBe(true);
		expect(schema.safeParse(["a.ts", "a.ts"]).success).toBe(false);
		expect(wire.uniqueItems).toBe(true);
	});

	it("respects record key schemas", () => {
		const schema = Type.Record(Type.Literal("target"), Type.String());

		expect(schema.safeParse({ target: "ok" }).success).toBe(true);
		expect(schema.safeParse({ other: "bad" }).success).toBe(false);
	});

	it("merges every object passed to Composite", () => {
		const schema = Type.Composite([
			Type.Object({ a: Type.String() }),
			Type.Object({ b: Type.String() }),
			Type.Object({ c: Type.String() }),
		]);

		expect(schema.safeParse({ a: "a", b: "b", c: "c" }).success).toBe(true);
		expect(schema.safeParse({ a: "a", b: "b" }).success).toBe(false);
	});

	it("applies minLength on top of a string format", () => {
		const schema = Type.String({ format: "email", minLength: 20 });

		expect(schema.safeParse("a@b.co").success).toBe(false);
		expect(schema.safeParse("longer-address@example.com").success).toBe(true);
	});

	it("applies pattern on top of a url format", () => {
		const schema = Type.String({ format: "url", pattern: "^https://" });

		expect(schema.safeParse("http://example.com").success).toBe(false);
		expect(schema.safeParse("https://example.com").success).toBe(true);
	});

	it("preserves unknown properties by default on Type.Object", () => {
		const schema = Type.Object({ a: Type.String() });
		const parsed = schema.safeParse({ a: "x", extra: 1 });

		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect((parsed.data as { extra?: unknown }).extra).toBe(1);
		}
	});

	// Regression: issue #1101. Real TypeBox lets extension authors do
	// `JSON.stringify(schema)` and get a clean JSON Schema — that's the
	// contract the shim is impersonating. Without a `toJSON` stamp, the shim
	// leaks raw Zod internals (`def`, `_zod`, object-shaped `enum`,
	// `"type":"enum"`) and breaks any pipeline that crosses a JSON boundary.
	describe("JSON.stringify produces valid JSON Schema (TypeBox contract)", () => {
		it("emits clean JSON Schema for a complex object", () => {
			const schema = Type.Object({
				direction: Type.Enum({ upstream: "upstream", downstream: "downstream" }),
				depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 3 })),
				tags: Type.Array(Type.String()),
			});
			const round = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
			expect(isValidJsonSchema(round)).toBe(true);
			// No raw Zod internals leak through.
			expect(round).not.toHaveProperty("_zod");
			expect(round).not.toHaveProperty("def");
			expect(round.type).toBe("object");
		});

		it("emits valid JSON Schema for composition operators", () => {
			const base = Type.Object({ a: Type.String(), b: Type.Number() });
			for (const schema of [
				Type.Partial(base),
				Type.Required(base),
				Type.Pick(base, ["a"]),
				Type.Omit(base, ["a"]),
				Type.Composite([base, Type.Object({ c: Type.Boolean() })]),
			]) {
				const round = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
				expect(isValidJsonSchema(round)).toBe(true);
				expect(round).not.toHaveProperty("_zod");
			}
		});
	});
});
