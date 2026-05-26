import { describe, expect, it } from "bun:test";
import { splitInternalUrlSel } from "@oh-my-pi/pi-coding-agent/tools/path-utils";

describe("splitInternalUrlSel", () => {
	it("returns the input unchanged when there is no selector tail", () => {
		expect(splitInternalUrlSel("artifact://3")).toEqual({ path: "artifact://3" });
		expect(splitInternalUrlSel("agent://reviewer_0")).toEqual({ path: "agent://reviewer_0" });
		expect(splitInternalUrlSel("memory://root")).toEqual({ path: "memory://root" });
	});

	it("peels a single line-range selector", () => {
		expect(splitInternalUrlSel("artifact://3:1-100")).toEqual({ path: "artifact://3", sel: "1-100" });
		expect(splitInternalUrlSel("artifact://3:50+150")).toEqual({ path: "artifact://3", sel: "50+150" });
		expect(splitInternalUrlSel("artifact://3:50-")).toEqual({ path: "artifact://3", sel: "50-" });
	});

	it("peels a `raw` selector", () => {
		expect(splitInternalUrlSel("artifact://3:raw")).toEqual({ path: "artifact://3", sel: "raw" });
	});

	it("peels compound `raw:range` selectors in either order", () => {
		expect(splitInternalUrlSel("artifact://3:raw:1-100")).toEqual({
			path: "artifact://3",
			sel: "raw:1-100",
		});
		expect(splitInternalUrlSel("artifact://3:1-100:raw")).toEqual({
			path: "artifact://3",
			sel: "1-100:raw",
		});
	});

	it("peels the malformed `:-N` selector that the strict splitter misses (the original bug)", () => {
		expect(splitInternalUrlSel("artifact://3:raw:-100")).toEqual({
			path: "artifact://3",
			sel: "raw:-100",
		});
		expect(splitInternalUrlSel("artifact://3:-100")).toEqual({ path: "artifact://3", sel: "-100" });
	});

	it("peels selectors from skill URLs with namespaced hosts", () => {
		expect(splitInternalUrlSel("skill://superpowers:brainstorming:1-5")).toEqual({
			path: "skill://superpowers:brainstorming",
			sel: "1-5",
		});
	});

	it("does not peel chunks that are not selector-shaped", () => {
		// `name` is part of the host, not a selector.
		expect(splitInternalUrlSel("skill://plugin:name")).toEqual({ path: "skill://plugin:name" });
	});

	it("stops at the scheme separator `://`", () => {
		expect(splitInternalUrlSel("agent://1-50")).toEqual({ path: "agent://1-50" });
	});

	it("keeps bare-integer suffixes on mcp:// URLs (could be a port)", () => {
		expect(splitInternalUrlSel("mcp://some/resource:1234")).toEqual({
			path: "mcp://some/resource:1234",
		});
	});

	it("treats mcp:// URIs as opaque by default — selector-shaped suffixes are NOT peeled", () => {
		// MCP resource URIs are server-defined and may legitimately end with `:raw`,
		// `:1-50`, etc. Without an explicit escape the URI must be forwarded verbatim
		// to the protocol handler so server-defined resources remain reachable.
		expect(splitInternalUrlSel("mcp://server/resource:1-50")).toEqual({
			path: "mcp://server/resource:1-50",
		});
		expect(splitInternalUrlSel("mcp://server/resource:raw")).toEqual({
			path: "mcp://server/resource:raw",
		});
		expect(splitInternalUrlSel("mcp://server/resource:L10")).toEqual({
			path: "mcp://server/resource:L10",
		});
		expect(splitInternalUrlSel("mcp://server/resource:conflicts")).toEqual({
			path: "mcp://server/resource:conflicts",
		});
	});

	it("keeps escaped selector-shaped mcp:// suffixes opaque too", () => {
		// MCP resource URIs are exact server-defined IDs. A resource may
		// legitimately end in `/:raw` or `/:1-50`; splitting before resolution
		// would make that resource unreachable with no exact-URI escape hatch.
		expect(splitInternalUrlSel("mcp://server/resource/:1-50")).toEqual({
			path: "mcp://server/resource/:1-50",
		});
		expect(splitInternalUrlSel("mcp://server/resource/:raw")).toEqual({
			path: "mcp://server/resource/:raw",
		});
		expect(splitInternalUrlSel("mcp://server/resource/:L10")).toEqual({
			path: "mcp://server/resource/:L10",
		});
		expect(splitInternalUrlSel("mcp://server/resource/:conflicts")).toEqual({
			path: "mcp://server/resource/:conflicts",
		});
	});

	it("does not peel when the only slash before the colon is part of the `://` separator", () => {
		// Guards against degenerate inputs like `mcp://:1-50` — stripping the
		// scheme's own slash would emit `mcp:/` as the path. The peeler refuses
		// when the resulting path no longer carries a scheme separator.
		expect(splitInternalUrlSel("mcp://:1-50")).toEqual({ path: "mcp://:1-50" });
		expect(splitInternalUrlSel("mcp://:raw")).toEqual({ path: "mcp://:raw" });
	});

	it("rejects bare-integer suffixes even with the trailing-slash escape", () => {
		// Could still be a port number after a path; require a richer selector form.
		expect(splitInternalUrlSel("mcp://server/resource/:1234")).toEqual({
			path: "mcp://server/resource/:1234",
		});
	});

	it("returns the input unchanged for non-URL strings", () => {
		expect(splitInternalUrlSel("/abs/path:1-50")).toEqual({ path: "/abs/path:1-50" });
		expect(splitInternalUrlSel("plain-text")).toEqual({ path: "plain-text" });
	});

	it("does not peel for unknown schemes", () => {
		expect(splitInternalUrlSel("http://example.com:1-50")).toEqual({
			path: "http://example.com:1-50",
		});
	});
});
