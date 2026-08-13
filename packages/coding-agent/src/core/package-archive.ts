import {
	closeSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";

const TAR_BLOCK_BYTES = 512;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 10_000;

function text(buffer: Buffer): string {
	const end = buffer.indexOf(0);
	return buffer.subarray(0, end === -1 ? buffer.length : end).toString("utf8");
}

function octal(buffer: Buffer, label: string): number {
	const value = text(buffer).trim();
	if (!/^[0-7]+$/u.test(value)) throw new Error(`Invalid tar ${label}`);
	const parsed = Number.parseInt(value, 8);
	if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid tar ${label}`);
	return parsed;
}

function checksum(header: Buffer): void {
	const declared = octal(header.subarray(148, 156), "checksum");
	let actual = 0;
	for (let index = 0; index < header.length; index += 1) {
		actual += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
	}
	if (actual !== declared) throw new Error("Invalid tar checksum");
}

function parsePax(payload: Buffer): Map<string, string> {
	const fields = new Map<string, string>();
	let offset = 0;
	while (offset < payload.length) {
		const space = payload.indexOf(0x20, offset);
		if (space < 0) throw new Error("Invalid tar PAX record");
		const lengthText = payload.subarray(offset, space).toString("ascii");
		if (!/^\d+$/u.test(lengthText)) throw new Error("Invalid tar PAX record length");
		const length = Number.parseInt(lengthText, 10);
		if (!Number.isSafeInteger(length) || length <= 0 || offset + length > payload.length) {
			throw new Error("Invalid tar PAX record length");
		}
		const record = payload.subarray(space + 1, offset + length - 1).toString("utf8");
		const equals = record.indexOf("=");
		if (equals > 0) fields.set(record.slice(0, equals), record.slice(equals + 1));
		offset += length;
	}
	return fields;
}

function safePackagePath(rawPath: string): string[] {
	if (!rawPath || rawPath.includes("\0") || rawPath.includes("\\") || rawPath.startsWith("/")) {
		throw new Error("Npm tarball contains an unsafe path");
	}
	const trimmed = rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
	const segments = trimmed.split("/");
	if (segments[0] !== "package") throw new Error("Npm tarball entries must stay under package/");
	const relativeSegments = segments.slice(1);
	if (relativeSegments.some((segment) => !segment || segment === "." || segment === "..")) {
		throw new Error("Npm tarball contains an unsafe path");
	}
	return relativeSegments;
}

function assertInside(root: string, path: string): void {
	const fromRoot = relative(root, path);
	if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
		throw new Error("Npm tarball contains an unsafe path");
	}
}

function ensureDirectory(root: string, segments: string[]): string {
	let current = root;
	for (const segment of segments) {
		current = join(current, segment);
		if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
		const stats = lstatSync(current);
		if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("Npm tarball path is not a safe directory");
	}
	return current;
}

function writeExclusiveFile(path: string, content: Buffer): void {
	const descriptor = openSync(
		path,
		constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
		0o600,
	);
	try {
		writeFileSync(descriptor, content);
	} finally {
		closeSync(descriptor);
	}
}

/** Extract registry tarball files only. Links and special entries fail closed. */
export function extractNpmPackageTarball(archivePath: string, destination: string): void {
	if (existsSync(destination)) throw new Error("Npm package extraction destination already exists");
	const archive = readFileSync(archivePath);
	if (archive.length > MAX_ARCHIVE_BYTES) throw new Error("Npm package archive exceeds the size limit");
	const root = resolve(destination);
	let expanded: Buffer;
	try {
		expanded = gunzipSync(archive, { maxOutputLength: MAX_EXPANDED_BYTES });
	} catch {
		throw new Error("Npm package archive is not a bounded gzip stream");
	}
	mkdirSync(root, { recursive: true, mode: 0o700 });
	let offset = 0;
	let files = 0;
	let nextPath: string | undefined;
	try {
		while (offset + TAR_BLOCK_BYTES <= expanded.length) {
			const header = expanded.subarray(offset, offset + TAR_BLOCK_BYTES);
			offset += TAR_BLOCK_BYTES;
			if (header.every((byte) => byte === 0)) break;
			checksum(header);
			const size = octal(header.subarray(124, 136), "entry size");
			if (size > MAX_FILE_BYTES || offset + size > expanded.length)
				throw new Error("Npm tarball entry exceeds the size limit");
			const payload = expanded.subarray(offset, offset + size);
			offset += Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
			const type = String.fromCharCode(header[156] ?? 0);
			const headerPath = [text(header.subarray(345, 500)), text(header.subarray(0, 100))].filter(Boolean).join("/");
			if (type === "x") {
				nextPath = parsePax(payload).get("path") ?? nextPath;
				continue;
			}
			if (type === "g") continue;
			if (type === "L") {
				nextPath = text(payload).replace(/\n$/u, "");
				continue;
			}
			const segments = safePackagePath(nextPath ?? headerPath);
			nextPath = undefined;
			if (segments.length === 0) continue;
			const path = resolve(root, ...segments);
			assertInside(root, path);
			if (type === "5") {
				ensureDirectory(root, segments);
				continue;
			}
			if (type !== "0" && type !== "\0") throw new Error(`Npm tarball contains unsupported entry type ${type}`);
			files += 1;
			if (files > MAX_FILES) throw new Error("Npm package contains too many files");
			ensureDirectory(root, segments.slice(0, -1));
			writeExclusiveFile(path, payload);
		}
	} catch (error) {
		rmSync(root, { recursive: true, force: true });
		throw error;
	}
}
