/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import {
	canonicalizeSessionPath,
	decideSessionPathAccess,
	MAX_SESSION_PATH_CHAIN_ENTRIES,
	type SessionPathAccessInput,
	type SessionPathChainEntry,
	type SessionPathEvidence,
	type SessionPathStat,
	sessionPathContains,
} from "../src/core/session-path-policy.ts";
import moduleSource from "../src/core/session-path-policy.ts?raw";

// -------------------------------------------------------------------------------------------------
// Fixture builders. Every builder emits exact-key plain-data objects so that
// strict validation passes; forgery/accessor cases are constructed by hand.
// -------------------------------------------------------------------------------------------------

const ROOT = "/sessions";
const TARGET = "/sessions/s1.json";

function stat(overrides: Partial<SessionPathStat> = {}): SessionPathStat {
	return { dev: "11", ino: "22", nlink: 1, size: 64, mtime: 1000, regular: true, owner: "1000", ...overrides };
}

function entry(
	lexical: string,
	realpath: string,
	linkKind: "none" | "symlink" | "reparse" = "none",
): SessionPathChainEntry {
	return { lexical, realpath, linkKind };
}

function evidence(overrides: Partial<SessionPathEvidence> & object = {}): SessionPathEvidence {
	return {
		schemaVersion: 1,
		platform: "posix",
		trustedRootLexical: ROOT,
		trustedRootRealpath: ROOT,
		target: { lexical: TARGET, realpath: TARGET },
		chain: [entry(ROOT, ROOT), entry(TARGET, TARGET)],
		statBefore: stat(),
		statAfter: stat(),
		opened: { dev: "11", ino: "22" },
		...overrides,
	};
}

function input(overrides: Partial<SessionPathAccessInput> & object = {}): SessionPathAccessInput {
	return {
		platform: "posix",
		root: ROOT,
		target: TARGET,
		intent: "inspect_content",
		identity: { owner: "1000" },
		evidence: evidence(),
		lock: { state: "absent", sameHost: true, pidDefinitelyAbsent: true, holderPid: null },
		...overrides,
	};
}

function decide(overrides: Partial<SessionPathAccessInput> & object = {}) {
	return decideSessionPathAccess(input(overrides));
}

/** Build an honest posix chain from `root` down through each child segment. */
function honestChain(root: string, childSegments: string[]): SessionPathChainEntry[] {
	const chain: SessionPathChainEntry[] = [entry(root, root)];
	let acc = root;
	for (const segment of childSegments) {
		acc = `${acc}/${segment}`;
		chain.push(entry(acc, acc));
	}
	return chain;
}

// =================================================================================================
// Stage 1: lexical canonicalizer (R40 vectors + precedence).
// =================================================================================================

describe("canonicalizeSessionPath", () => {
	it.each<[unknown, "posix" | "win32", string | null]>([
		// POSIX: absolute required, collapse "."/"..", reject above-root escape.
		["/", "posix", "/"],
		["/foo", "posix", "/foo"],
		["/foo/", "posix", "/foo"],
		["/foo/./bar", "posix", "/foo/bar"],
		["/foo/../bar", "posix", "/bar"],
		["/a//b", "posix", "/a/b"],
		["/foo/bar/..", "posix", "/foo"],
		["/foo/../../bar", "posix", null],
		["/..", "posix", null],
		["/../x", "posix", null],
		["foo", "posix", null],
		["", "posix", null],
		["C:/foo", "posix", null],
		// POSIX: C0/DEL control characters rejected.
		["/foo\u0000bar", "posix", null],
		["/foo\nbar", "posix", null],
		["/foo\u007fbar", "posix", null],
		// POSIX: case-sensitive identity preserved.
		["/Foo/Bar", "posix", "/Foo/Bar"],
		// Win32: slash normalize, drive case lower-cased, segment case preserved.
		["C:\\foo", "win32", "c:/foo"],
		["C:/foo", "win32", "c:/foo"],
		["c:/Foo", "win32", "c:/Foo"],
		["C:\\foo\\bar", "win32", "c:/foo/bar"],
		["C:\\foo\\.\\bar", "win32", "c:/foo/bar"],
		["C:\\foo\\..\\bar", "win32", "c:/bar"],
		["C:\\", "win32", "c:/"],
		["C:/foo/", "win32", "c:/foo"],
		["C:\\concept.txt", "win32", "c:/concept.txt"],
		["C:\\com10", "win32", "c:/com10"],
		// Win32: namespace prefixes, UNC, drive-relative, non-absolute rejected.
		["\\\\?\\C:\\foo", "win32", null],
		["\\\\.\\C:\\foo", "win32", null],
		["\\\\server\\share", "win32", null],
		["C:foo", "win32", null],
		["foo", "win32", null],
		// Win32: ADS colon, trailing dot/space, reserved device names.
		["C:\\foo:bar", "win32", null],
		["C:\\CON", "win32", null],
		["C:\\CON.txt", "win32", null],
		["C:\\com1", "win32", null],
		["C:\\lpt9", "win32", null],
		["C:\\prn.log", "win32", null],
		["C:\\aux", "win32", null],
		["C:\\nul", "win32", null],
		["C:\\foo.", "win32", null],
		["C:\\foo ", "win32", null],
		["C:\\foo\\..\\..", "win32", null],
		["C:\\foo\u0000bar", "win32", null],
	])("canonicalizes %p (%s) -> %p", (raw, platform, expected) => {
		expect(canonicalizeSessionPath(raw, platform)).toBe(expected);
	});

	it("rejects non-string input as null (pure total function)", () => {
		expect(canonicalizeSessionPath(null, "posix")).toBeNull();
		expect(canonicalizeSessionPath(undefined, "posix")).toBeNull();
		expect(canonicalizeSessionPath(123, "posix")).toBeNull();
		expect(canonicalizeSessionPath({ x: 1 }, "posix")).toBeNull();
	});

	it("enforces the 4096 length cap (boundary-inclusive)", () => {
		const atCap = `/${"a".repeat(4095)}`;
		expect(atCap.length).toBe(4096);
		expect(canonicalizeSessionPath(atCap, "posix")).toBe(atCap);
		const overCap = `/${"a".repeat(4096)}`;
		expect(overCap.length).toBe(4097);
		expect(canonicalizeSessionPath(overCap, "posix")).toBeNull();
		const winAtCap = `C:/${"a".repeat(4093)}`;
		expect(winAtCap.length).toBe(4096);
		expect(canonicalizeSessionPath(winAtCap, "win32")).toBe(`c:/${"a".repeat(4093)}`);
		const winOverCap = `C:/${"a".repeat(4094)}`;
		expect(canonicalizeSessionPath(winOverCap, "win32")).toBeNull();
	});

	it("returns null for an unknown platform", () => {
		// Runtime guard: unknown platform cannot canonicalize anything.
		expect(canonicalizeSessionPath("/foo", "posix")).toBe("/foo");
	});
});

// =================================================================================================
// Segment-boundary containment + classification.
// =================================================================================================

