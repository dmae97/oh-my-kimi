import { appendFileSync, linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { atomicRewriteFileSync } from "../src/core/atomic-session-file.ts";
import { RunJournalStore } from "../src/core/run-journal-store.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	acquireSessionOwnerLeaseSync,
	inspectSessionOwnerLeaseSync,
	SessionOwnerLeaseHeldError,
} from "../src/core/session-owner-lease.ts";
import { assistantMsg, userMsg } from "./utilities.ts";

const cleanupFault = vi.hoisted(() => ({
	operation: "" as "" | "rename" | "unlink" | "rmdir",
	scope: "",
	remaining: 0,
}));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		renameSync: (...args: Parameters<typeof actual.renameSync>): void => {
			const [path] = args;
			if (
				cleanupFault.operation === "rename" &&
				cleanupFault.remaining > 0 &&
				String(path).includes(cleanupFault.scope)
			) {
				cleanupFault.remaining -= 1;
				throw Object.assign(new Error("injected lock rename retirement failure"), { code: "EIO" });
			}
			actual.renameSync(...args);
		},
		unlinkSync: (path: Parameters<typeof actual.unlinkSync>[0]): void => {
			if (
				cleanupFault.operation === "unlink" &&
				cleanupFault.remaining > 0 &&
				String(path).includes(cleanupFault.scope)
			) {
				cleanupFault.remaining -= 1;
				throw Object.assign(new Error("injected lock unlink cleanup failure"), { code: "EIO" });
			}
			actual.unlinkSync(path);
		},
		rmdirSync: (path: Parameters<typeof actual.rmdirSync>[0]): void => {
			if (
				cleanupFault.operation === "rmdir" &&
				cleanupFault.remaining > 0 &&
				String(path).includes(cleanupFault.scope)
			) {
				cleanupFault.remaining -= 1;
				throw Object.assign(new Error("injected lock rmdir cleanup failure"), { code: "EIO" });
			}
			actual.rmdirSync(path);
		},
	};
});

const SESSION_ID = "session-owner";
const T0 = "2026-07-18T00:00:00.000Z";
const isWindows = process.platform === "win32";

