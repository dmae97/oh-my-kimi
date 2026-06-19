import { describe, expect, it } from "bun:test";
import { findCompactMode, parseCompactArgs } from "@oh-my-pi/pi-coding-agent/session/compact-modes";

describe("compact mode registry", () => {
	it("maps each mode to the settings overrides the engine relies on", () => {
		// These override values are load-bearing: the engine merges them over the
		// configured compaction.* settings, so a regression here silently changes
		// what `/compact <mode>` does.
		expect(findCompactMode("soft")?.overrides).toEqual({ strategy: "context-full", remoteEnabled: false });
		expect(findCompactMode("remote")?.overrides).toEqual({ strategy: "context-full", remoteEnabled: true });
		expect(findCompactMode("snapcompact")?.overrides).toEqual({ strategy: "snapcompact" });
	});

	it("flags remote as remote-requiring and snapcompact as focus-rejecting", () => {
		expect(findCompactMode("remote")?.requiresRemote).toBe(true);
		expect(findCompactMode("snapcompact")?.rejectsFocus).toBe(true);
		// soft is a plain local summary: neither flag.
		expect(findCompactMode("soft")?.requiresRemote).toBeUndefined();
		expect(findCompactMode("soft")?.rejectsFocus).toBeUndefined();
	});

	it("resolves mode names case-insensitively and rejects unknowns", () => {
		expect(findCompactMode("SOFT")?.name).toBe("soft");
		expect(findCompactMode("  Remote ")?.name).toBe("remote");
		expect(findCompactMode("bogus")).toBeUndefined();
		expect(findCompactMode("")).toBeUndefined();
	});
});

describe("parseCompactArgs", () => {
	it("returns no mode and no instructions for empty args", () => {
		expect(parseCompactArgs("")).toEqual({});
		expect(parseCompactArgs("   ")).toEqual({});
	});

	it("detects a leading mode token", () => {
		expect(parseCompactArgs("soft")).toEqual({ mode: "soft" });
		expect(parseCompactArgs("remote")).toEqual({ mode: "remote" });
		expect(parseCompactArgs("snapcompact")).toEqual({ mode: "snapcompact" });
	});

	it("splits a mode from its trailing focus instructions", () => {
		expect(parseCompactArgs("soft focus on the parser bug")).toEqual({
			mode: "soft",
			instructions: "focus on the parser bug",
		});
		expect(parseCompactArgs("remote   keep auth details")).toEqual({
			mode: "remote",
			instructions: "keep auth details",
		});
	});

	it("treats a non-mode first token as plain focus instructions (backward compatible)", () => {
		expect(parseCompactArgs("summarize the auth flow")).toEqual({ instructions: "summarize the auth flow" });
		// A bare word that is not a mode is still focus text, not an error.
		expect(parseCompactArgs("everything")).toEqual({ instructions: "everything" });
	});

	it("rejects focus instructions for modes that produce no summary", () => {
		const result = parseCompactArgs("snapcompact keep the diffs");
		expect(result).toHaveProperty("error");
		expect("error" in result && result.error).toContain("snapcompact");
		// Bare snapcompact is fine.
		expect(parseCompactArgs("snapcompact")).toEqual({ mode: "snapcompact" });
	});
});