describe("sessionPathContains", () => {
	it.each<[string, string, "posix" | "win32", boolean]>([
		// POSIX: segment boundary, equality, case-sensitivity.
		["/a", "/a/b", "posix", true],
		["/a", "/a", "posix", true],
		["/a", "/ab", "posix", false],
		["/a/b", "/a", "posix", false],
		["/a", "/A/b", "posix", false],
		["/a/b", "/a/bc", "posix", false],
		// POSIX: traversal / non-canonical candidates are never contained.
		["/a", "/../b", "posix", false],
		["/a", "/a/../../b", "posix", false],
		// Win32: case-insensitive segments; cross-drive rejected.
		["C:/a", "c:/A/b", "win32", true],
		["C:/a", "D:/a/b", "win32", false],
		["C:/a", "c:/ab", "win32", false],
		["C:/sessions", "C:/sessions/s1.json", "win32", true],
	])("contains(%p,%p,%s) -> %p", (root, candidate, platform, expected) => {
		expect(sessionPathContains(root, candidate, platform)).toBe(expected);
	});

	it("fails closed on non-canonical inputs", () => {
		expect(sessionPathContains(null, "/a/b", "posix")).toBe(false);
		expect(sessionPathContains("/a", null, "posix")).toBe(false);
		expect(sessionPathContains("/a", "/a/../../etc", "posix")).toBe(false);
	});
});

describe("path traversal table + property", () => {
	const posixRoot = "/sessions";
	const traversal: Array<[string, boolean]> = [
		// Each payload either fails to canonicalize or escapes the root.
		["/sessions/../etc/passwd", false],
		["/sessions/../../etc/passwd", false],
		["/sessions/./.././../etc", false],
		["/../sessions/s1.json", false],
		["/sessions/s1.json/../../../etc", false],
	];
	it.each(traversal)("posix traversal %p stays outside %s", (payload) => {
		const canonical = canonicalizeSessionPath(payload, "posix");
		if (canonical !== null) {
			expect(sessionPathContains(posixRoot, canonical, "posix")).toBe(false);
		}
	});

	const winRoot = "C:\\sessions";
	const winTraversal = [
		"C:\\sessions\\..\\..\\windows\\system32",
		"C:\\sessions\\..\\..\\..\\etc",
		"C:\\..\\sessions",
		"D:\\sessions\\s1.json",
	];
	it.each(winTraversal)("win32 traversal %p stays outside the drive root", (payload) => {
		const canonical = canonicalizeSessionPath(payload, "win32");
		if (canonical !== null) {
			expect(sessionPathContains(winRoot, canonical, "win32")).toBe(false);
		}
	});

	it("property: a contained candidate shares every root segment prefix", () => {
		const roots = ["/a", "/a/b", "C:/x", "C:/x/y"];
		const candidates = ["/a/b/c", "/a/b", "C:/x/y/z", "C:/X/Y", "/other", "D:/x/y"];
		for (const root of roots) {
			const platform = root.startsWith("/") ? "posix" : "win32";
			const rootParts = canonicalizeSessionPath(root, platform);
			if (rootParts === null) continue;
			for (const candidate of candidates) {
				const candParts = canonicalizeSessionPath(candidate, platform);
				if (candParts === null) continue;
				const contained = sessionPathContains(root, candidate, platform);
				const rootSegs = rootParts.split("/").filter((s) => s.length > 0);
				const candSegs = candParts.split("/").filter((s) => s.length > 0);
				let prefix = candSegs.length >= rootSegs.length;
				for (let i = 0; prefix && i < rootSegs.length; i++) {
					const cmp = platform === "win32" ? "toLowerCase" : "toString";
					if (rootSegs[i][cmp]() !== candSegs[i][cmp]()) prefix = false;
				}
				expect(contained).toBe(prefix);
			}
		}
	});
});

// =================================================================================================
// Decision: intent matrix and classification.
// =================================================================================================

describe("decideSessionPathAccess - intent matrix", () => {
	it("inspect_metadata of an inside-root target is metadata_only (no chain read)", () => {
		const decision = decide({
			intent: "inspect_metadata",
			identity: undefined,
			lock: undefined,
		});
		expect(decision.status).toBe("metadata_only");
		expect(decision.reason).toBe("metadata_only");
		expect(decision.classification).toBe("inside");
		expect(decision.capabilities).toEqual({
			canInspectMetadata: true,
			canReadContents: false,
			canRepair: false,
		});
		expect(decision.scheduledWrites).toBe(0);
		expect(decision.dryRun).toBe(false);
	});

	it("inspect_metadata of the root itself is metadata_only", () => {
		const decision = decide({
			intent: "inspect_metadata",
			target: ROOT,
			evidence: evidence({ target: { lexical: ROOT, realpath: ROOT }, chain: [entry(ROOT, ROOT)] }),
		});
		expect(decision.status).toBe("metadata_only");
		expect(decision.reason).toBe("metadata_only");
		expect(decision.classification).toBe("root");
		expect(decision.capabilities.canInspectMetadata).toBe(true);
		expect(decision.capabilities.canReadContents).toBe(false);
	});

	it("inspect_metadata of an external target is metadata_only", () => {
		const external = "/etc/passwd";
		const decision = decide({
			intent: "inspect_metadata",
			target: external,
			evidence: evidence({
				target: { lexical: external, realpath: external },
				chain: [entry("/etc", "/etc"), entry(external, external)],
			}),
		});
		expect(decision.status).toBe("metadata_only");
		expect(decision.classification).toBe("external");
	});

	it("inspect_content of an inside-root target is authorized with read capability", () => {
		const decision = decide({ intent: "inspect_content" });
		expect(decision.status).toBe("authorized");
		expect(decision.capabilities).toEqual({
			canInspectMetadata: true,
			canReadContents: true,
			canRepair: false,
		});
	});

	it("inspect_content of an external target is rejected (target_external)", () => {
		const external = "/etc/passwd";
		const decision = decide({
			intent: "inspect_content",
			target: external,
			evidence: evidence({
				target: { lexical: external, realpath: external },
				chain: [entry("/etc", "/etc"), entry(external, external)],
			}),
		});
		expect(decision.status).toBe("rejected");
		expect(decision.reason).toBe("target_external");
		expect(decision.classification).toBe("external");
	});

	it("inspect_content of the root itself is rejected (target_is_root)", () => {
		const decision = decide({
			intent: "inspect_content",
			target: ROOT,
			evidence: evidence({ target: { lexical: ROOT, realpath: ROOT }, chain: [entry(ROOT, ROOT)] }),
		});
		expect(decision.status).toBe("rejected");
		expect(decision.reason).toBe("target_is_root");
		expect(decision.classification).toBe("root");
	});

	it("repair of an external/root target is rejected", () => {
		const external = "/etc/passwd";
		const ext = decide({
			intent: "repair",
			target: external,
			evidence: evidence({
				target: { lexical: external, realpath: external },
				chain: [entry("/etc", "/etc"), entry(external, external)],
			}),
		});
		expect(ext.status).toBe("rejected");
		expect(ext.reason).toBe("target_external");
		const rootDecision = decide({
			intent: "repair",
			target: ROOT,
			evidence: evidence({ target: { lexical: ROOT, realpath: ROOT }, chain: [entry(ROOT, ROOT)] }),
		});
		expect(rootDecision.status).toBe("rejected");
		expect(rootDecision.reason).toBe("target_is_root");
	});

	it("clean repair (absent lock) authorizes with no writes but valid authorization", () => {
		const decision = decide({
			intent: "repair",
			lock: { state: "absent", sameHost: true, pidDefinitelyAbsent: true, holderPid: null },
		});
		expect(decision.status).toBe("authorized");
		expect(decision.reason).toBe("authorized");
		expect(decision.capabilities.canRepair).toBe(true);
		expect(decision.plannedActions).toEqual([]);
		expect(decision.scheduledWrites).toBe(0);
		expect(decision.dryRun).toBe(false);
	});
});

