import { createHash } from "node:crypto";
import { type BigIntStats, closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import type { DurableFileGeneration } from "./durable-file-identity.ts";
import { DurableFileReadRaceError } from "./durable-file-io.ts";

const READ_BUFFER_SIZE = 1024 * 1024;

export interface SessionFileDurableMetadata {
	readonly completeBytes: number;
	readonly recordCount: number;
	readonly completePrefixSha256: string;
	readonly generation: DurableFileGeneration;
}

function assertStable(path: string, before: BigIntStats, after: BigIntStats): void {
	const current = statSync(path, { bigint: true });
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
}

export function sessionFileHasCompleteTail(path: string): boolean {
	const fd = openSync(path, "r");
	try {
		const before = fstatSync(fd, { bigint: true });
		if (before.size === 0n) return true;
		if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Session file is too large");
		const tail = Buffer.allocUnsafe(1);
		readSync(fd, tail, 0, 1, Number(before.size - 1n));
		const after = fstatSync(fd, { bigint: true });
		assertStable(path, before, after);
		return tail[0] === 0x0a;
	} finally {
		closeSync(fd);
	}
}

export function readSessionFileDurableMetadata(path: string): SessionFileDurableMetadata {
	const fd = openSync(path, "r");
	try {
		const before = fstatSync(fd, { bigint: true });
		if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Session file is too large");
		const digest = createHash("sha256");
		const buffer = Buffer.allocUnsafe(READ_BUFFER_SIZE);
		let completeBytes = 0;
		let recordCount = 0;
		while (true) {
			const bytesRead = readSync(fd, buffer, 0, buffer.byteLength, null);
			if (bytesRead === 0) break;
			digest.update(buffer.subarray(0, bytesRead));
			completeBytes += bytesRead;
			for (let index = 0; index < bytesRead; index += 1) {
				if (buffer[index] === 0x0a) recordCount += 1;
			}
		}
		const after = fstatSync(fd, { bigint: true });
		assertStable(path, before, after);
		return Object.freeze({
			completeBytes,
			recordCount,
			completePrefixSha256: digest.digest("hex"),
			generation: Object.freeze({
				dev: before.dev.toString(),
				ino: before.ino.toString(),
				birthtimeNs: before.birthtimeNs.toString(),
				ctimeNs: before.ctimeNs.toString(),
			}),
		});
	} finally {
		closeSync(fd);
	}
}
