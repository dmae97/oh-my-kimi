import { randomUUID } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync } from "node:fs";

const MAX_LOCK_RECORD_BYTES = 512;
const MAX_CLOCK_SKEW_MS = 60_000;
const OWNER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROCESS_START_TOKEN = /^[A-Za-z0-9._:-]{1,128}$/;

export type LockOwner = {
	readonly schemaVersion: 2;
	readonly pid: number;
	readonly processStartToken: string | null;
	readonly acquiredAtMs: number;
	readonly ownerId: string;
};

export type LockOwnerSnapshot = {
	readonly owner: LockOwner;
	readonly dev: string;
	readonly ino: string;
};

export type ReplayLedgerProcessIdentity =
	| { readonly state: "present"; readonly startToken: string }
	| { readonly state: "absent" }
	| { readonly state: "unavailable" };

export type ReplayLedgerProcessIdentityReader = (pid: number) => ReplayLedgerProcessIdentity;

export class ReplayLedgerLockError extends Error {
	readonly name = "ReplayLedgerLockError";
}

export function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

function ownerInteger(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw new ReplayLedgerLockError("replay lock owner record is invalid");
	}
	return value;
}

function parseOwner(bytes: Buffer): LockOwner {
	if (bytes.byteLength === 0 || bytes.byteLength > MAX_LOCK_RECORD_BYTES) {
		throw new ReplayLedgerLockError("replay lock owner record is outside its size bound");
	}
	let value: unknown;
	try {
		value = JSON.parse(bytes.toString("utf8"));
	} catch (error) {
		throw new ReplayLedgerLockError("replay lock owner record is malformed", { cause: error });
	}
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		Object.keys(value).sort().join(",") !== "acquiredAtMs,ownerId,pid,processStartToken,schemaVersion" ||
		!("schemaVersion" in value) ||
		value.schemaVersion !== 2 ||
		!("pid" in value) ||
		!("processStartToken" in value) ||
		!("acquiredAtMs" in value) ||
		!("ownerId" in value) ||
		typeof value.ownerId !== "string" ||
		!OWNER_ID.test(value.ownerId) ||
		(value.processStartToken !== null &&
			(typeof value.processStartToken !== "string" || !PROCESS_START_TOKEN.test(value.processStartToken)))
	) {
		throw new ReplayLedgerLockError("replay lock owner record is invalid");
	}
	const pid = ownerInteger(value.pid);
	const acquiredAtMs = ownerInteger(value.acquiredAtMs);
	if (acquiredAtMs > Date.now() + MAX_CLOCK_SKEW_MS) {
		throw new ReplayLedgerLockError("replay lock owner record is invalid");
	}
	return { schemaVersion: 2, pid, processStartToken: value.processStartToken, acquiredAtMs, ownerId: value.ownerId };
}

export function readLockOwner(path: string): LockOwnerSnapshot {
	const fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
	try {
		const before = fstatSync(fd, { bigint: true });
		if (!before.isFile() || before.size <= 0n || before.size > BigInt(MAX_LOCK_RECORD_BYTES)) {
			throw new ReplayLedgerLockError("replay lock owner record is outside its size bound");
		}
		const bytes = readFileSync(fd);
		const after = fstatSync(fd, { bigint: true });
		if (
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			before.size !== after.size ||
			after.size !== BigInt(bytes.length)
		) {
			throw new ReplayLedgerLockError("replay lock owner record changed during inspection");
		}
		return { owner: parseOwner(bytes), dev: String(after.dev), ino: String(after.ino) };
	} finally {
		closeSync(fd);
	}
}

export function lockOwnersEqual(left: LockOwnerSnapshot, right: LockOwnerSnapshot): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.owner.ownerId === right.owner.ownerId &&
		left.owner.pid === right.owner.pid &&
		left.owner.processStartToken === right.owner.processStartToken &&
		left.owner.acquiredAtMs === right.owner.acquiredAtMs
	);
}

export function createLockOwner(processIdentity: ReplayLedgerProcessIdentityReader): LockOwner {
	const identity = processIdentity(process.pid);
	if (identity.state !== "present" || !PROCESS_START_TOKEN.test(identity.startToken)) {
		throw new ReplayLedgerLockError("replay lock acquisition requires process-start identity");
	}
	return {
		schemaVersion: 2,
		pid: process.pid,
		processStartToken: identity.startToken,
		acquiredAtMs: Date.now(),
		ownerId: randomUUID(),
	};
}

export function lockOwnerIsDead(owner: LockOwner, processIdentity: ReplayLedgerProcessIdentityReader): boolean {
	const current = processIdentity(owner.pid);
	if (current.state === "unavailable") {
		throw new ReplayLedgerLockError("replay lock owner liveness could not be established");
	}
	if (current.state === "absent") return true;
	if (owner.processStartToken === null) {
		throw new ReplayLedgerLockError("replay lock recovery requires process-start identity");
	}
	return current.startToken !== owner.processStartToken;
}

export function parseLinuxProcessIdentityStat(stat: string): ReplayLedgerProcessIdentity {
	if (stat.length > 4_096) return { state: "unavailable" };
	const close = stat.lastIndexOf(")");
	if (close < 0) return { state: "unavailable" };
	const fields = stat
		.slice(close + 2)
		.trim()
		.split(/\s+/);
	if (["Z", "X", "x"].includes(fields[0] ?? "")) return { state: "absent" };
	const startTime = fields[19];
	return startTime !== undefined && /^\d+$/.test(startTime)
		? { state: "present", startToken: `linux:${startTime}` }
		: { state: "unavailable" };
}

export function inspectProcessIdentity(pid: number): ReplayLedgerProcessIdentity {
	if (process.platform !== "linux") return { state: "unavailable" };
	try {
		return parseLinuxProcessIdentityStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		return errorCode(error) === "ENOENT" ? { state: "absent" } : { state: "unavailable" };
	}
}
