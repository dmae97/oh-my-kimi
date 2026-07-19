import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, rmdirSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { ensureDurableDirectorySync, fsyncDirectorySync, writeExclusiveFileDurablySync } from "./durable-file-io.ts";
import {
	createDurableFileLockRetirement,
	type DurableFileLockRetirement,
	retireDurableFileLockSync,
} from "./durable-file-lock-cleanup.ts";
import {
	type DurableFileLockOwnerSnapshot,
	fileErrorCode,
	readDurableFileLockOwnerSync,
	sameDurableFileLockOwner,
} from "./durable-file-lock-owner.ts";

export type DurableFileLockPathObservation =
	| { readonly status: "absent" }
	| { readonly status: "live"; readonly pid: number; readonly host: string }
	| { readonly status: "unknown" };

export interface HeldDurableFileLock {
	readonly key: string;
	readonly path: string;
	readonly token: string;
	readonly expectedOwner: DurableFileLockOwnerSnapshot;
	readonly retirement: DurableFileLockRetirement;
}

export class DurableFileLockBusyError extends Error {
	override readonly name = "DurableFileLockBusyError";
	constructor() {
		super("Durable file lock is held by another live process");
	}
}

export class DurableFileLockOwnershipError extends Error {
	override readonly name = "DurableFileLockOwnershipError";
	constructor() {
		super("Durable file lock ownership changed before retirement");
	}
}

const USER = userInfo();
const USER_KEY =
	USER.uid >= 0 ? String(USER.uid) : createHash("sha256").update(USER.username).digest("hex").slice(0, 16);
const ROOT = join(tmpdir(), `omk-persistence-${USER_KEY}`);
const WAITER = new Int32Array(new SharedArrayBuffer(4));
const retryableLocks: HeldDurableFileLock[] = [];

export function getDurableFileLockRoot(): string {
	let value: ReturnType<typeof lstatSync>;
	try {
		value = lstatSync(ROOT);
	} catch (error) {
		if (fileErrorCode(error) !== "ENOENT") throw error;
		ensureDurableDirectorySync(ROOT);
		value = lstatSync(ROOT);
	}
	if (!value.isDirectory() || value.isSymbolicLink()) throw new Error("Persistence lock root is not a real directory");
	if (typeof process.getuid === "function" && value.uid !== process.getuid()) {
		throw new Error("Persistence lock root is not owned by the current user");
	}
	if ((value.mode & 0o7777) !== 0o700) {
		chmodSync(ROOT, 0o700);
		value = lstatSync(ROOT);
		if ((value.mode & 0o7777) !== 0o700) throw new Error("Persistence lock root mode is not private");
	}
	return ROOT;
}

function ownerPath(path: string): string {
	return join(path, "owner.json");
}

function processIsLive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		return fileErrorCode(error) !== "ESRCH";
	}
}

function removeOwnedLock(lock: HeldDurableFileLock): void {
	if (lock.retirement.retiredPath === undefined) {
		let current: DurableFileLockOwnerSnapshot;
		try {
			current = readDurableFileLockOwnerSync(lock.path);
		} catch (error) {
			if (fileErrorCode(error) === "ENOENT") throw new DurableFileLockOwnershipError();
			throw error;
		}
		if (!sameDurableFileLockOwner(current, lock.expectedOwner)) throw new DurableFileLockOwnershipError();
	}
	retireDurableFileLockSync(lock.path, lock.retirement);
}

export function releaseDurableFileLockPathsSync(
	held: HeldDurableFileLock[],
	selected: readonly HeldDurableFileLock[],
): void {
	for (const lock of [...selected].reverse()) {
		removeOwnedLock(lock);
		const index = held.indexOf(lock);
		if (index >= 0) held.splice(index, 1);
	}
}

export function retainRetryableDurableFileLocks(locks: readonly HeldDurableFileLock[]): void {
	for (const lock of locks) if (!retryableLocks.includes(lock)) retryableLocks.push(lock);
}

export function assertDurableFileLockPathsOwnedSync(locks: readonly HeldDurableFileLock[]): void {
	for (const lock of locks) {
		if (retryableLocks.includes(lock) || lock.retirement.retiredPath !== undefined)
			throw new DurableFileLockOwnershipError();
		let current: DurableFileLockOwnerSnapshot;
		try {
			current = readDurableFileLockOwnerSync(lock.path);
		} catch (error) {
			if (fileErrorCode(error) === "ENOENT") throw new DurableFileLockOwnershipError();
			throw error;
		}
		if (!sameDurableFileLockOwner(current, lock.expectedOwner)) throw new DurableFileLockOwnershipError();
	}
}

export function drainRetryableDurableFileLocksSync(): void {
	releaseDurableFileLockPathsSync(retryableLocks, retryableLocks);
}

function ownerObservation(lockPath: string): DurableFileLockOwnerSnapshot | DurableFileLockPathObservation {
	try {
		return readDurableFileLockOwnerSync(lockPath);
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		if (fileErrorCode(error) === "ENOENT") {
			try {
				lstatSync(lockPath);
			} catch (pathError) {
				if (!(pathError instanceof Error)) throw pathError;
				if (fileErrorCode(pathError) === "ENOENT") return { status: "absent" };
			}
		}
		return { status: "unknown" };
	}
}

