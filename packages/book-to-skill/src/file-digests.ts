import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, type Stats } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { type ArtifactDigest, PROVENANCE_FILE_NAME, type SourceDigest } from "./types.ts";

const MAX_ARTIFACT_FILES = 1_000;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024;
const HASH_BUFFER_BYTES = 64 * 1024;

function regularFileStat(path: string, maxBytes: number) {
	const stat = lstatSync(path);
	if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link: ${path}`);
	if (!stat.isFile()) throw new Error(`Expected a regular file: ${path}`);
	if (!Number.isSafeInteger(stat.size) || stat.size > maxBytes) {
		throw new Error(`File exceeds the ${maxBytes}-byte verification limit: ${path}`);
	}
	return stat;
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function hashFile(path: string, maxBytes: number): { bytes: number; sha256: string } {
	const pathStat = regularFileStat(path, maxBytes);
	const hash = createHash("sha256");
	const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
	const descriptor = openSync(path, "r");
	let openedStat: ReturnType<typeof fstatSync>;
	try {
		openedStat = fstatSync(descriptor);
		if (!openedStat.isFile() || !sameFileIdentity(pathStat, openedStat) || openedStat.size !== pathStat.size) {
			throw new Error(`File changed while opening: ${path}`);
		}
		let totalBytes = 0;
		let bytesRead = 0;
		do {
			bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
			if (bytesRead > 0) {
				totalBytes += bytesRead;
				if (totalBytes > maxBytes) throw new Error(`File changed beyond the verification limit: ${path}`);
				hash.update(buffer.subarray(0, bytesRead));
			}
		} while (bytesRead > 0);
		const finalStat = fstatSync(descriptor);
		if (
			totalBytes !== openedStat.size ||
			!sameFileIdentity(openedStat, finalStat) ||
			finalStat.size !== openedStat.size ||
			finalStat.mtimeMs !== openedStat.mtimeMs ||
			finalStat.ctimeMs !== openedStat.ctimeMs
		) {
			throw new Error(`File changed while hashing: ${path}`);
		}
	} finally {
		closeSync(descriptor);
	}
	const finalPathStat = regularFileStat(path, maxBytes);
	if (!sameFileIdentity(openedStat, finalPathStat) || finalPathStat.size !== openedStat.size) {
		throw new Error(`File path changed while hashing: ${path}`);
	}
	return { bytes: openedStat.size, sha256: hash.digest("hex") };
}

function toPosixRelative(root: string, path: string): string {
	return relative(root, path).split(sep).join("/");
}

function assertSkillDirectory(skillDir: string): void {
	const stat = lstatSync(skillDir);
	if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link skill directory: ${skillDir}`);
	if (!stat.isDirectory()) throw new Error(`Expected a skill directory: ${skillDir}`);
}

export function digestSources(paths: readonly string[]): SourceDigest[] {
	return paths.map((path, index) => {
		const digest = hashFile(path, MAX_SOURCE_BYTES);
		return Object.freeze({ id: `source-${index + 1}`, name: basename(path), ...digest });
	});
}

export function collectArtifactDigests(skillDir: string): ArtifactDigest[] {
	assertSkillDirectory(skillDir);
	const files: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			const path = join(directory, entry.name);
			const stat = lstatSync(path);
			if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link artifact: ${path}`);
			if (stat.isDirectory()) visit(path);
			else if (stat.isFile() && entry.name !== PROVENANCE_FILE_NAME) files.push(path);
			else if (!stat.isFile()) throw new Error(`Unsupported artifact type: ${path}`);
		}
	};
	visit(skillDir);
	if (files.length > MAX_ARTIFACT_FILES) throw new Error(`Skill exceeds ${MAX_ARTIFACT_FILES} artifact files`);

	let totalBytes = 0;
	const digests = files.map((path) => {
		const digest = hashFile(path, MAX_ARTIFACT_BYTES);
		totalBytes += digest.bytes;
		return Object.freeze({ path: toPosixRelative(skillDir, path), ...digest });
	});
	if (totalBytes > MAX_TOTAL_ARTIFACT_BYTES) {
		throw new Error(`Skill artifacts exceed ${MAX_TOTAL_ARTIFACT_BYTES} bytes`);
	}
	if (!digests.some((entry) => entry.path === "SKILL.md")) throw new Error("Generated skill is missing SKILL.md");
	return digests.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
