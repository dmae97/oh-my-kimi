import { closeSync, constants as fsConstants, fsyncSync, openSync, unlinkSync, writeSync } from "node:fs";
import type { LockOwner } from "./replay-ledger-lock-owner.ts";
import { errorCode, ReplayLedgerLockError } from "./replay-ledger-lock-owner.ts";

export function writeAll(fd: number, bytes: Buffer): void {
	let offset = 0;
	while (offset < bytes.byteLength) {
		const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
		if (written <= 0) throw new ReplayLedgerLockError("replay lock owner record write did not complete");
		offset += written;
	}
}

export function fsyncDirectory(path: string): void {
	const fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

export function createLockCandidate(path: string, owner: LockOwner): string {
	const candidate = `${path}.${owner.ownerId}.candidate`;
	const fd = openSync(candidate, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
	try {
		writeAll(fd, Buffer.from(`${JSON.stringify(owner)}\n`, "utf8"));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	return candidate;
}

export function removeLockCandidate(path: string): void {
	try {
		unlinkSync(path);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
}
