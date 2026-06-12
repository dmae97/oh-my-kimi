import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LocalProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
	fileHyperlink,
	isHyperlinkEnabled,
	tryResolveInternalUrlSync,
	uriHyperlink,
	urlHyperlink,
	urlHyperlinkAlways,
} from "@oh-my-pi/pi-coding-agent/tui/hyperlink";
import * as terminalCaps from "@oh-my-pi/pi-tui";

// OSC 8 sequence markers
const OSC = "\x1b]";
const ST = "\x1b\\";
const BEL = "\x07";
const LINK_END = `${OSC}8;;${ST}`;
const ORIGINAL_NO_COLOR = Bun.env.NO_COLOR;

/** Extract the hyperlink URI from a wrapped string. Returns undefined if not wrapped. */
function extractLinkUri(text: string): string | undefined {
	const match = text.match(/\x1b\]8;[^;]*;([^\x1b]+)\x1b\\/);
	return match?.[1];
}

function extractAnyTerminatorLinkUri(text: string): string | undefined {
	return text.match(/\x1b\]8;[^;]*;([^\x1b\x07]+)(?:\x1b\\|\x07)/)?.[1];
}

/** Returns true if the string contains an OSC 8 hyperlink wrapping a given display text. */
function isHyperlinked(text: string): boolean {
	return text.includes(`${OSC}8;`) && text.includes(LINK_END);
}

/** Set the `tui.hyperlinks` mode via a non-persistent runtime override. */
function setHyperlinkMode(mode: "off" | "auto" | "always"): void {
	settings.override("tui.hyperlinks", mode);
}

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterAll(() => {
	resetSettingsForTest();
});

afterEach(() => {
	settings.clearOverride("tui.hyperlinks");
	if (ORIGINAL_NO_COLOR === undefined) {
		delete Bun.env.NO_COLOR;
	} else {
		Bun.env.NO_COLOR = ORIGINAL_NO_COLOR;
	}
});

describe("isHyperlinkEnabled", () => {
	it('returns false when mode is "off"', () => {
		setHyperlinkMode("off");
		expect(isHyperlinkEnabled()).toBe(false);
	});

	it('returns true when mode is "always" regardless of TTY', () => {
		setHyperlinkMode("always");
		expect(isHyperlinkEnabled()).toBe(true);
	});

	it("returns false in auto mode when NO_COLOR is set", () => {
		setHyperlinkMode("auto");
		Bun.env.NO_COLOR = "1";
		expect(isHyperlinkEnabled()).toBe(false);
	});

	it("returns false in auto mode when stdout is not a TTY", () => {
		setHyperlinkMode("auto");
		const origTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		try {
			Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
			expect(isHyperlinkEnabled()).toBe(false);
		} finally {
			if (origTTY) {
				Object.defineProperty(process.stdout, "isTTY", origTTY);
			} else {
				Reflect.deleteProperty(process.stdout, "isTTY");
			}
		}
	});

	it("returns TERMINAL.hyperlinks value in auto mode when conditions are met", () => {
		setHyperlinkMode("auto");
		delete Bun.env.NO_COLOR;
		const origTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		try {
			Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
			// TERMINAL.hyperlinks may be true or false depending on the test runner env;
			// what matters is that isHyperlinkEnabled mirrors it.
			const expected = terminalCaps.TERMINAL.hyperlinks;
			expect(isHyperlinkEnabled()).toBe(expected);
		} finally {
			if (origTTY) {
				Object.defineProperty(process.stdout, "isTTY", origTTY);
			} else {
				Reflect.deleteProperty(process.stdout, "isTTY");
			}
		}
	});
});