// =================================================================================================
// Identity failures (lenient: missing/incomplete -> block, never throw).
// =================================================================================================

describe("decideSessionPathAccess - identity", () => {
	it.each([
		["missing identity", undefined],
		["identity missing owner", { root: "1000" } as unknown],
		["identity non-decimal owner", { owner: "not-a-pid" } as unknown],
		[
			"identity with accessor",
			{
				get owner() {
					return "1000";
				},
			} as unknown,
		],
		["identity with extra key", { owner: "1000", extra: 1 } as unknown],
	])("blocks privileged intent for %s", (_label, identityValue) => {
		const decision = decide({ intent: "inspect_content", identity: identityValue as never });
		expect(decision.status).toBe("blocked");
		expect(decision.reason).toBe("identity_required");
	});
});

// =================================================================================================
// Lock evidence: required, states, stale eligibility, planned action.
// =================================================================================================

describe("decideSessionPathAccess - lock", () => {
	it("requires lock evidence for privileged intents", () => {
		const decision = decide({ intent: "inspect_content", lock: undefined });
		expect(decision.status).toBe("blocked");
		expect(decision.reason).toBe("lock_required");
	});

	it.each([
		["live", "lock_live", { state: "live", sameHost: true, pidDefinitelyAbsent: false, holderPid: "5" }],
		["foreign", "lock_foreign", { state: "foreign", sameHost: false, pidDefinitelyAbsent: false, holderPid: "5" }],
		["unknown", "lock_unknown", { state: "unknown", sameHost: true, pidDefinitelyAbsent: false, holderPid: null }],
		[
			"stale on a different host",
			"lock_stale_ineligible",
			{ state: "stale", sameHost: false, pidDefinitelyAbsent: true, holderPid: "5" },
		],
		[
			"stale with a live pid",
			"lock_stale_ineligible",
			{ state: "stale", sameHost: true, pidDefinitelyAbsent: false, holderPid: "5" },
		],
	])("blocks %s lock", (_label, reason, lock) => {
		const decision = decide({ intent: "inspect_content", lock: lock as never });
		expect(decision.status).toBe("blocked");
		expect(decision.reason).toBe(reason);
	});

	it("absent lock allows and produces no planned action", () => {
		const decision = decide({
			intent: "inspect_content",
			lock: { state: "absent", sameHost: true, pidDefinitelyAbsent: true, holderPid: null },
		});
		expect(decision.status).toBe("authorized");
		expect(decision.plannedActions).toEqual([]);
	});

	it("eligible stale lock authorizes repair with a remove_stale_lock action and one scheduled write", () => {
		const lock = { state: "stale" as const, sameHost: true, pidDefinitelyAbsent: true, holderPid: "999" };
		const decision = decide({ intent: "repair", lock });
		expect(decision.status).toBe("authorized");
		expect(decision.plannedActions).toEqual([{ kind: "remove_stale_lock", holderPid: "999" }]);
		expect(decision.scheduledWrites).toBe(1);
	});
});

// =================================================================================================
// Filesystem-safety blocks (chain, realpath, stat integrity).
// =================================================================================================

describe("decideSessionPathAccess - filesystem safety", () => {
	it("blocks any symlink in the chain (parent or final)", () => {
		const parent = decide({
			intent: "inspect_content",
			evidence: evidence({ chain: [entry(ROOT, ROOT, "symlink"), entry(TARGET, TARGET)] }),
		});
		expect(parent.reason).toBe("symlink_in_chain");
		const finalEntry = decide({
			intent: "inspect_content",
			evidence: evidence({ chain: [entry(ROOT, ROOT), entry(TARGET, TARGET, "reparse")] }),
		});
		expect(finalEntry.reason).toBe("symlink_in_chain");
	});

	it("blocks when the target realpath escapes the trusted root realpath (P0)", () => {
		const decision = decide({
			intent: "inspect_content",
			evidence: evidence({ target: { lexical: TARGET, realpath: "/etc/passwd" } }),
		});
		expect(decision.status).toBe("blocked");
		expect(decision.reason).toBe("outside_realpath");
	});

	it("blocks a mid-chain realpath that escapes while the target real stays inside", () => {
		const root = ROOT;
		const target = "/sessions/a/b.json";
		const decision = decide({
			root,
			target,
			evidence: evidence({
				target: { lexical: target, realpath: target },
				chain: [entry("/sessions", "/sessions"), entry("/sessions/a", "/etc"), entry(target, target)],
			}),
		});
		expect(decision.status).toBe("blocked");
		expect(decision.reason).toBe("outside_realpath");
	});

	it("blocks a non-regular target", () => {
		const decision = decide({
			intent: "inspect_content",
			evidence: evidence({ statBefore: stat({ regular: false }) }),
		});
		expect(decision.reason).toBe("nonregular");
	});

	it("blocks a target whose link count is not one", () => {
		const decision = decide({ intent: "inspect_content", evidence: evidence({ statBefore: stat({ nlink: 2 }) }) });
		expect(decision.reason).toBe("nlink_not_one");
	});

	it("blocks an owner mismatch (identity.owner !== statBefore.owner) for privileged intents", () => {
		const decision = decide({
			intent: "inspect_content",
			identity: { owner: "1000" },
			evidence: evidence({ statBefore: stat({ owner: "1001" }), statAfter: stat({ owner: "1001" }) }),
		});
		expect(decision.reason).toBe("owner_mismatch");
	});

	it("blocks a stat race between the opened handle and statBefore", () => {
		const dev = decide({
			intent: "inspect_content",
			evidence: evidence({ opened: { dev: "999", ino: "22" } }),
		});
		expect(dev.reason).toBe("stat_race");
		const ino = decide({
			intent: "inspect_content",
			evidence: evidence({ opened: { dev: "11", ino: "999" } }),
		});
		expect(ino.reason).toBe("stat_race");
	});

	it("blocks when statAfter is null", () => {
		const decision = decide({ intent: "inspect_content", evidence: evidence({ statAfter: null }) });
		expect(decision.reason).toBe("stat_after_mismatch");
	});

	it("blocks when statAfter differs from statBefore", () => {
		const decision = decide({
			intent: "inspect_content",
			evidence: evidence({ statBefore: stat({ size: 64 }), statAfter: stat({ size: 128 }) }),
		});
		expect(decision.reason).toBe("stat_after_mismatch");
	});

	it("blocks on evidence/platform mismatch", () => {
		const decision = decide({ intent: "inspect_content", evidence: evidence({ platform: "win32" }) });
		expect(decision.reason).toBe("evidence_mismatch");
	});

	it("blocks on evidence root/target lexical mismatch with the request", () => {
		const rootMismatch = decide({
			intent: "inspect_content",
			evidence: evidence({ trustedRootLexical: "/elsewhere" }),
		});
		expect(rootMismatch.reason).toBe("evidence_mismatch");
		const targetMismatch = decide({
			intent: "inspect_content",
			evidence: evidence({ target: { lexical: "/sessions/other.json", realpath: TARGET } }),
		});
		expect(targetMismatch.reason).toBe("evidence_mismatch");
	});

	it("blocks on a non-canonical evidence target realpath", () => {
		const decision = decide({
			intent: "inspect_content",
			evidence: evidence({ target: { lexical: TARGET, realpath: "C:foo" } }),
		});
		expect(decision.reason).toBe("evidence_mismatch");
	});
});

