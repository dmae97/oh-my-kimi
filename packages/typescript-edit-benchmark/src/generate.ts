#!/usr/bin/env bun
/**
 * Generate edit benchmark cases from TypeScript sources in a pi-mono-style repo.
 *
 * The goal is testing edit precision, not bug-finding ability. The mutation can
 * be trivial - what matters is whether the model can surgically apply the patch
 * in difficult contexts:
 *
 * - Repeated lines: The exact target line appears multiple times
 * - Long files: 300+ lines with edit in the middle
 * - Similar blocks: Multiple structurally similar functions
 * - Dense code: Minimal whitespace makes context harder to read
 * - Deep nesting: Whitespace-sensitive edits at high indent levels
 *
 * Difficulty modes control both FILE SELECTION and PROMPT DETAIL:
 * - easy: Short files, unique lines, line number given
 * - medium: Medium files, function context given
 * - hard: Long files with similar blocks, no location hint
 * - nightmare: Long files where target line repeats, minimal info
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { diffLines } from "diff";
import { formatContent } from "./formatter";
import { ALL_MUTATIONS, CATEGORY_MAP, type Mutation, type MutationInfo } from "./mutations";

const SUPPORTED_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);
using DEFAULT_SOURCE_REPO_DIR = TempDir.createSync("@pi-mono-source");
const DEFAULT_OUTPUT = path.join(import.meta.dir, "../fixtures.tar.gz");
/** Default when no `--typescript-dir` is passed: shallow-clone this repo and scan `packages/`. */
const DEFAULT_SOURCE_REPO_URL = "https://github.com/badlogic/pi-mono.git";

const EXCLUDE_DIRS = new Set([
	"__tests__",
	"__mocks__",
	"fixtures",
	"fixture",
	"dist",
	"build",
	"node_modules",
	"scripts",
]);

type Difficulty = "easy" | "medium" | "hard" | "nightmare";

interface FileEntry {
	path: string;
	content: string;
	lineCount: number;
	repeatedLines: Map<string, number[]>;
	similarBlockCount: number;
	density: number;
	maxIndent: number;
	functionRanges: Array<[string, number, number]>;
}

interface CaseResult {
	caseId: string;
	mutation: Mutation;
	finalInfo: MutationInfo;
	filePath: string;
	formattedMutatedContent: string;
	formattedOriginalContent: string;
	difficulty: Difficulty;
	difficultyScore: number;
}

interface Args {
	typescriptDir: string;
	output: string;
	countPerType: number;
	seed: number;
	categories: string | null;
	difficulty: string;
	minScore: number | null;
	dryRun: boolean;
}

function parseArguments(): Args {
	const { values } = parseArgs({
		options: {
			"typescript-dir": { type: "string", default: DEFAULT_SOURCE_REPO_DIR.path() },
			output: { type: "string", default: DEFAULT_OUTPUT },
			"count-per-type": { type: "string", default: "20" },
			seed: { type: "string", default: "42" },
			categories: { type: "string" },
			difficulty: { type: "string", default: "easy,medium,hard,nightmare" },
			"min-score": { type: "string" },
			"dry-run": { type: "boolean", default: false },
		},
	});

	return {
		typescriptDir: values["typescript-dir"] ?? DEFAULT_SOURCE_REPO_DIR.path(),
		output: values.output ?? DEFAULT_OUTPUT,
		countPerType: parseInt(values["count-per-type"] ?? "20", 10),
		seed: parseInt(values.seed ?? "42", 10),
		categories: values.categories ?? null,
		difficulty: values.difficulty ?? "easy,medium,hard,nightmare",
		minScore: values["min-score"] ? parseInt(values["min-score"], 10) : null,
		dryRun: values["dry-run"] ?? false,
	};
}

