import { linkSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
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
import { ReplayLedgerMutationGate } from "./replay-ledger-mutation-gate.ts";

export { fsyncDirectory, writeAll } from "./replay-ledger-io.ts";
export type { ReplayLedgerProcessIdentity } from "./replay-ledger-lock-owner.ts";
export { ReplayLedgerLockError } from "./replay-ledger-lock-owner.ts";

const LOCK_ATTEMPTS = 200;
const LOCK_WAIT_MS = 5;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

export interface ReplayLedgerLockOptions {
	readonly processIdentity?: ReplayLedgerProcessIdentityReader;
	readonly beforeReclaimRemove?: () => void;
	readonly beforeMutationGateReclaimRemove?: () => void;
	readonly beforeMutationGateRelease?: () => void;
}

export class ReplayLedgerLock {
	private readonly path: string;
	private readonly gate: ReplayLedgerMutationGate;
	private readonly processIdentity: ReplayLedgerProcessIdentityReader;
	private readonly beforeReclaimRemove: (() => void) | undefined;

	constructor(path: string, options: ReplayLedgerLockOptions = {}) {
		this.path = path;
		this.processIdentity = options.processIdentity ?? inspectProcessIdentity;
		this.beforeReclaimRemove = options.beforeReclaimRemove;
		this.gate = new ReplayLedgerMutationGate(`${path}.reclaim`, {
			processIdentity: this.processIdentity,
			beforeReclaimRemove: options.beforeMutationGateReclaimRemove,
			beforeRelease: options.beforeMutationGateRelease,
		});
	}

	private withMutationGate<T>(operation: () => T): T {
		return this.gate.run(operation);
	}

	private tryAcquire(candidate: string, expected: LockOwnerSnapshot): LockOwnerSnapshot | undefined {
		return this.withMutationGate(() => {
			try {
				linkSync(candidate, this.path);
				fsyncDirectory(dirname(this.path));
				const acquired = readLockOwner(this.path);
				if (!lockOwnersEqual(acquired, expected)) {
					throw new ReplayLedgerLockError("replay lock ownership changed during acquisition");
				}
				return acquired;
			} catch (error) {
				if (errorCode(error) === "EEXIST") return undefined;
				throw error;
			}
		});
	}

	private reclaim(observed: LockOwnerSnapshot): void {
		this.withMutationGate(() => {
			let current: LockOwnerSnapshot;
			try {
				current = readLockOwner(this.path);
			} catch (error) {
				if (errorCode(error) === "ENOENT") return;
				throw error;
			}
			if (!lockOwnersEqual(current, observed)) return;
			this.beforeReclaimRemove?.();
			let finalOwner: LockOwnerSnapshot;
			try {
				finalOwner = readLockOwner(this.path);
			} catch (error) {
				if (errorCode(error) === "ENOENT") return;
				throw error;
			}
			if (!lockOwnersEqual(finalOwner, observed)) return;
			unlinkSync(this.path);
			fsyncDirectory(dirname(this.path));
		});
	}

	private acquire(owner: LockOwner): LockOwnerSnapshot {
		const candidate = createLockCandidate(this.path, owner);
		try {
			const expected = readLockOwner(candidate);
			for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
				let current: LockOwnerSnapshot;
				try {
					current = readLockOwner(this.path);
				} catch (error) {
					if (errorCode(error) !== "ENOENT") throw error;
					const acquired = this.tryAcquire(candidate, expected);
					if (acquired !== undefined) return acquired;
					continue;
				}
				if (lockOwnerIsDead(current.owner, this.processIdentity)) {
					this.reclaim(current);
					continue;
				}
				Atomics.wait(sleeper, 0, 0, LOCK_WAIT_MS);
			}
			throw new ReplayLedgerLockError("replay ledger interprocess lock is unavailable");
		} finally {
			removeLockCandidate(candidate);
		}
	}

	private release(acquired: LockOwnerSnapshot): void {
		this.withMutationGate(() => {
			const current = readLockOwner(this.path);
			if (!lockOwnersEqual(current, acquired)) {
				throw new ReplayLedgerLockError("replay lock ownership changed before release");
			}
			unlinkSync(this.path);
			fsyncDirectory(dirname(this.path));
		});
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
