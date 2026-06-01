import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";

export interface FileLockOptions {
	staleMs?: number;
	retries?: number;
	retryDelayMs?: number;
}

const DEFAULT_OPTIONS: Required<FileLockOptions> = {
	staleMs: 10_000,
	retries: 50,
	retryDelayMs: 100,
};

interface LockInfo {
	pid: number;
	timestamp: number;
	token: string;
}

function getLockPath(filePath: string): string {
	return `${filePath}.lock`;
}

async function writeLockInfo(lockPath: string, token: string): Promise<void> {
	const info: LockInfo = { pid: process.pid, timestamp: Date.now(), token };
	await Bun.write(`${lockPath}/info`, JSON.stringify(info));
}

async function readLockInfo(lockPath: string): Promise<LockInfo | null> {
	try {
		const content = await fs.readFile(`${lockPath}/info`, "utf-8");
		return JSON.parse(content) as LockInfo;
	} catch {
		return null;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function isLockStale(lockPath: string, staleMs: number): Promise<boolean> {
	const info = await readLockInfo(lockPath);
	if (info) {
		if (!isProcessAlive(info.pid)) return true;
		if (Date.now() - info.timestamp > staleMs) return true;
		return false;
	}

	// No info file. Either the lock holder is between mkdir and writeLockInfo
	// (fresh dir, do not reap) or the dir was already removed (also do not
	// reap — there is nothing to clean up, and an unguarded fs.rm here would
	// race with another contender's successful mkdir and wipe their dir).
	try {
		const stat = await fs.stat(lockPath);
		return Date.now() - stat.mtimeMs > staleMs;
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

async function tryAcquireLock(lockPath: string): Promise<string | null> {
	try {
		await fs.mkdir(lockPath);
		const token = randomUUID();
		await writeLockInfo(lockPath, token);
		return token;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			return null;
		}
		throw error;
	}
}

async function releaseLock(lockPath: string, expectedToken?: string): Promise<void> {
	try {
		if (expectedToken !== undefined) {
			const info = await readLockInfo(lockPath);
			if (!info || info.token !== expectedToken) {
				// We are not the owner. The lock either expired and was reaped
				// or another process has reclaimed it. Do nothing — releasing
				// here would wipe the rightful owner's lock.
				logger.debug("file-lock: skipping release for non-owned lock", {
					lockPath,
					expectedToken,
					actualToken: info?.token,
				});
				return;
			}
		}
		await fs.rm(lockPath, { recursive: true });
	} catch {
		// Ignore errors on release.
	}
}

async function lockExists(lockPath: string): Promise<boolean> {
	try {
		await fs.stat(lockPath);
		return true;
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

async function acquireLock(filePath: string, options: FileLockOptions = {}): Promise<() => Promise<void>> {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const lockPath = getLockPath(filePath);

	for (let attempt = 0; attempt < opts.retries; attempt++) {
		const token = await tryAcquireLock(lockPath);
		if (token !== null) {
			return () => releaseLock(lockPath, token);
		}

		if ((await lockExists(lockPath)) && (await isLockStale(lockPath, opts.staleMs))) {
			// Reaping a stale lock — no token because we didn't acquire it. The
			// rightful owner is presumed dead; rm without ownership check.
			await releaseLock(lockPath);
			continue;
		}

		await Bun.sleep(opts.retryDelayMs);
	}

	throw new Error(`Failed to acquire lock for ${filePath} after ${opts.retries} attempts`);
}

export async function withFileLock<T>(
	filePath: string,
	fn: () => Promise<T>,
	options: FileLockOptions = {},
): Promise<T> {
	const release = await acquireLock(filePath, options);
	try {
		return await fn();
	} finally {
		await release();
	}
}

/**
 * Test-only handles for the internal lock primitives. These are NOT part of
 * the public API — they exist so the contract tests can validate token-keyed
 * release semantics and the mkdir-race window without re-implementing them.
 */
export const __internalsForTesting = {
	tryAcquireLock,
	releaseLock,
	readLockInfo,
	isLockStale,
	getLockPath,
};
