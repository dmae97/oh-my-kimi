import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const MAX_EXTENSION_FILES = 256;
const MAX_EXTENSION_BYTES = 1_048_576;

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

export function scanPackageExtensionSources(
	root: string,
	extensions: string[],
): { sources: ScannedPackageSource[]; skipped: string[] } {
	const sources: ScannedPackageSource[] = [];
	const skipped: string[] = [];
	const realRoot = realpathSync(root);
	for (const path of [...new Set(extensions)].slice(0, MAX_EXTENSION_FILES)) {
		const file = packageRelativePath(root, path);
		if (file === null) {
			skipped.push("<outside-package>");
			continue;
		}
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
			sources.push({ file, text: buffer.subarray(0, offset).toString("utf8") });
		} catch {
			skipped.push(file);
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	}
	if (extensions.length > MAX_EXTENSION_FILES) skipped.push("<file-limit>");
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
