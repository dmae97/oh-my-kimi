import {
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	acquireDurableFileMutationLockSync,
	DurableFileLockBusyError,
	getDurableFileLockRoot,
	resolveDurableFileIdentity,
} from "../src/core/durable-file-identity.ts";
import {
	ensureDurableDirectorySync,
	normalizeDurablePathIdentity,
	writeExclusiveFileDurablySync,
} from "../src/core/durable-file-io.ts";
import { getDefaultSessionDir, SessionManager } from "../src/core/session-manager.ts";

const fsyncCalls = vi.hoisted(() => ({ count: 0, failAt: 0, concurrentMkdirPath: "" }));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		mkdirSync: (...args: Parameters<typeof actual.mkdirSync>) => {
			const [path] = args;
			if (String(path) === fsyncCalls.concurrentMkdirPath) {
				fsyncCalls.concurrentMkdirPath = "";
				actual.mkdirSync(...args);
				throw Object.assign(new Error("injected concurrent mkdir winner"), { code: "EEXIST" });
			}
			return actual.mkdirSync(...args);
		},
		fsyncSync: (fd: number): void => {
			fsyncCalls.count += 1;
			if (fsyncCalls.count === fsyncCalls.failAt) {
				throw Object.assign(new Error("injected directory fsync failure"), { code: "EIO" });
			}
			actual.fsyncSync(fd);
		},
	};
});

const isWindows = process.platform === "win32";

