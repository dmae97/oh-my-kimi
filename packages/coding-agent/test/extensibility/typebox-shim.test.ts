import { describe, expect, it } from "bun:test";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
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
});
