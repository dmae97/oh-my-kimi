import { linkSync, readdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createLockCandidate, fsyncDirectory, removeLockCandidate } from "./replay-ledger-io.ts";
import {
	createLockOwner,
	errorCode,
	inspectProcessIdentity,
	type LockOwner,
	type LockOwnerSnapshot,
	lockOwnerIsDead,
	lockOwnersEqual,
	ReplayLedgerLockError,
	type ReplayLedgerProcessIdentityReader,
	readLockOwner,
} from "./replay-ledger-lock-owner.ts";

const GATE_ATTEMPTS = 200;
const GATE_WAIT_MS = 5;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

export interface ReplayLedgerMutationGateOptions {
	readonly processIdentity?: ReplayLedgerProcessIdentityReader;
	readonly beforeReclaimRemove?: () => void;
	readonly beforeRelease?: () => void;
}

export class ReplayLedgerMutationGate {
	private readonly path: string;
	private readonly processIdentity: ReplayLedgerProcessIdentityReader;
	private readonly beforeReclaimRemove: (() => void) | undefined;
	private readonly beforeRelease: (() => void) | undefined;

	constructor(path: string, options: ReplayLedgerMutationGateOptions = {}) {
		this.path = path;
		this.processIdentity = options.processIdentity ?? inspectProcessIdentity;
		this.beforeReclaimRemove = options.beforeReclaimRemove;
		this.beforeRelease = options.beforeRelease;
	}

	private intentPaths(): string[] {
		const directory = dirname(this.path);
		const prefix = `${basename(this.path)}.intent.`;
		return readdirSync(directory)
			.filter((name) => name.startsWith(prefix))
			.map((name) => join(directory, name));
	}

	private hasLiveIntent(): boolean {
		const prefix = `${this.path}.intent.`;
		for (const path of this.intentPaths()) {
			let observed: LockOwnerSnapshot;
			try {
				observed = readLockOwner(path);
			} catch (error) {
				if (errorCode(error) === "ENOENT") continue;
				throw error;
			}
			if (path.slice(prefix.length) !== observed.owner.ownerId) {
				throw new ReplayLedgerLockError("replay lock reclaim intent owner is invalid");
			}
			if (!lockOwnerIsDead(observed.owner, this.processIdentity)) return true;
			let current: LockOwnerSnapshot;
			try {
				current = readLockOwner(path);
			} catch (error) {
				if (errorCode(error) === "ENOENT") continue;
				throw error;
			}
			if (!lockOwnersEqual(current, observed) || !lockOwnerIsDead(current.owner, this.processIdentity)) return true;
			removeLockCandidate(path);
			fsyncDirectory(dirname(this.path));
		}
		return false;
	}

	private withIntent<T>(candidate: string, owner: LockOwner, operation: () => T): T {
		const intent = `${this.path}.intent.${owner.ownerId}`;
		linkSync(candidate, intent);
		fsyncDirectory(dirname(this.path));
		try {
			return operation();
		} finally {
			removeLockCandidate(intent);
			fsyncDirectory(dirname(this.path));
		}
	}

	private abandon(acquired: LockOwnerSnapshot): void {
		try {
			const current = readLockOwner(this.path);
			if (lockOwnersEqual(current, acquired)) unlinkSync(this.path);
		} catch {
			// Preserve the original acquisition error; a mismatched owner must remain.
		}
	}

	private tryAcquire(candidate: string, expected: LockOwnerSnapshot): LockOwnerSnapshot | undefined {
		if (this.hasLiveIntent()) return undefined;
		let linked = false;
		try {
			linkSync(candidate, this.path);
			linked = true;
			fsyncDirectory(dirname(this.path));
			const acquired = readLockOwner(this.path);
			if (!lockOwnersEqual(acquired, expected)) {
				throw new ReplayLedgerLockError("replay lock reclaim ownership changed during acquisition");
			}
			if (!this.hasLiveIntent()) return acquired;
			this.releaseOwned(acquired);
			return undefined;
		} catch (error) {
			if (errorCode(error) === "EEXIST") return undefined;
			if (linked) this.abandon(expected);
			throw error;
		}
	}

	private reclaim(candidate: string, owner: LockOwner, observed: LockOwnerSnapshot): void {
		this.withIntent(candidate, owner, () => {
			let current: LockOwnerSnapshot;
			try {
				current = readLockOwner(this.path);
			} catch (error) {
				if (errorCode(error) === "ENOENT") return;
				throw error;
			}
			if (!lockOwnersEqual(current, observed) || !lockOwnerIsDead(current.owner, this.processIdentity)) return;
			this.beforeReclaimRemove?.();
			let finalOwner: LockOwnerSnapshot;
			try {
				finalOwner = readLockOwner(this.path);
			} catch (error) {
				if (errorCode(error) === "ENOENT") return;
				throw error;
			}
			if (!lockOwnersEqual(finalOwner, observed) || !lockOwnerIsDead(finalOwner.owner, this.processIdentity)) return;
			removeLockCandidate(this.path);
			fsyncDirectory(dirname(this.path));
		});
	}

	private acquire(owner: LockOwner): LockOwnerSnapshot {
		const candidate = createLockCandidate(this.path, owner);
		try {
			const expected = readLockOwner(candidate);
			for (let attempt = 0; attempt < GATE_ATTEMPTS; attempt++) {
				const acquired = this.tryAcquire(candidate, expected);
				if (acquired !== undefined) return acquired;
				let current: LockOwnerSnapshot;
				try {
					current = readLockOwner(this.path);
				} catch (error) {
					if (errorCode(error) === "ENOENT") continue;
					throw error;
				}
				if (lockOwnerIsDead(current.owner, this.processIdentity)) {
					this.reclaim(candidate, owner, current);
					continue;
				}
				Atomics.wait(sleeper, 0, 0, GATE_WAIT_MS);
			}
			throw new ReplayLedgerLockError("replay lock reclaim serialization is unavailable");
		} finally {
			removeLockCandidate(candidate);
		}
	}

	private releaseOwned(acquired: LockOwnerSnapshot): void {
		let current: LockOwnerSnapshot;
		try {
			current = readLockOwner(this.path);
		} catch (error) {
			if (errorCode(error) === "ENOENT") {
				throw new ReplayLedgerLockError("replay lock reclaim ownership changed before release");
			}
			throw error;
		}
		if (!lockOwnersEqual(current, acquired)) {
			throw new ReplayLedgerLockError("replay lock reclaim ownership changed before release");
		}
		unlinkSync(this.path);
		fsyncDirectory(dirname(this.path));
	}

	private release(acquired: LockOwnerSnapshot): void {
		this.beforeRelease?.();
		this.releaseOwned(acquired);
	}

	run<T>(operation: () => T): T {
		const acquired = this.acquire(createLockOwner(this.processIdentity));
		let result: T;
		try {
			result = operation();
		} catch (error) {
			this.release(acquired);
			throw error;
		}
		if (
			result !== null &&
			(typeof result === "object" || typeof result === "function") &&
			"then" in result &&
			typeof result.then === "function"
		) {
			return Promise.resolve(result).finally(() => this.release(acquired)) as T;
		}
		this.release(acquired);
		return result;
	}
}
