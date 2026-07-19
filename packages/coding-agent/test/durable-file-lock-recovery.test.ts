import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	acquireDurableFileMutationLockSync,
	getDurableFileLockRoot,
	inspectDurableFileLockSync,
	resolveDurableFileIdentity,
} from "../src/core/durable-file-identity.ts";

const fault = vi.hoisted(() => ({
	ownerOpenRemaining: 0,
	retirementUnlinkRemaining: 0,
	replaceLockPath: "",
	lockStats: 0,
	replacementToken: "",
	replaced: false,
	ownerGateObserved: false,
	disappearLockPath: "",
	disappearOwnerReads: 0,
}));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
			const result = actual.lstatSync(...args);
			const [path] = args;
			if (fault.replaceLockPath !== "" && String(path) === fault.replaceLockPath) {
				fault.lockStats += 1;
				if (fault.lockStats === 4) {
					const parent = fault.replaceLockPath.slice(0, fault.replaceLockPath.lastIndexOf("/"));
					const prefix = `${fault.replaceLockPath.split("/").at(-1)}.reclaim-`;
					fault.ownerGateObserved = actual.readdirSync(parent).some((name) => name.startsWith(prefix));
					actual.renameSync(fault.replaceLockPath, `${fault.replaceLockPath}.stale`);
					actual.mkdirSync(fault.replaceLockPath, { mode: 0o700 });
					actual.writeFileSync(
						`${fault.replaceLockPath}/owner.json`,
						JSON.stringify({ pid: process.pid, host: hostname(), token: fault.replacementToken }),
						{ mode: 0o600 },
					);
					fault.replaced = true;
				}
			}
			return result;
		},
		openSync: (...args: Parameters<typeof actual.openSync>): number => {
			const [path] = args;
			if (String(path) === `${fault.disappearLockPath}/owner.json`) {
				fault.disappearOwnerReads += 1;
				if (fault.disappearOwnerReads === 2) {
					actual.rmSync(fault.disappearLockPath, { recursive: true });
					throw Object.assign(new Error("injected competing reclaimer"), { code: "ENOENT" });
				}
			}
			if (fault.ownerOpenRemaining > 0 && String(path).endsWith("/owner.json")) {
				fault.ownerOpenRemaining -= 1;
				throw Object.assign(new Error("injected owner read failure"), { code: "EIO" });
			}
			return actual.openSync(...args);
		},
		unlinkSync: (...args: Parameters<typeof actual.unlinkSync>): void => {
			const [path] = args;
			if (fault.retirementUnlinkRemaining > 0 && String(path).includes(".release-")) {
				fault.retirementUnlinkRemaining -= 1;
				throw Object.assign(new Error("injected retirement cleanup failure"), { code: "EIO" });
			}
			actual.unlinkSync(...args);
		},
	};
});

