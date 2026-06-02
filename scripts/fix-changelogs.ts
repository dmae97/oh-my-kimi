#!/usr/bin/env bun

import { $, Glob } from "bun";
import * as path from "node:path";

const CHANGELOG_GLOB = "packages/*/CHANGELOG.md";
const ORDERED_SECTION_TITLES = ["Breaking Changes", "Added", "Changed", "Fixed", "Removed"] as const;

interface NumberedLine {
	text: string;
	lineNumber: number;
}

interface Subsection {
	title: string;
	lines: NumberedLine[];
}

interface ReleaseSection {
	heading: string;
	title: string;
	leadingLines: NumberedLine[];
	subsections: Subsection[];
}

interface ChangelogDocument {
	prefixLines: NumberedLine[];
	sections: ReleaseSection[];
}

interface ParsedItem {
	startLine: number;
	endLine: number;
	lines: string[];
}

interface FixCounters {
	promotedItems: number;
	mergedDuplicateHeadings: number;
	removedEmptyHeadings: number;
}

export interface FixChangelogContentResult extends FixCounters {
	content: string;
}

interface HunkRef {
	path: string;
	index: number;
}

interface AddedItemCandidate {
	path: string;
	lineNumber: number;
	text: string;
	hunk: HunkRef;
	pairedWithRemoval: boolean;
}

interface RemovedItemOccurrence {
	path: string;
	text: string;
	hunk: HunkRef;
	pairedWithAddition: boolean;
}

export interface ChangedChangelogSummary extends FixCounters {
	path: string;
}

export interface RunChangelogFixerOptions {
	repoRoot?: string;
	since?: string;
	write?: boolean;
}

export interface RunChangelogFixerResult {
	since: string;
	changedFiles: ChangedChangelogSummary[];
}

interface CliOptions {
	mode: "write" | "dry-run" | "check";
	repoRoot?: string;
	since?: string;
	help: boolean;
}

function isReleaseHeading(line: string): boolean {
	return /^## \[[^\]]+\]/.test(line);
}

function isSubsectionHeading(line: string): boolean {
	return /^###\s+\S/.test(line);
}

