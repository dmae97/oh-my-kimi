import {
	type BlobStore,
	externalizeImageDataSync,
	externalizeImageDataUrlSync,
	isBlobRef,
	isImageDataUrl,
} from "./blob-store";
import type { FileEntry } from "./session-entries";

const MAX_PERSIST_CHARS = 500_000;
const TRUNCATION_NOTICE = "\n\n[Session persistence truncated large content]";
/** Minimum base64 length to externalize to blob store (skip tiny inline images) */
const BLOB_EXTERNALIZE_THRESHOLD = 1024;
const TEXT_CONTENT_KEY = "content";

function truncateString(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	let truncated = value.slice(0, maxLength);
	if (truncated.length > 0) {
		const last = truncated.charCodeAt(truncated.length - 1);
		if (last >= 0xd800 && last <= 0xdbff) {
			truncated = truncated.slice(0, -1);
		}
	}
	return truncated;
}

export function isImageBlock(value: unknown): value is { type: "image"; data: string; mimeType?: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		(value as { type?: string }).type === "image" &&
		"data" in value &&
		typeof (value as { data?: string }).data === "string"
	);
}

function isImageMimeType(value: unknown): value is string {
	return typeof value === "string" && value.toLowerCase().startsWith("image/");
}

export function isImageDataPayload(value: unknown): value is { data: string; mimeType?: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"data" in value &&
		typeof (value as { data?: string }).data === "string" &&
		(isImageBlock(value) || ("mimeType" in value && isImageMimeType((value as { mimeType?: unknown }).mimeType)))
	);
}

function shouldExternalizeImagePayload(
	value: unknown,
	key: string | undefined,
): value is { data: string; mimeType?: string } {
	if (!isImageDataPayload(value)) return false;
	if (isBlobRef(value.data) || value.data.length < BLOB_EXTERNALIZE_THRESHOLD) return false;
	return (key === TEXT_CONTENT_KEY && isImageBlock(value)) || key === "images";
}

/**
 * Recursively truncate large strings in an object for session persistence.
 * - Truncates any oversized string fields (key-agnostic)
 * - Externalizes oversized image payloads to blob refs
 * - Updates lineCount when content is truncated
 * - Returns original object if no changes needed (structural sharing)
 *
 * Runs in one synchronous tick so an OOM/SIGKILL landing right after a persist
 * call returns cannot lose the entry. Image externalization happens via the
 * synchronous blob-store path (`fs.writeFileSync`), so blob bytes are in the
 * kernel page cache before the JSONL line referencing them is written.
 */
function truncateForPersistence(obj: unknown, blobStore: BlobStore, key?: string): unknown {
	if (obj === null || obj === undefined) return obj;
	if (shouldExternalizeImagePayload(obj, key)) {
		return { ...obj, data: externalizeImageDataSync(blobStore, obj.data, obj.mimeType) };
	}

	if (typeof obj === "string") {
		if (key === "image_url" && isImageDataUrl(obj)) {
			return externalizeImageDataUrlSync(blobStore, obj);
		}
		if (obj.length > MAX_PERSIST_CHARS) {
			// Cryptographic signatures must be preserved exactly or cleared entirely — never truncated.
			// Truncation would produce an invalid signature that the API rejects.
			if (key === "thinkingSignature" || key === "thoughtSignature" || key === "textSignature") {
				return "";
			}
			const limit = Math.max(0, MAX_PERSIST_CHARS - TRUNCATION_NOTICE.length);
			return `${truncateString(obj, limit)}${TRUNCATION_NOTICE}`;
		}
		return obj;
	}

	if (Array.isArray(obj)) {
		let changed = false;
		const result: unknown[] = new Array(obj.length);
		for (let i = 0; i < obj.length; i++) {
			const item = obj[i];
			const newItem = truncateForPersistence(item, blobStore, key);
			if (newItem !== item) changed = true;
			result[i] = newItem;
		}
		return changed ? result : obj;
	}

	if (typeof obj === "object") {
		let changed = false;
		const entries: Array<readonly [string, unknown]> = [];
		for (const [childKey, value] of Object.entries(obj)) {
			// Strip transient/redundant properties that shouldn't be persisted.
			// - jsonlEvents: raw subprocess streaming events (already saved to artifact files)
			if (childKey === "jsonlEvents") {
				changed = true;
				continue;
			}
			const newValue = truncateForPersistence(value, blobStore, childKey);
			if (newValue !== value) changed = true;
			entries.push([childKey, newValue]);
		}
		if (!changed) return obj;

		const contentEntry = entries.find(([childKey]) => childKey === "content");
		const lineCountEntry = entries.find(([childKey]) => childKey === "lineCount");
		if (
			contentEntry &&
			typeof contentEntry[1] === "string" &&
			lineCountEntry &&
			typeof lineCountEntry[1] === "number"
		) {
			const content = contentEntry[1];
			const updatedEntries = entries.map(([childKey, value]) =>
				childKey === "lineCount" ? ([childKey, content.split("\n").length] as const) : ([childKey, value] as const),
			);
			return Object.fromEntries(updatedEntries);
		}
		return Object.fromEntries(entries);
	}

	return obj;
}

