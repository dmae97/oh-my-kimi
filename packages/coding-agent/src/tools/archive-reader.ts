import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { inflateSync, strFromU8 } from "fflate";

import { formatBytes } from "./render-utils";
import { ToolError } from "./tool-errors";

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

export type ArchiveFormat = "zip" | "tar" | "tar.gz";

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

interface TarStorage {
	type: "tar";
	file: File;
}

interface ZipStorage {
	type: "zip";
	archivePath: string;
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

function getArchiveFormatFromPath(filePath: string): ArchiveFormat | undefined {
	const normalized = filePath.toLowerCase();
	if (normalized.endsWith(".tar.gz") || normalized.endsWith(".tgz")) return "tar.gz";
	if (normalized.endsWith(".tar")) return "tar";
	if (normalized.endsWith(".zip")) return "zip";
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

async function readZipRange(filePath: string, start: number, end: number): Promise<Uint8Array> {
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
		throw new ToolError("Invalid ZIP archive range");
	}

	const bytes = await Bun.file(filePath).slice(start, end).bytes();
	if (bytes.byteLength !== end - start) {
		throw new ToolError("Invalid ZIP archive: truncated data");
	}
	return bytes;
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
	filePath: string,
	tail: Uint8Array,
	tailStart: number,
	eocdOffset: number,
): Promise<ZipCentralDirectoryInfo | undefined> {
	const locatorOffset = eocdOffset - ZIP64_EOCD_LOCATOR_LENGTH;
	if (locatorOffset < 0) return undefined;

	const locator =
		locatorOffset >= tailStart
			? tail.subarray(locatorOffset - tailStart, locatorOffset - tailStart + ZIP64_EOCD_LOCATOR_LENGTH)
			: await readZipRange(filePath, locatorOffset, eocdOffset);
	if (readUInt32LE(locator, 0) !== ZIP64_EOCD_LOCATOR_SIGNATURE) return undefined;

	const zip64EocdDisk = readUInt32LE(locator, 4);
	const zip64EocdOffset = readUInt64LEAsNumber(locator, 8);
	const totalDisks = readUInt32LE(locator, 16);
	if (zip64EocdDisk !== 0 || totalDisks > 1) {
		throw new ToolError("Multi-disk ZIP archives are not supported");
	}

	const record = await readZipRange(filePath, zip64EocdOffset, zip64EocdOffset + 56);
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

async function readZipCentralDirectoryInfo(filePath: string, fileSize: number): Promise<ZipCentralDirectoryInfo> {
	if (fileSize < ZIP_EOCD_MIN_LENGTH) {
		throw new ToolError("Invalid ZIP archive: missing end of central directory");
	}

	const tailLength = Math.min(fileSize, ZIP_EOCD_MIN_LENGTH + ZIP_EOCD_MAX_COMMENT_LENGTH);
	const tailStart = fileSize - tailLength;
	const tail = await readZipRange(filePath, tailStart, fileSize);
	const eocdIndex = findEndOfCentralDirectory(tail);
	const eocdOffset = tailStart + eocdIndex;

	if (readUInt16LE(tail, eocdIndex + 4) !== 0 || readUInt16LE(tail, eocdIndex + 6) !== 0) {
		throw new ToolError("Multi-disk ZIP archives are not supported");
	}

	let entries = readUInt16LE(tail, eocdIndex + 10);
	let size = readUInt32LE(tail, eocdIndex + 12);
	let offset = readUInt32LE(tail, eocdIndex + 16);
	const needsZip64 = entries === ZIP_UINT16_MAX || size === ZIP_UINT32_MAX || offset === ZIP_UINT32_MAX;
	const zip64Info = await readZip64CentralDirectoryInfo(filePath, tail, tailStart, eocdOffset);
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
	filePath: string,
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

		const rawPath = strFromU8(centralDirectory.subarray(nameStart, extraStart), (flags & ZIP_UTF8_FLAG) === 0);
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
							archivePath: filePath,
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

async function readZipFileBytes(storage: ZipStorage, uncompressedSize: number): Promise<Uint8Array> {
	if ((storage.flags & ZIP_ENCRYPTED_FLAG) !== 0) {
		throw new ToolError("Encrypted ZIP entries are not supported");
	}

	const localHeader = await readZipRange(
		storage.archivePath,
		storage.localHeaderOffset,
		storage.localHeaderOffset + 30,
	);
	if (readUInt32LE(localHeader, 0) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) {
		throw new ToolError("Invalid ZIP archive: malformed local file header");
	}

	const fileNameLength = readUInt16LE(localHeader, 26);
	const extraLength = readUInt16LE(localHeader, 28);
	const dataStart = storage.localHeaderOffset + 30 + fileNameLength + extraLength;
	const compressedBytes = await readZipRange(storage.archivePath, dataStart, dataStart + storage.compressedSize);

	if (storage.compression === ZIP_STORED_COMPRESSION) {
		return compressedBytes;
	}
	if (storage.compression !== ZIP_DEFLATE_COMPRESSION) {
		throw new ToolError(`Unsupported ZIP compression method: ${storage.compression}`);
	}

	try {
		return inflateSync(compressedBytes, { out: new Uint8Array(uncompressedSize) });
	} catch (error) {
		throw new ToolError(error instanceof Error ? error.message : String(error));
	}
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

async function readZipEntries(filePath: string): Promise<ArchiveIndexEntry[]> {
	const fileSize = Bun.file(filePath).size;
	if (!Number.isSafeInteger(fileSize)) {
		throw new ToolError("ZIP archive is too large to read safely");
	}

	const directoryInfo = await readZipCentralDirectoryInfo(filePath, fileSize);
	const centralDirectory = await readZipRange(
		filePath,
		directoryInfo.offset,
		directoryInfo.offset + directoryInfo.size,
	);
	return parseZipCentralDirectory(filePath, centralDirectory, directoryInfo.entries);
}

export function parseArchivePathCandidates(filePath: string): ArchivePathCandidate[] {
	const normalized = filePath.replace(/\\/g, "/");
	const pattern = /\.(?:tar\.gz|tgz|zip|tar)(?=(?::|$))/gi;
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

export async function openArchive(filePath: string): Promise<ArchiveReader> {
	const format = getArchiveFormatFromPath(filePath);
	if (!format) {
		throw new ToolError(`Unsupported archive format: ${filePath}`);
	}

	if (format === "zip") {
		return new ArchiveReader(format, await readZipEntries(filePath));
	}

	const file = Bun.file(filePath);
	const archiveSize = file.size;
	if (archiveSize > MAX_TAR_ARCHIVE_BYTES) {
		throw new ToolError(
			`Archive is too large to read in memory (${formatBytes(archiveSize)} > ${formatBytes(MAX_TAR_ARCHIVE_BYTES)} limit)`,
		);
	}
	const entries = await readTarEntries(await file.bytes());
	return new ArchiveReader(format, entries);
}

export async function listArchiveRoot(
	bytes: Uint8Array,
	format: ArchiveFormat,
	opts: { limit?: number } = {},
): Promise<string> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-archive-"));
	const tempPath = path.join(tempDir, `payload.${format}`);
	try {
		await Bun.write(tempPath, bytes);
		const archive = await openArchive(tempPath);
		const entries = archive.listDirectory("");
		const limitedEntries = opts.limit !== undefined && opts.limit > 0 ? entries.slice(0, opts.limit) : entries;
		const lines = formatArchiveEntryLines(limitedEntries);
		return lines.length > 0 ? lines.join("\n") : "(empty archive directory)";
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}
