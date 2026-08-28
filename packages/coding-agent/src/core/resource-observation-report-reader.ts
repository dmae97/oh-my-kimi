import * as fs from "node:fs";
import * as path from "node:path";
import { RESOURCE_OBSERVATION_JOURNAL_FILE } from "./resource-observation-journal.ts";

const MAX_DIRECTORY_ENTRIES = 5000;
const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;

export interface ResourceJournalCollection {
	readonly journals: readonly string[];
	readonly diagnostics: number;
	readonly truncated: boolean;
}

interface JournalReadResult {
	readonly kind: "missing" | "invalid" | "ok";
	readonly text?: string;
}

export function collectResourceJournalTexts(cwd: string, maxJournals: number): ResourceJournalCollection {
	const root = resolveRunsRoot(cwd);
	if (root.kind === "missing") return { journals: [], diagnostics: 0, truncated: false };
	if (root.kind === "invalid") return { journals: [], diagnostics: 1, truncated: true };
	const journals: string[] = [];
	let diagnostics = 0;
	let truncated = false;
	let visited = 0;
	let directory: fs.Dir | undefined;
	try {
		directory = fs.opendirSync(root.path);
		while (true) {
			const entry = directory.readSync();
			if (entry === null) break;
			visited += 1;
			if (visited > MAX_DIRECTORY_ENTRIES) {
				diagnostics += 1;
				truncated = true;
				break;
			}
			if (entry.isSymbolicLink()) {
				diagnostics += 1;
				truncated = true;
				continue;
			}
			if (!entry.isDirectory()) continue;
			const runDir = safeRealDirectory(root.path, entry.name);
			if (runDir === null) {
				diagnostics += 1;
				truncated = true;
				continue;
			}
			const journalPath = path.join(runDir, RESOURCE_OBSERVATION_JOURNAL_FILE);
			const candidate = inspectJournalCandidate(journalPath);
			if (candidate === "missing") continue;
			if (candidate === "invalid") {
				diagnostics += 1;
				truncated = true;
				continue;
			}
			if (journals.length >= maxJournals) {
				truncated = true;
				break;
			}
			const read = readBoundedJournal(journalPath);
			if (read.kind !== "ok" || read.text === undefined) {
				diagnostics += 1;
				truncated = true;
				continue;
			}
			journals.push(read.text);
		}
	} catch {
		diagnostics += 1;
		truncated = true;
	} finally {
		directory?.closeSync();
	}
	return { journals, diagnostics, truncated };
}

function resolveRunsRoot(
	cwd: string,
): { readonly kind: "missing" } | { readonly kind: "invalid" } | { readonly kind: "ok"; readonly path: string } {
	try {
		const root = fs.realpathSync(cwd);
		const omkDir = path.join(root, ".omk");
		const runsDir = path.join(omkDir, "runs");
		for (const candidate of [omkDir, runsDir]) {
			const stat = fs.lstatSync(candidate);
			if (stat.isSymbolicLink() || !stat.isDirectory()) return { kind: "invalid" };
		}
		const realRuns = fs.realpathSync(runsDir);
		return isWithin(root, realRuns) ? { kind: "ok", path: realRuns } : { kind: "invalid" };
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "invalid" };
	}
}

function safeRealDirectory(root: string, name: string): string | null {
	try {
		const candidate = path.join(root, name);
		const before = fs.lstatSync(candidate);
		if (before.isSymbolicLink() || !before.isDirectory()) return null;
		const real = fs.realpathSync(candidate);
		return isWithin(root, real) ? real : null;
	} catch {
		return null;
	}
}

function inspectJournalCandidate(filePath: string): "missing" | "invalid" | "valid" {
	try {
		const stat = fs.lstatSync(filePath);
		if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_JOURNAL_BYTES) return "invalid";
		return "valid";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "invalid";
	}
}

function readBoundedJournal(filePath: string): JournalReadResult {
	let descriptor: number | undefined;
	try {
		const before = fs.lstatSync(filePath);
		if (before.isSymbolicLink() || !before.isFile()) return { kind: "invalid" };
		descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		const opened = fs.fstatSync(descriptor);
		if (
			!opened.isFile() ||
			opened.dev !== before.dev ||
			opened.ino !== before.ino ||
			opened.size > MAX_JOURNAL_BYTES
		) {
			return { kind: "invalid" };
		}
		const buffer = Buffer.alloc(MAX_JOURNAL_BYTES + 1);
		let bytesRead = 0;
		while (bytesRead < buffer.length) {
			const count = fs.readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
			if (count === 0) break;
			bytesRead += count;
		}
		const after = fs.fstatSync(descriptor);
		if (
			bytesRead > MAX_JOURNAL_BYTES ||
			after.dev !== opened.dev ||
			after.ino !== opened.ino ||
			after.size !== opened.size
		) {
			return { kind: "invalid" };
		}
		return { kind: "ok", text: buffer.subarray(0, bytesRead).toString("utf8") };
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "invalid" };
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
	}
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