describe("fileHyperlink", () => {
	it("returns plain text when hyperlinks are disabled (mode=off)", () => {
		setHyperlinkMode("off");
		const result = fileHyperlink("/Users/foo/bar.ts", "bar.ts");
		expect(result).toBe("bar.ts");
	});

	it("wraps text in OSC 8 when hyperlinks are enabled (mode=always)", () => {
		setHyperlinkMode("always");
		const result = fileHyperlink("/Users/foo/bar.ts", "bar.ts");
		expect(isHyperlinked(result)).toBe(true);
		expect(result).toContain("bar.ts");
	});

	it("builds a valid file:// URI with the absolute path", () => {
		setHyperlinkMode("always");
		const result = fileHyperlink("/Users/foo/bar.ts", "bar.ts");
		const uri = extractLinkUri(result);
		expect(uri).toMatch(/^file:\/\//);
		expect(uri).toContain("bar.ts");
	});

	it("encodes spaces in the path", () => {
		setHyperlinkMode("always");
		const result = fileHyperlink("/Users/foo/my file.ts", "my file.ts");
		const uri = extractLinkUri(result);
		expect(uri).toContain("%20");
		expect(uri).not.toContain(" ");
	});

	it("percent-encodes URL-reserved path bytes before appending query params", () => {
		setHyperlinkMode("always");
		const result = fileHyperlink("/Users/foo/a#b?c% d.ts", "a#b?c% d.ts", { line: 12 });
		const uri = extractLinkUri(result);
		expect(uri).toBe("file:///Users/foo/a%23b%3Fc%25%20d.ts?line=12");
	});

	it("resolves relative paths before building file URIs", () => {
		setHyperlinkMode("always");
		const result = fileHyperlink("relative file#1.ts", "relative file#1.ts");
		const uri = extractLinkUri(result);
		expect(uri).toBeDefined();
		expect(decodeURIComponent(new URL(uri!).pathname)).toEndWith("/relative file#1.ts");
	});

	it("appends line and col as query params when provided", () => {
		setHyperlinkMode("always");
		const result = fileHyperlink("/Users/foo/bar.ts", "bar.ts", { line: 42, col: 7 });
		const uri = extractLinkUri(result);
		expect(uri).toContain("line=42");
		expect(uri).toContain("col=7");
	});

	it("omits query params when line/col are not provided", () => {
		setHyperlinkMode("always");
		const result = fileHyperlink("/Users/foo/bar.ts", "bar.ts");
		const uri = extractLinkUri(result);
		expect(uri).not.toContain("?");
	});

	it("produces a stable id for the same path", () => {
		setHyperlinkMode("always");
		const r1 = fileHyperlink("/Users/foo/bar.ts", "bar.ts");
		const r2 = fileHyperlink("/Users/foo/bar.ts", "different display text");
		// Extract id= from params (between "id=" and next ";")
		const id1 = r1.match(/id=([^;]+)/)?.[1];
		const id2 = r2.match(/id=([^;]+)/)?.[1];
		expect(id1).toBeDefined();
		expect(id1).toBe(id2);
	});

	it("does not double-wrap text that already contains an OSC 8 sequence", () => {
		setHyperlinkMode("always");
		const alreadyWrapped = `${OSC}8;id=abc123;file:///foo/bar.ts${ST}bar.ts${LINK_END}`;
		const result = fileHyperlink("/Users/foo/other.ts", alreadyWrapped);
		// Should return the already-wrapped text unchanged
		expect(result).toBe(alreadyWrapped);
	});

	it("preserves ANSI color codes inside the hyperlink", () => {
		setHyperlinkMode("always");
		const colored = "\x1b[32mbar.ts\x1b[0m";
		const result = fileHyperlink("/Users/foo/bar.ts", colored);
		expect(result).toContain(colored);
		expect(isHyperlinked(result)).toBe(true);
	});
});

describe("uriHyperlink", () => {
	it("wraps arbitrary URI targets when hyperlinks are enabled", () => {
		setHyperlinkMode("always");
		const result = uriHyperlink("local://handoff.md", "handoff");
		expect(isHyperlinked(result)).toBe(true);
		expect(extractLinkUri(result)).toBe("local://handoff.md");
	});

	it("leaves text plain for URI targets containing control bytes", () => {
		setHyperlinkMode("always");
		expect(uriHyperlink("https://example.com/\x07bad", "bad")).toBe("bad");
	});
});

describe("urlHyperlink", () => {
	it("wraps HTTP URLs and normalizes www hosts", () => {
		setHyperlinkMode("always");
		const result = urlHyperlink("www.example.com/path", "example");
		expect(isHyperlinked(result)).toBe(true);
		expect(extractLinkUri(result)).toBe("https://www.example.com/path");
	});

	it("does not wrap non-HTTP URL schemes", () => {
		setHyperlinkMode("always");
		expect(urlHyperlink("ftp://example.com/file", "file")).toBe("file");
	});
});

describe("urlHyperlinkAlways", () => {
	it("wraps HTTP URLs in auto mode even when capability detection would suppress", () => {
		setHyperlinkMode("auto");
		Bun.env.NO_COLOR = "1"; // forces isHyperlinkEnabled() to false in auto mode
		const result = urlHyperlinkAlways("www.example.com/path", "example");

		expect(isHyperlinkEnabled()).toBe(false);
		expect(result).toContain(`${OSC}8;`);
		expect(result).toContain(`${OSC}8;;${BEL}`);
		expect(extractAnyTerminatorLinkUri(result)).toBe("https://www.example.com/path");
	});

	it("returns plain text when the user opts out with tui.hyperlinks=off", () => {
		setHyperlinkMode("off");
		expect(urlHyperlinkAlways("https://example.com/path", "example")).toBe("example");
	});

	it("does not wrap non-HTTP URL schemes", () => {
		setHyperlinkMode("always");
		expect(urlHyperlinkAlways("ftp://example.com/file", "file")).toBe("file");
	});
});

describe("tryResolveInternalUrlSync", () => {
	// The "no session options" contract below asserts on process-global state
	// (AgentRegistry main session, LocalProtocolHandler override) that sibling
	// test files in the same worker may have populated. Pin the premise
	// explicitly so the test is full-suite safe, not just file-local safe.
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		LocalProtocolHandler.resetOverrideForTests();
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		LocalProtocolHandler.resetOverrideForTests();
	});

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