function parseReleaseTitle(heading: string): string {
	const match = heading.match(/^## \[([^\]]+)\]/);
	return match?.[1] ?? heading.replace(/^##\s+/, "").trim();
}

function parseSubsectionTitle(heading: string): string {
	return heading.replace(/^###\s+/, "").trim();
}

function isListItemLine(line: string): boolean {
	return line.trimStart().startsWith("- ");
}

function normalizeItemText(text: string): string {
	return text.trim();
}

function splitContentLines(content: string): string[] {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (normalized.endsWith("\n")) {
		return normalized.slice(0, -1).split("\n");
	}
	return normalized.split("\n");
}

function createNumberedLine(text: string, lineNumber: number): NumberedLine {
	return { text, lineNumber };
}

function parseChangelog(content: string): ChangelogDocument {
	const lines = splitContentLines(content);
	const numberedLines = lines.map((text, index) => createNumberedLine(text, index + 1));
	const prefixLines: NumberedLine[] = [];
	const sections: ReleaseSection[] = [];
	let index = 0;

	while (index < numberedLines.length && !isReleaseHeading(numberedLines[index]?.text ?? "")) {
		const line = numberedLines[index];
		if (line) prefixLines.push(line);
		index++;
	}

	while (index < numberedLines.length) {
		const headingLine = numberedLines[index];
		if (!headingLine) break;
		index++;

		const bodyLines: NumberedLine[] = [];
		while (index < numberedLines.length && !isReleaseHeading(numberedLines[index]?.text ?? "")) {
			const line = numberedLines[index];
			if (line) bodyLines.push(line);
			index++;
		}

		sections.push(parseReleaseSection(headingLine.text, bodyLines));
	}

	return { prefixLines, sections };
}

function parseReleaseSection(heading: string, bodyLines: readonly NumberedLine[]): ReleaseSection {
	const leadingLines: NumberedLine[] = [];
	const subsections: Subsection[] = [];
	let index = 0;

	while (index < bodyLines.length && !isSubsectionHeading(bodyLines[index]?.text ?? "")) {
		const line = bodyLines[index];
		if (line) leadingLines.push(line);
		index++;
	}

	while (index < bodyLines.length) {
		const headingLine = bodyLines[index];
		if (!headingLine) break;
		index++;

		const lines: NumberedLine[] = [];
		while (index < bodyLines.length && !isSubsectionHeading(bodyLines[index]?.text ?? "")) {
			const line = bodyLines[index];
			if (line) lines.push(line);
			index++;
		}

		subsections.push({ title: parseSubsectionTitle(headingLine.text), lines });
	}

	return {
		heading,
		title: parseReleaseTitle(heading),
		leadingLines,
		subsections,
	};
}

function trimBlankLines(lines: readonly string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start]?.trim() === "") start++;
	while (end > start && lines[end - 1]?.trim() === "") end--;
	return lines.slice(start, end);
}

function numberedText(lines: readonly NumberedLine[]): string[] {
	return lines.map(line => line.text);
}

function syntheticLines(lines: readonly string[]): NumberedLine[] {
	return lines.map(text => ({ text, lineNumber: 0 }));
}

function appendSubsectionLines(target: Subsection, sourceLines: readonly string[]): void {
	const trimmedSource = trimBlankLines(sourceLines);
	if (trimmedSource.length === 0) return;

	const existing = trimBlankLines(numberedText(target.lines));
	if (existing.length === 0) {
		target.lines = syntheticLines(trimmedSource);
		return;
	}

	const lastExisting = existing[existing.length - 1] ?? "";
	const firstSource = trimmedSource[0] ?? "";
	const separator = isListItemLine(lastExisting) && isListItemLine(firstSource) ? [] : [""];
	target.lines = syntheticLines([...existing, ...separator, ...trimmedSource]);
}

function parseItems(lines: readonly NumberedLine[]): ParsedItem[] {
	const items: ParsedItem[] = [];
	let index = 0;

	while (index < lines.length) {
		const line = lines[index];
		if (!line || !isListItemLine(line.text)) {
			index++;
			continue;
		}

		const start = index;
		index++;
		while (index < lines.length && !isListItemLine(lines[index]?.text ?? "")) {
			index++;
		}

		const itemLines = lines.slice(start, index);
		const firstLine = itemLines[0];
		const lastLine = itemLines[itemLines.length - 1];
		if (firstLine && lastLine) {
			items.push({
				startLine: firstLine.lineNumber,
				endLine: lastLine.lineNumber,
				lines: trimBlankLines(numberedText(itemLines)),
			});
		}
	}

	return items;
}

function lineRangeSet(items: readonly ParsedItem[]): Set<number> {
	const lines = new Set<number>();
	for (const item of items) {
		for (let line = item.startLine; line <= item.endLine; line++) {
			lines.add(line);
		}
	}
	return lines;
}

function subsectionHasItem(subsection: Subsection, itemLines: readonly string[]): boolean {
	const wanted = trimBlankLines(itemLines).join("\n");
	if (!wanted) return true;
	for (const item of parseItems(subsection.lines)) {
		if (item.lines.join("\n") === wanted) return true;
	}
	return false;
}

function getOrCreateUnreleasedSection(document: ChangelogDocument): ReleaseSection {
	const existing = document.sections.find(section => section.title === "Unreleased");
	if (existing) return existing;

	const section: ReleaseSection = {
		heading: "## [Unreleased]",
		title: "Unreleased",
		leadingLines: [],
		subsections: [],
	};
	document.sections.unshift(section);
	return section;
}

function getOrCreateSubsection(section: ReleaseSection, title: string): Subsection {
	const existing = section.subsections.findLast(subsection => subsection.title === title);
	if (existing) return existing;

	const subsection: Subsection = { title, lines: [] };
	section.subsections.push(subsection);
	return subsection;
}

function titleOrder(title: string): number {
	const index = ORDERED_SECTION_TITLES.indexOf(title as (typeof ORDERED_SECTION_TITLES)[number]);
	return index === -1 ? ORDERED_SECTION_TITLES.length : index;
}

function normalizeSection(section: ReleaseSection): FixCounters {
	const counters: FixCounters = {
		promotedItems: 0,
		mergedDuplicateHeadings: 0,
		removedEmptyHeadings: 0,
	};
	const subsectionByTitle = new Map<string, Subsection>();
	const normalizedSubsections: Subsection[] = [];

	for (const subsection of section.subsections) {
		const trimmedLines = trimBlankLines(numberedText(subsection.lines));
		if (trimmedLines.length === 0) {
			counters.removedEmptyHeadings++;
			continue;
		}

		const existing = subsectionByTitle.get(subsection.title);
		if (existing) {
			appendSubsectionLines(existing, trimmedLines);
			counters.mergedDuplicateHeadings++;
			continue;
		}

		const normalized: Subsection = {
			title: subsection.title,
			lines: syntheticLines(trimmedLines),
		};
		subsectionByTitle.set(subsection.title, normalized);
		normalizedSubsections.push(normalized);
	}

	if (section.title === "Unreleased") {
		normalizedSubsections.sort((a, b) => titleOrder(a.title) - titleOrder(b.title));
	}

	section.leadingLines = syntheticLines(trimBlankLines(numberedText(section.leadingLines)));
	section.subsections = normalizedSubsections;
	return counters;
}

function renderChangelog(document: ChangelogDocument): string {
	const output: string[] = [];
	const prefix = trimBlankLines(numberedText(document.prefixLines));
	if (prefix.length > 0) {
		output.push(...prefix, "");
	}

	for (const section of document.sections) {
		output.push(section.heading);
		const leading = trimBlankLines(numberedText(section.leadingLines));
		if (leading.length > 0) {
			output.push("", ...leading);
		}

		for (const subsection of section.subsections) {
			const lines = trimBlankLines(numberedText(subsection.lines));
			if (lines.length === 0) continue;
			output.push("", `### ${subsection.title}`, "", ...lines);
		}

		output.push("");
	}

	while (output.length > 0 && output[output.length - 1] === "") {
		output.pop();
	}
	return `${output.join("\n")}\n`;
}

export function fixChangelogContent(
	content: string,
	promotableAddedItemStartLines: ReadonlySet<number>,
): FixChangelogContentResult {
	const document = parseChangelog(content);
	let unreleased = document.sections.find(section => section.title === "Unreleased");
	let promotedItems = 0;

	for (const section of document.sections) {
		if (section.title === "Unreleased") continue;

		for (const subsection of section.subsections) {
			const items = parseItems(subsection.lines).filter(item => promotableAddedItemStartLines.has(item.startLine));
			if (items.length === 0) continue;

			const linesToRemove = lineRangeSet(items);
			subsection.lines = subsection.lines.filter(line => !linesToRemove.has(line.lineNumber));

			unreleased ??= getOrCreateUnreleasedSection(document);
			const targetSubsection = getOrCreateSubsection(unreleased, subsection.title);
			for (const item of items) {
				if (!subsectionHasItem(targetSubsection, item.lines)) {
					appendSubsectionLines(targetSubsection, item.lines);
				}
				promotedItems++;
			}
		}
	}

	let mergedDuplicateHeadings = 0;
	let removedEmptyHeadings = 0;
	for (const section of document.sections) {
		const counters = normalizeSection(section);
		mergedDuplicateHeadings += counters.mergedDuplicateHeadings;
		removedEmptyHeadings += counters.removedEmptyHeadings;
	}

	if (promotedItems === 0 && mergedDuplicateHeadings === 0 && removedEmptyHeadings === 0) {
		return {
			content,
			promotedItems,
			mergedDuplicateHeadings,
			removedEmptyHeadings,
		};
	}

	return {
		content: renderChangelog(document),
		promotedItems,
		mergedDuplicateHeadings,
		removedEmptyHeadings,
	};
}

function hunkKey(hunk: HunkRef): string {
	return `${hunk.path}\0${hunk.index}`;
}

function itemKey(pathName: string, text: string): string {
	return `${pathName}\0${normalizeItemText(text)}`;
}

export function collectPromotableAddedItemLines(diffText: string): Map<string, Set<number>> {
	const candidates: AddedItemCandidate[] = [];
	const removals: RemovedItemOccurrence[] = [];
	let currentPath = "";
	let oldLine = 0;
	let newLine = 0;
	let hunkIndex = -1;

	for (const rawLine of diffText.replace(/\r\n/g, "\n").split("\n")) {
		if (rawLine.startsWith("+++ b/")) {
			currentPath = rawLine.slice("+++ b/".length);
			continue;
		}

		if (rawLine.startsWith("diff --git ")) {
			currentPath = "";
			hunkIndex = -1;
			continue;
		}

		const hunkMatch = rawLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
		if (hunkMatch) {
			oldLine = Number(hunkMatch[1]);
			newLine = Number(hunkMatch[2]);
			hunkIndex++;
			continue;
		}

		if (!currentPath || hunkIndex < 0 || rawLine.length === 0) continue;

		const marker = rawLine[0];
		const text = rawLine.slice(1);
		const hunk = { path: currentPath, index: hunkIndex };
		if (marker === "+") {
			if (isListItemLine(text)) {
				candidates.push({
					path: currentPath,
					lineNumber: newLine,
					text,
					hunk,
					pairedWithRemoval: false,
				});
			}
			newLine++;
			continue;
		}

		if (marker === "-") {
			if (isListItemLine(text)) {
				removals.push({
					path: currentPath,
					text,
					hunk,
					pairedWithAddition: false,
				});
			}
			oldLine++;
			continue;
		}

		if (marker === " ") {
			oldLine++;
			newLine++;
		}
	}

	const removalsByItem = new Map<string, RemovedItemOccurrence[]>();
	for (const removal of removals) {
		const key = itemKey(removal.path, removal.text);
		const existing = removalsByItem.get(key);
		if (existing) {
			existing.push(removal);
		} else {
			removalsByItem.set(key, [removal]);
		}
	}

	for (const candidate of candidates) {
		const sameItemRemovals = removalsByItem.get(itemKey(candidate.path, candidate.text));
		const matchingRemoval = sameItemRemovals?.find(removal => !removal.pairedWithAddition);
		if (matchingRemoval) {
			matchingRemoval.pairedWithAddition = true;
			candidate.pairedWithRemoval = true;
		}
	}

	const unpairedRemovalCountByHunk = new Map<string, number>();
	for (const removal of removals) {
		if (removal.pairedWithAddition) continue;
		const key = hunkKey(removal.hunk);
		unpairedRemovalCountByHunk.set(key, (unpairedRemovalCountByHunk.get(key) ?? 0) + 1);
	}

	const linesByPath = new Map<string, Set<number>>();
	for (const candidate of candidates) {
		if (candidate.pairedWithRemoval) continue;
		const key = hunkKey(candidate.hunk);
		const unpairedRemovalCount = unpairedRemovalCountByHunk.get(key) ?? 0;
		if (unpairedRemovalCount > 0) {
			unpairedRemovalCountByHunk.set(key, unpairedRemovalCount - 1);
			continue;
		}

		const existing = linesByPath.get(candidate.path);
		if (existing) {
			existing.add(candidate.lineNumber);
		} else {
			linesByPath.set(candidate.path, new Set([candidate.lineNumber]));
		}
	}

	return linesByPath;
}

async function git(args: readonly string[], cwd: string): Promise<string> {
	const result = await $`git -c core.fsmonitor=false -c core.untrackedCache=false -c fetch.pruneTags=false ${args}`
		.cwd(cwd)
		.quiet();
	return result.text();
}

async function resolveRepoRoot(repoRoot: string | undefined): Promise<string> {
	if (repoRoot) return path.resolve(repoRoot);
	return (await git(["rev-parse", "--show-toplevel"], process.cwd())).trim();
}

async function latestTag(repoRoot: string): Promise<string> {
	return (await git(["describe", "--tags", "--abbrev=0"], repoRoot)).trim();
}

async function changelogPaths(repoRoot: string): Promise<string[]> {
	const glob = new Glob(CHANGELOG_GLOB);
	const paths: string[] = [];
	for await (const changelogPath of glob.scan(repoRoot)) {
		paths.push(path.isAbsolute(changelogPath) ? path.relative(repoRoot, changelogPath) : changelogPath);
	}
	paths.sort();
	return paths;
}

async function changelogDiff(repoRoot: string, since: string, paths: readonly string[]): Promise<string> {
	if (paths.length === 0) return "";
	return git(["diff", "--unified=0", "--no-color", "--no-ext-diff", since, "--", ...paths], repoRoot);
}

export async function runChangelogFixer(options: RunChangelogFixerOptions = {}): Promise<RunChangelogFixerResult> {
	const repoRoot = await resolveRepoRoot(options.repoRoot);
	const since = options.since ?? (await latestTag(repoRoot));
	const paths = await changelogPaths(repoRoot);
	const diff = await changelogDiff(repoRoot, since, paths);
	const addedItemLines = collectPromotableAddedItemLines(diff);
	const changedFiles: ChangedChangelogSummary[] = [];

	for (const changelogPath of paths) {
		const absolutePath = path.join(repoRoot, changelogPath);
		const currentContent = await Bun.file(absolutePath).text();
		const result = fixChangelogContent(currentContent, addedItemLines.get(changelogPath) ?? new Set<number>());
		if (result.content === currentContent) continue;

		changedFiles.push({
			path: changelogPath,
			promotedItems: result.promotedItems,
			mergedDuplicateHeadings: result.mergedDuplicateHeadings,
			removedEmptyHeadings: result.removedEmptyHeadings,
		});

		if (options.write !== false) {
			await Bun.write(absolutePath, result.content);
		}
	}

	return { since, changedFiles };
}

function parseCliArgs(args: readonly string[]): CliOptions {
	const options: CliOptions = { mode: "write", help: false };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		switch (arg) {
			case "--dry-run":
				options.mode = "dry-run";
				break;
			case "--check":
				options.mode = "check";
				break;
			case "--since": {
				const value = args[index + 1];
				if (!value) throw new Error("--since requires a tag or commit");
				options.since = value;
				index++;
				break;
			}
			case "--repo-root": {
				const value = args[index + 1];
				if (!value) throw new Error("--repo-root requires a path");
				options.repoRoot = value;
				index++;
				break;
			}
			case "-h":
			case "--help":
				options.help = true;
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return options;
}

function usage(): string {
	return [
		"Usage: bun scripts/fix-changelogs.ts [--dry-run|--check] [--since <tag>]",
		"",
		"Moves changelog items added since the latest tag from released sections into [Unreleased],",
		"then removes duplicate or empty ### category headings.",
		"",
		"Options:",
		"  --dry-run          Print what would change without writing files.",
		"  --check            Exit 1 if any changelog would change.",
		"  --since <tag>      Compare changelog additions against this tag/commit instead of latest tag.",
		"  --repo-root <dir>  Run against an explicit repository root.",
	].join("\n");
}

function printSummary(result: RunChangelogFixerResult, mode: CliOptions["mode"]): void {
	const suffix = mode === "write" ? "" : ` (${mode}, not written)`;
	if (result.changedFiles.length === 0) {
		console.log(`Changelogs already clean since ${result.since}.`);
		return;
	}

	console.log(`Fixed ${result.changedFiles.length} changelog(s) since ${result.since}${suffix}:`);
	for (const file of result.changedFiles) {
		const parts = [
			`${file.promotedItems} promoted item(s)`,
			`${file.mergedDuplicateHeadings} merged duplicate heading(s)`,
			`${file.removedEmptyHeadings} removed empty heading(s)`,
		];
		console.log(`  ${file.path}: ${parts.join(", ")}`);
	}
}

async function main(): Promise<void> {
	try {
		const cliOptions = parseCliArgs(process.argv.slice(2));
		if (cliOptions.help) {
			console.log(usage());
			return;
		}

		const result = await runChangelogFixer({
			repoRoot: cliOptions.repoRoot,
			since: cliOptions.since,
			write: cliOptions.mode === "write",
		});
		printSummary(result, cliOptions.mode);
		if (cliOptions.mode === "check" && result.changedFiles.length > 0) {
			process.exit(1);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

if (import.meta.main) {
	await main();
}
