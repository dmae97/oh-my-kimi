import {
	chmodSync,
	linkSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { atomicRewriteFileSync } from "../../src/core/atomic-session-file.ts";
import { acquireDurableFileMutationLockSync, DurableFileLockBusyError } from "../../src/core/durable-file-identity.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

// Failure injection: the helper and SessionManager import from "fs" (not
// "node:fs"), so this mock only affects the code under test. The test's own
// assertions above use the real "node:fs" module.
const fsyncFailure = vi.hoisted(() => ({ callCount: 0, failAt: 0, code: "EIO", targetIno: "" }));
const fsyncObserver = vi.hoisted<{ current?: () => void }>(() => ({}));
vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs")>();
	return {
		...actual,
		fsyncSync: (fd: number): void => {
			fsyncObserver.current?.();
			fsyncFailure.callCount += 1;
			const targetsFd =
				fsyncFailure.targetIno === "" ||
				actual.fstatSync(fd, { bigint: true }).ino.toString() === fsyncFailure.targetIno;
			if (
				fsyncFailure.failAt > 0 &&
				targetsFd &&
				(fsyncFailure.targetIno !== "" || fsyncFailure.callCount === fsyncFailure.failAt)
			) {
				throw Object.assign(new Error("injected fsync failure"), { code: fsyncFailure.code });
			}
			actual.fsyncSync(fd);
		},
	};
});

const isWindows = process.platform === "win32";

function mutationLockIsHeld(path: string): boolean {
	try {
		acquireDurableFileMutationLockSync(path, { timeoutMs: 0 }).release();
		return false;
	} catch (error) {
		if (error instanceof DurableFileLockBusyError) return true;
		throw error;
	}
}

describe("atomicRewriteFileSync", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "atomic-rewrite-"));
	});

	afterEach(() => {
		fsyncFailure.callCount = 0;
		fsyncFailure.failAt = 0;
		fsyncFailure.code = "EIO";
		fsyncFailure.targetIno = "";
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("replaces existing content and leaves no temp files behind", () => {
		const target = join(tempDir, "target.jsonl");
		writeFileSync(target, "old-line\n");

		atomicRewriteFileSync(target, "new-line-1\nnew-line-2\n");

		expect(readFileSync(target, "utf8")).toBe("new-line-1\nnew-line-2\n");
		expect(readdirSync(tempDir)).toEqual(["target.jsonl"]);
	});

	it("creates the target when it does not exist yet", () => {
		const target = join(tempDir, "fresh.jsonl");

		atomicRewriteFileSync(target, "hello\n");

		expect(readFileSync(target, "utf8")).toBe("hello\n");
		expect(readdirSync(tempDir)).toEqual(["fresh.jsonl"]);
	});

	it.skipIf(isWindows)("creates a new target with private mode 0600", () => {
		const target = join(tempDir, "private.jsonl");

		atomicRewriteFileSync(target, "private\n");

		expect(statSync(target).mode & 0o777).toBe(0o600);
	});

	it.skipIf(isWindows)("refuses to split a target with an unknown hardlink", () => {
		const target = join(tempDir, "target.jsonl");
		const alias = join(tempDir, "alias.jsonl");
		writeFileSync(target, "old\n");
		linkSync(target, alias);

		expect(() => atomicRewriteFileSync(target, "new\n")).toThrow(/hard ?link/i);
		expect(readFileSync(target, "utf8")).toBe("old\n");
		expect(readFileSync(alias, "utf8")).toBe("old\n");
	});

	it.skipIf(isWindows)("rewrites the canonical target without replacing a symlink alias", () => {
		const target = join(tempDir, "target.jsonl");
		const alias = join(tempDir, "alias.jsonl");
		writeFileSync(target, "old\n");
		symlinkSync(target, alias);

		atomicRewriteFileSync(alias, "new\n");

		expect(lstatSync(alias).isSymbolicLink()).toBe(true);
		expect(readFileSync(target, "utf8")).toBe("new\n");
	});

	it.skipIf(isWindows)("replaces via rename instead of truncating the target in place", () => {
		const target = join(tempDir, "target.jsonl");
		writeFileSync(target, "old\n");
		const inoBefore = statSync(target, { bigint: true }).ino;

		atomicRewriteFileSync(target, "new\n");

		// A new inode proves the target was atomically replaced by rename and
		// was never opened for truncation, so concurrent readers only ever see
		// the complete old or complete new file.
		expect(statSync(target, { bigint: true }).ino).not.toBe(inoBefore);
	});

	it.skipIf(isWindows)("preserves the existing file mode", () => {
		const target = join(tempDir, "target.jsonl");
		writeFileSync(target, "old\n");
		chmodSync(target, 0o600);

		atomicRewriteFileSync(target, "new\n");

		expect(statSync(target).mode & 0o777).toBe(0o600);
	});

	it("keeps the old target intact and removes the temp file when a pre-rename step fails", () => {
		const target = join(tempDir, "target.jsonl");
		writeFileSync(target, "old\n");

		fsyncFailure.callCount = 0;
		fsyncFailure.failAt = 1;
		expect(() => atomicRewriteFileSync(target, "new\n")).toThrow("injected fsync failure");

		expect(readFileSync(target, "utf8")).toBe("old\n");
		expect(readdirSync(tempDir)).toEqual(["target.jsonl"]);
	});

	it.skipIf(isWindows)("propagates a real parent-directory durability failure after rename", () => {
		const target = join(tempDir, "target.jsonl");
		writeFileSync(target, "old\n");
		fsyncFailure.callCount = 0;
		fsyncFailure.failAt = 2;
		fsyncFailure.code = "EIO";

		expect(() => atomicRewriteFileSync(target, "new\n")).toThrow("injected fsync failure");
		expect(readFileSync(target, "utf8")).toBe("new\n");
	});

	it.skipIf(isWindows)("allows an explicitly unsupported parent-directory fsync code", () => {
		const target = join(tempDir, "target.jsonl");
		writeFileSync(target, "old\n");
		fsyncFailure.callCount = 0;
		fsyncFailure.failAt = 2;
		fsyncFailure.code = "EINVAL";

		expect(() => atomicRewriteFileSync(target, "new\n")).not.toThrow();
		expect(readFileSync(target, "utf8")).toBe("new\n");
	});
});

