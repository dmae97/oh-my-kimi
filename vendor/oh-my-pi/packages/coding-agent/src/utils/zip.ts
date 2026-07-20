// The single archive boundary for the codebase: ZIP (framed here, over the raw
// DEFLATE codec in `node:zlib`) and tar / tar.gz (via `Bun.Archive`). This is
// the ONLY module that frames ZIP containers or touches `Bun.Archive`; the
// markit document converters, the read/search/write tools, the URL fetcher, the
// debug report bundler, and the tool-binary installer all go through here so
// there is exactly one archive implementation to reason about. Do not parse or
// build ZIP/tar, or call `Bun.Archive`, anywhere else.
import * as path from "node:path";
import * as zlib from "node:zlib";
import { formatBytes } from "@oh-my-pi/pi-utils";
import { ToolError } from "../tools/tool-errors";

/** A ZIP archive decoded to a `path → bytes` map of its file members. */
export type Unzipped = Record<string, Uint8Array>;

const ENCODER = new TextEncoder();
// `node:zlib` is only the DEFLATE codec; ZIP container framing is ours (see
// `unzip` / `zip` below). Entry names use the platform text decoders.
const UTF8_DECODER = new TextDecoder();
// ZIP central-directory names without the UTF-8 flag carry no reliable encoding;
// decode them as their legacy code page (windows-1252) as a stable best effort.
const LEGACY_NAME_DECODER = new TextDecoder("windows-1252");

/** Read a single ZIP entry as UTF-8 text, or `undefined` when the entry is absent. */
export function unzipText(entries: Unzipped, entryPath: string): string | undefined {
	const data = entries[entryPath];
	return data ? UTF8_DECODER.decode(data) : undefined;
}

/**
 * Decode an in-memory ZIP archive into a `path → bytes` map of its file members
 * (directory entries and `..`-escaping names are dropped). Shares the
 * central-directory record parser with the lazy, file-backed reader.
 */
export function unzip(bytes: Uint8Array): Unzipped {
	const info = readCentralDirectoryInfoSync(bytes);
	const centralDirectory = readMemoryRange(bytes, info.offset, info.offset + info.size);
	const out: Unzipped = {};
	for (const entry of parseZipCentralDirectory(memoryByteSource(bytes), centralDirectory, info.entries)) {
		if (entry.isDirectory || entry.storage?.type !== "zip") continue;
		out[entry.path] = extractZipMember(bytes, entry.storage, entry.size);
	}
	return out;
}

/**
 * Cap on the on-disk size of tar/tar.gz archives, which are loaded fully into
 * memory (and decompressed by `Bun.Archive`) just to index entries. ZIP is
 * exempt: it is read via ranged central-directory access.
 */
const MAX_TAR_ARCHIVE_BYTES = 256 * 1024 * 1024;
/**
 * Cap on a single archive member's declared (uncompressed) size. The declared
 * size is attacker-controlled metadata — a crafted ZIP entry can claim
 * multi-GB sizes that would be allocated up front before any data inflates.
 */
const MAX_ARCHIVE_MEMBER_BYTES = 64 * 1024 * 1024;

/** Inflate one raw DEFLATE stream, bounded to its declared uncompressed size. */
function inflateRaw(bytes: Uint8Array, declaredSize: number): Uint8Array {
	return zlib.inflateRawSync(bytes, { maxOutputLength: Math.max(declaredSize, 1) });
}

export type ArchiveFormat = "zip" | "tar" | "tar.gz";

/**
 * Where to read an archive from: a filesystem path (format inferred from the
 * extension; ZIP is read lazily via ranged central-directory access) or
 * in-memory bytes with an explicit format.
 */
export type ArchiveSource = string | { bytes: Uint8Array; format: ArchiveFormat };

/** Content for a member when packing or extracting an archive. */
export type ArchiveMemberContent = string | Uint8Array | Blob;

export interface ArchivePathCandidate {
	archivePath: string;
	subPath: string;
}

export interface ArchiveNode {
	path: string;
	isDirectory: boolean;
	size: number;
	mtimeMs?: number;
}

export interface ArchiveDirectoryEntry extends ArchiveNode {
	name: string;
}

export interface ExtractedArchiveFile extends ArchiveNode {
	bytes: Uint8Array;
}

/** A byte window into an archive — file-backed (lazy) or in-memory. */
interface ByteSource {
	readonly size: number;
	read(start: number, end: number): Promise<Uint8Array>;
}

function assertValidRange(start: number, end: number): void {
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
		throw new ToolError("Invalid ZIP archive range");
	}
}

/** Read an exact in-memory range, throwing (not clamping) when it runs past the buffer. */
function readMemoryRange(buffer: Uint8Array, start: number, end: number): Uint8Array {
	assertValidRange(start, end);
	if (end > buffer.byteLength) {
		throw new ToolError("Invalid ZIP archive: truncated data");
	}
	return buffer.subarray(start, end);
}

function fileByteSource(filePath: string): ByteSource {
	const file = Bun.file(filePath);
	const size = file.size;
	if (!Number.isSafeInteger(size)) {
		throw new ToolError("ZIP archive is too large to read safely");
	}
	return {
		size,
		async read(start, end) {
			assertValidRange(start, end);
			const bytes = await file.slice(start, end).bytes();
			if (bytes.byteLength !== end - start) {
				throw new ToolError("Invalid ZIP archive: truncated data");
			}
			return bytes;
		},
	};
}

function memoryByteSource(buffer: Uint8Array): ByteSource {
	return {
		size: buffer.byteLength,
		async read(start, end) {
			return readMemoryRange(buffer, start, end);
		},
	};
}