async function ensureSourceRepo(typescriptDir: string): Promise<void> {
	if (fs.existsSync(typescriptDir)) {
		const packagesDir = path.join(typescriptDir, "packages");
		if (fs.existsSync(packagesDir) && fs.statSync(packagesDir).isDirectory()) return;
		throw new Error(`Directory exists but missing packages/: ${typescriptDir}`);
	}

	console.log(`Cloning pi-mono repository to ${typescriptDir}…`);
	fs.mkdirSync(path.dirname(typescriptDir), { recursive: true });
	const result = await $`git clone --depth 1 ${DEFAULT_SOURCE_REPO_URL} ${typescriptDir}`.quiet().nothrow();
	if (result.exitCode !== 0) {
		const decoder = new TextDecoder();
		const stderr = result.stderr ? decoder.decode(result.stderr) : "";
		throw new Error(`Failed to clone pi-mono: ${stderr.trim()}`);
	}
	console.log("Clone complete.");
}

function isExcluded(filePath: string): boolean {
	const parts = filePath.split("/");
	for (const part of parts) {
		if (EXCLUDE_DIRS.has(part)) return true;
	}
	const filename = path.basename(filePath);
	if (filename.includes(".test.") || filename.includes(".spec.") || filename.includes(".fixture.")) {
		return true;
	}
	return false;
}

function hasStructure(content: string): boolean {
	return ["function ", "class ", "export ", "=>"].some(token => content.includes(token));
}

async function collectFiles(typescriptDir: string): Promise<string[]> {
	const sourceDir = path.join(typescriptDir, "packages");
	const candidates: string[] = [];

	async function walk(dir: string): Promise<void> {
		if (isExcluded(dir)) return;
		const entries = await fs.promises.readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(fullPath);
			} else if (entry.isFile()) {
				const ext = `.${entry.name.split(".").pop()}`;
				if (SUPPORTED_EXTENSIONS.has(ext) && !isExcluded(fullPath)) {
					candidates.push(fullPath);
				}
			}
		}
	}

	await walk(sourceDir);
	return candidates.sort();
}

async function readFileAsync(filePath: string): Promise<string> {
	return Bun.file(filePath).text();
}

function findRepeatedLines(content: string, minRepeats = 2): Map<string, number[]> {
	const lines = content.split("\n");
	const positions = new Map<string, number[]>();
	const trivial = new Set(["{", "}", "};", ");", "],", "});", "return;", "break;", "continue;", ""]);

	for (let i = 0; i < lines.length; i++) {
		const stripped = lines[i].trim();
		if (stripped.length < 10 || trivial.has(stripped)) continue;
		const pos = positions.get(stripped) ?? [];
		pos.push(i + 1);
		positions.set(stripped, pos);
	}

	const result = new Map<string, number[]>();
	for (const [line, pos] of positions) {
		if (pos.length >= minRepeats) {
			result.set(line, pos);
		}
	}
	return result;
}

function countSimilarBlocks(content: string): number {
	const funcPattern = /(?:function\s+(\w+)|const\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>)/g;
	const matches = [...content.matchAll(funcPattern)];
	return matches.length;
}

function computeDensity(content: string): number {
	if (!content) return 0;
	const nonWs = content.replace(/[\s\n\t]/g, "").length;
	return nonWs / content.length;
}

function findMaxIndent(content: string): number {
	let maxIndent = 0;
	for (const line of content.split("\n")) {
		if (line.trim()) {
			const indent = line.length - line.trimStart().length;
			maxIndent = Math.max(maxIndent, indent);
		}
	}
	return maxIndent;
}

function findFunctionRanges(content: string): Array<[string, number, number]> {
	const lines = content.split("\n");
	const ranges: Array<[string, number, number]> = [];
	const funcPattern = /(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>)/;

	let braceDepth = 0;
	let currentFunc: string | null = null;
	let funcStart = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const match = funcPattern.exec(line);
		if (match && braceDepth === 0) {
			if (currentFunc) {
				ranges.push([currentFunc, funcStart, i]);
			}
			currentFunc = match[1] ?? match[2];
			funcStart = i + 1;
		}

		braceDepth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;

		if (currentFunc && braceDepth === 0 && line.includes("}")) {
			ranges.push([currentFunc, funcStart, i + 1]);
			currentFunc = null;
		}
	}

	if (currentFunc) {
		ranges.push([currentFunc, funcStart, lines.length]);
	}

	return ranges;
}

