import { describe, expect, it } from "bun:test";
import { RunOutput } from "@oh-my-pi/pi-coding-agent/tools/browser/run-output";
import { formatSelectorMatchHint, toActionableHandle } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import type { ElementHandle } from "puppeteer-core";

// Regression coverage for the invisible-output failure mode: `display("string")`,
// `console.log`, and `print` reach the runtime as `onText` chunks, which the browser
// embedders used to route to the debug log only — the tool result showed a bare
// "Ran code on tab" while the displayed text vanished.
describe("browser run output — stream text reaches the tool result", () => {
	it("surfaces buffered stream text as a display entry on finish", () => {
		const output = new RunOutput();
		output.pushText("plain string via display()\n");
		output.pushText("console.log line\n");

		expect(output.finish()).toEqual([{ type: "text", text: "plain string via display()\nconsole.log line" }]);
	});

	it("keeps stream text ordered around display() payloads", () => {
		const output = new RunOutput();
		output.pushText("before\n");
		output.pushDisplay({ type: "json", data: { a: 1 } });
		output.pushText("after\n");

		const entries = output.finish();
		expect(entries.map(e => (e.type === "text" ? e.text : e.type))).toEqual([
			"before",
			JSON.stringify({ a: 1 }, null, 2),
			"after",
		]);
	});

	it("flushes pending text before pre-built entries (screenshot captions) and emits images verbatim", () => {
		const output = new RunOutput();
		output.pushText("shot incoming\n");
		output.push({ type: "image", data: "aGk=", mimeType: "image/png" });
		output.pushDisplay({ type: "image", data: "eW8=", mimeType: "image/webp" });

		expect(output.finish()).toEqual([
			{ type: "text", text: "shot incoming" },
			{ type: "image", data: "aGk=", mimeType: "image/png" },
			{ type: "image", data: "eW8=", mimeType: "image/webp" },
		]);
	});

	it("returns no entries when nothing was displayed", () => {
		expect(new RunOutput().finish()).toEqual([]);
	});
});

// The tool docs promise `.fill()` on handles from tab.id()/tab.ref()/tab.waitFor();
// raw puppeteer ElementHandles only expose `.type()`. `input.fill is not a function`
// was a live failure.
describe("browser handle enrichment — fill()", () => {
	it("adds a fill() that clears the current value before typing", async () => {
		const calls: string[] = [];
		const node = { value: "old", focused: false };
		const stub = {
			evaluate: async (fn: (el: unknown) => unknown) => {
				calls.push("evaluate");
				fn({
					get value() {
						return node.value;
					},
					set value(v: string) {
						node.value = v;
					},
					focus: () => {
						node.focused = true;
					},
				});
			},
			type: async (text: string) => {
				calls.push("type");
				node.value += text;
			},
		} as unknown as ElementHandle;

		await toActionableHandle(stub).fill("fresh");

		expect(calls).toEqual(["evaluate", "type"]);
		expect(node.focused).toBe(true);
		expect(node.value).toBe("fresh");
	});
});

// A selector op's fail-fast timeout must diagnose *why*: a missing element (consent
// wall, wrong page) needs a different recovery than a present-but-unactionable one.
describe("browser selector timeout hint", () => {
	it("points at observe/ariaSnapshot when nothing matches", () => {
		expect(formatSelectorMatchHint(0)).toContain("matches no elements");
		expect(formatSelectorMatchHint(0)).toContain("tab.observe()");
	});

	it("reports the match count when elements exist but the action stalled", () => {
		const hint = formatSelectorMatchHint(3);
		expect(hint).toContain("3 element(s)");
		expect(hint).toContain("hidden or covered");
	});
});