/**
 * Read the duplication-relevant fields of an OpenAI Responses reasoning item.
 * Returns `undefined` for anything that is not a `type: "reasoning"` object, so
 * non-reasoning payload entries and corrupt signatures are never matched.
 */
function readReasoningItem(item: unknown): { encrypted_content?: string; id?: string } | undefined {
	if (item === null || typeof item !== "object") return undefined;
	if (!("type" in item) || item.type !== "reasoning") return undefined;
	const reasoning: { encrypted_content?: string; id?: string } = {};
	if ("encrypted_content" in item && typeof item.encrypted_content === "string" && item.encrypted_content.length > 0) {
		reasoning.encrypted_content = item.encrypted_content;
	}
	if ("id" in item && typeof item.id === "string" && item.id.length > 0) reasoning.id = item.id;
	return reasoning;
}

/**
 * True when a `thinkingSignature` (a JSON-encoded reasoning item) is already
 * carried by a reasoning item in the message's provider payload — matched on
 * `encrypted_content` (the load-bearing blob) when present, else on item `id`.
 * A signature the payload does not cover is never reported as recoverable, so it
 * is always kept.
 */
function signatureCoveredByPayload(
	signature: string,
	encrypted: ReadonlySet<string>,
	ids: ReadonlySet<string>,
): boolean {
	let parsed: unknown;
	try {
		parsed = JSON.parse(signature);
	} catch {
		return false;
	}
	const reasoning = readReasoningItem(parsed);
	if (!reasoning) return false;
	if (reasoning.encrypted_content) return encrypted.has(reasoning.encrypted_content);
	if (reasoning.id) return ids.has(reasoning.id);
	return false;
}

/**
 * Drop `thinkingSignature` from assistant thinking blocks whose reasoning item is
 * already carried, verbatim, in the message's OpenAI Responses `providerPayload`.
 *
 * Responses/Codex turns mint each reasoning item once and store it twice:
 * `providerPayload.items` (the authoritative native-history copy that replay and
 * remote compaction read) and `content[].thinkingSignature`, which is literally
 * `JSON.stringify(reasoningItem)` — including the large `encrypted_content` blob.
 * Replay only ever reads the payload; the signature is a no-payload fallback that
 * same-provider turns never reach and cross-model turns strip as untrustworthy.
 * Persisting both stores the encrypted reasoning twice for zero token or replay
 * benefit, so the on-disk copy drops the duplicate signature whenever its
 * reasoning item is recoverable from the payload. The in-memory entry is left
 * untouched; only the serialized line is slimmed.
 */
function stripReplayedReasoningSignatures(entry: FileEntry): FileEntry {
	if (entry.type !== "message" || entry.message.role !== "assistant") return entry;
	const message = entry.message;
	const payload = message.providerPayload;
	if (payload?.type !== "openaiResponsesHistory" || !Array.isArray(payload.items)) return entry;
	const hasSignedThinking = message.content.some(
		block =>
			block.type === "thinking" && typeof block.thinkingSignature === "string" && block.thinkingSignature.length > 0,
	);
	if (!hasSignedThinking) return entry;

	const encrypted = new Set<string>();
	const ids = new Set<string>();
	for (const rawItem of payload.items) {
		const reasoning = readReasoningItem(rawItem);
		if (!reasoning) continue;
		if (reasoning.encrypted_content) encrypted.add(reasoning.encrypted_content);
		if (reasoning.id) ids.add(reasoning.id);
	}
	if (encrypted.size === 0 && ids.size === 0) return entry;

	let changed = false;
	const content = message.content.map(block => {
		if (
			block.type !== "thinking" ||
			typeof block.thinkingSignature !== "string" ||
			block.thinkingSignature.length === 0
		) {
			return block;
		}
		if (!signatureCoveredByPayload(block.thinkingSignature, encrypted, ids)) return block;
		changed = true;
		return { ...block, thinkingSignature: undefined };
	});
	if (!changed) return entry;
	return { ...entry, message: { ...message, content } };
}

export function prepareEntryForPersistence(entry: FileEntry, blobStore: BlobStore): FileEntry {
	return truncateForPersistence(stripReplayedReasoningSignatures(entry), blobStore) as FileEntry;
}