async function analyzeFile(filePath: string): Promise<FileEntry> {
	const content = await readFileAsync(filePath);
	const lines = content.split("\n");
	return {
		path: filePath,
		content,
		lineCount: lines.length,
		repeatedLines: findRepeatedLines(content),
		similarBlockCount: countSimilarBlocks(content),
		density: computeDensity(content),
		maxIndent: findMaxIndent(content),
		functionRanges: findFunctionRanges(content),
	};
}

async function filterFiles(paths: string[], minLines = 30, maxLines = 800): Promise<FileEntry[]> {
	const filtered: FileEntry[] = [];
	for (const filePath of paths) {
		const content = await readFileAsync(filePath);
		const lineCount = content.split("\n").length;
		if (lineCount < minLines || lineCount > maxLines) continue;
		if (!hasStructure(content)) continue;
		const entry = await analyzeFile(filePath);
		filtered.push(entry);
	}
	return filtered;
}

function scoreDifficulty(entry: FileEntry, lineNumber: number): number {
	let score = 0;
	const lines = entry.content.split("\n");
	if (lineNumber < 1 || lineNumber > lines.length) return 0;

	const lineContent = lines[lineNumber - 1].trim();

	// File length bonus
	if (entry.lineCount > 300) score += 3;
	else if (entry.lineCount > 150) score += 1;

	// Middle of file bonus
	const middleStart = entry.lineCount * 0.33;
	const middleEnd = entry.lineCount * 0.66;
	if (lineNumber >= middleStart && lineNumber <= middleEnd) score += 2;

	// Repeated line bonus
	if (entry.repeatedLines.has(lineContent)) {
		const repeatCount = entry.repeatedLines.get(lineContent)!.length;
		score += Math.min(repeatCount, 5);
	}

	// Similar function blocks bonus
	if (entry.similarBlockCount >= 5) score += 3;
	else if (entry.similarBlockCount >= 3) score += 1;

	// Dense code bonus
	if (entry.density > 0.75) score += 2;
	else if (entry.density > 0.65) score += 1;

	// Deep nesting bonus
	const lineIndent = lines[lineNumber - 1].length - lines[lineNumber - 1].trimStart().length;
	if (lineIndent >= 16) score += 2;
	else if (lineIndent >= 8) score += 1;

	// Generic context penalty
	const trivialLines = new Set(["{", "}", "};", ");", "});", "return;", "break;", "continue;", ""]);
	const contextStart = Math.max(0, lineNumber - 3);
	const contextEnd = Math.min(lines.length, lineNumber + 2);
	let trivialContext = 0;
	for (let i = contextStart; i < contextEnd; i++) {
		if (trivialLines.has(lines[i].trim())) trivialContext++;
	}
	if (trivialContext >= 3) score += 2;

	// Similar variable names nearby
	const funcName = findContainingFunction(entry, lineNumber);
	if (funcName) {
		for (const [name, start, end] of entry.functionRanges) {
			if (name === funcName) {
				const funcLines = lines.slice(start - 1, end);
				const identifiers = new Set(funcLines.join("\n").match(/\b[a-z][a-zA-Z0-9]*\b/g) ?? []);
				let similarPairs = 0;
				const ids = Array.from(identifiers);
				for (const a of ids) {
					for (const b of ids) {
						if (a !== b && (a.startsWith(b) || b.startsWith(a) || a.includes(b) || b.includes(a))) {
							similarPairs++;
						}
					}
				}
				if (similarPairs >= 3) score += 2;
				break;
			}
		}
	}

	return score;
}

function findContainingFunction(entry: FileEntry, lineNumber: number): string | null {
	for (const [name, start, end] of entry.functionRanges) {
		if (lineNumber >= start && lineNumber <= end) return name;
	}
	return null;
}

