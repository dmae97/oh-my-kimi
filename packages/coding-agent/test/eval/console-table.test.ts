import { describe, expect, it } from "bun:test";
import { JsRuntime, type RuntimeHooks } from "@oh-my-pi/pi-coding-agent/eval/js/shared/runtime";
import type { JsDisplayOutput } from "@oh-my-pi/pi-coding-agent/eval/js/shared/types";

function makeRuntime(): {
	runtime: JsRuntime;
	hooks: RuntimeHooks;
	texts: string[];
	displays: JsDisplayOutput[];
} {
	const texts: string[] = [];
	const displays: JsDisplayOutput[] = [];
	const runtime = new JsRuntime({
		initialCwd: process.cwd(),
		sessionId: "test",
	});
	const hooks: RuntimeHooks = {
		onText: (chunk: string) => {
			texts.push(chunk);
		},
		onDisplay: (output: JsDisplayOutput) => {
			displays.push(output);
		},
		callTool: async () => undefined,
	};
	return { runtime, hooks, texts, displays };
}

describe("console.table bridge", () => {
	it("renders an array of objects as an ASCII table on text output", async () => {
		const { runtime, hooks, texts, displays } = makeRuntime();
		await runtime.run("console.table([{ name: 'Ada', age: 36 }, { name: 'Linus', age: 54 }]);", undefined, hooks);
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
		const { runtime, hooks, texts } = makeRuntime();
		await runtime.run("console.table([{ name: 'Ada', age: 36, secret: 'hidden' }], ['name']);", undefined, hooks);
		const out = texts.join("");
		expect(out).toContain("name");
		expect(out).toContain("Ada");
		expect(out).not.toContain("secret");
		expect(out).not.toContain("hidden");
		expect(out).not.toContain("age");
	});
});