interface TarStorage {
	type: "tar";
	file: File;
}

interface ZipStorage {
	type: "zip";
	source: ByteSource;
	compressedSize: number;
	compression: number;
	flags: number;
	localHeaderOffset: number;
}

type EntryStorage = TarStorage | ZipStorage;

interface ArchiveIndexEntry extends ArchiveNode {
	storage?: EntryStorage;
}

function normalizeArchiveLookupPath(rawPath?: string): string | undefined {
	if (!rawPath) return "";

	const parts = rawPath.replace(/\\/g, "/").split("/");
	const normalizedParts: string[] = [];
	for (const part of parts) {
		if (!part || part === ".") continue;
		if (part === "..") return undefined;
		normalizedParts.push(part);
	}

	return normalizedParts.join("/");
}

function normalizeArchiveEntryPath(rawPath: string): string | undefined {
	const parts = rawPath.replace(/\\/g, "/").split("/");
	const normalizedParts: string[] = [];
	for (const part of parts) {
		if (!part || part === ".") continue;
		if (part === "..") return undefined;
		normalizedParts.push(part);
	}

	if (normalizedParts.length === 0) return undefined;
	return normalizedParts.join("/");
}

function isArchiveDirectoryName(rawPath: string): boolean {
	return rawPath.endsWith("/") || rawPath.endsWith("\\");
}

function upsertArchiveEntry(map: Map<string, ArchiveIndexEntry>, entry: ArchiveIndexEntry): void {
	const existing = map.get(entry.path);
	if (!existing) {
		map.set(entry.path, entry);
		return;
	}

	if (existing.isDirectory && !entry.isDirectory) {
		map.set(entry.path, entry);
		return;
	}

	if (!existing.isDirectory && entry.isDirectory) {
		return;
	}

	map.set(entry.path, {
		...existing,
		size: existing.size || entry.size,
		mtimeMs: existing.mtimeMs ?? entry.mtimeMs,
		storage: existing.storage ?? entry.storage,
	});
}

function ensureParentDirectories(map: Map<string, ArchiveIndexEntry>): void {
	for (const entry of [...map.values()]) {
		const parts = entry.path.split("/");
		const stop = parts.length - 1;
		for (let index = 1; index <= stop; index++) {
			const dirPath = parts.slice(0, index).join("/");
			if (!dirPath || map.has(dirPath)) continue;
			map.set(dirPath, {
				path: dirPath,
				isDirectory: true,
				size: 0,
			});
		}
	}
}

/**
 * Extensions that are ZIP containers under a different name — JVM (`.jar`,
 * `.war`, `.ear`) and Android (`.apk`) packages are all ZIP archives. Treated
 * as `zip` for member read/list and whole-archive rewrite.
 */
const ZIP_ALIAS_EXTENSIONS = ["jar", "war", "ear", "apk"] as const;

/**
 * Regex alternation of every recognized archive extension, longest first so
 * `.tar.gz` wins over `.tar`. Shared with `parseArchivePathCandidates` as its
 * split pattern so extension recognition and path splitting never drift.
 */
const ARCHIVE_EXTENSION_ALTERNATION = ["tar\\.gz", "tgz", "zip", "tar", ...ZIP_ALIAS_EXTENSIONS].join("|");

/** Infer an archive format from a filesystem path's extension. */
export function archiveFormatFromPath(filePath: string): ArchiveFormat | undefined {
	const normalized = filePath.toLowerCase();
	if (normalized.endsWith(".tar.gz") || normalized.endsWith(".tgz")) return "tar.gz";
	if (normalized.endsWith(".tar")) return "tar";
	if (normalized.endsWith(".zip")) return "zip";
	if (ZIP_ALIAS_EXTENSIONS.some(ext => normalized.endsWith(`.${ext}`))) return "zip";
	return undefined;
}

export function formatArchiveEntryLines(entries: readonly ArchiveDirectoryEntry[]): string[] {
	return entries.map(entry => {
		if (entry.isDirectory) return `${entry.name}/`;

		const sizeSuffix = entry.size > 0 ? ` (${formatBytes(entry.size)})` : "";
		return `${entry.name}${sizeSuffix}`;
	});
}

const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER_SIGNATURE = 0x02014b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const ZIP_EOCD_MIN_LENGTH = 22;
const ZIP_EOCD_MAX_COMMENT_LENGTH = 0xffff;
const ZIP64_EOCD_LOCATOR_LENGTH = 20;
const ZIP_STORED_COMPRESSION = 0;
const ZIP_DEFLATE_COMPRESSION = 8;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_ENCRYPTED_FLAG = 0x0001;
const ZIP_UINT16_MAX = 0xffff;
const ZIP_UINT32_MAX = 0xffffffff;
const ZIP_UINT32_RANGE = 0x100000000;

interface ZipCentralDirectoryInfo {
	entries: number;
	offset: number;
	size: number;
}

interface Zip64EntryValues {
	compressedSize: number;
	uncompressedSize: number;
	localHeaderOffset: number;
	diskStart: number;
}

interface Zip64EntryPlaceholders {
	compressedSize: boolean;
	uncompressedSize: boolean;
	localHeaderOffset: boolean;
	diskStart: boolean;
}