function getCandidatesForDifficulty(files: FileEntry[], difficulty: Difficulty): FileEntry[] {
	switch (difficulty) {
		case "easy":
			return files.filter(f => f.lineCount < 150 && f.repeatedLines.size < 3);
		case "medium":
			return files.filter(f => f.lineCount >= 100 && f.lineCount <= 300);
		case "hard":
			return files.filter(f => f.lineCount > 200 && f.similarBlockCount >= 3);
		case "nightmare":
			return files.filter(f => f.repeatedLines.size > 0 && f.lineCount > 200);
		default:
			return files;
	}
}

function regionAvailable(usedLines: Map<string, number[]>, filePath: string, lineNumber: number): boolean {
	const used = usedLines.get(filePath) ?? [];
	return !used.some(ln => Math.abs(ln - lineNumber) <= 3);
}

function recordRegion(usedLines: Map<string, number[]>, filePath: string, lineNumber: number): void {
	const used = usedLines.get(filePath) ?? [];
	used.push(lineNumber);
	usedLines.set(filePath, used);
}

function buildPrompt(
	filePath: string,
	mutation: Mutation,
	info: MutationInfo,
	difficulty: Difficulty,
	entry: FileEntry,
): string {
	const header = `# Fix the bug in \`${path.basename(filePath)}\``;

	const isStructural = mutation.category === "structural";
	const isMultiEdit = mutation.name === "identifier-multi-edit";

	if (difficulty === "easy") {
		const detail = mutation.describe(info);
		const location = isStructural
			? `The issue starts around line ${info.lineNumber}.`
			: `The issue is on line ${info.lineNumber}.`;
		return [header, detail, location, mutation.fixHint].join("\n\n");
	}

	if (difficulty === "medium") {
		const detail = mutation.describe(info);
		const funcName = findContainingFunction(entry, info.lineNumber);
		let location: string;
		if (funcName) {
			location = `The issue is in the \`${funcName}\` function.`;
		} else {
			const ratio = entry.lineCount ? info.lineNumber / entry.lineCount : 0;
			if (ratio < 0.33) location = "The issue is near the top of the file.";
			else if (ratio < 0.66) location = "The issue is around the middle of the file.";
			else location = "The issue is near the end of the file.";
		}
		if (isMultiEdit) {
			location += " The same error appears in multiple places.";
		}
		return [header, detail, location, mutation.fixHint].join("\n\n");
	}

	if (difficulty === "hard") {
		const detail = mutation.describe(info);
		if (isMultiEdit) {
			return [header, detail, "Find and fix all occurrences of this issue."].join("\n\n");
		}
		if (isStructural) {
			return [header, detail, "The fix may involve multiple lines."].join("\n\n");
		}
		return [header, detail, "Find and fix this issue."].join("\n\n");
	}

	// nightmare
	if (isStructural) {
		return [header, "There is a structural bug in this file.", "Track it down and fix it with a minimal edit."].join(
			"\n\n",
		);
	}
	if (isMultiEdit) {
		return [
			header,
			"An identifier is consistently misspelled throughout this file.",
			"Find all occurrences and fix them.",
		].join("\n\n");
	}
	return [header, "There is a subtle bug in this file.", "Track it down and fix it with a minimal edit."].join("\n\n");
}

function createSeededRng(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		return state / 0x7fffffff;
	};
}

function countChangedHunks(original: string, mutated: string): number {
	const changes = diffLines(original, mutated);
	let hunks = 0;
	let inChangedChunk = false;
	for (const change of changes) {
		if (change.added || change.removed) {
			if (!inChangedChunk) {
				hunks++;
				inChangedChunk = true;
			}
		} else {
			inChangedChunk = false;
		}
	}
	return hunks;
}

function countChangedLines(original: string, mutated: string): number {
	const changes = diffLines(original, mutated);
	let changedLines = 0;
	for (const change of changes) {
		if (!change.added && !change.removed) continue;
		const split = change.value.split("\n");
		changedLines += split.filter((line, idx) => idx < split.length - 1 || line.length > 0).length;
	}
	return changedLines;
}

