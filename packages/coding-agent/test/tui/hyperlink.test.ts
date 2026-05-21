import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as settingsModule from "@oh-my-pi/pi-coding-agent/config/settings";
import * as terminalCaps from "@oh-my-pi/pi-tui";
import { fileHyperlink, isHyperlinkEnabled, tryResolveInternalUrlSync } from "@oh-my-pi/pi-coding-agent/tui/hyperlink";

// OSC 8 sequence markers
const OSC = "\x1b]";
const ST = "\x1b\\";
const LINK_START = (id: string, uri: string) => `${OSC}8;id=${id};${uri}${ST}`;
const LINK_END = `${OSC}8;;${ST}`;

/** Extract the hyperlink URI from a wrapped string. Returns undefined if not wrapped. */
function extractLinkUri(text: string): string | undefined {
	const match = text.match(/\x1b\]8;[^;]*;([^\x1b]+)\x1b\\/);
	return match?.[1];
}

/** Returns true if the string contains an OSC 8 hyperlink wrapping a given display text. */
function isHyperlinked(text: string): boolean {
	return text.includes(`${OSC}8;`) && text.includes(LINK_END);
}

describe("isHyperlinkEnabled", () => {
	afterEach(() => {
		delete Bun.env.NO_COLOR;
	});

	it('returns false when mode is "off"', () => {
		const spy = spyOn(settingsModule.settings, "get").mockImplementation(
			(key: string) => (key === "tui.hyperlinks" ? "off" : undefined) as never,
		);
		expect(isHyperlinkEnabled()).toBe(false);
		spy.mockRestore();
	});

	it('returns true when mode is "always" regardless of TTY', () => {
		const spy = spyOn(settingsModule.settings, "get").mockImplementation(
			(key: string) => (key === "tui.hyperlinks" ? "always" : undefined) as never,
		);
		expect(isHyperlinkEnabled()).toBe(true);
		spy.mockRestore();
	});

	it('returns false in auto mode when NO_COLOR is set', () => {
		const spy = spyOn(settingsModule.settings, "get").mockImplementation(
			(key: string) => (key === "tui.hyperlinks" ? "auto" : undefined) as never,
		);
		Bun.env.NO_COLOR = "1";
		expect(isHyperlinkEnabled()).toBe(false);
		spy.mockRestore();
	});

	it('returns false in auto mode when stdout is not a TTY', () => {
		const spy = spyOn(settingsModule.settings, "get").mockImplementation(
			(key: string) => (key === "tui.hyperlinks" ? "auto" : undefined) as never,
		);
		const origTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
		expect(isHyperlinkEnabled()).toBe(false);
		if (origTTY) Object.defineProperty(process.stdout, "isTTY", origTTY);
		spy.mockRestore();
	});

	it("returns TERMINAL.hyperlinks value in auto mode when conditions are met", () => {
		const settingsSpy = spyOn(settingsModule.settings, "get").mockImplementation(
			(key: string) => (key === "tui.hyperlinks" ? "auto" : undefined) as never,
		);
		const origTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		// TERMINAL.hyperlinks may be true or false depending on the test runner env;
		// what matters is that isHyperlinkEnabled mirrors it.
		const expected = terminalCaps.TERMINAL.hyperlinks;
		expect(isHyperlinkEnabled()).toBe(expected);
		if (origTTY) Object.defineProperty(process.stdout, "isTTY", origTTY);
		settingsSpy.mockRestore();
	});
});

