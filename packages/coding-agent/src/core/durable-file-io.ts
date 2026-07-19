import { createHash } from "node:crypto";
import {
	type BigIntStats,
	closeSync,
	existsSync,
	fstatSync,
	fsyncSync,
	openSync,
	readFileSync,
	realpathSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { ensureDurableParentDirectorySync, fsyncDirectorySync } from "./durable-file-directory.ts";
import { enforcePrivateFileDescriptorModeSync } from "./durable-file-mode.ts";

export {
	ensureDurableDirectorySync,
	ensureDurableParentDirectorySync,
	fsyncDirectorySync,
} from "./durable-file-directory.ts";

export interface DurableFileGeneration {
	readonly dev: string;
	readonly ino: string;
	readonly birthtimeNs: string;
	readonly ctimeNs: string;
}

export interface DurableFileIdentity {
	readonly canonicalPath: string;
	readonly generation: DurableFileGeneration | null;
	readonly pathKey: string;
	readonly aliasKey: string;
	readonly lockKeys: readonly string[];
}

export interface DurableFileSnapshot {
	readonly bytes: Uint8Array;
	readonly generation: DurableFileGeneration;
}

export class DurableFileReadRaceError extends Error {
	constructor() {
		super("Durable file identity or bytes changed while being read");
		this.name = "DurableFileReadRaceError";
	}
}

function generation(stat: BigIntStats): DurableFileGeneration {
	return Object.freeze({
		dev: stat.dev.toString(),
		ino: stat.ino.toString(),
		birthtimeNs: stat.birthtimeNs.toString(),
		ctimeNs: stat.ctimeNs.toString(),
	});
}

export function normalizeDurablePathIdentity(path: string, platform: NodeJS.Platform): string {
	if (platform === "darwin") return path.normalize("NFD").toLowerCase();
	if (platform === "win32") return path.normalize("NFC").toLowerCase();
	return path;
}

function canonicalizePath(path: string): string {
	const requested = resolve(path);
	let cursor = requested;
	const tail: string[] = [];
	while (true) {
		try {
			return resolve(realpathSync.native(cursor), ...tail);
		} catch (error) {
			const code = error instanceof Error && "code" in error ? Reflect.get(error, "code") : undefined;
			if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
			const parent = dirname(cursor);
			if (parent === cursor) return requested;
			tail.unshift(basename(cursor));
			cursor = parent;
		}
	}
}

export function resolveDurableFileIdentity(path: string): DurableFileIdentity {
	const canonicalPath = canonicalizePath(path);
	let fileGeneration: DurableFileGeneration | null = null;
	try {
		fileGeneration = generation(statSync(path, { bigint: true }));
	} catch (error) {
		const code = error instanceof Error && "code" in error ? Reflect.get(error, "code") : undefined;
		if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
	}
	const lockPathIdentity = normalizeDurablePathIdentity(canonicalPath, process.platform);
	const pathKey = createHash("sha256").update(`path\0${lockPathIdentity}`, "utf8").digest("hex");
	const aliasKey = fileGeneration
		? createHash("sha256")
				.update(`inode\0${fileGeneration.dev}\0${fileGeneration.ino}\0${fileGeneration.birthtimeNs}`, "utf8")
				.digest("hex")
		: pathKey;
	return Object.freeze({
		canonicalPath,
		generation: fileGeneration,
		pathKey,
		aliasKey,
		lockKeys: Object.freeze([...new Set([pathKey, aliasKey])].sort()),
	});
}

export function sameDurableFileGeneration(
	left: DurableFileGeneration | null,
	right: DurableFileGeneration | null,
): boolean {
	if (left === null || right === null) return left === right;
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.birthtimeNs === right.birthtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

export function readDurableFileSnapshot(path: string): DurableFileSnapshot | null {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch (error) {
		if (error instanceof Error && "code" in error && Reflect.get(error, "code") === "ENOENT") return null;
		throw error;
	}
	try {
		enforcePrivateFileDescriptorModeSync(fd, path);
		const before = fstatSync(fd, { bigint: true });
		const bytes: Uint8Array = readFileSync(fd);
		const after = fstatSync(fd, { bigint: true });
		let current: BigIntStats;
		try {
			current = statSync(path, { bigint: true });
		} catch {
			throw new DurableFileReadRaceError();
		}
		if (
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			before.size !== after.size ||
			before.mtimeNs !== after.mtimeNs ||
			before.ctimeNs !== after.ctimeNs ||
			before.dev !== current.dev ||
			before.ino !== current.ino ||
			before.size !== current.size ||
			before.mtimeNs !== current.mtimeNs ||
			before.ctimeNs !== current.ctimeNs ||
			before.birthtimeNs !== current.birthtimeNs
		) {
			throw new DurableFileReadRaceError();
		}
		return Object.freeze({ bytes, generation: generation(before) });
	} finally {
		closeSync(fd);
	}
}

function writeAll(fd: number, bytes: Uint8Array): void {
	let offset = 0;
	while (offset < bytes.byteLength) {
		offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
	}
}

/** Append without truncation. On an indeterminate fsync failure, visible bytes are retained. */
export function appendFileDurablySync(path: string, bytes: Uint8Array): void {
	ensureDurableParentDirectorySync(path);
	const existed = existsSync(path);
	const fd = openSync(path, "a", 0o600);
	try {
		enforcePrivateFileDescriptorModeSync(fd, path);
		writeAll(fd, bytes);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	if (!existed) fsyncDirectorySync(dirname(path));
}

export function writeExclusiveFileDurablySync(path: string, bytes: Uint8Array): void {
	ensureDurableParentDirectorySync(path);
	const fd = openSync(path, "wx", 0o600);
	try {
		enforcePrivateFileDescriptorModeSync(fd, path);
		writeAll(fd, bytes);
		fsyncSync(fd);
	} catch (error) {
		closeSync(fd);
		try {
			unlinkSync(path);
			fsyncDirectorySync(dirname(path));
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "Exclusive durable file cleanup failed");
		}
		throw error;
	}
	closeSync(fd);
	try {
		fsyncDirectorySync(dirname(path));
	} catch (error) {
		try {
			unlinkSync(path);
			fsyncDirectorySync(dirname(path));
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "Exclusive durable file rollback failed");
		}
		throw error;
	}
}