function countPositionalLineChanges(original: string, mutated: string): number {
	const originalLines = original.split("\n");
	const mutatedLines = mutated.split("\n");
	const max = Math.max(originalLines.length, mutatedLines.length);
	let changed = 0;
	for (let i = 0; i < max; i++) {
		if ((originalLines[i] ?? "") !== (mutatedLines[i] ?? "")) {
			changed++;
		}
	}
	return changed;
}

function countPositionalLineHunks(original: string, mutated: string): number {
	const originalLines = original.split("\n");
	const mutatedLines = mutated.split("\n");
	const max = Math.max(originalLines.length, mutatedLines.length);
	let hunks = 0;
	let inChanged = false;
	for (let i = 0; i < max; i++) {
		const changed = (originalLines[i] ?? "") !== (mutatedLines[i] ?? "");
		if (changed) {
			if (!inChanged) {
				hunks++;
				inChanged = true;
			}
		} else {
			inChanged = false;
		}
	}
	return hunks;
}

function splitChangedLines(value: string): string[] {
	const lines = value.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines;
}

interface DiffHunk {
	oldStart: number;
	oldEnd: number;
	newStart: number;
	newEnd: number;
	removedLines: string[];
	addedLines: string[];
}

function distanceToRange(lineNumber: number, start: number, end: number): number {
	if (start > end) return Math.abs(lineNumber - start);
	if (lineNumber < start) return start - lineNumber;
	if (lineNumber > end) return lineNumber - end;
	return 0;
}

function resolveLineForHunk(hunk: DiffHunk, fallbackLine: number, maxLine: number): number {
	if (maxLine <= 0) return 1;
	if (hunk.newStart <= hunk.newEnd) {
		return Math.max(hunk.newStart, Math.min(fallbackLine, hunk.newEnd));
	}
	return Math.max(1, Math.min(hunk.newStart, maxLine));
}

function snippetFromChangedLines(changedLines: string[], fallbackLines: string[], lineNumber: number): string {
	if (changedLines.length > 0) {
		return changedLines.slice(0, 3).join("\n");
	}
	const fallback = fallbackLines[lineNumber - 1] ?? "";
	return fallback.trim() ? fallback : "";
}

function resolveFormattedMutationInfo(
	originalContent: string,
	mutatedContent: string,
	fallbackInfo: MutationInfo,
): MutationInfo | null {
	const changes = diffLines(originalContent, mutatedContent);
	const hunks: DiffHunk[] = [];
	let oldLine = 1;
	let newLine = 1;
	let index = 0;

	while (index < changes.length) {
		const change = changes[index];
		if (!change.added && !change.removed) {
			const unchangedCount = splitChangedLines(change.value).length;
			oldLine += unchangedCount;
			newLine += unchangedCount;
			index++;
			continue;
		}

		const hunk: DiffHunk = {
			oldStart: oldLine,
			oldEnd: oldLine - 1,
			newStart: newLine,
			newEnd: newLine - 1,
			removedLines: [],
			addedLines: [],
		};

		while (index < changes.length) {
			const part = changes[index];
			if (!part.added && !part.removed) break;
			const lines = splitChangedLines(part.value);
			if (part.removed) {
				hunk.removedLines.push(...lines);
				oldLine += lines.length;
				hunk.oldEnd = oldLine - 1;
			}
			if (part.added) {
				hunk.addedLines.push(...lines);
				newLine += lines.length;
				hunk.newEnd = newLine - 1;
			}
			index++;
		}

		hunks.push(hunk);
	}

	if (hunks.length === 0) return null;

	let chosen = hunks[0];
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const hunk of hunks) {
		const oldDistance = distanceToRange(fallbackInfo.lineNumber, hunk.oldStart, hunk.oldEnd);
		const newDistance = distanceToRange(fallbackInfo.lineNumber, hunk.newStart, hunk.newEnd);
		const distance = Math.min(oldDistance, newDistance);
		if (distance < bestDistance) {
			bestDistance = distance;
			chosen = hunk;
		}
	}

	const mutatedLines = mutatedContent.split("\n");
	const originalLines = originalContent.split("\n");
	const lineNumber = resolveLineForHunk(chosen, fallbackInfo.lineNumber, mutatedLines.length);
	if (lineNumber < 1 || lineNumber > Math.max(mutatedLines.length, 1)) return null;

	const resolved: MutationInfo = {
		lineNumber,
		originalSnippet: snippetFromChangedLines(chosen.removedLines, originalLines, Math.max(1, chosen.oldStart)),
		mutatedSnippet: snippetFromChangedLines(chosen.addedLines, mutatedLines, lineNumber),
	};

	if (resolved.originalSnippet && !originalContent.includes(resolved.originalSnippet)) return null;
	if (resolved.mutatedSnippet && !mutatedContent.includes(resolved.mutatedSnippet)) return null;

	return resolved;
}

