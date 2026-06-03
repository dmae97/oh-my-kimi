import { describe, expect, it } from "bun:test";
import { parseReadUrlTarget } from "@oh-my-pi/pi-coding-agent/tools/fetch";

describe("parseReadUrlTarget", () => {
	it("returns null for non-URL paths", () => {
		expect(parseReadUrlTarget("/etc/hosts")).toBeNull();
		expect(parseReadUrlTarget("relative/file.ts")).toBeNull();
	});

	it("returns a bare URL with no selectors", () => {
		expect(parseReadUrlTarget("https://example.com/foo")).toEqual({
			path: "https://example.com/foo",
			raw: false,
		});
	});

	it("peels :raw", () => {
		expect(parseReadUrlTarget("https://example.com/foo:raw")).toEqual({
			path: "https://example.com/foo",
			raw: true,
		});
	});

	it("peels a single line range as offset/limit", () => {
		expect(parseReadUrlTarget("https://example.com/foo:50-100")).toEqual({
			path: "https://example.com/foo",
			raw: false,
			offset: 50,
			limit: 51,
		});
		expect(parseReadUrlTarget("https://example.com/foo:50+10")).toEqual({
			path: "https://example.com/foo",
			raw: false,
			offset: 50,
			limit: 10,
		});
		expect(parseReadUrlTarget("https://example.com/foo:50")).toEqual({
			path: "https://example.com/foo",
			raw: false,
			offset: 50,
		});
	});

	it("peels multi-range selectors into ranges (regression: was stuck on URL → 404)", () => {
		// Direct repro of bug report 6234.
		const result = parseReadUrlTarget("https://raw.githubusercontent.com/oven-sh/bun/main/README.md:5-10,20-30");
		expect(result).toEqual({
			path: "https://raw.githubusercontent.com/oven-sh/bun/main/README.md",
			raw: false,
			ranges: [
				{ startLine: 5, endLine: 10 },
				{ startLine: 20, endLine: 30 },
			],
		});
	});

	it("peels raw + range combos in both orders (regression: was stuck on URL → 404)", () => {
		// Direct repro of bug report 6230.
		expect(parseReadUrlTarget("https://example.com/foo:raw:1-120")).toEqual({
			path: "https://example.com/foo",
			raw: true,
			offset: 1,
			limit: 120,
		});
		expect(parseReadUrlTarget("https://example.com/foo:1-120:raw")).toEqual({
			path: "https://example.com/foo",
			raw: true,
			offset: 1,
			limit: 120,
		});
	});

	it("rejects two range groups on the same URL", () => {
		expect(() => parseReadUrlTarget("https://example.com/foo:5-10:20-30")).toThrow(/range groups/);
	});

	it("leaves URL ports intact", () => {
		// `:8080` after the host has no trailing selector character — port stays put.
		expect(parseReadUrlTarget("https://example.com:8080/foo")).toEqual({
			path: "https://example.com:8080/foo",
			raw: false,
		});
		// Port + selector combo still works because the selector sits on a path segment.
		expect(parseReadUrlTarget("https://example.com:8080/foo:raw")).toEqual({
			path: "https://example.com:8080/foo",
			raw: true,
		});
	});

	it("treats trailing-colon selectors that don't parse as part of the URL", () => {
		// `:abc` is not a selector token; the parser leaves it on the URL.
		expect(parseReadUrlTarget("https://example.com/foo:abc")).toEqual({
			path: "https://example.com/foo:abc",
			raw: false,
		});
	});

	it("supports the documented `host:port/` escape for naked-host selectors", () => {
		// `https://example.com/:80` is the documented form to read line 80 of the homepage.
		expect(parseReadUrlTarget("https://example.com/:80")).toEqual({
			path: "https://example.com/",
			raw: false,
			offset: 80,
		});
	});

	it("repairs a collapsed scheme `https:/` → `https://` (regression: path.normalize → 404)", () => {
		// A URL run through Node's path.normalize/path.resolve loses one slash from the scheme.
		// Without the repair it falls through to filesystem resolution → "Path not found".
		expect(
			parseReadUrlTarget("https:/github.com/kovidgoyal/kitty/blob/8996aa798c774ca48432c55f7d5135ebbd9390c3/kitty/graphics.c"),
		).toEqual({
			path: "https://github.com/kovidgoyal/kitty/blob/8996aa798c774ca48432c55f7d5135ebbd9390c3/kitty/graphics.c",
			raw: false,
		});
		expect(parseReadUrlTarget("http:/example.com/foo")).toEqual({
			path: "http://example.com/foo",
			raw: false,
		});
	});

	it("repairs a collapsed scheme while still peeling selectors", () => {
		expect(parseReadUrlTarget("https:/example.com/foo:50-100")).toEqual({
			path: "https://example.com/foo",
			raw: false,
			offset: 50,
			limit: 51,
		});
		expect(parseReadUrlTarget("https:/example.com/foo:raw")).toEqual({
			path: "https://example.com/foo",
			raw: true,
		});
	});
});
