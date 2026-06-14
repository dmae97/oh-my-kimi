import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { recoverOrphanedBackups } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

class FsCodeError extends Error {
	code: string;

	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

// The atomic-write + EPERM `.bak` move-aside/rollback dance lives in
// FileSessionStorage.writeTextAtomic, so these tests must drive a real
// file-backed storage (with a temp dir) and override `rename` to simulate the
// Windows EPERM-on-replace failure.
class RenameEpermOnceStorage extends FileSessionStorage {
	failNextSessionReplace = false;
	backupCleanupPath: string | undefined;

	async rename(source: string, target: string): Promise<void> {
		if (
			this.failNextSessionReplace &&
			source.includes(".tmp") &&
			target.endsWith(".jsonl") &&
			this.existsSync(target)
		) {
			this.failNextSessionReplace = false;
			throw new FsCodeError("EPERM", `EPERM: operation not permitted, rename '${source}' -> '${target}'`);
		}
		return super.rename(source, target);
	}

	async unlink(target: string): Promise<void> {
		if (target.endsWith(".bak")) {
			this.backupCleanupPath = target;
		}
		return super.unlink(target);
	}
}

describe("SessionManager rewrite EPERM replacement fallback", () => {
	let sessionDir: string;

	beforeEach(async () => {
		sessionDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-eperm-"));
	});

	afterEach(async () => {
		await fsp.rm(sessionDir, { recursive: true, force: true });
	});

	it("keeps the active session healthy when replacing an existing file hits EPERM", async () => {
		const storage = new RenameEpermOnceStorage();
		const session = SessionManager.create(sessionDir, sessionDir, storage);
		await session.ensureOnDisk();
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		storage.failNextSessionReplace = true;
		await expect(session.setSessionName("renamed session", "user")).resolves.toBe(true);

		const rewritten = await storage.readText(sessionFile);
		expect(rewritten).toContain('"title":"renamed session"');
		const backupPath = storage.backupCleanupPath;
		if (!backupPath) throw new Error("Expected EPERM fallback to create a rollback backup");
		expect(storage.existsSync(backupPath)).toBe(false);

		session.appendMessage({ role: "user", content: "after rewrite", timestamp: Date.now() });
		await expect(session.flush()).resolves.toBeUndefined();
	});
});

describe("SessionManager rewrite EPERM rollback failure", () => {
	let sessionDir: string;

	beforeEach(async () => {
		sessionDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-eperm-"));
	});

	afterEach(async () => {
		await fsp.rm(sessionDir, { recursive: true, force: true });
	});

	it("preserves the original EPERM as the thrown error's cause when rollback also fails", async () => {
		class DoubleFailStorage extends FileSessionStorage {
			failureMode = false;
			tempRenameAttempts = 0;

			async rename(source: string, target: string): Promise<void> {
				if (!this.failureMode) return super.rename(source, target);
				// Every temp -> target rename fails with EPERM (both the upstream attempt in
				// writeTextAtomic and the retry inside #replaceSessionFileAfterEperm).
				if (source.includes(".tmp") && target.endsWith(".jsonl")) {
					this.tempRenameAttempts++;
					const tag = this.tempRenameAttempts === 1 ? "original" : "retry";
					throw new FsCodeError("EPERM", `EPERM ${tag}: rename '${source}' -> '${target}'`);
				}
				// The rollback rename (backup -> target) fails with a distinct code.
				if (source.endsWith(".bak") && target.endsWith(".jsonl")) {
					throw new FsCodeError("EIO", `EIO rollback: rename '${source}' -> '${target}'`);
				}
				return super.rename(source, target);
			}
		}

		const storage = new DoubleFailStorage();
		const session = SessionManager.create(sessionDir, sessionDir, storage);
		await session.ensureOnDisk();
		storage.failureMode = true;
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		let thrown: Error | undefined;
		try {
			await session.setSessionName("doomed", "user");
		} catch (err) {
			thrown = err as Error;
		}
		if (!thrown) throw new Error("Expected setSessionName to reject");
		// Message text MUST surface both the retry failure and the rollback failure.
		expect(thrown.message).toContain("rollback");
		expect(thrown.message).toContain("EIO rollback");
		expect(thrown.message).toContain("EPERM retry");
		// `cause` MUST be the original upstream EPERM that started the fallback path,
		// not the second/retry failure or the rollback failure.
		const cause = thrown.cause as Error | undefined;
		expect(cause).toBeInstanceOf(Error);
		expect(cause?.message).toContain("EPERM original");
	});
});

describe("recoverOrphanedBackups", () => {
	it("promotes an orphaned <basename>.jsonl.<snowflake>.bak back to the primary path when the primary is missing", async () => {
		const storage = new MemorySessionStorage();
		const dir = "/sessions/proj";
		const primary = `${dir}/session-abc.jsonl`;
		const backup = `${primary}.1700000000000.bak`;
		storage.writeTextSync(backup, '{"type":"session","id":"abc"}\n');

		await recoverOrphanedBackups(dir, storage);

		expect(storage.existsSync(primary)).toBe(true);
		expect(storage.existsSync(backup)).toBe(false);
		expect(await storage.readText(primary)).toBe('{"type":"session","id":"abc"}\n');
	});

	it("leaves the backup alone when the primary already exists", async () => {
		const storage = new MemorySessionStorage();
		const dir = "/sessions/proj";
		const primary = `${dir}/session-xyz.jsonl`;
		const backup = `${primary}.1700000000000.bak`;
		storage.writeTextSync(primary, '{"type":"session","id":"xyz","keep":true}\n');
		storage.writeTextSync(backup, '{"type":"session","id":"xyz","stale":true}\n');

		await recoverOrphanedBackups(dir, storage);

		expect(await storage.readText(primary)).toContain('"keep":true');
		expect(storage.existsSync(backup)).toBe(true);
	});

	it("picks the newest backup when multiple orphans exist for the same primary", async () => {
		const storage = new MemorySessionStorage();
		const dir = "/sessions/proj";
		const primary = `${dir}/session-multi.jsonl`;
		const older = `${primary}.100.bak`;
		const newer = `${primary}.200.bak`;
		storage.writeTextSync(older, "older");
		// Force the newer backup to have a strictly higher mtime so recovery is deterministic.
		await Bun.sleep(5);
		storage.writeTextSync(newer, "newer");

		await recoverOrphanedBackups(dir, storage);

		expect(storage.existsSync(primary)).toBe(true);
		expect(await storage.readText(primary)).toBe("newer");
	});
});
