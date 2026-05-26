import { describe, expect, it } from "bun:test";
import { JsRuntime } from "@oh-my-pi/pi-coding-agent/eval/js/shared/runtime";
import type { JsDisplayOutput } from "@oh-my-pi/pi-coding-agent/eval/js/shared/types";

function makeRuntime(): { runtime: JsRuntime; texts: string[]; displays: JsDisplayOutput[] } {
	const texts: string[] = [];
	const displays: JsDisplayOutput[] = [];
	const runtime = new JsRuntime({
		initialCwd: process.cwd(),
		sessionId: "test",
		getHooks: () => ({
			onText: chunk => {
				texts.push(chunk);
			},
			onDisplay: output => {
				displays.push(output);
			},
			callTool: async () => undefined,
		}),
	});
	return { runtime, texts, displays };
}

describe("console.table bridge", () => {
	it("renders an array of objects as an ASCII table on text output", async () => {
		const { runtime, texts, displays } = makeRuntime();
		await runtime.run("console.table([{ name: 'Ada', age: 36 }, { name: 'Linus', age: 54 }]);");
		expect(displays).toEqual([]);
		expect(texts.length).toBe(1);
		const out = texts[0];
		// Box-drawing frame proves we routed through node:console.Console, not util.inspect.
		expect(out).toContain("┌");
		expect(out).toContain("(index)");
		expect(out).toContain("name");
		expect(out).toContain("age");
		expect(out).toContain("Ada");
		expect(out).toContain("Linus");
		expect(out.endsWith("\n")).toBe(true);
	});

	it("honors the optional columns filter", async () => {
		const { runtime, texts } = makeRuntime();
		await runtime.run("console.table([{ name: 'Ada', age: 36, secret: 'hidden' }], ['name']);");
		const out = texts.join("");
		expect(out).toContain("name");
		expect(out).toContain("Ada");
		expect(out).not.toContain("secret");
		expect(out).not.toContain("hidden");
		expect(out).not.toContain("age");
	});
});
