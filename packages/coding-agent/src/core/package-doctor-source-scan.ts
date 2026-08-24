import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const MAX_EXTENSION_FILES = 256;
const MAX_EXTENSION_BYTES = 1_048_576;
const SOURCE_EXTENSIONS = [".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"] as const;

export const PACKAGE_DOCTOR_SUPPORTED_EVENTS = new Set([
	"resources_discover",
	"session_start",
	"session_before_switch",
	"session_before_fork",
	"session_before_compact",
	"session_compact",
	"session_shutdown",
	"session_before_tree",
	"session_tree",
	"context",
	"before_provider_request",
	"after_provider_response",
	"before_agent_start",
	"agent_start",
	"agent_end",
	"agent_settled",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"model_select",
	"thinking_level_select",
	"tool_call",
	"tool_result",
	"user_bash",
	"input",
]);

export interface ScannedPackageSource {
	file: string;
	text: string;
}

function packageRelativePath(root: string, path: string): string | null {
	const candidate = relative(root, resolve(path));
	if (!candidate || candidate === ".") return candidate || ".";
	if (candidate === ".." || candidate.startsWith(`..${sep}`) || isAbsolute(candidate)) return null;
	return candidate.replace(/\\/gu, "/");
}

/**
 * True only for an existing regular file. A bare `existsSync` also matches the
 * directory a specifier like `./nested` names, which would shadow its real
 * `./nested/index.ts` target.
 */
function isFilePath(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** Candidate on-disk paths for one relative import specifier. */
function resolutionCandidates(fromFile: string, specifier: string): string[] {
	const base = resolve(dirname(fromFile), specifier);
	const candidates = [base];
	for (const extension of SOURCE_EXTENSIONS) {
		candidates.push(`${base}${extension}`, resolve(base, `index${extension}`));
	}
	// TypeScript source commonly imports its own emitted specifier (`./x.js`).
	const rewritten = base.replace(/\.(?:js|mjs|cjs|jsx)$/u, "");
	if (rewritten !== base) {
		for (const extension of SOURCE_EXTENSIONS) candidates.push(`${rewritten}${extension}`);
	}
	return candidates;
}

/**
 * Relative imports of `text` that resolve to a real file inside the package.
 * Bare specifiers (`node:fs`, `some-package`) are dependencies, not package
 * source, and anything resolving outside the root is dropped rather than read.
 */
function relativeImportTargets(root: string, fromFile: string, text: string): string[] {
	const targets: string[] = [];
	for (const specifier of importedSpecifiers(text)) {
		if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;
		for (const candidate of resolutionCandidates(fromFile, specifier)) {
			if (packageRelativePath(root, candidate) === null) continue;
			if (!isFilePath(candidate)) continue;
			targets.push(candidate);
			break;
		}
	}
	return targets;
}

/**
 * Read every package-owned extension source reachable from the manifest entries.
 *
 * Scanning only the declared entry files made the compatibility verdict wrong
 * for any package that keeps handlers in imported modules, so the walk follows
 * relative imports transitively. Package-external reads stay impossible: a
 * candidate must resolve inside the root, and each open still verifies the
 * realpath, refuses symlinks, and matches device/inode before reading.
 */
export function scanPackageExtensionSources(
	root: string,
	extensions: string[],
): { sources: ScannedPackageSource[]; skipped: string[] } {
	const sources: ScannedPackageSource[] = [];
	const skipped: string[] = [];
	const realRoot = realpathSync(root);
	const seen = new Set<string>();
	const queue = [...new Set(extensions)];
	let truncated = extensions.length > MAX_EXTENSION_FILES;

	while (queue.length > 0) {
		if (sources.length >= MAX_EXTENSION_FILES) {
			truncated = true;
			break;
		}
		const path = queue.shift() as string;
		const file = packageRelativePath(root, path);
		if (file === null) {
			skipped.push("<outside-package>");
			continue;
		}
		if (seen.has(file)) continue;
		seen.add(file);
		let fd: number | undefined;
		try {
			const realPath = realpathSync(path);
			if (packageRelativePath(realRoot, realPath) === null) {
				skipped.push("<outside-package>");
				continue;
			}
			const expected = statSync(realPath);
			fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
			const opened = fstatSync(fd);
			if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino) {
				skipped.push(file);
				continue;
			}
			const buffer = Buffer.alloc(MAX_EXTENSION_BYTES + 1);
			let offset = 0;
			while (offset < buffer.length) {
				const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
				if (read === 0) break;
				offset += read;
			}
			if (offset > MAX_EXTENSION_BYTES) {
				skipped.push(file);
				continue;
			}
			const text = buffer.subarray(0, offset).toString("utf8");
			sources.push({ file, text });
			queue.push(...relativeImportTargets(root, path, text));
		} catch {
			skipped.push(file);
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	}
	if (truncated) skipped.push("<file-limit>");
	return { sources, skipped };
}

export function importedSpecifiers(text: string): string[] {
	const specifiers = new Set<string>();
	const patterns = [
		/\b(?:import|export)\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']/gu,
		/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/gu,
	];
	for (const pattern of patterns) {
		for (const match of text.matchAll(pattern)) {
			if (match[1]) specifiers.add(match[1]);
		}
	}
	return [...specifiers];
}

export function subscribedEvents(text: string): string[] {
	const events: string[] = [];
	for (const match of text.matchAll(/\b(?:api|omk|pi)\.on\(\s*["']([^"']+)["']/gu)) {
		if (match[1] !== undefined) events.push(match[1]);
	}
	return events;
}

export function sourceFilesMatching(sources: ScannedPackageSource[], predicate: (text: string) => boolean): string[] {
	const files: string[] = [];
	for (const source of sources) {
		if (predicate(source.text)) files.push(source.file);
	}
	return files;
}