function reclaimGatePath(lockPath: string, observed: DurableFileLockOwnerSnapshot): string {
	const ownerKey = createHash("sha256")
		.update(`${observed.owner.token}\0${observed.dev}\0${observed.ino}`)
		.digest("hex")
		.slice(0, 24);
	return `${lockPath}.reclaim-${ownerKey}.lock`;
}

export function durableFileLockPath(scope: string, key: string): string {
	if (!/^[a-z-]+$/u.test(scope)) throw new TypeError("Durable file lock scope is invalid");
	return join(getDurableFileLockRoot(), `${scope}-${key}.lock`);
}

export function acquireDurableFileLockPathSync(key: string, path: string, deadline: number): HeldDurableFileLock {
	while (true) {
		const token = randomUUID();
		try {
			mkdirSync(path, { mode: 0o700 });
		} catch (error) {
			if (fileErrorCode(error) !== "EEXIST") throw error;
			if (inspectDurableFileLockPathSync(path, deadline).status === "absent") continue;
			if (Date.now() >= deadline) throw new DurableFileLockBusyError();
			Atomics.wait(WAITER, 0, 0, Math.min(10, deadline - Date.now()));
			continue;
		}
		const directory = lstatSync(path, { bigint: true });
		if (!directory.isDirectory() || directory.isSymbolicLink()) throw new DurableFileLockOwnershipError();
		const expectedOwner: DurableFileLockOwnerSnapshot = Object.freeze({
			owner: Object.freeze({ pid: process.pid, host: hostname(), token }),
			dev: directory.dev.toString(),
			ino: directory.ino.toString(),
		});
		const lock: HeldDurableFileLock = {
			key,
			path,
			token,
			expectedOwner,
			retirement: createDurableFileLockRetirement(),
		};
		let ownerWritten = false;
		try {
			fsyncDirectorySync(dirname(path));
			writeExclusiveFileDurablySync(ownerPath(path), Buffer.from(JSON.stringify(expectedOwner.owner), "utf8"));
			ownerWritten = true;
			assertDurableFileLockPathsOwnedSync([lock]);
			return lock;
		} catch (error) {
			let cleanupError: unknown;
			try {
				if (ownerWritten) releaseDurableFileLockPathsSync([lock], [lock]);
				else {
					rmdirSync(path);
					fsyncDirectorySync(dirname(path));
				}
			} catch (failure) {
				cleanupError = failure instanceof Error ? failure : new Error(String(failure));
				if (ownerWritten && !(cleanupError instanceof DurableFileLockOwnershipError))
					retainRetryableDurableFileLocks([lock]);
			}
			if (cleanupError) throw new AggregateError([error, cleanupError], "Durable file lock creation cleanup failed");
			throw error;
		}
	}
}

function reclaim(lockPath: string, observed: DurableFileLockOwnerSnapshot, deadline: number): boolean {
	const gate = acquireDurableFileLockPathSync(
		`reclaim:${observed.owner.token}`,
		reclaimGatePath(lockPath, observed),
		deadline,
	);
	const stale: HeldDurableFileLock = {
		key: `stale:${observed.owner.token}`,
		path: lockPath,
		token: observed.owner.token,
		expectedOwner: observed,
		retirement: createDurableFileLockRetirement(),
	};
	let failure: unknown;
	let retired = false;
	try {
		const current = readDurableFileLockOwnerSync(lockPath);
		if (sameDurableFileLockOwner(current, observed)) {
			removeOwnedLock(stale);
			retired = true;
		}
	} catch (error) {
		if (fileErrorCode(error) === "ENOENT") {
			try {
				lstatSync(lockPath);
			} catch (pathError) {
				if (fileErrorCode(pathError) === "ENOENT") retired = true;
				else failure = pathError instanceof Error ? pathError : new Error(String(pathError));
			}
		}
		if (!retired && failure === undefined) failure = error instanceof Error ? error : new Error(String(error));
		if (stale.retirement.retiredPath !== undefined) retainRetryableDurableFileLocks([stale]);
	}
	try {
		releaseDurableFileLockPathsSync([gate], [gate]);
	} catch (error) {
		retainRetryableDurableFileLocks([gate]);
		const cleanupError = error instanceof Error ? error : new Error(String(error));
		failure = failure ? new AggregateError([failure, cleanupError], "Durable lock reclaim failed") : cleanupError;
	}
	if (failure) throw failure;
	return retired;
}

export function inspectDurableFileLockPathSync(lockPath: string, deadline: number): DurableFileLockPathObservation {
	const observed = ownerObservation(lockPath);
	if ("status" in observed) return observed;
	if (observed.owner.host !== hostname()) return { status: "unknown" };
	if (processIsLive(observed.owner.pid)) {
		return { status: "live", pid: observed.owner.pid, host: observed.owner.host };
	}
	return reclaim(lockPath, observed, deadline) ? { status: "absent" } : { status: "unknown" };
}
