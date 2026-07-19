import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	type CompactionEnvelope,
	createSessionRevisionToken,
	validateCompactionEnvelope,
} from "./compaction/transaction.ts";
import type { CompactionEntry, FileEntry, SessionEntry, SessionHeader } from "./session-manager.ts";

function envelopeFromEntry(entry: CompactionEntry): CompactionEnvelope | null {
	if (typeof entry.details !== "object" || entry.details === null || Array.isArray(entry.details)) return null;
	if (!Object.hasOwn(entry.details, "compactionEnvelope")) return null;
	return validateCompactionEnvelope(Reflect.get(entry.details, "compactionEnvelope"));
}

function branchFromPrefix(prefix: readonly FileEntry[], leafId: string): SessionEntry[] {
	const byId = new Map(
		prefix.filter((entry): entry is SessionEntry => entry.type !== "session").map((entry) => [entry.id, entry]),
	);
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	let current = byId.get(leafId);
	while (current) {
		if (seen.has(current.id)) throw new Error(`Compaction source at ${leafId} contains a cycle`);
		seen.add(current.id);
		branch.unshift(current);
		current = current.parentId === null ? undefined : byId.get(current.parentId);
	}
	if (branch.at(-1)?.id !== leafId)
		throw new Error(`Compaction source leaf ${leafId} is outside the persisted prefix`);
	return branch;
}

function sourceSha256(entries: readonly SessionEntry[]): string {
	return createHash("sha256")
		.update(entries.map((entry) => JSON.stringify(entry)).join("\n"), "utf8")
		.digest("hex");
}

function serializedPrefix(prefix: readonly FileEntry[]): string {
	return `${prefix.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function prefixRevision(header: SessionHeader, prefix: readonly FileEntry[], leafId: string) {
	const bytes = serializedPrefix(prefix);
	const last = prefix.at(-1);
	return createSessionRevisionToken({
		sessionId: header.id,
		completeBytes: Buffer.byteLength(bytes),
		recordCount: prefix.length,
		leafId,
		lastEntryId: last?.type === "session" ? null : (last?.id ?? null),
		completePrefixSha256: createHash("sha256").update(bytes, "utf8").digest("hex"),
	});
}

function sameOrderedIds(left: readonly string[], right: readonly SessionEntry[]): boolean {
	return left.length === right.length && left.every((id, index) => id === right[index]?.id);
}

function assertSourceMatches(
	entry: CompactionEntry,
	envelope: CompactionEnvelope,
	source: readonly SessionEntry[],
): void {
	if (
		envelope.source.sessionId === "" ||
		!sameOrderedIds(envelope.source.entryIds, source) ||
		envelope.source.sourceSha256 !== sourceSha256(source) ||
		envelope.source.activeLeafId !== entry.parentId
	) {
		throw new Error(`Invalid compaction envelope source in entry ${entry.id}. Run the session doctor.`);
	}
}

function persistedRecordStarts(bytes: Uint8Array): number[] {
	const starts = [0];
	for (let index = 0; index < bytes.byteLength; index += 1) {
		if (bytes[index] === 0x0a && index + 1 < bytes.byteLength) starts.push(index + 1);
	}
	return starts;
}

/** Recompute persisted compaction provenance instead of trusting its envelope. */
export function validatePersistedCompactionEnvelopes(
	path: string,
	entries: readonly FileEntry[],
	sessionId: string,
): void {
	const header = entries[0];
	if (!header || header.type !== "session" || header.id !== sessionId) throw new Error("Invalid session header");
	const bytes = readFileSync(path);
	const starts = persistedRecordStarts(bytes);
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (!entry || entry.type !== "compaction") continue;
		const envelope = envelopeFromEntry(entry);
		if (!envelope) continue;
		if (entry.parentId === null) throw new Error(`Compaction entry ${entry.id} has no source leaf`);
		const prefix = entries.slice(0, index);
		const source = branchFromPrefix(prefix, entry.parentId);
		const start = starts[index];
		if (start === undefined) throw new Error(`Compaction entry ${entry.id} has no persisted prefix`);
		const last = prefix.at(-1);
		const expectedRevision = createSessionRevisionToken({
			sessionId,
			completeBytes: start,
			recordCount: index,
			leafId: entry.parentId,
			lastEntryId: last?.type === "session" ? null : (last?.id ?? null),
			completePrefixSha256: createHash("sha256").update(bytes.subarray(0, start)).digest("hex"),
		});
		const base = envelope.baseRevision;
		const summarySha256 = createHash("sha256").update(entry.summary, "utf8").digest("hex");
		if (
			base.sessionId !== expectedRevision.sessionId ||
			base.completeBytes !== expectedRevision.completeBytes ||
			base.recordCount !== expectedRevision.recordCount ||
			base.leafId !== expectedRevision.leafId ||
			base.lastEntryId !== expectedRevision.lastEntryId ||
			base.completePrefixSha256 !== expectedRevision.completePrefixSha256 ||
			envelope.source.sessionId !== sessionId ||
			envelope.summary !== entry.summary ||
			envelope.summarySha256 !== summarySha256
		) {
			throw new Error(`Invalid compaction envelope binding in entry ${entry.id}. Run the session doctor.`);
		}
		assertSourceMatches(entry, envelope, source);
	}
}

/** Copy one branch while rebinding nested compaction provenance in source order. */
export function rebindBranchedCompactionEnvelopes(
	header: SessionHeader,
	entries: readonly SessionEntry[],
): SessionEntry[] {
	const referencedLabels = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "compaction") continue;
		for (const id of envelopeFromEntry(entry)?.source.entryIds ?? []) referencedLabels.add(id);
	}
	const originalPrefix: FileEntry[] = [];
	const copiedPrefix: FileEntry[] = [header];
	const copied: SessionEntry[] = [];
	for (const entry of entries) {
		let copy = entry;
		if (entry.type === "compaction") {
			const details = entry.details;
			const envelope = envelopeFromEntry(entry);
			if (envelope) {
				if (typeof details !== "object" || details === null || Array.isArray(details))
					throw new Error(`Compaction entry ${entry.id} has invalid details`);
				if (entry.parentId === null) throw new Error(`Compaction entry ${entry.id} has no source leaf`);
				assertSourceMatches(entry, envelope, branchFromPrefix(originalPrefix, entry.parentId));
				const source = branchFromPrefix(copiedPrefix, entry.parentId);
				const first = source[0];
				const last = source.at(-1);
				if (!first || !last) throw new Error(`Compaction entry ${entry.id} has no source entries`);
				copy = {
					...entry,
					details: {
						...details,
						compactionEnvelope: validateCompactionEnvelope({
							...envelope,
							baseRevision: prefixRevision(header, copiedPrefix, entry.parentId),
							source: {
								...envelope.source,
								sessionId: header.id,
								entryIds: source.map((candidate) => candidate.id),
								firstEntryId: first.id,
								lastEntryId: last.id,
								sourceSha256: sourceSha256(source),
								activeLeafId: entry.parentId,
							},
						}),
					},
				};
			}
		}
		originalPrefix.push(entry);
		if (entry.type === "label" && !referencedLabels.has(entry.id)) continue;
		copied.push(copy);
		copiedPrefix.push(copy);
	}
	return copied;
}