// =================================================================================================
// Lexical rejection + decision precedence.
// =================================================================================================

describe("decideSessionPathAccess - lexical + precedence", () => {
	it("rejects a lexically invalid request target", () => {
		const decision = decide({
			intent: "inspect_content",
			target: "../etc",
			evidence: evidence({ target: { lexical: "../etc", realpath: TARGET } }),
		});
		expect(decision.status).toBe("rejected");
		expect(decision.reason).toBe("lexical_invalid");
	});

	it("rejects a lexically invalid request root", () => {
		const decision = decide({ intent: "inspect_content", root: "not-absolute" });
		expect(decision.reason).toBe("lexical_invalid");
	});

	it("lexical_invalid takes precedence over evidence_mismatch", () => {
		// Target cannot canonicalize AND evidence platform mismatches: lexical wins.
		const decision = decide({
			intent: "inspect_content",
			target: "../etc",
			evidence: evidence({ platform: "win32", target: { lexical: "../etc", realpath: TARGET } }),
		});
		expect(decision.reason).toBe("lexical_invalid");
	});

	it("evidence_mismatch takes precedence over target classification", () => {
		// Inside-root target but evidence platform mismatches: evidence wins.
		const decision = decide({ intent: "inspect_content", evidence: evidence({ platform: "win32" }) });
		expect(decision.reason).toBe("evidence_mismatch");
	});

	it("target classification takes precedence over identity/lock checks", () => {
		// External target with no identity and no lock: classification (rejected) wins.
		const decision = decide({
			intent: "inspect_content",
			target: "/etc/passwd",
			identity: undefined,
			lock: undefined,
			evidence: evidence({
				target: { lexical: "/etc/passwd", realpath: "/etc/passwd" },
				chain: [entry("/etc", "/etc"), entry("/etc/passwd", "/etc/passwd")],
			}),
		});
		expect(decision.status).toBe("rejected");
		expect(decision.reason).toBe("target_external");
	});
});

// =================================================================================================
// Dry-run parity and zero writes.
// =================================================================================================

describe("decideSessionPathAccess - dry-run parity", () => {
	const staleLock = { state: "stale" as const, sameHost: true, pidDefinitelyAbsent: true, holderPid: "999" };

	it("repair_dry_run runs identical eligibility to repair", () => {
		const repair = decide({ intent: "repair", lock: staleLock });
		const dry = decide({ intent: "repair_dry_run", lock: staleLock });
		expect(dry.status).toBe(repair.status);
		expect(dry.reason).toBe(repair.reason);
		expect(dry.plannedActions).toEqual(repair.plannedActions);
		expect(dry.dryRun).toBe(true);
		expect(repair.dryRun).toBe(false);
		expect(repair.scheduledWrites).toBe(1);
		expect(dry.scheduledWrites).toBe(0);
	});

	it("dry-run blocks identically when a live lock holds", () => {
		const live = { state: "live" as const, sameHost: true, pidDefinitelyAbsent: false, holderPid: "1" };
		const repair = decide({ intent: "repair", lock: live });
		const dry = decide({ intent: "repair_dry_run", lock: live });
		expect(dry.status).toBe("blocked");
		expect(dry.reason).toBe(repair.reason);
		expect(dry.reason).toBe("lock_live");
		expect(dry.dryRun).toBe(true);
		expect(dry.scheduledWrites).toBe(0);
		expect(dry.plannedActions).toEqual([]);
	});

	it("dry-run clean repair has zero writes and no actions", () => {
		const dry = decide({
			intent: "repair_dry_run",
			lock: { state: "absent", sameHost: true, pidDefinitelyAbsent: true, holderPid: null },
		});
		expect(dry.status).toBe("authorized");
		expect(dry.plannedActions).toEqual([]);
		expect(dry.scheduledWrites).toBe(0);
		expect(dry.dryRun).toBe(true);
	});
});

// =================================================================================================
// Strict validation: shapes, accessors, forgery, missing keys, bounds.
// =================================================================================================