async function generateCase(
	rng: () => number,
	mutation: Mutation,
	files: FileEntry[],
	usedLines: Map<string, number[]>,
	difficulty: Difficulty,
	minScore: number | null,
	attemptLimit = 100,
): Promise<CaseResult | null> {
	let candidates = getCandidatesForDifficulty(files, difficulty);
	if (candidates.length === 0) candidates = files;

	function canApply(entry: FileEntry): boolean {
		try {
			return mutation.canApply(entry.content);
		} catch {
			return false;
		}
	}

	let applicable = candidates.filter(canApply);
	if (applicable.length === 0 && candidates !== files) {
		applicable = files.filter(canApply);
	}
	if (applicable.length === 0) return null;

	const targetMinScore = minScore ?? { easy: 0, medium: 2, hard: 5, nightmare: 8 }[difficulty] ?? 0;

	for (let attempt = 0; attempt < attemptLimit; attempt++) {
		const entry = applicable[Math.floor(rng() * applicable.length)];
		let mutatedContent: string;
		let rawInfo: MutationInfo;
		try {
			[mutatedContent, rawInfo] = mutation.mutate(entry.content, rng);
		} catch {
			continue;
		}
		if (mutatedContent === entry.content) continue;
		const changedHunks = countChangedHunks(entry.content, mutatedContent);
		const changedLines = countChangedLines(entry.content, mutatedContent);
		const positionalHunks = countPositionalLineHunks(entry.content, mutatedContent);
		const positionalChanges = countPositionalLineChanges(entry.content, mutatedContent);
		const isStructural = mutation.category === "structural";
		const isMultiEdit = mutation.name === "identifier-multi-edit";
		if (!isStructural && !isMultiEdit) {
			if (changedHunks !== 1) continue;
			if (positionalHunks !== 1) continue;
			if (changedLines > 30 || positionalChanges > 30) continue;
		}

		if (!regionAvailable(usedLines, entry.path, rawInfo.lineNumber)) continue;

		const diffScore = scoreDifficulty(entry, rawInfo.lineNumber);

		if (difficulty === "nightmare") {
			const lines = entry.content.split("\n");
			if (rawInfo.lineNumber <= lines.length) {
				const lineContent = lines[rawInfo.lineNumber - 1].trim();
				if (!entry.repeatedLines.has(lineContent)) continue;
			}
		}

		if (diffScore < targetMinScore) continue;

		const filename = path.basename(entry.path);
		const [formattedInput, formattedExpected] = await Promise.all([
			formatContent(filename, mutatedContent),
			formatContent(filename, entry.content),
		]);
		const normalizedMutated = ensureTrailingNewline(formattedInput.formatted);
		const normalizedOriginal = ensureTrailingNewline(formattedExpected.formatted);
		const finalInfo = resolveFormattedMutationInfo(normalizedOriginal, normalizedMutated, rawInfo);
		if (!finalInfo) continue;

		recordRegion(usedLines, entry.path, rawInfo.lineNumber);
		return {
			caseId: "",
			mutation,
			finalInfo,
			filePath: entry.path,
			formattedMutatedContent: normalizedMutated,
			formattedOriginalContent: normalizedOriginal,
			difficulty,
			difficultyScore: diffScore,
		};
	}

	return null;
}

function ensureTrailingNewline(content: string): string {
	return content.replace(/\n*$/, "\n");
}

