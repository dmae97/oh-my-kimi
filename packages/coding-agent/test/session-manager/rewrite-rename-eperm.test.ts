import { describe, expect, it } from "bun:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

class FsCodeError extends Error {
	code: string;

	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

class RenameEpermOnceStorage extends MemorySessionStorage {
	failNextSessionReplace = false;
	backupCleanupPath: string | undefined;

	rename(source: string, target: string): Promise<void> {
		if (
			this.failNextSessionReplace &&
			source.includes(".tmp") &&
			target.endsWith(".jsonl") &&
			this.existsSync(target)
		) {
			this.failNextSessionReplace = false;
			return Promise.reject(
				new FsCodeError("EPERM", `EPERM: operation not permitted, rename '${source}' -> '${target}'`),
			);
		}
		return super.rename(source, target);
	}

	unlink(target: string): Promise<void> {
		if (target.endsWith(".bak")) {
			this.backupCleanupPath = target;
		}
		return super.unlink(target);
	}
}

describe("SessionManager rewrite EPERM replacement fallback", () => {
	it("keeps the active session healthy when replacing an existing file hits EPERM", async () => {
		const storage = new RenameEpermOnceStorage();
		const session = SessionManager.create("/cwd", "/sessions", storage);
		await session.ensureOnDisk();
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		storage.failNextSessionReplace = true;
		await expect(session.setSessionName("renamed session", "user")).resolves.toBe(true);

		const rewritten = storage.readTextSync(sessionFile);
		expect(rewritten).toContain('"title":"renamed session"');
		const backupPath = storage.backupCleanupPath;
		if (!backupPath) throw new Error("Expected EPERM fallback to create a rollback backup");
		expect(storage.existsSync(backupPath)).toBe(false);

		session.appendMessage({ role: "user", content: "after rewrite", timestamp: Date.now() });
		await expect(session.flush()).resolves.toBeUndefined();
	});
});