describe("durable file lock recovery", () => {
	let root: string;
	let target: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "omk-durable-lock-recovery-"));
		target = join(root, "session.jsonl");
		fault.ownerOpenRemaining = 0;
		fault.retirementUnlinkRemaining = 0;
		fault.replaceLockPath = "";
		fault.lockStats = 0;
		fault.replacementToken = "";
		fault.replaced = false;
		fault.ownerGateObserved = false;
		fault.disappearLockPath = "";
		fault.disappearOwnerReads = 0;
	});

	afterEach(async () => {
		fault.ownerOpenRemaining = 0;
		fault.retirementUnlinkRemaining = 0;
		fault.replaceLockPath = "";
		fault.disappearLockPath = "";
		await rm(root, { recursive: true, force: true });
	});

	it("keeps release retryable when the owner record cannot be read transiently", () => {
		// Given: a held lock whose next owner read fails transiently.
		const lock = acquireDurableFileMutationLockSync(target, { timeoutMs: 0 });
		fault.ownerOpenRemaining = 1;

		// When: release cannot prove ownership.
		expect(() => lock.release()).toThrow("injected owner read failure");

		// Then: the same handle can retry instead of silently leaking the lock.
		expect(() => lock.release()).not.toThrow();
		expect(inspectDurableFileLockSync(target, "mutation").status).toBe("absent");
	});

	it("serializes stale reclaim by owner and compares token plus inode before retirement", () => {
		// Given: a stale owner is replaced by a live owner during the gated final read.
		const identity = resolveDurableFileIdentity(target);
		const lockPath = join(getDurableFileLockRoot(), `mutation-${identity.pathKey}.lock`);
		mkdirSync(lockPath, { mode: 0o700 });
		const staleToken = randomUUID();
		writeFileSync(
			join(lockPath, "owner.json"),
			JSON.stringify({ pid: 99_999_999, host: hostname(), token: staleToken }),
			{ mode: 0o600 },
		);
		fault.replaceLockPath = lockPath;
		fault.replacementToken = staleToken;

		// When: reclaim reaches its final owner/inode comparison.
		try {
			expect(() => acquireDurableFileMutationLockSync(target, { timeoutMs: 0 })).toThrow(/ownership|lock/i);

			// Then: an owner-specific gate serialized reclaim and the replacement survives.
			expect(fault.ownerGateObserved).toBe(true);
			expect(fault.replaced).toBe(true);
			expect(JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")).token).toBe(fault.replacementToken);
		} finally {
			fault.replaceLockPath = "";
			rmSync(lockPath, { recursive: true, force: true });
			rmSync(`${lockPath}.stale`, { recursive: true, force: true });
		}
	});

	it("accepts a competing reclaimer ENOENT only after the lock path is absent", () => {
		// Given: a dead owner disappears during the gated reclaimer's final read.
		const identity = resolveDurableFileIdentity(target);
		const lockPath = join(getDurableFileLockRoot(), `mutation-${identity.pathKey}.lock`);
		mkdirSync(lockPath, { mode: 0o700 });
		writeFileSync(
			join(lockPath, "owner.json"),
			JSON.stringify({ pid: 99_999_999, host: hostname(), token: randomUUID() }),
			{ mode: 0o600 },
		);
		fault.disappearLockPath = lockPath;

		// When: acquisition observes the second reclaimer's ENOENT.
		const lock = acquireDurableFileMutationLockSync(target, { timeoutMs: 0 });

		// Then: absence was proven and acquisition remains usable.
		expect(fault.disappearOwnerReads).toBeGreaterThanOrEqual(2);
		lock.release();
	});

	it("rejects transfer after queued cleanup completed and ownership was reacquired", () => {
		// Given: one handle queues retirement cleanup and a replacement drains then reacquires it.
		const stale = acquireDurableFileMutationLockSync(target, { timeoutMs: 0 });
		fault.retirementUnlinkRemaining = 1;
		expect(() => stale.release()).toThrow("injected retirement cleanup failure");
		fault.retirementUnlinkRemaining = 0;
		const replacement = acquireDurableFileMutationLockSync(target, { timeoutMs: 0 });

		try {
			// When/Then: the stale handle cannot treat its old key as globally owned.
			expect(() => stale.transfer(target, { timeoutMs: 0 })).toThrow(/ownership/i);
		} finally {
			replacement.release();
		}
	});

	it("keeps a retired artifact reachable until cleanup and parent sync succeed", () => {
		// Given: retirement can rename the lock but owner cleanup fails twice.
		const lock = acquireDurableFileMutationLockSync(target, { timeoutMs: 0 });
		fault.retirementUnlinkRemaining = 2;

		// When: release encounters an indeterminate cleanup.
		expect(() => lock.release()).toThrow("injected retirement cleanup failure");

		// Then: retry drains the same retirement rather than reporting silent success.
		fault.retirementUnlinkRemaining = 0;
		expect(() => lock.release()).not.toThrow();
		const lockName = `mutation-${resolveDurableFileIdentity(target).pathKey}.lock.release-`;
		expect(readdirSync(getDurableFileLockRoot()).some((name) => name.startsWith(lockName))).toBe(false);
	});
});
