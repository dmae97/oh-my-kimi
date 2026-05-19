import { describe, expect, it } from "bun:test";
import { JsRuntime } from "@oh-my-pi/pi-coding-agent/eval/js/shared/runtime";
import type { JsDisplayOutput } from "@oh-my-pi/pi-coding-agent/eval/js/shared/types";

function collect(): {
	runtime: JsRuntime;
	displays: JsDisplayOutput[];
	texts: string[];
} {
	const displays: JsDisplayOutput[] = [];
	const texts: string[] = [];
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
	return { runtime, displays, texts };
}

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_BASE64 = Buffer.from(PNG_BYTES).toString("base64");

describe("JsRuntime.displayValue image coercion", () => {
	it("passes through strict base64 strings verbatim", () => {
		const { runtime, displays } = collect();
		runtime.displayValue({ type: "image", data: PNG_BASE64, mimeType: "image/png" });
		expect(displays).toEqual([{ type: "image", data: PNG_BASE64, mimeType: "image/png" }]);
	});

	it("base64-encodes Uint8Array data", () => {
		const { runtime, displays } = collect();
		runtime.displayValue({ type: "image", data: PNG_BYTES, mimeType: "image/png" });
		expect(displays).toEqual([{ type: "image", data: PNG_BASE64, mimeType: "image/png" }]);
	});

	it("base64-encodes Buffer data", () => {
		const { runtime, displays } = collect();
		runtime.displayValue({ type: "image", data: Buffer.from(PNG_BYTES), mimeType: "image/png" });
		expect(displays).toEqual([{ type: "image", data: PNG_BASE64, mimeType: "image/png" }]);
	});

	it("base64-encodes ArrayBuffer data", () => {
		const { runtime, displays } = collect();
		const ab = PNG_BYTES.buffer.slice(PNG_BYTES.byteOffset, PNG_BYTES.byteOffset + PNG_BYTES.byteLength);
		runtime.displayValue({ type: "image", data: ab, mimeType: "image/png" });
		expect(displays).toEqual([{ type: "image", data: PNG_BASE64, mimeType: "image/png" }]);
	});

	it("recovers decimal CSV produced by Uint8Array.prototype.toString", () => {
		// Reproduces the puppeteer footgun: page.screenshot() returns Uint8Array, and
		// `uint8array.toString("base64")` silently falls through to Array.toString,
		// yielding "137,80,78,71,...". Anthropic rejects that as invalid base64.
		const { runtime, displays } = collect();
		const decimalCsv = Array.from(PNG_BYTES).toString();
		expect(decimalCsv).toBe("137,80,78,71,13,10,26,10");
		runtime.displayValue({ type: "image", data: decimalCsv, mimeType: "image/png" });
		expect(displays).toEqual([{ type: "image", data: PNG_BASE64, mimeType: "image/png" }]);
	});

	it("recovers JSON-serialized Buffer shape ({ type: 'Buffer', data: [...] })", () => {
		const { runtime, displays } = collect();
		const jsonBuffer = JSON.parse(JSON.stringify(Buffer.from(PNG_BYTES))) as {
			type: string;
			data: number[];
		};
		runtime.displayValue({ type: "image", data: jsonBuffer, mimeType: "image/png" });
		expect(displays).toEqual([{ type: "image", data: PNG_BASE64, mimeType: "image/png" }]);
	});

	it("drops images whose data is unrecognized and surfaces a diagnostic in text", () => {
		const { runtime, displays, texts } = collect();
		runtime.displayValue({ type: "image", data: { not: "a buffer" }, mimeType: "image/png" });
		expect(displays).toHaveLength(0);
		expect(texts.join("")).toMatch(/image dropped/);
	});

	it("rejects strings that look base64-ish but aren't strictly valid", () => {
		// Padding mid-string, whitespace, or URL-safe alphabet are all dropped — the
		// Anthropic API only honors strict base64 in image sources.
		const { runtime, displays, texts } = collect();
		runtime.displayValue({ type: "image", data: "abcd=efg", mimeType: "image/png" });
		expect(displays).toHaveLength(0);
		expect(texts.join("")).toMatch(/image dropped/);
	});
});
