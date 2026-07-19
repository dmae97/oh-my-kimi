import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { enforcePrivateFileDescriptorModeSync } from "./durable-file-mode.ts";

const MAX_OWNER_BYTES = 1_024;
const MAX_OWNER_TEXT = 512;

export interface DurableFileLockOwner {
	readonly pid: number;
	readonly host: string;
	readonly token: string;
}

export interface DurableFileLockOwnerSnapshot {
	readonly owner: DurableFileLockOwner;
	readonly dev: string;
	readonly ino: string;
}

export class DurableFileLockOwnerError extends Error {
	override readonly name = "DurableFileLockOwnerError";
}

export function fileErrorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error ? String(Reflect.get(error, "code")) : undefined;
}

function parseOwner(input: string): DurableFileLockOwner {
	let value: unknown;
	try {
		value = JSON.parse(input);
	} catch (error) {
		throw new DurableFileLockOwnerError("Durable file lock owner record is malformed", { cause: error });
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new DurableFileLockOwnerError("Durable file lock owner record is invalid");
	}
	const pid = Reflect.get(value, "pid");
	const host = Reflect.get(value, "host");
	const token = Reflect.get(value, "token");
	if (
		!Number.isSafeInteger(pid) ||
		Number(pid) <= 0 ||
		typeof host !== "string" ||
		host.length === 0 ||
		host.length > MAX_OWNER_TEXT ||
		typeof token !== "string" ||
		token.length === 0 ||
		token.length > MAX_OWNER_TEXT
	) {
		throw new DurableFileLockOwnerError("Durable file lock owner record is invalid");
	}
	return Object.freeze({ pid: Number(pid), host, token });
}

/** Read one owner while binding its token to both owner-file and lock-directory inodes. */
export function readDurableFileLockOwnerSync(lockPath: string): DurableFileLockOwnerSnapshot {
	const beforeDirectory = lstatSync(lockPath, { bigint: true });
	if (!beforeDirectory.isDirectory() || beforeDirectory.isSymbolicLink()) {
		throw new DurableFileLockOwnerError("Durable file lock is not a real directory");
	}
	const path = `${lockPath}/owner.json`;
	const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		enforcePrivateFileDescriptorModeSync(fd, path);
		const beforeOwner = fstatSync(fd, { bigint: true });
		if (!beforeOwner.isFile() || beforeOwner.size <= 0 || beforeOwner.size > MAX_OWNER_BYTES) {
			throw new DurableFileLockOwnerError("Durable file lock owner record is outside its size bound");
		}
		const bytes: Buffer = readFileSync(fd);
		const afterOwner = fstatSync(fd, { bigint: true });
		const currentOwner = lstatSync(path, { bigint: true });
		const afterDirectory = lstatSync(lockPath, { bigint: true });
		if (
			beforeOwner.dev !== afterOwner.dev ||
			beforeOwner.ino !== afterOwner.ino ||
			beforeOwner.size !== afterOwner.size ||
			afterOwner.size !== BigInt(bytes.byteLength) ||
			afterOwner.dev !== currentOwner.dev ||
			afterOwner.ino !== currentOwner.ino ||
			beforeDirectory.dev !== afterDirectory.dev ||
			beforeDirectory.ino !== afterDirectory.ino
		) {
			throw new DurableFileLockOwnerError("Durable file lock owner changed during inspection");
		}
		return Object.freeze({
			owner: parseOwner(bytes.toString("utf8")),
			dev: afterDirectory.dev.toString(),
			ino: afterDirectory.ino.toString(),
		});
	} finally {
		closeSync(fd);
	}
}

export function sameDurableFileLockOwner(
	left: DurableFileLockOwnerSnapshot,
	right: DurableFileLockOwnerSnapshot,
): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.owner.token === right.owner.token;
}
