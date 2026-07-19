import {
	acquireDurableFileLockSync,
	acquireDurableFileMutationLockSync,
	type DurableFileIdentity,
	type DurableFileLock,
	DurableFileLockBusyError,
	type DurableFileLockObservation,
	inspectDurableFileLockSync,
	resolveDurableFileIdentity,
} from "./durable-file-identity.ts";

const OWNER_SCOPE = "session-owner";

export interface SessionOwnerLease {
	readonly sessionPath: string;
	readonly identity: DurableFileIdentity;
	readonly released: boolean;
	owns(path: string): boolean;
	/** Refresh inode aliases after the owner creates or atomically replaces the session file. */
	refresh(mutationLockHeld?: boolean): void;
	/** Transfer ownership without releasing the current path unless the new path is acquired. */
	transfer(path: string, mutationLockHeld?: boolean): void;
	release(): void;
}

export class SessionOwnerLeaseHeldError extends Error {
	readonly observation: DurableFileLockObservation;

	constructor(observation: DurableFileLockObservation) {
		super("Session has a live or indeterminate owner lease; automatic recovery is refused");
		this.name = "SessionOwnerLeaseHeldError";
		this.observation = observation;
	}
}

export function sessionPathFromPersistenceArtifact(path: string): string {
	return path.endsWith(".runjournal") ? path.slice(0, -".runjournal".length) : path;
}

function identitiesOverlap(left: DurableFileIdentity, right: DurableFileIdentity): boolean {
	return left.lockKeys.some((key) => right.lockKeys.includes(key));
}

export function inspectSessionOwnerLeaseUnlockedSync(path: string): DurableFileLockObservation {
	return inspectDurableFileLockSync(sessionPathFromPersistenceArtifact(path), OWNER_SCOPE);
}

export function inspectSessionOwnerLeaseSync(path: string): DurableFileLockObservation {
	const sessionPath = sessionPathFromPersistenceArtifact(path);
	const mutation = acquireDurableFileMutationLockSync(sessionPath);
	try {
		return inspectSessionOwnerLeaseUnlockedSync(sessionPath);
	} finally {
		mutation.release();
	}
}

export function assertSessionOwnerRecoveryAllowedUnlockedSync(path: string, ownerLease?: SessionOwnerLease): void {
	const sessionPath = sessionPathFromPersistenceArtifact(path);
	if (ownerLease?.owns(sessionPath)) return;
	const observation = inspectSessionOwnerLeaseUnlockedSync(sessionPath);
	if (observation.status !== "absent") throw new SessionOwnerLeaseHeldError(observation);
}

function releaseFailedAcquisition(ownerLock: DurableFileLock, mutation: DurableFileLock, failure: Error): never {
	const failures = [failure];
	try {
		ownerLock.release();
	} catch (error) {
		failures.push(error instanceof Error ? error : new Error(String(error)));
	}
	try {
		mutation.release();
	} catch (error) {
		failures.push(error instanceof Error ? error : new Error(String(error)));
	}
	if (failures.length === 1) throw failure;
	throw new AggregateError(failures, "Session owner lease acquisition cleanup failed");
}

export function acquireSessionOwnerLeaseSync(path: string): SessionOwnerLease {
	let sessionPath = sessionPathFromPersistenceArtifact(path);
	const mutation = acquireDurableFileMutationLockSync(sessionPath);
	let ownerLock: DurableFileLock;
	try {
		ownerLock = acquireDurableFileLockSync(sessionPath, OWNER_SCOPE, { timeoutMs: 0 });
	} catch (error) {
		const failure =
			error instanceof DurableFileLockBusyError
				? new SessionOwnerLeaseHeldError(inspectSessionOwnerLeaseUnlockedSync(sessionPath))
				: error;
		try {
			mutation.release();
		} catch (cleanupError) {
			const cleanupFailure = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
			throw new AggregateError([failure, cleanupFailure], "Session owner lease acquisition cleanup failed");
		}
		throw failure;
	}
	try {
		mutation.release();
	} catch (error) {
		releaseFailedAcquisition(ownerLock, mutation, error instanceof Error ? error : new Error(String(error)));
	}

	let ownedPath = sessionPath;
	let identity = ownerLock.identity;
	let pendingMutation: DurableFileLock | undefined;
	let released = false;

	function drainPendingMutation(): void {
		if (!pendingMutation) return;
		pendingMutation.release();
		pendingMutation = undefined;
	}

	const lease: SessionOwnerLease = {
		get sessionPath() {
			return sessionPath;
		},
		get identity() {
			return identity;
		},
		get released() {
			return released;
		},
		owns(candidate: string): boolean {
			return !released && identitiesOverlap(identity, resolveDurableFileIdentity(candidate));
		},
		refresh(mutationLockHeld = false): void {
			lease.transfer(sessionPath, mutationLockHeld);
		},
		transfer(path, mutationLockHeld = false): void {
			if (released) throw new TypeError("Cannot transfer a released session owner lease");
			const nextPath = sessionPathFromPersistenceArtifact(path);
			drainPendingMutation();
			if (ownedPath === nextPath && sessionPath !== nextPath) {
				sessionPath = nextPath;
				identity = ownerLock.identity;
				return;
			}
			const nextMutation = mutationLockHeld ? undefined : acquireDurableFileMutationLockSync(nextPath);
			let failure: unknown;
			try {
				ownerLock.transfer(nextPath, { timeoutMs: 0 });
				ownedPath = nextPath;
			} catch (error) {
				failure =
					error instanceof DurableFileLockBusyError
						? new SessionOwnerLeaseHeldError(inspectSessionOwnerLeaseUnlockedSync(nextPath))
						: error;
			}
			if (nextMutation) {
				try {
					nextMutation.release();
				} catch (error) {
					pendingMutation = nextMutation;
					const cleanupFailure = error instanceof Error ? error : new Error(String(error));
					failure = failure
						? new AggregateError([failure, cleanupFailure], "Session owner lease transfer failed")
						: cleanupFailure;
				}
			}
			if (failure) throw failure;
			sessionPath = nextPath;
			identity = ownerLock.identity;
		},
		release(): void {
			if (released) return;
			drainPendingMutation();
			const releaseLock = acquireDurableFileMutationLockSync(ownedPath);
			let failure: unknown;
			try {
				ownerLock.release();
			} catch (error) {
				failure = error instanceof Error ? error : new Error(String(error));
			}
			try {
				releaseLock.release();
			} catch (error) {
				pendingMutation = releaseLock;
				const cleanupFailure = error instanceof Error ? error : new Error(String(error));
				failure = failure
					? new AggregateError([failure, cleanupFailure], "Session owner lease release failed")
					: cleanupFailure;
			}
			if (failure) throw failure;
			released = true;
		},
	};
	return lease;
}