describe("SessionManager rewrite atomicity", () => {
	let tempDir: string;

	const v1SessionContent =
		'{"type":"session","id":"sess-1","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
		'{"type":"message","timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n';

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "session-atomic-"));
	});

	afterEach(() => {
		fsyncFailure.callCount = 0;
		fsyncFailure.failAt = 0;
		fsyncFailure.code = "EIO";
		fsyncFailure.targetIno = "";
		fsyncObserver.current = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it.skipIf(isWindows)("migration rewrite replaces the session file via rename", () => {
		const file = join(tempDir, "old-session.jsonl");
		writeFileSync(file, v1SessionContent);
		const inoBefore = statSync(file, { bigint: true }).ino;

		SessionManager.open(file, tempDir);

		expect(statSync(file, { bigint: true }).ino).not.toBe(inoBefore);
	});

	it("migration rewrite persists migrated content inside the load lock and leaves no temp files", () => {
		const file = join(tempDir, "old-session.jsonl");
		writeFileSync(file, v1SessionContent);
		let rewriteHeldLock = false;
		fsyncObserver.current = () => {
			rewriteHeldLock ||= mutationLockIsHeld(file);
		};

		SessionManager.open(file, tempDir);

		expect(rewriteHeldLock).toBe(true);
		expect(readdirSync(tempDir)).toEqual(["old-session.jsonl"]);
		const lines = readFileSync(file, "utf8").trim().split("\n");
		const header = JSON.parse(lines[0]);
		expect(header.version).toBe(3);
		const message = JSON.parse(lines[1]);
		expect(message.id).toBeDefined();
	});

	it.skipIf(isWindows)("migration rewrite preserves the session file mode", () => {
		const file = join(tempDir, "old-session.jsonl");
		writeFileSync(file, v1SessionContent);
		chmodSync(file, 0o600);

		SessionManager.open(file, tempDir);

		expect(statSync(file).mode & 0o777).toBe(0o600);
	});

	it("does not publish memory or truncate indeterminate bytes when append fsync fails", () => {
		// Given: an already-flushed session and its accepted memory/file head.
		const manager = SessionManager.create(tempDir, tempDir);
		manager.appendMessage({ role: "user", content: "seed", timestamp: 1 });
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seeded" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		const file = manager.getSessionFile();
		if (!file) throw new Error("expected persisted session file");
		const acceptedEntries = manager.getEntries();
		const acceptedLeaf = manager.getLeafId();
		const acceptedBytes = readFileSync(file);

		// When: persistence fails before the append is durable.
		let appendHeldLock = false;
		fsyncObserver.current = () => {
			appendHeldLock ||= mutationLockIsHeld(file);
		};
		fsyncFailure.callCount = 0;
		fsyncFailure.failAt = 1;
		fsyncFailure.targetIno = statSync(file, { bigint: true }).ino.toString();

		// Then: memory stays at the accepted head, while visible indeterminate bytes are never truncated.
		expect(() => manager.appendMessage({ role: "user", content: "must roll back", timestamp: 3 })).toThrow(
			"injected fsync failure",
		);
		expect(appendHeldLock).toBe(true);
		expect(manager.getEntries()).toEqual(acceptedEntries);
		expect(manager.getLeafId()).toBe(acceptedLeaf);
		const visible = readFileSync(file);
		expect(visible.subarray(0, acceptedBytes.byteLength)).toEqual(acceptedBytes);
		expect(visible.toString("utf8")).toContain("must roll back");
	});
});
