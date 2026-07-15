import { describe, expect, test } from "bun:test";
import * as vm from "node:vm";
import { parseHTML } from "linkedom";
import { Marked } from "marked";

const [templateHtml, templateJs] = await Promise.all([
	Bun.file(new URL("../src/export/html/template.html", import.meta.url)).text(),
	Bun.file(new URL("../src/export/html/template.js", import.meta.url)).text(),
]);

function renderMarkdown(source: string): Element {
	const { document, window } = parseHTML(templateHtml);
	const session = {
		header: {
			type: "session",
			version: 3,
			id: "markdown-test",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: "/tmp",
		},
		entries: [
			{
				type: "message",
				id: "message-1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: {
					role: "user",
					content: source,
					timestamp: 0,
				},
			},
		],
		leafId: "message-1",
	};

	const sessionData = document.getElementById("session-data");
	if (!sessionData) throw new Error("Export template is missing session data");
	sessionData.textContent = Buffer.from(JSON.stringify(session)).toBase64();
	Object.defineProperty(window, "location", {
		value: new URL("https://example.test/export.html"),
		configurable: true,
	});
	Object.defineProperty(window, "matchMedia", {
		value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		configurable: true,
	});

	const context = vm.createContext({
		window,
		document,
		marked: new Marked(),
		hljs: {
			getLanguage: () => false,
			highlight: () => ({ value: "" }),
			highlightAuto: () => ({ value: "" }),
		},
		URL,
		URLSearchParams,
		TextDecoder,
		Uint8Array,
		atob,
		navigator: { clipboard: null },
		localStorage: { getItem: () => null, setItem() {} },
		setTimeout: () => 0,
		clearTimeout() {},
	});
	vm.runInContext(templateJs, context);

	const rendered = document.querySelector(".markdown-content");
	if (!rendered) throw new Error("Export viewer did not render Markdown content");
	return rendered;
}

describe("HTML export Markdown", () => {
	test("renders inline Markdown in ordered, unordered, and nested list items", () => {
		const rendered = renderMarkdown("**outside**\n\n- **bold** and *italic* and `code`\n  1. **nested**");

		expect(rendered.querySelector("p strong")?.textContent).toBe("outside");
		expect(rendered.querySelector("ul > li > strong")?.textContent).toBe("bold");
		expect(rendered.querySelector("ul > li > em")?.textContent).toBe("italic");
		expect(rendered.querySelector("ul > li > code")?.textContent).toBe("code");
		expect(rendered.querySelector("ol > li > strong")?.textContent).toBe("nested");
	});
});