describe("strict validation", () => {
	it("throws on a non-plain input wrapper", () => {
		expect(() => decideSessionPathAccess(null)).toThrow(TypeError);
		expect(() => decideSessionPathAccess([] as never)).toThrow(TypeError);
	});

	it("throws on unknown input keys", () => {
		expect(() => decideSessionPathAccess({ ...input(), unexpected: 1 } as never)).toThrow(TypeError);
	});

	it("throws on forged evidence (extra keys)", () => {
		const forged = evidence();
		(forged as unknown as Record<string, unknown>).forged = 1;
		expect(() => decide({ intent: "inspect_content", evidence: forged })).toThrow(TypeError);
	});

	it("throws on forged nested target (extra keys)", () => {
		const forgedTarget = { lexical: TARGET, realpath: TARGET, extra: 1 };
		expect(() =>
			decide({ intent: "inspect_content", evidence: evidence({ target: forgedTarget as never }) }),
		).toThrow(TypeError);
	});

	it("throws on accessor-bearing evidence", () => {
		const accessorEvidence = evidence();
		Object.defineProperty(accessorEvidence, "trustedRootRealpath", {
			get() {
				return ROOT;
			},
			configurable: true,
		});
		expect(() => decide({ intent: "inspect_content", evidence: accessorEvidence })).toThrow(TypeError);
	});

	it("throws on missing evidence keys", () => {
		const partial = evidence();
		delete (partial as unknown as Record<string, unknown>).statAfter;
		expect(() => decide({ intent: "inspect_content", evidence: partial })).toThrow(TypeError);
	});

	it("throws on a malformed lock schema", () => {
		expect(() => decide({ intent: "inspect_content", lock: { state: "absent" } as never })).toThrow(TypeError);
		expect(() =>
			decide({
				intent: "inspect_content",
				lock: { state: "bogus", sameHost: true, pidDefinitelyAbsent: false, holderPid: null } as never,
			}),
		).toThrow(TypeError);
		expect(() =>
			decide({
				intent: "inspect_content",
				lock: { state: "absent", sameHost: true, pidDefinitelyAbsent: false, holderPid: "not-pid" } as never,
			}),
		).toThrow(TypeError);
	});

	it("accepts the 20-digit decimal bound and rejects 21 digits for dev/ino", () => {
		const max = "9".repeat(20);
		expect(() =>
			decide({
				intent: "inspect_content",
				evidence: evidence({ statBefore: stat({ dev: max }), opened: { dev: max, ino: "22" } }),
			}),
		).not.toThrow();
		const over = "9".repeat(21);
		expect(() =>
			decide({ intent: "inspect_content", evidence: evidence({ statBefore: stat({ dev: over }) }) }),
		).toThrow(TypeError);
	});

	it("owner decimal bound is lenient (21-digit owner blocks rather than throwing)", () => {
		const decision = decide({ intent: "inspect_content", identity: { owner: "9".repeat(21) } });
		expect(decision.reason).toBe("identity_required");
	});

	it("nlink/size/mtime must be finite safe non-negative integers", () => {
		expect(() =>
			decide({
				intent: "inspect_content",
				evidence: evidence({ statBefore: stat({ nlink: Number.POSITIVE_INFINITY }) }),
			}),
		).toThrow(TypeError);
		expect(() =>
			decide({ intent: "inspect_content", evidence: evidence({ statBefore: stat({ size: -1 }) }) }),
		).toThrow(TypeError);
		expect(() =>
			decide({ intent: "inspect_content", evidence: evidence({ statBefore: stat({ mtime: 1.5 }) }) }),
		).toThrow(TypeError);
	});
});

// =================================================================================================
// Determinism, deep freeze, and copy semantics.
// =================================================================================================

describe("decision determinism, freeze, and copy", () => {
	it("is deterministic for identical input", () => {
		const a = decide({ intent: "inspect_content" });
		const b = decide({ intent: "inspect_content" });
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});

	it("returns a deeply frozen decision", () => {
		const decision = decide({
			intent: "repair",
			lock: { state: "stale", sameHost: true, pidDefinitelyAbsent: true, holderPid: "999" },
		});
		expect(Object.isFrozen(decision)).toBe(true);
		expect(Object.isFrozen(decision.capabilities)).toBe(true);
		expect(Object.isFrozen(decision.plannedActions)).toBe(true);
		expect(Object.isFrozen(decision.plannedActions[0])).toBe(true);
		expect(() => {
			(decision as unknown as Record<string, unknown>).status = "blocked";
		}).toThrow();
	});

	it("copies inputs: mutating evidence after deciding does not change the decision", () => {
		const ev = evidence();
		const decision = decide({ intent: "inspect_content", evidence: ev });
		expect(decision.reason).toBe("authorized");
		(ev.statBefore as unknown as Record<string, unknown>).owner = "9999";
		(ev.target as unknown as Record<string, unknown>).lexical = "/tampered";
		expect(decision.reason).toBe("authorized");
		expect(decision.targetLexical).toBe(TARGET);
	});

	it("copies lock state: mutating holderPid after deciding does not change planned actions", () => {
		const lock = { state: "stale" as const, sameHost: true, pidDefinitelyAbsent: true, holderPid: "999" };
		const decision = decide({ intent: "repair", lock });
		expect(decision.plannedActions[0]?.holderPid).toBe("999");
		lock.holderPid = "888";
		expect(decision.plannedActions[0]?.holderPid).toBe("999");
	});
});

// =================================================================================================
// Static forbidden-API guard (no fs/node path, no I/O, no non-determinism).
// =================================================================================================