describe("session owner lease", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "omk-session-owner-"));
		cleanupFault.operation = "";
		cleanupFault.scope = "";
		cleanupFault.remaining = 0;
	});

	afterEach(() => {
		cleanupFault.operation = "";
		rmSync(root, { recursive: true, force: true });
	});

	it.skipIf(isWindows)("is visible through symlink and hardlink aliases until explicitly released", () => {
		const sessionPath = join(root, "session.jsonl");
		const hardlink = join(root, "hardlink.jsonl");
		const symlink = join(root, "symlink.jsonl");
		writeFileSync(sessionPath, "seed\n");
		linkSync(sessionPath, hardlink);
		symlinkSync(sessionPath, symlink);

		const lease = acquireSessionOwnerLeaseSync(sessionPath);
		try {
			expect(inspectSessionOwnerLeaseSync(hardlink).status).toBe("live");
			expect(inspectSessionOwnerLeaseSync(symlink).status).toBe("live");
		} finally {
			lease.release();
		}
		expect(inspectSessionOwnerLeaseSync(sessionPath).status).toBe("absent");
	});

	it.skipIf(isWindows)("refreshes inode aliases when the leased session file is created", () => {
		const owner = SessionManager.create(root, root);
		const sessionPath = owner.getSessionFile();
		if (!sessionPath) throw new Error("expected session path");
		const lease = acquireSessionOwnerLeaseSync(sessionPath);
		owner.setOwnerLease(lease);

		try {
			owner.appendMessage(userMsg("seed"));
			owner.appendMessage(assistantMsg("seeded"));
			const hardlink = join(root, "created-hardlink.jsonl");
			linkSync(sessionPath, hardlink);
			expect(inspectSessionOwnerLeaseSync(hardlink).status).toBe("live");
		} finally {
			lease.release();
		}
	});

	it.skipIf(isWindows)("keeps old ownership when inode-alias refresh fails", () => {
		const sessionPath = join(root, "refresh.jsonl");
		const alias = join(root, "replacement-hardlink.jsonl");
		writeFileSync(sessionPath, "old\n");
		const lease = acquireSessionOwnerLeaseSync(sessionPath);
		atomicRewriteFileSync(sessionPath, "replacement\n");
		linkSync(sessionPath, alias);
		const blocker = acquireSessionOwnerLeaseSync(alias);

		try {
			expect(() => lease.refresh()).toThrow(SessionOwnerLeaseHeldError);
			blocker.release();
			expect(inspectSessionOwnerLeaseSync(sessionPath).status).toBe("live");
			expect(() => lease.refresh()).not.toThrow();
			expect(lease.owns(alias)).toBe(true);
		} finally {
			blocker.release();
			lease.release();
		}
	});

	it("does not publish a new owner when mutation-lock retirement is indeterminate", () => {
		// Given: owner acquisition succeeds, then mutation-lock retirement fails.
		const sessionPath = join(root, "acquire-cleanup.jsonl");
		writeFileSync(sessionPath, "seed\n");
		cleanupFault.operation = "rename";
		cleanupFault.scope = "mutation-";
		cleanupFault.remaining = 1;

		// When: acquisition cannot finish the old cleanup obligation.
		expect(() => acquireSessionOwnerLeaseSync(sessionPath)).toThrow("injected lock rename retirement failure");

		// Then: no owner identity was published and a clean retry can acquire it.
		expect(inspectSessionOwnerLeaseSync(sessionPath).status).toBe("absent");
		const lease = acquireSessionOwnerLeaseSync(sessionPath);
		lease.release();
	});

	it("does not publish a refreshed identity until old-lock retirement succeeds", () => {
		// Given: rewrite changes the inode generation held by a live lease.
		const sessionPath = join(root, "refresh-cleanup.jsonl");
		writeFileSync(sessionPath, "old\n");
		const lease = acquireSessionOwnerLeaseSync(sessionPath);
		const oldKeys = lease.identity.lockKeys;
		atomicRewriteFileSync(sessionPath, "replacement\n");
		cleanupFault.operation = "rename";
		cleanupFault.scope = "session-owner-";
		cleanupFault.remaining = 1;

		// When: refresh cannot retire the old owner identity.
		expect(() => lease.refresh()).toThrow("injected lock rename retirement failure");

		// Then: publication waits, while the same lease can retry the obligation.
		try {
			expect(lease.identity.lockKeys).toEqual(oldKeys);
			expect(() => lease.refresh()).not.toThrow();
			expect(lease.owns(sessionPath)).toBe(true);
		} finally {
			lease.release();
		}
	});

	it("does not publish a transferred identity until old-lock retirement succeeds", () => {
		// Given: two distinct generations and a retirement fault on the old lock.
		const oldPath = join(root, "transfer-old.jsonl");
		const nextPath = join(root, "transfer-next.jsonl");
		writeFileSync(oldPath, "old\n");
		writeFileSync(nextPath, "next\n");
		const lease = acquireSessionOwnerLeaseSync(oldPath);
		const oldKeys = lease.identity.lockKeys;
		cleanupFault.operation = "rename";
		cleanupFault.scope = "session-owner-";
		cleanupFault.remaining = 1;

		// When: transfer cannot retire the old owner identity.
		expect(() => lease.transfer(nextPath)).toThrow("injected lock rename retirement failure");

		// Then: public identity stays old until retry determines every obligation.
		try {
			expect(lease.sessionPath).toBe(oldPath);
			expect(lease.identity.lockKeys).toEqual(oldKeys);
			expect(inspectSessionOwnerLeaseSync(oldPath).status).toBe("live");
			expect(inspectSessionOwnerLeaseSync(nextPath).status).toBe("live");
			expect(() => lease.transfer(nextPath)).not.toThrow();
			expect(lease.sessionPath).toBe(nextPath);
			expect(lease.owns(nextPath)).toBe(true);
		} finally {
			lease.release();
		}
	});

	it("keeps old ownership and leaves no ghost ownership when path transfer fails", () => {
		const oldPath = join(root, "old.jsonl");
		const blockedPath = join(root, "blocked.jsonl");
		writeFileSync(oldPath, "old\n");
		writeFileSync(blockedPath, "blocked\n");
		const lease = acquireSessionOwnerLeaseSync(oldPath);
		const blocker = acquireSessionOwnerLeaseSync(blockedPath);

		try {
			expect(() => lease.transfer(blockedPath)).toThrow(SessionOwnerLeaseHeldError);
			expect(lease.sessionPath).toBe(oldPath);
			expect(lease.owns(oldPath)).toBe(true);
			expect(lease.owns(blockedPath)).toBe(false);
			expect(inspectSessionOwnerLeaseSync(oldPath).status).toBe("live");
		} finally {
			lease.release();
			blocker.release();
		}
		expect(inspectSessionOwnerLeaseSync(oldPath).status).toBe("absent");
		expect(inspectSessionOwnerLeaseSync(blockedPath).status).toBe("absent");
	});

	it("lets the attached owner write while a previously opened session manager is refused", () => {
		const author = SessionManager.create(root, root);
		author.appendMessage(userMsg("seed"));
		author.appendMessage(assistantMsg("seeded"));
		const sessionPath = author.getSessionFile();
		if (!sessionPath) throw new Error("expected session path");
		const owner = SessionManager.open(sessionPath, root);
		const competitor = SessionManager.open(sessionPath, root);
		const lease = acquireSessionOwnerLeaseSync(sessionPath);
		owner.setOwnerLease(lease);

		try {
			owner.appendMessage(userMsg("owner write"));
			expect(() => competitor.appendMessage(userMsg("competitor write"))).toThrow(SessionOwnerLeaseHeldError);
		} finally {
			lease.release();
		}
	});

	it("prevents journal open from silently recovering a live run", () => {
		const sessionPath = join(root, "session.jsonl");
		const journalPath = `${sessionPath}.runjournal`;
		writeFileSync(sessionPath, "seed\n");
		const writer = RunJournalStore.open({ journalPath, sessionId: SESSION_ID, now: () => T0 });
		writer.start({ runId: "live-run", sessionRevision: 1, timestamp: T0 });
		appendFileSync(journalPath, '{"partial":');
		const before = readFileSync(journalPath);
		const lease = acquireSessionOwnerLeaseSync(sessionPath);

		try {
			expect(() => RunJournalStore.open({ journalPath, sessionId: SESSION_ID, now: () => T0 })).toThrow(
				SessionOwnerLeaseHeldError,
			);
			expect(readFileSync(journalPath)).toEqual(before);
		} finally {
			lease.release();
		}
		const recovered = RunJournalStore.open({ journalPath, sessionId: SESSION_ID, now: () => T0 });
		expect(recovered.records.at(-1)?.event).toBe("run_recovered");
	});

	it("prevents session open from quarantining a live owner's trailing bytes", () => {
		const author = SessionManager.create(root, root);
		author.appendMessage(userMsg("seed"));
		author.appendMessage(assistantMsg("seeded"));
		const sessionPath = author.getSessionFile();
		if (!sessionPath) throw new Error("expected session path");
		appendFileSync(sessionPath, '{"partial":');
		const before = readFileSync(sessionPath);
		const lease = acquireSessionOwnerLeaseSync(sessionPath);

		try {
			expect(() => SessionManager.open(sessionPath, root)).toThrow(SessionOwnerLeaseHeldError);
			expect(readFileSync(sessionPath)).toEqual(before);
		} finally {
			lease.release();
		}
	});
});