function readUInt16LE(bytes: Uint8Array, offset: number): number {
	return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUInt32LE(bytes: Uint8Array, offset: number): number {
	return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

function bytesMatchAscii(bytes: Uint8Array, offset: number, value: string): boolean {
	if (bytes.byteLength < offset + value.length) return false;
	for (let index = 0; index < value.length; index++) {
		if (bytes[offset + index] !== value.charCodeAt(index)) return false;
	}
	return true;
}

export function sniffArchiveFormat(bytes: Uint8Array): ArchiveFormat | undefined {
	if (bytes.byteLength >= 4) {
		const signature = readUInt32LE(bytes, 0);
		if (
			signature === ZIP_LOCAL_FILE_HEADER_SIGNATURE ||
			signature === ZIP_EOCD_SIGNATURE ||
			signature === ZIP_DATA_DESCRIPTOR_SIGNATURE
		) {
			return "zip";
		}
	}

	if (bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
		return "tar.gz";
	}

	if (bytesMatchAscii(bytes, 257, "ustar")) {
		return "tar";
	}

	return undefined;
}

function readUInt64LEAsNumber(bytes: Uint8Array, offset: number): number {
	const value = readUInt32LE(bytes, offset) + readUInt32LE(bytes, offset + 4) * ZIP_UINT32_RANGE;
	if (!Number.isSafeInteger(value)) {
		throw new ToolError("ZIP archive uses offsets or sizes too large to read safely");
	}
	return value;
}

function findEndOfCentralDirectory(tail: Uint8Array): number {
	for (let offset = tail.byteLength - ZIP_EOCD_MIN_LENGTH; offset >= 0; offset--) {
		if (readUInt32LE(tail, offset) !== ZIP_EOCD_SIGNATURE) continue;
		const commentLength = readUInt16LE(tail, offset + 20);
		if (offset + ZIP_EOCD_MIN_LENGTH + commentLength === tail.byteLength) return offset;
	}

	throw new ToolError("Invalid ZIP archive: missing end of central directory");
}

async function readZip64CentralDirectoryInfo(
	source: ByteSource,
	tail: Uint8Array,
	tailStart: number,
	eocdOffset: number,
): Promise<ZipCentralDirectoryInfo | undefined> {
	const locatorOffset = eocdOffset - ZIP64_EOCD_LOCATOR_LENGTH;
	if (locatorOffset < 0) return undefined;

	const locator =
		locatorOffset >= tailStart
			? tail.subarray(locatorOffset - tailStart, locatorOffset - tailStart + ZIP64_EOCD_LOCATOR_LENGTH)
			: await source.read(locatorOffset, eocdOffset);
	if (readUInt32LE(locator, 0) !== ZIP64_EOCD_LOCATOR_SIGNATURE) return undefined;

	const zip64EocdDisk = readUInt32LE(locator, 4);
	const zip64EocdOffset = readUInt64LEAsNumber(locator, 8);
	const totalDisks = readUInt32LE(locator, 16);
	if (zip64EocdDisk !== 0 || totalDisks > 1) {
		throw new ToolError("Multi-disk ZIP archives are not supported");
	}

	const record = await source.read(zip64EocdOffset, zip64EocdOffset + 56);
	if (readUInt32LE(record, 0) !== ZIP64_EOCD_SIGNATURE) {
		throw new ToolError("Invalid ZIP archive: missing ZIP64 end of central directory");
	}
	if (readUInt32LE(record, 16) !== 0 || readUInt32LE(record, 20) !== 0) {
		throw new ToolError("Multi-disk ZIP archives are not supported");
	}

	return {
		entries: readUInt64LEAsNumber(record, 32),
		size: readUInt64LEAsNumber(record, 40),
		offset: readUInt64LEAsNumber(record, 48),
	};
}

async function readZipCentralDirectoryInfo(source: ByteSource): Promise<ZipCentralDirectoryInfo> {
	const fileSize = source.size;
	if (fileSize < ZIP_EOCD_MIN_LENGTH) {
		throw new ToolError("Invalid ZIP archive: missing end of central directory");
	}

	const tailLength = Math.min(fileSize, ZIP_EOCD_MIN_LENGTH + ZIP_EOCD_MAX_COMMENT_LENGTH);
	const tailStart = fileSize - tailLength;
	const tail = await source.read(tailStart, fileSize);
	const eocdIndex = findEndOfCentralDirectory(tail);
	const eocdOffset = tailStart + eocdIndex;

	if (readUInt16LE(tail, eocdIndex + 4) !== 0 || readUInt16LE(tail, eocdIndex + 6) !== 0) {
		throw new ToolError("Multi-disk ZIP archives are not supported");
	}

	let entries = readUInt16LE(tail, eocdIndex + 10);
	let size = readUInt32LE(tail, eocdIndex + 12);
	let offset = readUInt32LE(tail, eocdIndex + 16);
	const needsZip64 = entries === ZIP_UINT16_MAX || size === ZIP_UINT32_MAX || offset === ZIP_UINT32_MAX;
	const zip64Info = await readZip64CentralDirectoryInfo(source, tail, tailStart, eocdOffset);
	if (zip64Info) {
		({ entries, size, offset } = zip64Info);
	} else if (needsZip64) {
		throw new ToolError("Invalid ZIP archive: missing ZIP64 central directory metadata");
	}

	if (offset + size > fileSize) {
		throw new ToolError("Invalid ZIP archive: central directory exceeds file size");
	}

	return { entries, offset, size };
}

function readZip64EntryValues(
	extra: Uint8Array,
	placeholders: Zip64EntryPlaceholders,
	current: Zip64EntryValues,
): Zip64EntryValues {
	if (
		!placeholders.compressedSize &&
		!placeholders.uncompressedSize &&
		!placeholders.localHeaderOffset &&
		!placeholders.diskStart
	) {
		return current;
	}

	let offset = 0;
	while (offset + 4 <= extra.byteLength) {
		const headerId = readUInt16LE(extra, offset);
		const dataSize = readUInt16LE(extra, offset + 2);
		const dataStart = offset + 4;
		const dataEnd = dataStart + dataSize;
		if (dataEnd > extra.byteLength) {
			throw new ToolError("Invalid ZIP archive: malformed extra field");
		}

		if (headerId === 0x0001) {
			let cursor = dataStart;
			let uncompressedSize = current.uncompressedSize;
			let compressedSize = current.compressedSize;
			let localHeaderOffset = current.localHeaderOffset;
			let diskStart = current.diskStart;

			if (placeholders.uncompressedSize) {
				if (cursor + 8 > dataEnd) throw new ToolError("Invalid ZIP archive: malformed ZIP64 extra field");
				uncompressedSize = readUInt64LEAsNumber(extra, cursor);
				cursor += 8;
			}
			if (placeholders.compressedSize) {
				if (cursor + 8 > dataEnd) throw new ToolError("Invalid ZIP archive: malformed ZIP64 extra field");
				compressedSize = readUInt64LEAsNumber(extra, cursor);
				cursor += 8;
			}
			if (placeholders.localHeaderOffset) {
				if (cursor + 8 > dataEnd) throw new ToolError("Invalid ZIP archive: malformed ZIP64 extra field");
				localHeaderOffset = readUInt64LEAsNumber(extra, cursor);
				cursor += 8;
			}
			if (placeholders.diskStart) {
				if (cursor + 4 > dataEnd) throw new ToolError("Invalid ZIP archive: malformed ZIP64 extra field");
				diskStart = readUInt32LE(extra, cursor);
			}

			return { compressedSize, uncompressedSize, localHeaderOffset, diskStart };
		}

		offset = dataEnd;
	}

	throw new ToolError("Invalid ZIP archive: missing ZIP64 extra field");
}

function parseZipCentralDirectory(
	source: ByteSource,
	centralDirectory: Uint8Array,
	expectedEntries: number,
): ArchiveIndexEntry[] {
	const entries: ArchiveIndexEntry[] = [];
	let offset = 0;

	for (let index = 0; index < expectedEntries; index++) {
		if (offset + 46 > centralDirectory.byteLength) {
			throw new ToolError("Invalid ZIP archive: truncated central directory");
		}
		if (readUInt32LE(centralDirectory, offset) !== ZIP_CENTRAL_DIRECTORY_HEADER_SIGNATURE) {
			throw new ToolError("Invalid ZIP archive: malformed central directory");
		}

		const flags = readUInt16LE(centralDirectory, offset + 8);
		const compression = readUInt16LE(centralDirectory, offset + 10);
		const compressedSizeRaw = readUInt32LE(centralDirectory, offset + 20);
		const uncompressedSizeRaw = readUInt32LE(centralDirectory, offset + 24);
		const fileNameLength = readUInt16LE(centralDirectory, offset + 28);
		const extraLength = readUInt16LE(centralDirectory, offset + 30);
		const commentLength = readUInt16LE(centralDirectory, offset + 32);
		const diskStartRaw = readUInt16LE(centralDirectory, offset + 34);
		const localHeaderOffsetRaw = readUInt32LE(centralDirectory, offset + 42);
		const nameStart = offset + 46;
		const extraStart = nameStart + fileNameLength;
		const entryEnd = extraStart + extraLength + commentLength;
		if (entryEnd > centralDirectory.byteLength) {
			throw new ToolError("Invalid ZIP archive: truncated central directory entry");
		}

		const useLegacyEncoding = (flags & ZIP_UTF8_FLAG) === 0;
		const rawPath = (useLegacyEncoding ? LEGACY_NAME_DECODER : UTF8_DECODER).decode(
			centralDirectory.subarray(nameStart, extraStart),
		);
		const normalizedPath = normalizeArchiveEntryPath(rawPath);
		if (normalizedPath) {
			const values = readZip64EntryValues(
				centralDirectory.subarray(extraStart, extraStart + extraLength),
				{
					compressedSize: compressedSizeRaw === ZIP_UINT32_MAX,
					uncompressedSize: uncompressedSizeRaw === ZIP_UINT32_MAX,
					localHeaderOffset: localHeaderOffsetRaw === ZIP_UINT32_MAX,
					diskStart: diskStartRaw === ZIP_UINT16_MAX,
				},
				{
					compressedSize: compressedSizeRaw,
					uncompressedSize: uncompressedSizeRaw,
					localHeaderOffset: localHeaderOffsetRaw,
					diskStart: diskStartRaw,
				},
			);
			if (values.diskStart !== 0) {
				throw new ToolError("Multi-disk ZIP archives are not supported");
			}

			const isDirectory = isArchiveDirectoryName(rawPath);
			entries.push({
				path: normalizedPath,
				isDirectory,
				size: isDirectory ? 0 : values.uncompressedSize,
				storage: isDirectory
					? undefined
					: {
							type: "zip",
							source,
							compressedSize: values.compressedSize,
							compression,
							flags,
							localHeaderOffset: values.localHeaderOffset,
						},
			});
		}

		offset = entryEnd;
	}

	return entries;
}

/** Decode a single ZIP member's already-read payload, bounded to its declared size. */
function decodeZipMember(compressed: Uint8Array, compression: number, declaredSize: number): Uint8Array {
	if (compression === ZIP_STORED_COMPRESSION) {
		return compressed;
	}
	if (compression !== ZIP_DEFLATE_COMPRESSION) {
		throw new ToolError(`Unsupported ZIP compression method: ${compression}`);
	}
	try {
		return inflateRaw(compressed, declaredSize);
	} catch (error) {
		throw new ToolError(error instanceof Error ? error.message : String(error));
	}
}

async function readZipFileBytes(storage: ZipStorage, uncompressedSize: number): Promise<Uint8Array> {
	if ((storage.flags & ZIP_ENCRYPTED_FLAG) !== 0) {
		throw new ToolError("Encrypted ZIP entries are not supported");
	}

	const localHeader = await storage.source.read(storage.localHeaderOffset, storage.localHeaderOffset + 30);
	if (readUInt32LE(localHeader, 0) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) {
		throw new ToolError("Invalid ZIP archive: malformed local file header");
	}

	const fileNameLength = readUInt16LE(localHeader, 26);
	const extraLength = readUInt16LE(localHeader, 28);
	const dataStart = storage.localHeaderOffset + 30 + fileNameLength + extraLength;
	const compressedBytes = await storage.source.read(dataStart, dataStart + storage.compressedSize);
	return decodeZipMember(compressedBytes, storage.compression, uncompressedSize);
}

async function readTarEntries(bytes: Uint8Array): Promise<ArchiveIndexEntry[]> {
	let archive: Bun.Archive;
	try {
		archive = new Bun.Archive(bytes);
	} catch (error) {
		throw new ToolError(error instanceof Error ? error.message : String(error));
	}

	let files: Map<string, File>;
	try {
		files = await archive.files();
	} catch (error) {
		throw new ToolError(error instanceof Error ? error.message : String(error));
	}

	const entries: ArchiveIndexEntry[] = [];
	for (const [rawPath, file] of files) {
		const normalizedPath = normalizeArchiveEntryPath(rawPath);
		if (!normalizedPath) continue;
		const mtimeMs = file.lastModified > 0 ? file.lastModified : undefined;
		entries.push({
			path: normalizedPath,
			isDirectory: false,
			size: file.size,
			mtimeMs,
			storage: { type: "tar", file },
		});
	}

	return entries;
}

async function readZipEntries(source: ByteSource): Promise<ArchiveIndexEntry[]> {
	const directoryInfo = await readZipCentralDirectoryInfo(source);
	const centralDirectory = await source.read(directoryInfo.offset, directoryInfo.offset + directoryInfo.size);
	return parseZipCentralDirectory(source, centralDirectory, directoryInfo.entries);
}

/**
 * Split an `archive.ext:inner/path` reference into every plausible
 * `{ archivePath, subPath }` pair, longest archive prefix first. A path may
 * contain more than one archive extension, so each candidate is a guess at
 * where the archive ends and the member portion begins.
 */
export function parseArchivePathCandidates(filePath: string): ArchivePathCandidate[] {
	const normalized = filePath.replace(/\\/g, "/");
	const pattern = new RegExp(`\\.(?:${ARCHIVE_EXTENSION_ALTERNATION})(?=(?::|$))`, "gi");
	const seen = new Set<string>();
	const candidates: ArchivePathCandidate[] = [];

	let match: RegExpExecArray | null;
	while (true) {
		match = pattern.exec(normalized);
		if (match === null) {
			break;
		}
		const end = match.index + match[0].length;
		const archivePath = filePath.slice(0, end);
		const subPath = normalized.slice(end).replace(/^:+/, "");
		const key = `${archivePath}\0${subPath}`;
		if (seen.has(key)) continue;
		seen.add(key);
		candidates.push({ archivePath, subPath });
	}

	return candidates.sort((left, right) => right.archivePath.length - left.archivePath.length);
}

/**
 * An indexed, read-only view over a single archive. ZIP archives are indexed
 * from the central directory and members are inflated on demand; tar archives
 * are fully materialized by `Bun.Archive` up front.
 */
export class ArchiveReader {
	readonly format: ArchiveFormat;
	#entries = new Map<string, ArchiveIndexEntry>();

	constructor(format: ArchiveFormat, entries: ArchiveIndexEntry[]) {
		this.format = format;
		for (const entry of entries) {
			upsertArchiveEntry(this.#entries, entry);
		}
		ensureParentDirectories(this.#entries);
	}

	getNode(subPath?: string): ArchiveNode | undefined {
		const normalizedPath = normalizeArchiveLookupPath(subPath);
		if (normalizedPath === undefined) return undefined;
		if (normalizedPath === "") {
			return { path: "", isDirectory: true, size: 0 };
		}

		const entry = this.#entries.get(normalizedPath);
		if (!entry) return undefined;
		return {
			path: entry.path,
			isDirectory: entry.isDirectory,
			size: entry.size,
			mtimeMs: entry.mtimeMs,
		};
	}

	listDirectory(subPath?: string): ArchiveDirectoryEntry[] {
		const normalizedPath = normalizeArchiveLookupPath(subPath);
		if (normalizedPath === undefined) {
			throw new ToolError("Archive path cannot contain '..'");
		}

		if (normalizedPath) {
			const entry = this.#entries.get(normalizedPath);
			if (!entry) {
				throw new ToolError(`Archive path '${normalizedPath}' not found`);
			}
			if (!entry.isDirectory) {
				throw new ToolError(`Archive path '${normalizedPath}' is not a directory`);
			}
		}

		const prefix = normalizedPath ? `${normalizedPath}/` : "";
		const children = new Map<string, ArchiveDirectoryEntry>();

		for (const entry of this.#entries.values()) {
			if (normalizedPath) {
				if (!entry.path.startsWith(prefix) || entry.path === normalizedPath) continue;
			}

			const relativePath = normalizedPath ? entry.path.slice(prefix.length) : entry.path;
			const nextSegment = relativePath.split("/")[0];
			if (!nextSegment) continue;

			const childPath = normalizedPath ? `${normalizedPath}/${nextSegment}` : nextSegment;
			if (children.has(childPath)) continue;

			const childEntry = this.#entries.get(childPath);
			const isDirectory = childEntry?.isDirectory ?? relativePath.includes("/");
			children.set(childPath, {
				name: nextSegment,
				path: childPath,
				isDirectory,
				size: isDirectory ? 0 : (childEntry?.size ?? entry.size),
				mtimeMs: childEntry?.mtimeMs ?? entry.mtimeMs,
			});
		}

		return [...children.values()].sort((left, right) =>
			left.name.toLowerCase().localeCompare(right.name.toLowerCase()),
		);
	}

	async readFile(subPath: string): Promise<ExtractedArchiveFile> {
		const normalizedPath = normalizeArchiveLookupPath(subPath);
		if (!normalizedPath) {
			throw new ToolError("Archive file path is required");
		}

		const entry = this.#entries.get(normalizedPath);
		if (!entry) {
			throw new ToolError(`Archive file '${normalizedPath}' not found`);
		}
		if (entry.isDirectory) {
			throw new ToolError(`Archive path '${normalizedPath}' is a directory`);
		}
		if (!entry.storage) {
			throw new ToolError(`Archive file '${normalizedPath}' has no readable storage`);
		}
		if (entry.size > MAX_ARCHIVE_MEMBER_BYTES) {
			throw new ToolError(
				`Archive member '${normalizedPath}' is too large to extract in memory (${formatBytes(entry.size)} > ${formatBytes(MAX_ARCHIVE_MEMBER_BYTES)} limit)`,
			);
		}

		const bytes =
			entry.storage.type === "tar"
				? await entry.storage.file.bytes()
				: await readZipFileBytes(entry.storage, entry.size);

		return {
			path: entry.path,
			isDirectory: false,
			size: entry.size,
			mtimeMs: entry.mtimeMs,
			bytes,
		};
	}
}

/**
 * Open an archive for reading. ZIP archives opened from a path are indexed
 * lazily via ranged central-directory reads (members inflate on demand); tar
 * archives and in-memory ZIPs are read from a single buffer.
 */
export async function openArchive(source: ArchiveSource): Promise<ArchiveReader> {
	if (typeof source === "string") {
		const format = archiveFormatFromPath(source);
		if (!format) {
			throw new ToolError(`Unsupported archive format: ${source}`);
		}
		if (format === "zip") {
			return new ArchiveReader(format, await readZipEntries(fileByteSource(source)));
		}

		const file = Bun.file(source);
		const archiveSize = file.size;
		if (archiveSize > MAX_TAR_ARCHIVE_BYTES) {
			throw new ToolError(
				`Archive is too large to read in memory (${formatBytes(archiveSize)} > ${formatBytes(MAX_TAR_ARCHIVE_BYTES)} limit)`,
			);
		}
		return new ArchiveReader(format, await readTarEntries(await file.bytes()));
	}

	const { bytes, format } = source;
	if (format === "zip") {
		return new ArchiveReader(format, await readZipEntries(memoryByteSource(bytes)));
	}
	if (bytes.byteLength > MAX_TAR_ARCHIVE_BYTES) {
		throw new ToolError(
			`Archive is too large to read in memory (${formatBytes(bytes.byteLength)} > ${formatBytes(MAX_TAR_ARCHIVE_BYTES)} limit)`,
		);
	}
	return new ArchiveReader(format, await readTarEntries(bytes));
}

/** Render the top-level entries of an in-memory archive as one line each. */
export async function listArchiveRoot(
	bytes: Uint8Array,
	format: ArchiveFormat,
	opts: { limit?: number } = {},
): Promise<string> {
	const archive = await openArchive({ bytes, format });
	const entries = archive.listDirectory("");
	const limitedEntries = opts.limit !== undefined && opts.limit > 0 ? entries.slice(0, opts.limit) : entries;
	const lines = formatArchiveEntryLines(limitedEntries);
	return lines.length > 0 ? lines.join("\n") : "(empty archive directory)";
}

async function resolveArchiveBytes(source: ArchiveSource): Promise<{ bytes: Uint8Array; format: ArchiveFormat }> {
	if (typeof source !== "string") return source;
	const format = archiveFormatFromPath(source);
	if (!format) {
		throw new ToolError(`Unsupported archive format: ${source}`);
	}
	return { bytes: await Bun.file(source).bytes(), format };
}

async function memberToBytes(content: ArchiveMemberContent): Promise<Uint8Array> {
	if (typeof content === "string") return ENCODER.encode(content);
	if (content instanceof Uint8Array) return content;
	return new Uint8Array(await content.arrayBuffer());
}

/**
 * Fully materialize every file member into a `path → content` map: ZIP members
 * are inflated in memory, tar members are returned as lazy `File`s. Use this
 * when you need every entry (rewrite, extract); for browsing or single-member
 * reads prefer `openArchive`, which is lazy for ZIP.
 */
export async function readArchiveEntries(source: ArchiveSource): Promise<Map<string, ArchiveMemberContent>> {
	const { bytes, format } = await resolveArchiveBytes(source);
	const entries = new Map<string, ArchiveMemberContent>();
	if (format === "zip") {
		const unzipped = unzip(bytes);
		for (const name in unzipped) {
			entries.set(name, unzipped[name]!);
		}
		return entries;
	}
	const files = await new Bun.Archive(bytes).files();
	for (const [name, file] of files) {
		entries.set(name.replace(/\\/g, "/"), file);
	}
	return entries;
}

/**
 * Serialize `entries` into an archive of `format` and write it to `destPath`.
 * ZIP is framed in memory, tar / tar.gz via `Bun.Archive` (gzip for tar.gz).
 * String members are encoded as UTF-8.
 */
export async function writeArchive(
	destPath: string,
	format: ArchiveFormat,
	entries: Iterable<readonly [string, ArchiveMemberContent]>,
): Promise<void> {
	if (format === "zip") {
		const record: Record<string, Uint8Array> = {};
		for (const [name, content] of entries) {
			record[name.replace(/\\/g, "/")] = await memberToBytes(content);
		}
		await Bun.write(destPath, zip(record));
		return;
	}

	const record: Record<string, ArchiveMemberContent> = {};
	for (const [name, content] of entries) {
		record[name.replace(/\\/g, "/")] = content;
	}
	await Bun.Archive.write(destPath, record, format === "tar.gz" ? { compress: "gzip" } : undefined);
}

/**
 * Extract every file member to `destDir`, creating parent directories as
 * needed. Entries that would escape `destDir` (via `..` or an absolute path)
 * are rejected. Returns the number of files written.
 */
export async function extractArchive(source: ArchiveSource, destDir: string): Promise<number> {
	const extractRoot = path.resolve(destDir);
	const entries = await readArchiveEntries(source);
	let count = 0;
	for (const [name, content] of entries) {
		if (name.endsWith("/")) continue;
		const outputPath = path.resolve(extractRoot, name);
		if (!outputPath.startsWith(extractRoot + path.sep)) {
			throw new ToolError(`Archive entry escapes extraction dir: ${name}`);
		}
		await Bun.write(outputPath, content);
		count++;
	}
	return count;
}

function writeUInt16LE(buf: Uint8Array, offset: number, value: number): void {
	buf[offset] = value & 0xff;
	buf[offset + 1] = (value >>> 8) & 0xff;
}

function writeUInt32LE(buf: Uint8Array, offset: number, value: number): void {
	buf[offset] = value & 0xff;
	buf[offset + 1] = (value >>> 8) & 0xff;
	buf[offset + 2] = (value >>> 16) & 0xff;
	buf[offset + 3] = (value >>> 24) & 0xff;
}

/**
 * Frame a `path → bytes` map into a ZIP archive in memory. Each member is raw
 * DEFLATE unless that would not shrink it, in which case it is stored. ZIP64 is
 * not emitted; archives beyond the 32-bit limits throw rather than corrupt.
 */
export function zip(entries: Unzipped): Uint8Array {
	const localParts: Uint8Array[] = [];
	const centralParts: Uint8Array[] = [];
	let offset = 0;
	let count = 0;

	for (const name in entries) {
		const data = entries[name]!;
		const nameBytes = ENCODER.encode(name);
		const crc = zlib.crc32(data) >>> 0;
		const uncompressedSize = data.byteLength;
		const deflated = zlib.deflateRawSync(data);
		const stored = deflated.byteLength >= uncompressedSize;
		const method = stored ? ZIP_STORED_COMPRESSION : ZIP_DEFLATE_COMPRESSION;
		const payload = stored ? data : deflated;

		// Without ZIP64 the name length is a u16 and offsets/sizes are u32 (with
		// 0xffff/0xffffffff reserved as ZIP64 sentinels); reject anything that
		// would silently wrap a header field instead of producing a valid archive.
		if (
			count + 1 >= ZIP_UINT16_MAX ||
			nameBytes.byteLength > ZIP_UINT16_MAX ||
			uncompressedSize >= ZIP_UINT32_MAX ||
			offset + 30 + nameBytes.byteLength + payload.byteLength >= ZIP_UINT32_MAX
		) {
			throw new ToolError("ZIP archive is too large to write (ZIP64 is not supported)");
		}

		const header = new Uint8Array(30 + nameBytes.byteLength);
		writeUInt32LE(header, 0, ZIP_LOCAL_FILE_HEADER_SIGNATURE);
		writeUInt16LE(header, 4, 20);
		writeUInt16LE(header, 6, ZIP_UTF8_FLAG);
		writeUInt16LE(header, 8, method);
		// Fixed 1980-01-01 timestamp keeps the output deterministic.
		writeUInt16LE(header, 12, 0x21);
		writeUInt32LE(header, 14, crc);
		writeUInt32LE(header, 18, payload.byteLength);
		writeUInt32LE(header, 22, uncompressedSize);
		writeUInt16LE(header, 26, nameBytes.byteLength);
		header.set(nameBytes, 30);
		localParts.push(header, payload);

		const record = new Uint8Array(46 + nameBytes.byteLength);
		writeUInt32LE(record, 0, ZIP_CENTRAL_DIRECTORY_HEADER_SIGNATURE);
		writeUInt16LE(record, 4, 20);
		writeUInt16LE(record, 6, 20);
		writeUInt16LE(record, 8, ZIP_UTF8_FLAG);
		writeUInt16LE(record, 10, method);
		writeUInt16LE(record, 14, 0x21);
		writeUInt32LE(record, 16, crc);
		writeUInt32LE(record, 20, payload.byteLength);
		writeUInt32LE(record, 24, uncompressedSize);
		writeUInt16LE(record, 28, nameBytes.byteLength);
		writeUInt32LE(record, 42, offset);
		record.set(nameBytes, 46);
		centralParts.push(record);

		offset += header.byteLength + payload.byteLength;
		count++;
	}

	const centralSize = centralParts.reduce((sum, part) => sum + part.byteLength, 0);
	if (centralSize >= ZIP_UINT32_MAX || offset + centralSize + ZIP_EOCD_MIN_LENGTH >= ZIP_UINT32_MAX) {
		throw new ToolError("ZIP archive is too large to write (ZIP64 is not supported)");
	}
	const eocd = new Uint8Array(ZIP_EOCD_MIN_LENGTH);
	writeUInt32LE(eocd, 0, ZIP_EOCD_SIGNATURE);
	writeUInt16LE(eocd, 8, count);
	writeUInt16LE(eocd, 10, count);
	writeUInt32LE(eocd, 12, centralSize);
	writeUInt32LE(eocd, 16, offset);

	const out = new Uint8Array(offset + centralSize + ZIP_EOCD_MIN_LENGTH);
	let pos = 0;
	for (const part of localParts) {
		out.set(part, pos);
		pos += part.byteLength;
	}
	for (const part of centralParts) {
		out.set(part, pos);
		pos += part.byteLength;
	}
	out.set(eocd, pos);
	return out;
}

function readZip64CentralDirectoryInfoSync(bytes: Uint8Array, eocdOffset: number): ZipCentralDirectoryInfo | undefined {
	const locatorOffset = eocdOffset - ZIP64_EOCD_LOCATOR_LENGTH;
	if (locatorOffset < 0) return undefined;

	const locator = readMemoryRange(bytes, locatorOffset, locatorOffset + ZIP64_EOCD_LOCATOR_LENGTH);
	if (readUInt32LE(locator, 0) !== ZIP64_EOCD_LOCATOR_SIGNATURE) return undefined;
	if (readUInt32LE(locator, 4) !== 0 || readUInt32LE(locator, 16) > 1) {
		throw new ToolError("Multi-disk ZIP archives are not supported");
	}

	const zip64EocdOffset = readUInt64LEAsNumber(locator, 8);
	const record = readMemoryRange(bytes, zip64EocdOffset, zip64EocdOffset + 56);
	if (readUInt32LE(record, 0) !== ZIP64_EOCD_SIGNATURE) {
		throw new ToolError("Invalid ZIP archive: missing ZIP64 end of central directory");
	}
	if (readUInt32LE(record, 16) !== 0 || readUInt32LE(record, 20) !== 0) {
		throw new ToolError("Multi-disk ZIP archives are not supported");
	}

	return {
		entries: readUInt64LEAsNumber(record, 32),
		size: readUInt64LEAsNumber(record, 40),
		offset: readUInt64LEAsNumber(record, 48),
	};
}

function readCentralDirectoryInfoSync(bytes: Uint8Array): ZipCentralDirectoryInfo {
	const fileSize = bytes.byteLength;
	if (fileSize < ZIP_EOCD_MIN_LENGTH) {
		throw new ToolError("Invalid ZIP archive: missing end of central directory");
	}

	const tailLength = Math.min(fileSize, ZIP_EOCD_MIN_LENGTH + ZIP_EOCD_MAX_COMMENT_LENGTH);
	const tailStart = fileSize - tailLength;
	const tail = readMemoryRange(bytes, tailStart, fileSize);
	const eocdIndex = findEndOfCentralDirectory(tail);

	if (readUInt16LE(tail, eocdIndex + 4) !== 0 || readUInt16LE(tail, eocdIndex + 6) !== 0) {
		throw new ToolError("Multi-disk ZIP archives are not supported");
	}

	let entries = readUInt16LE(tail, eocdIndex + 10);
	let size = readUInt32LE(tail, eocdIndex + 12);
	let offset = readUInt32LE(tail, eocdIndex + 16);
	const needsZip64 = entries === ZIP_UINT16_MAX || size === ZIP_UINT32_MAX || offset === ZIP_UINT32_MAX;
	const zip64Info = readZip64CentralDirectoryInfoSync(bytes, tailStart + eocdIndex);
	if (zip64Info) {
		({ entries, size, offset } = zip64Info);
	} else if (needsZip64) {
		throw new ToolError("Invalid ZIP archive: missing ZIP64 central directory metadata");
	}

	if (offset + size > fileSize) {
		throw new ToolError("Invalid ZIP archive: central directory exceeds file size");
	}

	return { entries, offset, size };
}

function extractZipMember(bytes: Uint8Array, storage: ZipStorage, uncompressedSize: number): Uint8Array {
	if ((storage.flags & ZIP_ENCRYPTED_FLAG) !== 0) {
		throw new ToolError("Encrypted ZIP entries are not supported");
	}

	const headerStart = storage.localHeaderOffset;
	const localHeader = readMemoryRange(bytes, headerStart, headerStart + 30);
	if (readUInt32LE(localHeader, 0) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) {
		throw new ToolError("Invalid ZIP archive: malformed local file header");
	}

	const fileNameLength = readUInt16LE(localHeader, 26);
	const extraLength = readUInt16LE(localHeader, 28);
	const dataStart = headerStart + 30 + fileNameLength + extraLength;
	const compressed = readMemoryRange(bytes, dataStart, dataStart + storage.compressedSize);
	return decodeZipMember(compressed, storage.compression, uncompressedSize);
}