describe("fileHyperlink", () => {
	afterEach(() => {
		delete Bun.env.NO_COLOR;
	});

	it("returns plain text when hyperlinks are disabled (mode=off)", () => {
		const spy = spyOn(settingsModule.settings, "get").mockImplementation(
			(key: string) => (key === "tui.hyperlinks" ? "off" : undefined) as never,
		);
		const result = fileHyperlink("/Users/foo/bar.ts", "bar.ts");
		expect(result).toBe("bar.ts");
		spy.mockRestore();
	});

	it("wraps text in OSC 8 when hyperlinks are enabled (mode=always)", () => {
		const spy = spyOn(settingsModule.settings, "get").mockImplementation(
			(key: string) => (key === "tui.hyperlinks" ? "always" : undefined) as never,
		);
		const result = fileHyperlink("/Users/foo/bar.ts", "bar.ts");
		expect(isHyperlinked(result)).toBe(true);
		expect(result).toContain("bar.ts");
		spy.mockRestore();
	});

	it("builds a valid file:// URI with the absolute path", () => {
		const spy = spyOn(settingsModule.settings, "get").mockImplementation(
			(key: string) => (key === "tui.hyperlinks" ? "always" : undefined) as never,
		);
		const result = fileHyperlink("/Users/foo/bar.ts", "bar.ts");
		const uri = extractLinkUri(result);
		expect(uri).toMatch(/^file:\/\//);
		expect(uri).toContain("bar.ts");
		spy.mockRestore();
	});

	it("encodes spaces in the path", () => {
		const spy = spyOn(settingsModule.settings, "get").mockImplementation(
			(key: string) => (key === "tui.hyperlinks" ? "always" : undefined) as never,
		);
		const result = fileHyperlink("/Users/foo/my file.ts", "my file.ts");
		const uri = extractLinkUri(result);
		expect(uri).toContain("%20");
		expect(uri).not.toContain(" ");
		spy.mockRestore();
	});

	it("appends line and col as query params when provided", () => {
		const spy = spyOn(settingsModule.settings, "get").mockImplementation(
			(key: string) => (key === "tui.hyperlinks" ? "always" : undefined) as never,
		);
		const result = fileHyperlink("/Users/foo/bar.ts", "bar.ts", { line: 42, col: 7 });
		const uri = extractLinkUri(result);
		expect(uri).toContain("line=42");
		expect(uri).toContain("col=7");
		spy.mockRestore();
	});

	it("omits query params when line/col are not provided", () => {
		const spy = spyOn(settingsModule.settings, "get").mockImplementation(
			(key: string) => (key === "tui.hyperlinks" ? "always" : undefined) as never,
		);
		const result = fileHyperlink("/Users/foo/bar.ts", "bar.ts");
		const uri = extractLinkUri(result);
		expect(uri).not.toContain("?");
		spy.mockRestore();
	});

	it("produces a stable id for the same path", () => {
		const spy = spyOn(settingsModule.settings, "get").mockImplementation(
			(key: string) => (key === "tui.hyperlinks" ? "always" : undefined) as never,
		);
		const r1 = fileHyperlink("/Users/foo/bar.ts", "bar.ts");
		const r2 = fileHyperlink("/Users/foo/bar.ts", "different display text");
		// Extract id= from params (between "id=" and next ";")
		const id1 = r1.match(/id=([^;]+)/)?.[1];
		const id2 = r2.match(/id=([^;]+)/)?.[1];
		expect(id1).toBeDefined();
		expect(id1).toBe(id2);
		spy.mockRestore();
	});

	it("does not double-wrap text that already contains an OSC 8 sequence", () => {
		const spy = spyOn(settingsModule.settings, "get").mockImplementation(
			(key: string) => (key === "tui.hyperlinks" ? "always" : undefined) as never,
		);
		const alreadyWrapped = `${OSC}8;id=abc123;file:///foo/bar.ts${ST}bar.ts${LINK_END}`;
		const result = fileHyperlink("/Users/foo/other.ts", alreadyWrapped);
		// Should return the already-wrapped text unchanged
		expect(result).toBe(alreadyWrapped);
		spy.mockRestore();
	});

	it("preserves ANSI color codes inside the hyperlink", () => {
		const spy = spyOn(settingsModule.settings, "get").mockImplementation(
			(key: string) => (key === "tui.hyperlinks" ? "always" : undefined) as never,
		);
		const colored = "\x1b[32mbar.ts\x1b[0m";
		const result = fileHyperlink("/Users/foo/bar.ts", colored);
		expect(result).toContain(colored);
		expect(isHyperlinked(result)).toBe(true);
		spy.mockRestore();
	});
});

describe("tryResolveInternalUrlSync", () => {
	it("returns undefined for non-internal URLs", () => {
		expect(tryResolveInternalUrlSync("/abs/path/file.ts")).toBeUndefined();
		expect(tryResolveInternalUrlSync("relative/path.ts")).toBeUndefined();
		expect(tryResolveInternalUrlSync("https://example.com/foo")).toBeUndefined();
	});

	it("returns undefined for unsupported internal URL schemes", () => {
		// Async-resolved schemes are intentionally not handled here.
		expect(tryResolveInternalUrlSync("artifact://123")).toBeUndefined();
		expect(tryResolveInternalUrlSync("agent://abc")).toBeUndefined();
		expect(tryResolveInternalUrlSync("skill://foo")).toBeUndefined();
		expect(tryResolveInternalUrlSync("omp://docs.md")).toBeUndefined();
	});

	it("returns undefined when local:// resolution has no session options", () => {
		// No AgentRegistry main session in this unit test, no override installed.
		expect(tryResolveInternalUrlSync("local://foo.md")).toBeUndefined();
	});

	it("swallows errors from malformed URLs", () => {
		// Malformed input should not throw, just return undefined.
		expect(tryResolveInternalUrlSync("local://%ZZ")).toBeUndefined();
	});
});
