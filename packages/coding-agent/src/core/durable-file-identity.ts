import { type DurableFileGeneration, type DurableFileIdentity, resolveDurableFileIdentity } from "./durable-file-io.ts";
import {
	acquireDurableFileLockPathSync,
	assertDurableFileLockPathsOwnedSync,
	DurableFileLockBusyError,
	DurableFileLockOwnershipError,
	drainRetryableDurableFileLocksSync,
	durableFileLockPath,
	getDurableFileLockRoot,
	type HeldDurableFileLock,
	inspectDurableFileLockPathSync,
	releaseDurableFileLockPathsSync,
	retainRetryableDurableFileLocks,
} from "./durable-file-lock-storage.ts";

export { DurableFileLockBusyError, DurableFileLockOwnershipError, getDurableFileLockRoot, resolveDurableFileIdentity };
export type { DurableFileGeneration, DurableFileIdentity };

export interface DurableFileLockOptions {
	readonly timeoutMs?: number;
}

export interface DurableFileLock {
	readonly identity: DurableFileIdentity;
	transfer(path: string, options?: DurableFileLockOptions): void;
	release(): void;
}

export type DurableFileLockObservation =
	| { readonly status: "absent" }
	| { readonly status: "live"; readonly pid: number; readonly host: string }
	| { readonly status: "unknown" };

export function inspectDurableFileLockSync(path: string, scope: string): DurableFileLockObservation {
	drainRetryableDurableFileLocksSync();
	const deadline = Date.now();
	const observations = resolveDurableFileIdentity(path).lockKeys.map((key) =>
		inspectDurableFileLockPathSync(durableFileLockPath(scope, key), deadline),
	);
	return (
		observations.find((value) => value.status === "live") ??
		observations.find((value) => value.status === "unknown") ?? { status: "absent" }
	);
}

function lockTimeout(options: DurableFileLockOptions): number {
	const timeoutMs = options.timeoutMs ?? 10_000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new TypeError("Lock timeout must be non-negative");
	return timeoutMs;
}

function sameLockKeys(left: DurableFileIdentity, right: DurableFileIdentity): boolean {
	return left.lockKeys.join("\0") === right.lockKeys.join("\0");
}

function rollbackAddedLocks(
	held: HeldDurableFileLock[],
	added: readonly HeldDurableFileLock[],
	failure: unknown,
): never {
	try {
		releaseDurableFileLockPathsSync(held, added);
	} catch (cleanupError) {
		retainRetryableDurableFileLocks(added);
		throw new AggregateError([failure, cleanupError], "Durable file lock acquisition cleanup failed");
	}
	throw failure;
}

function createLock(scope: string, identity: DurableFileIdentity, held: HeldDurableFileLock[]): DurableFileLock {
	let currentIdentity = identity;
	let released = false;
	return {
		get identity() {
			return currentIdentity;
		},
		transfer(nextPath, options = {}) {
			if (released) throw new TypeError("Cannot transfer a released durable file lock");
			assertDurableFileLockPathsOwnedSync(held);
			const deadline = Date.now() + lockTimeout(options);
			for (let attempt = 0; attempt < 4; attempt += 1) {
				const nextIdentity = resolveDurableFileIdentity(nextPath);
				const added: HeldDurableFileLock[] = [];
				try {
					for (const key of nextIdentity.lockKeys) {
						if (held.some((lock) => lock.key === key)) continue;
						const lock = acquireDurableFileLockPathSync(key, durableFileLockPath(scope, key), deadline);
						held.push(lock);
						added.push(lock);
					}
				} catch (error) {
					rollbackAddedLocks(held, added, error instanceof Error ? error : new Error(String(error)));
				}
				const stable = resolveDurableFileIdentity(nextPath);
				if (!sameLockKeys(stable, nextIdentity)) {
					releaseDurableFileLockPathsSync(held, added);
					continue;
				}
				const retained = new Set(stable.lockKeys);
				releaseDurableFileLockPathsSync(
					held,
					held.filter((lock) => !retained.has(lock.key)),
				);
				currentIdentity = stable;
				return;
			}
			throw new DurableFileLockBusyError();
		},
		release() {
			if (released) return;
			try {
				releaseDurableFileLockPathsSync(held, held);
			} catch (error) {
				retainRetryableDurableFileLocks(held);
				throw error;
			}
			released = true;
		},
	};
}

export function acquireDurableFileLockSync(
	path: string,
	scope: string,
	options: DurableFileLockOptions = {},
): DurableFileLock {
	drainRetryableDurableFileLocksSync();
	const deadline = Date.now() + lockTimeout(options);
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const identity = resolveDurableFileIdentity(path);
		const held: HeldDurableFileLock[] = [];
		try {
			for (const key of identity.lockKeys) {
				held.push(acquireDurableFileLockPathSync(key, durableFileLockPath(scope, key), deadline));
			}
			const stable = resolveDurableFileIdentity(path);
			if (!sameLockKeys(stable, identity)) {
				releaseDurableFileLockPathsSync(held, held);
				continue;
			}
			return createLock(scope, stable, held);
		} catch (error) {
			rollbackAddedLocks(held, held, error instanceof Error ? error : new Error(String(error)));
		}
	}
	throw new DurableFileLockBusyError();
}

export function acquireDurableFileMutationLockSync(path: string, options?: DurableFileLockOptions): DurableFileLock {
	return acquireDurableFileLockSync(path, "mutation", options);
}

export function withDurableFileMutationLockSync<T>(path: string, fn: () => T): T {
	const lock = acquireDurableFileMutationLockSync(path);
	try {
		return fn();
	} finally {
		lock.release();
	}
}