interface TarEntry {
	name: string;
	content: string;
}

async function writeTarball(entries: TarEntry[], outputPath: string): Promise<void> {
	const data: Record<string, string> = {};
	for (const entry of entries) {
		data[entry.name] = entry.content;
	}
	await Bun.Archive.write(outputPath, data, { compress: "gzip" });
}

async function buildCaseEntries(result: CaseResult, typescriptDir: string): Promise<TarEntry[]> {
	const filename = path.basename(result.filePath);
	const relativePath = path.relative(typescriptDir, result.filePath);
	const caseDir = `fixtures/${result.caseId}`;

	const lines = result.formattedOriginalContent.split("\n");
	const lineContent = result.finalInfo.lineNumber <= lines.length ? lines[result.finalInfo.lineNumber - 1].trim() : "";

	const entry: FileEntry = {
		path: result.filePath,
		content: result.formattedOriginalContent,
		lineCount: lines.length,
		repeatedLines: findRepeatedLines(result.formattedOriginalContent),
		similarBlockCount: countSimilarBlocks(result.formattedOriginalContent),
		density: computeDensity(result.formattedOriginalContent),
		maxIndent: findMaxIndent(result.formattedOriginalContent),
		functionRanges: findFunctionRanges(result.formattedOriginalContent),
	};

	const isRepeated = entry.repeatedLines.has(lineContent);
	const prompt = buildPrompt(result.filePath, result.mutation, result.finalInfo, result.difficulty, entry);

	const metadata = {
		mutation_type: result.mutation.name,
		mutation_category: result.mutation.category,
		difficulty: result.difficulty,
		difficulty_score: result.difficultyScore,
		line_number: result.finalInfo.lineNumber,
		original_snippet: result.finalInfo.originalSnippet,
		mutated_snippet: result.finalInfo.mutatedSnippet,
		file_path: relativePath,
		context: {
			file_lines: entry.lineCount,
			is_repeated_line: isRepeated,
			repeat_count: entry.repeatedLines.get(lineContent)?.length ?? 0,
			similar_block_count: entry.similarBlockCount,
			density: Math.round(entry.density * 1000) / 1000,
			line_indent:
				result.finalInfo.lineNumber <= lines.length
					? lines[result.finalInfo.lineNumber - 1].length -
						lines[result.finalInfo.lineNumber - 1].trimStart().length
					: 0,
			containing_function: findContainingFunction(entry, result.finalInfo.lineNumber),
		},
	};

	if (!result.formattedOriginalContent.includes(result.finalInfo.originalSnippet)) {
		throw new Error(`Generated case ${result.caseId} has invalid original snippet metadata`);
	}
	if (!result.formattedMutatedContent.includes(result.finalInfo.mutatedSnippet)) {
		throw new Error(`Generated case ${result.caseId} has invalid mutated snippet metadata`);
	}

	return [
		{ name: `${caseDir}/input/${filename}`, content: result.formattedMutatedContent },
		{ name: `${caseDir}/expected/${filename}`, content: result.formattedOriginalContent },
		{ name: `${caseDir}/prompt.md`, content: prompt },
		{ name: `${caseDir}/metadata.json`, content: JSON.stringify(metadata, null, 2) },
	];
}

function chooseDifficulties(difficulties: Difficulty[], count: number): Difficulty[] {
	return Array.from({ length: count }, (_, i) => difficulties[i % difficulties.length]);
}