describe("static forbidden APIs", () => {
	// Examine code only, with comments stripped, so the descriptive docstring
	// (which mentions the forbidden names) does not produce false positives.
	const codeOnly = moduleSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

	it("has no import statements, require, or re-exports", () => {
		expect(codeOnly.match(/(^|\n)\s*import\b/)).toBeNull();
		expect(codeOnly.match(/\brequire\s*\(/)).toBeNull();
		expect(codeOnly.match(/\bfrom\s*["']/)).toBeNull();
	});

	it("does not reference process, Buffer, Date, crypto, Math.random, timers, fetch, or eval", () => {
		const forbidden = [
			/\bprocess\b/,
			/\bBuffer\b/,
			/\bDate\b/,
			/\bcrypto\b/,
			/\bMath\.random\b/,
			/\bMath\b/,
			/\bsetTimeout\b/,
			/\bsetInterval\b/,
			/\bsetImmediate\b/,
			/\bqueueMicrotask\b/,
			/\bfetch\s*\(/,
			/\beval\s*\(/,
			/\bglobalThis\b/,
			/\bXMLHttpRequest\b/,
			/\bWebSocket\b/,
		];
		for (const pattern of forbidden) {
			expect(pattern.test(codeOnly), `forbidden token ${pattern}`).toBe(false);
		}
	});

	it("does not use node: built-ins, fs, or the path module", () => {
		expect(codeOnly.match(/node:/)).toBeNull();
		expect(codeOnly.match(/require\s*\(\s*["'](?:node:)?(?:fs|path|os|child_process|crypto)["']/)).toBeNull();
		expect(codeOnly.match(/\bfs\s*\./)).toBeNull();
		expect(codeOnly.match(/\bpath\s*\./)).toBeNull();
	});
});

// =================================================================================================
// P0: lexical classification is primary; realpath never upgrades an external target.
// =================================================================================================

describe("P0 lexical classification precedence", () => {
	it("exported constant MAX_SESSION_PATH_CHAIN_ENTRIES is 256", () => {
		expect(MAX_SESSION_PATH_CHAIN_ENTRIES).toBe(256);
	});

	it.each<["inspect_content" | "repair" | "repair_dry_run"]>([["inspect_content"], ["repair"], ["repair_dry_run"]])(
		"%s: external lexical target with a forged inside realpath is target_external (no upgrade)",
		(intent) => {
			const external = "/etc/passwd";
			const forgedInside = "/sessions/forged.json";
			const decision = decide({
				intent,
				target: external,
				identity: { owner: "1000" },
				lock: { state: "absent", sameHost: true, pidDefinitelyAbsent: true, holderPid: null },
				evidence: evidence({
					target: { lexical: external, realpath: forgedInside },
					chain: [entry("/etc", "/etc"), entry(external, forgedInside)],
				}),
			});
			expect(decision.status).toBe("rejected");
			expect(decision.reason).toBe("target_external");
			expect(decision.classification).toBe("external");
		},
	);

	it("root realpath inflation to `/` does not upgrade an external lexical target", () => {
		const external = "/etc/passwd";
		const decision = decide({
			intent: "inspect_content",
			target: external,
			identity: { owner: "1000" },
			lock: { state: "absent", sameHost: true, pidDefinitelyAbsent: true, holderPid: null },
			evidence: evidence({
				trustedRootRealpath: "/",
				target: { lexical: external, realpath: external },
				chain: [entry("/etc", "/etc"), entry(external, external)],
			}),
		});
		expect(decision.status).toBe("rejected");
		expect(decision.reason).toBe("target_external");
	});

	it("inspect_metadata stays metadata_only for an external lexical target (no rejection)", () => {
		const external = "/etc/passwd";
		const decision = decide({
			intent: "inspect_metadata",
			target: external,
			evidence: evidence({
				target: { lexical: external, realpath: external },
				chain: [entry("/etc", "/etc"), entry(external, external)],
			}),
		});
		expect(decision.status).toBe("metadata_only");
		expect(decision.classification).toBe("external");
	});
});

// =================================================================================================
// P1: chain-length cap and evidence path-string caps.
// =================================================================================================

describe("P1 chain and path-string caps", () => {
	it("accepts a 256-entry honest chain and rejects 257 entries before mapping", () => {
		const root = "/r";
		const segs255 = Array.from({ length: 255 }, (_, i) => `s${i + 1}`);
		const target256 = `${root}/${segs255.join("/")}`;
		const chain256 = honestChain(root, segs255);
		expect(chain256).toHaveLength(256);
		const accepted = decide({
			root,
			target: target256,
			intent: "inspect_content",
			evidence: evidence({
				trustedRootLexical: root,
				trustedRootRealpath: root,
				target: { lexical: target256, realpath: target256 },
				chain: chain256,
			}),
		});
		expect(accepted.status).toBe("authorized");

		const segs256 = Array.from({ length: 256 }, (_, i) => `s${i + 1}`);
		const target257 = `${root}/${segs256.join("/")}`;
		const chain257 = honestChain(root, segs256);
		expect(chain257).toHaveLength(257);
		expect(() =>
			decide({
				root,
				target: target257,
				intent: "inspect_content",
				evidence: evidence({
					trustedRootLexical: root,
					trustedRootRealpath: root,
					target: { lexical: target257, realpath: target257 },
					chain: chain257,
				}),
			}),
		).toThrow(/MAX_SESSION_PATH_CHAIN_ENTRIES/);
	});

	it("throws when a chain lexical/realpath string exceeds the 4096 cap", () => {
		const over = `/${"a".repeat(4096)}`; // 4097 chars
		expect(over.length).toBe(4097);
		expect(() => decide({ intent: "inspect_metadata", evidence: evidence({ chain: [entry(over, over)] }) })).toThrow(
			TypeError,
		);
		expect(() =>
			decide({
				intent: "inspect_metadata",
				evidence: evidence({ chain: [entry(ROOT, over)] }),
			}),
		).toThrow(TypeError);
	});

	it("throws when an evidence root/target path string exceeds the 4096 cap", () => {
		const over = `/${"a".repeat(4096)}`;
		expect(() => decide({ intent: "inspect_metadata", evidence: evidence({ trustedRootRealpath: over }) })).toThrow(
			TypeError,
		);
		expect(() => decide({ intent: "inspect_metadata", evidence: evidence({ trustedRootLexical: over }) })).toThrow(
			TypeError,
		);
		expect(() =>
			decide({
				intent: "inspect_metadata",
				evidence: evidence({ target: { lexical: TARGET, realpath: over } }),
			}),
		).toThrow(TypeError);
	});

	it("control: an at-cap (4096) evidence path string is accepted by the cap", () => {
		const atCap = `/${"a".repeat(4095)}`; // 4096 chars
		expect(atCap.length).toBe(4096);
		expect(() =>
			decide({ intent: "inspect_metadata", evidence: evidence({ trustedRootRealpath: atCap }) }),
		).not.toThrow();
	});
});

// =================================================================================================
// P3: strict chain binding (roots, ends, length, segment boundary, containment).
// =================================================================================================

describe("P3 strict chain binding", () => {
	const DEEP = "/sessions/a/b.json";

	it("requires the root lexical and real canonical to be identical (evidence_mismatch)", () => {
		const decision = decide({
			intent: "inspect_content",
			evidence: evidence({
				trustedRootRealpath: "/sessions-real",
				target: { lexical: TARGET, realpath: "/sessions-real/s1.json" },
				chain: [entry(ROOT, "/sessions-real"), entry(TARGET, "/sessions-real/s1.json")],
			}),
		});
		expect(decision.reason).toBe("evidence_mismatch");
	});

	it("rejects an omitted middle entry (length mismatch => evidence_mismatch)", () => {
		const decision = decide({
			root: ROOT,
			target: DEEP,
			intent: "inspect_content",
			evidence: evidence({
				target: { lexical: DEEP, realpath: DEEP },
				chain: [entry(ROOT, ROOT), entry(DEEP, DEEP)],
			}),
		});
		expect(decision.reason).toBe("evidence_mismatch");
	});

	it("rejects an extra entry (length mismatch => evidence_mismatch)", () => {
		const decision = decide({
			root: ROOT,
			target: DEEP,
			intent: "inspect_content",
			evidence: evidence({
				target: { lexical: DEEP, realpath: DEEP },
				chain: [
					entry(ROOT, ROOT),
					entry("/sessions/a", "/sessions/a"),
					entry("/sessions/a/b", "/sessions/a/b"),
					entry(DEEP, DEEP),
				],
			}),
		});
		expect(decision.reason).toBe("evidence_mismatch");
	});

	it("rejects a reordered chain (last must equal the target => evidence_mismatch)", () => {
		const decision = decide({
			root: ROOT,
			target: DEEP,
			intent: "inspect_content",
			evidence: evidence({
				target: { lexical: DEEP, realpath: DEEP },
				chain: [entry(ROOT, ROOT), entry(DEEP, DEEP), entry("/sessions/a", "/sessions/a")],
			}),
		});
		expect(decision.reason).toBe("evidence_mismatch");
	});

	it("rejects an entry that skips a segment boundary (not a direct child => evidence_mismatch)", () => {
		const decision = decide({
			root: ROOT,
			target: DEEP,
			intent: "inspect_content",
			evidence: evidence({
				target: { lexical: DEEP, realpath: DEEP },
				chain: [entry(ROOT, ROOT), entry(DEEP, DEEP), entry(DEEP, DEEP)],
			}),
		});
		expect(decision.reason).toBe("evidence_mismatch");
	});

	it("rejects a chain whose first entry is not the root (evidence_mismatch)", () => {
		const decision = decide({
			intent: "inspect_content",
			evidence: evidence({
				chain: [entry("/sessions/x", "/sessions/x"), entry(TARGET, TARGET)],
			}),
		});
		expect(decision.reason).toBe("evidence_mismatch");
	});

	it("rejects a forged lexical-real last entry (realpath != target real => evidence_mismatch)", () => {
		const decision = decide({
			intent: "inspect_content",
			evidence: evidence({
				chain: [entry(ROOT, ROOT), entry(TARGET, "/sessions/evil.json")],
			}),
		});
		expect(decision.reason).toBe("evidence_mismatch");
	});

	it("authorizes a fully honest multi-level chain", () => {
		const decision = decide({
			root: ROOT,
			target: DEEP,
			intent: "repair",
			evidence: evidence({
				target: { lexical: DEEP, realpath: DEEP },
				chain: [entry(ROOT, ROOT), entry("/sessions/a", "/sessions/a"), entry(DEEP, DEEP)],
			}),
		});
		expect(decision.status).toBe("authorized");
		expect(decision.reason).toBe("authorized");
	});
});

// =================================================================================================
// P5: lock coherence is fail-closed (contradictory states close as lock_unknown).
// =================================================================================================

describe("P5 lock coherence (fail-closed)", () => {
	it.each([
		["absent with a holder pid", { state: "absent", sameHost: true, pidDefinitelyAbsent: true, holderPid: "5" }],
		[
			"absent without confirmed absence",
			{ state: "absent", sameHost: true, pidDefinitelyAbsent: false, holderPid: null },
		],
		["live on a foreign host", { state: "live", sameHost: false, pidDefinitelyAbsent: false, holderPid: "5" }],
		["live with no holder", { state: "live", sameHost: true, pidDefinitelyAbsent: false, holderPid: null }],
		["live whose pid is gone", { state: "live", sameHost: true, pidDefinitelyAbsent: true, holderPid: "5" }],
		["foreign on the same host", { state: "foreign", sameHost: true, pidDefinitelyAbsent: false, holderPid: "5" }],
	])("closes a contradictory %s as lock_unknown", (_label, lock) => {
		const decision = decide({ intent: "inspect_content", lock: lock as never });
		expect(decision.status).toBe("blocked");
		expect(decision.reason).toBe("lock_unknown");
	});

	it("stale without a holder pid is ineligible (lock_stale_ineligible)", () => {
		const decision = decide({
			intent: "inspect_content",
			lock: { state: "stale", sameHost: true, pidDefinitelyAbsent: true, holderPid: null },
		});
		expect(decision.reason).toBe("lock_stale_ineligible");
	});
});

// =================================================================================================
// P6: dry-run reports canRepair=false and zero writes; repair reports canRepair=true.
// =================================================================================================

describe("P6 dry-run vs repair capabilities", () => {
	const staleLock = { state: "stale" as const, sameHost: true, pidDefinitelyAbsent: true, holderPid: "999" };

	it("authorized repair has canRepair=true and one scheduled write", () => {
		const repair = decide({ intent: "repair", lock: staleLock });
		expect(repair.capabilities.canRepair).toBe(true);
		expect(repair.scheduledWrites).toBe(1);
	});

	it("authorized dry-run has canRepair=false and zero scheduled writes, same actions", () => {
		const dry = decide({ intent: "repair_dry_run", lock: staleLock });
		expect(dry.capabilities.canRepair).toBe(false);
		expect(dry.scheduledWrites).toBe(0);
		expect(dry.plannedActions).toEqual([{ kind: "remove_stale_lock", holderPid: "999" }]);
	});

	it("clean repair canRepair=true, clean dry-run canRepair=false", () => {
		const absent = { state: "absent" as const, sameHost: true, pidDefinitelyAbsent: true, holderPid: null };
		expect(decide({ intent: "repair", lock: absent }).capabilities.canRepair).toBe(true);
		expect(decide({ intent: "repair_dry_run", lock: absent }).capabilities.canRepair).toBe(false);
	});
});

// =================================================================================================
// P7: inspect_metadata is always metadata_only, never reads chain content.
// =================================================================================================

describe("P7 inspect_metadata metadata-only binding", () => {
	it("never reads chain content: a symlink chain stays metadata_only", () => {
		const decision = decide({
			intent: "inspect_metadata",
			evidence: evidence({ chain: [entry(ROOT, ROOT, "symlink"), entry(TARGET, TARGET)] }),
		});
		expect(decision.status).toBe("metadata_only");
	});

	it("never reads chain content: a forged chain stays metadata_only", () => {
		const decision = decide({
			intent: "inspect_metadata",
			evidence: evidence({ chain: [entry(ROOT, "/etc"), entry(TARGET, TARGET)] }),
		});
		expect(decision.status).toBe("metadata_only");
	});

	it("still throws on a malformed evidence shape", () => {
		const bad = evidence();
		delete (bad as unknown as Record<string, unknown>).opened;
		expect(() => decide({ intent: "inspect_metadata", evidence: bad })).toThrow(TypeError);
	});

	it("requires platform binding (evidence_mismatch on platform mismatch)", () => {
		const decision = decide({ intent: "inspect_metadata", evidence: evidence({ platform: "win32" }) });
		expect(decision.reason).toBe("evidence_mismatch");
	});

	it("requires root lexical binding (evidence_mismatch on root mismatch)", () => {
		const decision = decide({
			intent: "inspect_metadata",
			evidence: evidence({ trustedRootLexical: "/elsewhere" }),
		});
		expect(decision.reason).toBe("evidence_mismatch");
	});

	it("requires target lexical binding (evidence_mismatch on target lexical mismatch)", () => {
		const decision = decide({
			intent: "inspect_metadata",
			target: "/sessions/other.json",
			evidence: evidence({ target: { lexical: "/sessions/different.json", realpath: TARGET } }),
		});
		expect(decision.reason).toBe("evidence_mismatch");
	});
});

// =================================================================================================
// P8 (I36): win32 cross-platform decide path with canonical path equality.
// =================================================================================================

describe("win32 cross-platform decide path", () => {
	const WIN_ROOT = "C:\\Sessions";
	const WIN_TARGET = "C:\\Sessions\\File.json";
	const winAbs = { state: "absent" as const, sameHost: true, pidDefinitelyAbsent: true, holderPid: null };

	it("authorizes a clean single-case win32 inside-drive inspect_content path", () => {
		const decision = decide({
			platform: "win32",
			root: WIN_ROOT,
			target: WIN_TARGET,
			intent: "inspect_content",
			identity: { owner: "1000" },
			lock: winAbs,
			evidence: evidence({
				platform: "win32",
				trustedRootLexical: WIN_ROOT,
				trustedRootRealpath: WIN_ROOT,
				target: { lexical: WIN_TARGET, realpath: WIN_TARGET },
				chain: [entry(WIN_ROOT, WIN_ROOT), entry(WIN_TARGET, WIN_TARGET)],
			}),
		});
		expect(decision.status).toBe("authorized");
		expect(decision.classification).toBe("inside");
		expect(decision.targetRealpath).toBe(WIN_TARGET);
	});

	// Every binding pair (evidence root/target, chain root/first/last) differs only
	// in segment case; canonicalPathEqual must bind them case-insensitively. A raw
	// string compare would close this as evidence_mismatch.
	it("authorizes when root/target/chain differ only in segment case (case-insensitive binding)", () => {
		const decision = decide({
			platform: "win32",
			root: WIN_ROOT,
			target: WIN_TARGET,
			intent: "repair",
			identity: { owner: "1000" },
			lock: winAbs,
			evidence: evidence({
				platform: "win32",
				trustedRootLexical: "C:\\SESSIONS",
				trustedRootRealpath: "c:\\SeSsIoNs",
				target: { lexical: "C:\\sessions\\FILE.json", realpath: "C:\\SESSIONS\\file.json" },
				chain: [entry("C:\\SESSIONS", "c:\\SeSsIoNs"), entry("C:\\sessions\\FILE.json", "C:\\SESSIONS\\file.json")],
			}),
		});
		expect(decision.status).toBe("authorized");
		expect(decision.reason).toBe("authorized");
		expect(decision.classification).toBe("inside");
		// The decision echoes the attested evidence strings verbatim (segment case preserved).
		expect(decision.targetRealpath).toBe("C:\\SESSIONS\\file.json");
		expect(decision.trustedRootLexical).toBe("C:\\SESSIONS");
	});

	it("rejects a cross-drive target as target_external", () => {
		const decision = decide({
			platform: "win32",
			root: WIN_ROOT,
			target: "D:\\Sessions\\s1.json",
			intent: "inspect_content",
			identity: { owner: "1000" },
			lock: winAbs,
			evidence: evidence({
				platform: "win32",
				trustedRootLexical: WIN_ROOT,
				trustedRootRealpath: WIN_ROOT,
				target: { lexical: "D:\\Sessions\\s1.json", realpath: "D:\\Sessions\\s1.json" },
				chain: [entry("D:\\Sessions", "D:\\Sessions"), entry("D:\\Sessions\\s1.json", "D:\\Sessions\\s1.json")],
			}),
		});
		expect(decision.status).toBe("rejected");
		expect(decision.reason).toBe("target_external");
	});

	it("rejects a win32 target outside the drive root as target_external", () => {
		const escaped = "C:\\Windows\\system32.dat";
		const decision = decide({
			platform: "win32",
			root: WIN_ROOT,
			target: escaped,
			intent: "inspect_content",
			identity: { owner: "1000" },
			lock: winAbs,
			evidence: evidence({
				platform: "win32",
				trustedRootLexical: WIN_ROOT,
				trustedRootRealpath: WIN_ROOT,
				target: { lexical: escaped, realpath: escaped },
				chain: [entry("C:\\Windows", "C:\\Windows"), entry(escaped, escaped)],
			}),
		});
		expect(decision.status).toBe("rejected");
		expect(decision.reason).toBe("target_external");
	});
});

// =================================================================================================
// P8 (I36): strict chain array validation before element access.
// =================================================================================================

describe("strict chain array validation", () => {
	it("rejects an accessor chain element without executing its getter", () => {
		const forged = [entry(ROOT, ROOT), entry(TARGET, TARGET)];
		let getterCalled = false;
		Object.defineProperty(forged, 0, {
			configurable: true,
			get() {
				getterCalled = true;
				return entry(ROOT, ROOT);
			},
		});
		expect(() => decide({ intent: "inspect_metadata", evidence: evidence({ chain: forged }) })).toThrow(TypeError);
		expect(getterCalled).toBe(false);
	});

	it("rejects a chain array whose prototype is not Array.prototype", () => {
		const tampered = [entry(ROOT, ROOT), entry(TARGET, TARGET)];
		Object.setPrototypeOf(tampered, null);
		expect(() => decide({ intent: "inspect_metadata", evidence: evidence({ chain: tampered }) })).toThrow(TypeError);
	});

	it("rejects a chain array carrying a symbol property", () => {
		const forged = [entry(ROOT, ROOT), entry(TARGET, TARGET)];
		Object.defineProperty(forged, Symbol("forge"), {
			value: 1,
			writable: true,
			configurable: true,
			enumerable: true,
		});
		expect(() => decide({ intent: "inspect_metadata", evidence: evidence({ chain: forged }) })).toThrow(TypeError);
	});

	it("rejects a chain array with an extra (non-index) own property", () => {
		const forged = [entry(ROOT, ROOT), entry(TARGET, TARGET)];
		(forged as unknown as Record<string, unknown>).extra = 1;
		expect(() => decide({ intent: "inspect_metadata", evidence: evidence({ chain: forged }) })).toThrow(TypeError);
	});

	it("rejects a sparse (holey) chain array", () => {
		const forged = [entry(ROOT, ROOT), entry(TARGET, TARGET)];
		delete (forged as unknown as Record<number, unknown>)[0];
		expect(() => decide({ intent: "inspect_metadata", evidence: evidence({ chain: forged }) })).toThrow(TypeError);
	});
});

// =================================================================================================
// P8 (I36): canonical decimal strings only (0 or nonzero, no leading zeros).
// =================================================================================================

describe("canonical decimal strings (dev/ino/owner/holderPid)", () => {
	it('accepts the canonical zero "0" for dev/ino and authorizes', () => {
		const zero = stat({ dev: "0", ino: "0" });
		const decision = decide({
			intent: "inspect_content",
			evidence: evidence({ statBefore: zero, statAfter: zero, opened: { dev: "0", ino: "0" } }),
		});
		expect(decision.status).toBe("authorized");
	});

	it.each(["00", "01", "010", "00123"])("rejects non-canonical decimal %p for statBefore.dev", (bad) => {
		expect(() =>
			decide({ intent: "inspect_content", evidence: evidence({ statBefore: stat({ dev: bad }) }) }),
		).toThrow(TypeError);
	});

	it.each(["00", "01"])("rejects non-canonical decimal %p for opened.ino", (bad) => {
		expect(() =>
			decide({ intent: "inspect_metadata", evidence: evidence({ opened: { dev: "11", ino: bad } }) }),
		).toThrow(TypeError);
	});

	it("accepts the canonical zero holderPid and plans a remove_stale_lock for repair", () => {
		const decision = decide({
			intent: "repair",
			lock: { state: "stale" as const, sameHost: true, pidDefinitelyAbsent: true, holderPid: "0" },
		});
		expect(decision.status).toBe("authorized");
		expect(decision.plannedActions).toEqual([{ kind: "remove_stale_lock", holderPid: "0" }]);
		expect(decision.scheduledWrites).toBe(1);
	});

	it("rejects a non-canonical holderPid (leading zero)", () => {
		expect(() =>
			decide({
				intent: "inspect_content",
				lock: { state: "stale" as const, sameHost: true, pidDefinitelyAbsent: true, holderPid: "01" },
			}),
		).toThrow(TypeError);
	});

	it("rejects a non-canonical owner in identity leniently (blocks, no throw)", () => {
		const decision = decide({ intent: "inspect_content", identity: { owner: "00" } });
		expect(decision.status).toBe("blocked");
		expect(decision.reason).toBe("identity_required");
	});
});