describe("durable file mutation identity", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "omk-durable-identity-"));
	});

	afterEach(() => {
		fsyncCalls.count = 0;
		fsyncCalls.failAt = 0;
		fsyncCalls.concurrentMkdirPath = "";
		rmSync(root, { recursive: true, force: true });
	});

	it.skipIf(isWindows)("shares one inode generation identity across symlink and hardlink aliases", () => {
		// Given: three names for one inode.
		const target = join(root, "target.jsonl");
		const hardlink = join(root, "hardlink.jsonl");
		const symlink = join(root, "symlink.jsonl");
		writeFileSync(target, "seed\n");
		linkSync(target, hardlink);
		symlinkSync(target, symlink);

		// When: every alias is resolved.
		const direct = resolveDurableFileIdentity(target);
		const hard = resolveDurableFileIdentity(hardlink);
		const symbolic = resolveDurableFileIdentity(symlink);

		// Then: aliases share the generation key, while symlinks also share canonical path.
		expect(direct.generation).not.toBeNull();
		expect(hard.aliasKey).toBe(direct.aliasKey);
		expect(symbolic.aliasKey).toBe(direct.aliasKey);
		expect(symbolic.canonicalPath).toBe(direct.canonicalPath);
	});

	it.skipIf(isWindows)("serializes mutation lock acquisition through hardlink and symlink aliases", () => {
		const target = join(root, "target.jsonl");
		const hardlink = join(root, "hardlink.jsonl");
		const symlink = join(root, "symlink.jsonl");
		writeFileSync(target, "seed\n");
		linkSync(target, hardlink);
		symlinkSync(target, symlink);
		const held = acquireDurableFileMutationLockSync(target, { timeoutMs: 0 });

		try {
			expect(() => acquireDurableFileMutationLockSync(hardlink, { timeoutMs: 0 })).toThrow(DurableFileLockBusyError);
			expect(() => acquireDurableFileMutationLockSync(symlink, { timeoutMs: 0 })).toThrow(DurableFileLockBusyError);
		} finally {
			held.release();
		}
	});

	it.skipIf(isWindows)("canonicalizes a non-existing target through its nearest existing symlink ancestor", () => {
		const realParent = join(root, "real");
		const aliasParent = join(root, "alias");
		mkdirSync(realParent);
		symlinkSync(realParent, aliasParent);

		const real = resolveDurableFileIdentity(join(realParent, "future.jsonl"));
		const alias = resolveDurableFileIdentity(join(aliasParent, "future.jsonl"));

		expect(real.generation).toBeNull();
		expect(alias.generation).toBeNull();
		expect(alias.canonicalPath).toBe(real.canonicalPath);
		expect(alias.pathKey).toBe(real.pathKey);
	});

	it.skipIf(isWindows)("fsyncs every traversed ancestor parent for a recursive durable root", () => {
		fsyncCalls.count = 0;

		ensureDurableDirectorySync(join(root, "one", "two", "three"));

		expect(fsyncCalls.count).toBe(4);
	});

	it.skipIf(isWindows)("fsyncs the parent after concurrent EEXIST and on a later retry", () => {
		// Given: another creator wins after the existence check but before mkdir.
		const target = join(root, "concurrent");
		fsyncCalls.concurrentMkdirPath = target;
		fsyncCalls.count = 0;

		// When: durable creation observes EEXIST and is later retried.
		ensureDurableDirectorySync(target);
		ensureDurableDirectorySync(target);

		// Then: both the EEXIST path and existing-directory retry sync the parent.
		expect(fsyncCalls.count).toBe(3);
	});

	it.skipIf(isWindows)("rejects an EEXIST object that is not a directory", () => {
		// Given: the requested durable directory name already belongs to a file.
		const target = join(root, "not-a-directory");
		writeFileSync(target, "file\n");

		// When/Then: existence cannot stand in for a directory type check.
		expect(() => ensureDurableDirectorySync(target)).toThrow(/directory/i);
	});

	it.skipIf(isWindows)("retries a failed ancestor fsync after concurrent EEXIST", () => {
		// Given: another creator wins an ancestor mkdir, then its parent fsync fails.
		const ancestor = join(root, "concurrent-ancestor");
		const target = join(ancestor, "child");
		fsyncCalls.concurrentMkdirPath = ancestor;
		fsyncCalls.failAt = 2;

		// When: the first traversal reports the durability failure.
		expect(() => ensureDurableDirectorySync(target)).toThrow("injected directory fsync failure");

		// Then: retry traverses and fsyncs the winner's parent before creating its child.
		fsyncCalls.failAt = 0;
		expect(() => ensureDurableDirectorySync(target)).not.toThrow();
		expect(existsSync(target)).toBe(true);
		expect(fsyncCalls.count).toBe(4);
	});

	it.skipIf(isWindows)("removes an uncommitted directory and retries its parent fsync", () => {
		// Given: the first parent-directory fsync fails after mkdir succeeds.
		const target = join(root, "retryable");
		fsyncCalls.failAt = 2;

		// When: durable creation reports the failure.
		expect(() => ensureDurableDirectorySync(target)).toThrow("injected directory fsync failure");

		// Then: cleanup is itself synced and a later call recreates durably.
		expect(existsSync(target)).toBe(false);
		expect(fsyncCalls.count).toBe(3);
		fsyncCalls.failAt = 0;
		expect(() => ensureDurableDirectorySync(target)).not.toThrow();
		expect(existsSync(target)).toBe(true);
		expect(fsyncCalls.count).toBe(5);
	});

	it.skipIf(isWindows)("fsyncs exclusive-file cleanup and leaves creation retryable", () => {
		// Given: creation succeeds through file fsync, then parent fsync fails.
		const target = join(root, "exclusive.jsonl");
		fsyncCalls.failAt = 2;

		// When: durable exclusive creation reports the failure.
		expect(() => writeExclusiveFileDurablySync(target, Buffer.from("private\n"))).toThrow(
			"injected directory fsync failure",
		);

		// Then: parent-synced cleanup removes the artifact and a retry succeeds.
		expect(existsSync(target)).toBe(false);
		expect(fsyncCalls.count).toBe(3);
		fsyncCalls.failAt = 0;
		expect(() => writeExclusiveFileDurablySync(target, Buffer.from("private\n"))).not.toThrow();
		expect(fsyncCalls.count).toBe(5);
	});

	it.skipIf(isWindows)("routes every recursive SessionManager directory creation through durable fsync", () => {
		const source = join(root, "source.jsonl");
		writeFileSync(source, `${JSON.stringify({ type: "session", version: 3, id: "source", cwd: root })}\n`);

		let before = fsyncCalls.count;
		getDefaultSessionDir(root, join(root, "default-agent"));
		expect(fsyncCalls.count).toBeGreaterThan(before);

		before = fsyncCalls.count;
		SessionManager.create(root, join(root, "custom", "nested"));
		expect(fsyncCalls.count).toBeGreaterThan(before);

		before = fsyncCalls.count;
		SessionManager.forkFrom(source, root, join(root, "fork", "nested"));
		expect(fsyncCalls.count).toBeGreaterThan(before);
	});

	it("defines Darwin decomposition and case folding at the platform boundary", () => {
		const composed = "/tmp/Futur\u00c9.jsonl";

		expect(normalizeDurablePathIdentity(composed, "darwin")).toBe("/tmp/future\u0301.jsonl");
		expect(normalizeDurablePathIdentity(composed, "linux")).toBe(composed);
	});

	it("normalizes and case-folds Darwin path keys before and after names exist", () => {
		const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
		try {
			const composedPath = join(root, "Futur\u00e9.jsonl");
			const decomposedPath = join(root, "futur\u0065\u0301.jsonl");
			const absentComposed = resolveDurableFileIdentity(composedPath);
			const absentDecomposed = resolveDurableFileIdentity(decomposedPath);
			writeFileSync(composedPath, "composed\n");
			writeFileSync(decomposedPath, "decomposed\n");

			const existingComposed = resolveDurableFileIdentity(composedPath);
			const existingDecomposed = resolveDurableFileIdentity(decomposedPath);
			expect(absentComposed.pathKey).toBe(absentDecomposed.pathKey);
			expect(existingComposed.pathKey).toBe(existingDecomposed.pathKey);
			expect(existingComposed.pathKey).toBe(absentComposed.pathKey);
		} finally {
			platform.mockRestore();
		}
	});

	it.skipIf(isWindows)("fsyncs the lock parent after retirement cleanup", () => {
		// Given: an acquired lock with all creation syncs complete.
		const lock = acquireDurableFileMutationLockSync(join(root, "cleanup-sync.jsonl"), { timeoutMs: 0 });
		const before = fsyncCalls.count;

		// When: its owner and directory are retired.
		lock.release();

		// Then: retirement and cleanup each sync the lock parent.
		expect(fsyncCalls.count).toBeGreaterThanOrEqual(before + 2);
	});

	it.skipIf(isWindows)("does not follow a symlink planted at the final lock target", () => {
		const target = join(root, "future.jsonl");
		const trap = join(root, "trap");
		mkdirSync(trap);
		const identity = resolveDurableFileIdentity(target);
		const lockTarget = join(getDurableFileLockRoot(), `mutation-${identity.pathKey}.lock`);
		symlinkSync(trap, lockTarget);

		try {
			expect(() => acquireDurableFileMutationLockSync(target, { timeoutMs: 0 })).toThrow(DurableFileLockBusyError);
			expect(readdirSync(trap)).toEqual([]);
		} finally {
			rmSync(lockTarget, { force: true });
		}
	});

	it.skipIf(isWindows)("uses a private mode-0700 per-user lock root", () => {
		const lockRoot = getDurableFileLockRoot();
		const stat = lstatSync(lockRoot);

		expect(stat.isDirectory()).toBe(true);
		expect(stat.isSymbolicLink()).toBe(false);
		expect(stat.mode & 0o777).toBe(0o700);
	});
});