async function main(): Promise<number> {
	const args = parseArguments();
	const rng = createSeededRng(args.seed);
	const typescriptDir = args.typescriptDir;

	await ensureSourceRepo(typescriptDir);

	const rawFiles = await collectFiles(typescriptDir);
	const files = await filterFiles(rawFiles);
	if (files.length === 0) {
		console.error("No eligible files found.");
		return 1;
	}

	console.log(`Analyzed ${files.length} files`);
	const withRepeats = files.filter(f => f.repeatedLines.size > 0).length;
	const longFiles = files.filter(f => f.lineCount > 200).length;
	const similarBlocks = files.filter(f => f.similarBlockCount >= 3).length;
	console.log(`  ${withRepeats} with repeated lines, ${longFiles} long files, ${similarBlocks} with similar blocks`);

	const difficulties = args.difficulty
		.split(",")
		.map(s => s.trim())
		.filter(Boolean) as Difficulty[];
	if (difficulties.length === 0) {
		console.error("No difficulties specified.");
		return 1;
	}

	let mutations = ALL_MUTATIONS;
	if (args.categories) {
		const categories = new Set(
			args.categories
				.split(",")
				.map(s => s.trim())
				.filter(Boolean),
		);
		const unknown = Array.from(categories).filter(c => !(c in CATEGORY_MAP));
		if (unknown.length > 0) {
			console.error(`Unknown categories: ${unknown.join(", ")}`);
			return 1;
		}
		mutations = ALL_MUTATIONS.filter(m => categories.has(m.category));
	}

	const usedLines = new Map<string, number[]>();
	const results: CaseResult[] = [];

	const fallbackOrder: Difficulty[] = ["hard", "medium", "easy"];

	for (const mutation of mutations) {
		const difficultiesForType = chooseDifficulties(difficulties, args.countPerType);
		let generated = 0;

		for (let index = 0; index < args.countPerType; index++) {
			const difficulty = difficultiesForType[index];
			let result = await generateCase(rng, mutation, files, usedLines, difficulty, args.minScore);

			if (!result) {
				for (const fallback of fallbackOrder) {
					if (fallback === difficulty) continue;
					result = await generateCase(rng, mutation, files, usedLines, fallback, 0);
					if (result) {
						console.log(`Note: ${mutation.name} case ${index + 1} fell back from ${difficulty} to ${fallback}`);
						break;
					}
				}
			}

			if (!result) {
				console.log(`Warning: Skipping ${mutation.name} case ${index + 1} (no applicable files left)`);
				continue;
			}

			generated++;
			const caseId = `${mutation.category}-${mutation.name}-${String(index + 1).padStart(3, "0")}`;
			results.push({
				...result,
				caseId,
			});
		}

		if (generated === 0) {
			console.log(`Warning: No cases generated for ${mutation.name} (mutation may be too rare)`);
		} else if (generated < args.countPerType) {
			console.log(`Note: Only ${generated}/${args.countPerType} cases generated for ${mutation.name}`);
		}
	}

	if (args.dryRun) {
		const byDifficulty = new Map<Difficulty, CaseResult[]>();
		for (const result of results) {
			const list = byDifficulty.get(result.difficulty) ?? [];
			list.push(result);
			byDifficulty.set(result.difficulty, list);
		}

		for (const diff of difficulties) {
			const cases = byDifficulty.get(diff) ?? [];
			console.log(`\n${diff.toUpperCase()} (${cases.length} cases):`);
			for (const result of cases.slice(0, 5)) {
				const rel = path.relative(typescriptDir, result.filePath);
				console.log(`  ${result.caseId}: ${rel}`);
				console.log(
					`    score=${result.difficultyScore}, lines=${result.formattedOriginalContent.split("\n").length}`,
				);
			}
			if (cases.length > 5) {
				console.log(`  ... and ${cases.length - 5} more`);
			}
		}

		const scores = results.map(r => r.difficultyScore);
		const min = Math.min(...scores);
		const max = Math.max(...scores);
		const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
		console.log(`\nScore distribution: min=${min}, max=${max}, avg=${avg.toFixed(1)}`);
		return 0;
	}

	const tarEntries: Promise<TarEntry[]>[] = [];
	for (const result of results) {
		tarEntries.push(buildCaseEntries(result, typescriptDir));
	}

	await writeTarball((await Promise.all(tarEntries)).flat(), args.output);

	console.log(`Generated ${results.length} cases in ${args.output}`);
	const scores = results.map(r => r.difficultyScore);
	const min = Math.min(...scores);
	const max = Math.max(...scores);
	const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
	console.log(`Score distribution: min=${min}, max=${max}, avg=${avg.toFixed(1)}`);
	return 0;
}

process.exit(await main());
