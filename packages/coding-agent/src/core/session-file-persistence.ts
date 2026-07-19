import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { atomicRewriteFileSync } from "./atomic-session-file.ts";
import { createSessionRevisionToken, type SessionRevisionToken } from "./compaction/transaction.ts";
import {
	type DurableFileSnapshot,
	readDurableFileSnapshot,
	sameDurableFileGeneration,
	writeExclusiveFileDurablySync,
} from "./durable-file-io.ts";
import { readSessionFileDurableMetadata, sessionFileHasCompleteTail } from "./session-file-head.ts";

export interface SessionQuarantineReport {
	readonly artifact: "session";
	readonly path: string;
	readonly quarantinePath: string;
	readonly byteCount: number;
	readonly completePrefixByteCount: number;
}

export class SessionManagerStaleWriteError extends Error {
	constructor(message = "Session file changed since this manager accepted its durable head") {
		super(message);
		this.name = "SessionManagerStaleWriteError";
	}
}

export type SessionDurableHead = {
	readonly revision: SessionRevisionToken;
	readonly generation: DurableFileSnapshot["generation"];
};

type FileEntryIdentity = {
	readonly type: string;
	readonly id?: unknown;
};

type SessionQuarantineResult = {
	readonly report: SessionQuarantineReport | null;
	readonly snapshot: DurableFileSnapshot | null;
};

export function quarantineSessionTrailingFragment(filePath: string): SessionQuarantineResult {
	if (sessionFileHasCompleteTail(filePath)) return { report: null, snapshot: null };
	if (statSync(filePath).nlink > 1)
		throw new Error("Session quarantine refused for a target with more than one hard link");
	const snapshot = readDurableFileSnapshot(filePath);
	if (!snapshot) return { report: null, snapshot: null };
	let lastNewline = -1;
	for (let index = snapshot.bytes.byteLength - 1; index >= 0; index -= 1) {
		if (snapshot.bytes[index] === 0x0a) {
			lastNewline = index;
			break;
		}
	}
	const completePrefixByteCount = lastNewline + 1;
	const fragment = snapshot.bytes.subarray(completePrefixByteCount);
	const quarantinePath = `${filePath}.quarantine-${randomUUID()}`;
	writeExclusiveFileDurablySync(quarantinePath, fragment);
	const current = readDurableFileSnapshot(filePath);
	if (
		!current ||
		!sameDurableFileGeneration(snapshot.generation, current.generation) ||
		Buffer.compare(snapshot.bytes, current.bytes) !== 0
	) {
		throw new SessionManagerStaleWriteError();
	}
	atomicRewriteFileSync(filePath, snapshot.bytes.subarray(0, completePrefixByteCount));
	return {
		report: Object.freeze({
			artifact: "session",
			path: filePath,
			quarantinePath,
			byteCount: fragment.byteLength,
			completePrefixByteCount,
		}),
		snapshot: readDurableFileSnapshot(filePath),
	};
}

export function sessionDurableHeadFromSnapshot(
	snapshot: DurableFileSnapshot,
	activeLeafId: string | null,
	entries: readonly FileEntryIdentity[],
): SessionDurableHead | null {
	const header = entries[0];
	if (!header || header.type !== "session" || typeof header.id !== "string") return null;
	let recordCount = 0;
	for (const byte of snapshot.bytes) {
		if (byte === 0x0a) recordCount += 1;
	}
	const lastEntry = entries.at(-1);
	const lastEntryId =
		lastEntry && lastEntry.type !== "session" && typeof lastEntry.id === "string" ? lastEntry.id : null;
	return Object.freeze({
		revision: createSessionRevisionToken({
			sessionId: header.id,
			completeBytes: snapshot.bytes.byteLength,
			recordCount,
			leafId: activeLeafId,
			lastEntryId,
			completePrefixSha256: createHash("sha256").update(snapshot.bytes).digest("hex"),
			fileIdentity: { dev: snapshot.generation.dev, ino: snapshot.generation.ino },
		}),
		generation: snapshot.generation,
	});
}

export function sessionDurableHeadFromFile(
	filePath: string,
	activeLeafId: string | null,
	entries: readonly FileEntryIdentity[],
): SessionDurableHead | null {
	if (!existsSync(filePath)) return null;
	const header = entries[0];
	if (!header || header.type !== "session" || typeof header.id !== "string") return null;
	const metadata = readSessionFileDurableMetadata(filePath);
	const lastEntry = entries.at(-1);
	const lastEntryId =
		lastEntry && lastEntry.type !== "session" && typeof lastEntry.id === "string" ? lastEntry.id : null;
	return Object.freeze({
		revision: createSessionRevisionToken({
			sessionId: header.id,
			completeBytes: metadata.completeBytes,
			recordCount: metadata.recordCount,
			leafId: activeLeafId,
			lastEntryId,
			completePrefixSha256: metadata.completePrefixSha256,
			fileIdentity: { dev: metadata.generation.dev, ino: metadata.generation.ino },
		}),
		generation: metadata.generation,
	});
}

export function sameDurableSessionHead(left: SessionDurableHead | null, right: SessionDurableHead | null): boolean {
	if (left === null || right === null) return left === right;
	return (
		left.revision.sessionId === right.revision.sessionId &&
		left.revision.completeBytes === right.revision.completeBytes &&
		left.revision.recordCount === right.revision.recordCount &&
		left.revision.lastEntryId === right.revision.lastEntryId &&
		left.revision.completePrefixSha256 === right.revision.completePrefixSha256 &&
		sameDurableFileGeneration(left.generation, right.generation)
	);
}
