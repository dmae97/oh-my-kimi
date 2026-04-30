/**
 * Auto-read file mentions from user prompts.
 *
 * When users reference files with @path syntax (e.g., "@src/foo.ts"),
 * we automatically inject the file contents as a FileMentionMessage
 * so the agent doesn't need to read them manually.
 */
import * as fs from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { glob } from "@oh-my-pi/pi-natives";
import { formatAge, formatBytes, readImageMetadata } from "@oh-my-pi/pi-utils";
import { formatHashLines } from "../edit/line-hash";
import type { FileMentionMessage } from "../session/messages";
import {
	DEFAULT_MAX_BYTES,
	formatHeadTruncationNotice,
	truncateHead,
	truncateHeadBytes,
} from "../session/streaming-output";
import { resolveReadPath } from "../tools/path-utils";
import { fuzzyMatch } from "./fuzzy";
import { formatDimensionNote, resizeImage } from "./image-resize";

/** Regex to match @filepath patterns in text */
const FILE_MENTION_REGEX = /@([^\s@]+)/g;
const LEADING_PUNCTUATION_REGEX = /^[`"'([{<]+/;
const TRAILING_PUNCTUATION_REGEX = /[)\]}>.,;:!?"'`]+$/;
const MENTION_BOUNDARY_REGEX = /[\s([{<"'`]/;
const DEFAULT_DIR_LIMIT = 500;
const MIN_FUZZY_QUERY_LENGTH = 5;
const MAX_RESOLUTION_CANDIDATES = 20_000;
const PATH_SEPARATOR_REGEX = /[/._\-\s]+/g;

type MentionDiscoveryProfile = {
	hidden: boolean;
	gitignore: boolean;
	includeNodeModules: boolean;
	maxResults: number;
	cache: boolean;
};

function getMentionCandidateDiscoveryProfile(): MentionDiscoveryProfile {
	return {
		hidden: true,
		gitignore: true,
		cache: true,
		includeNodeModules: true,
		maxResults: MAX_RESOLUTION_CANDIDATES,
	};
}

// Avoid OOM when users @mention very large files. Above these limits we skip
// auto-reading and only include the path in the message.
const MAX_AUTO_READ_TEXT_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_AUTO_READ_IMAGE_BYTES = 25 * 1024 * 1024; // 25MB

function isMentionBoundary(text: string, index: number): boolean {
	if (index === 0) return true;
	return MENTION_BOUNDARY_REGEX.test(text[index - 1]);
}

function sanitizeMentionPath(rawPath: string): string | null {
	let cleaned = rawPath.trim();
	cleaned = cleaned.replace(LEADING_PUNCTUATION_REGEX, "");
	cleaned = cleaned.replace(TRAILING_PUNCTUATION_REGEX, "");
	cleaned = cleaned.trim();
	return cleaned.length > 0 ? cleaned : null;
}

type MentionCandidate = {
	path: string;
	pathLower: string;
	normalizedPath: string;
};

function normalizeMentionQuery(query: string): string {
	return query.toLowerCase().replace(PATH_SEPARATOR_REGEX, "");
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await Bun.file(filePath).stat();
		return true;
	} catch {
		return false;
	}
}

async function listMentionCandidates(cwd: string): Promise<MentionCandidate[]> {
	let entries: string[];
	try {
		const discoveryProfile = getMentionCandidateDiscoveryProfile();
		const result = await glob({
			pattern: "**/*",
			path: cwd,
			...discoveryProfile,
		});
		entries = result.matches.map(match => match.path);
	} catch {
		return [];
	}

	entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
	const candidates: MentionCandidate[] = [];
	for (const entry of entries) {
		const pathLower = entry.toLowerCase();
		const normalizedPath = normalizeMentionQuery(entry);
		if (normalizedPath.length === 0) {
			continue;
		}
		candidates.push({ path: entry, pathLower, normalizedPath });
	}
	return candidates;
}

async function resolveMentionPath(
	filePath: string,
	cwd: string,
	getMentionCandidates: () => Promise<MentionCandidate[]>,
): Promise<string | null> {
	const absolutePath = resolveReadPath(filePath, cwd);
	if (await pathExists(absolutePath)) {
		return filePath;
	}

	const queryLower = filePath.toLowerCase();
	const candidates = await getMentionCandidates();
	const prefixMatches = candidates.filter(candidate => candidate.pathLower.startsWith(queryLower));
	if (prefixMatches.length === 1) {
		return prefixMatches[0]?.path ?? null;
	}
	if (prefixMatches.length > 1) {
		return null;
	}

	const normalizedQuery = normalizeMentionQuery(filePath);
	if (normalizedQuery.length < MIN_FUZZY_QUERY_LENGTH) {
		return null;
	}

	const scored = candidates
		.map(candidate => ({ candidate, match: fuzzyMatch(normalizedQuery, candidate.normalizedPath) }))
		.filter(entry => entry.match.matches)
		.sort((a, b) => {
			if (a.match.score !== b.match.score) {
				return a.match.score - b.match.score;
			}
			return a.candidate.path.localeCompare(b.candidate.path);
		});

	if (scored.length === 0) {
		return null;
	}

	const best = scored[0];

	return best?.candidate.path ?? null;
}

function buildTextOutput(textContent: string): { output: string; lineCount: number } {
	const allLines = textContent.split("\n");
	const totalFileLines = allLines.length;
	const truncation = truncateHead(textContent);

	if (truncation.firstLineExceedsLimit) {
		const firstLine = allLines[0] ?? "";
		const firstLineBytes = Buffer.byteLength(firstLine, "utf-8");
		const snippet = truncateHeadBytes(firstLine, DEFAULT_MAX_BYTES);
		let outputText = snippet.text;

		if (outputText.length > 0) {
			outputText += `\n\n[Line 1 is ${formatBytes(firstLineBytes)}, exceeds ${formatBytes(
				DEFAULT_MAX_BYTES,
			)} limit. Showing first ${formatBytes(snippet.bytes)} of the line.]`;
		} else {
			outputText = `[Line 1 is ${formatBytes(firstLineBytes)}, exceeds ${formatBytes(
				DEFAULT_MAX_BYTES,
			)} limit. Unable to display a valid UTF-8 snippet.]`;
		}

		return { output: outputText, lineCount: totalFileLines };
	}

	let outputText = truncation.content;

	if (truncation.truncated) {
		outputText += formatHeadTruncationNotice(truncation, { startLine: 1, totalFileLines });
	}

	return { output: outputText, lineCount: totalFileLines };
}

async function buildDirectoryListing(absolutePath: string): Promise<{ output: string; lineCount: number }> {
	let entries: string[];
	try {
		entries = await Array.fromAsync(new Bun.Glob("*").scan({ cwd: absolutePath, dot: true, onlyFiles: false }));
	} catch {
		return { output: "(empty directory)", lineCount: 1 };
	}

	entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

	const results: string[] = [];
	let entryLimitReached = false;

	for (const entry of entries) {
		if (results.length >= DEFAULT_DIR_LIMIT) {
			entryLimitReached = true;
			break;
		}

		const fullPath = path.join(absolutePath, entry);
		let suffix = "";
		let age = "";

		try {
			const stat = await Bun.file(fullPath).stat();
			if (stat.isDirectory()) {
				suffix = "/";
			}
			const ageSeconds = Math.floor((Date.now() - stat.mtimeMs) / 1000);
			age = formatAge(ageSeconds);
		} catch {
			continue;
		}

		const line = age ? `${entry}${suffix} (${age})` : `${entry}${suffix}`;
		results.push(line);
	}

	if (results.length === 0) {
		return { output: "(empty directory)", lineCount: 1 };
	}

	const rawOutput = results.join("\n");
	const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
	let output = truncation.content;

	const notices: string[] = [];
	if (entryLimitReached) {
		notices.push(`${DEFAULT_DIR_LIMIT} entries limit reached. Use limit=${DEFAULT_DIR_LIMIT * 2} for more`);
	}
	if (truncation.truncated) {
		notices.push(`${formatBytes(DEFAULT_MAX_BYTES)} limit reached`);
	}
	if (notices.length > 0) {
		output += `\n\n[${notices.join(". ")}]`;
	}

	return { output, lineCount: output.split("\n").length };
}

/** Extract all @filepath mentions from text */
export function extractFileMentions(text: string): string[] {
	const matches = [...text.matchAll(FILE_MENTION_REGEX)];
	const mentions: string[] = [];

	for (const match of matches) {
		const index = match.index ?? 0;
		if (!isMentionBoundary(text, index)) continue;

		const cleaned = sanitizeMentionPath(match[1]);
		if (!cleaned) continue;

		mentions.push(cleaned);
	}

	return [...new Set(mentions)];
}

/**
 * Generate a FileMentionMessage containing the contents of mentioned files.
 * Returns empty array if no files could be read.
 */
export async function generateFileMentionMessages(
	filePaths: string[],
	cwd: string,
	options?: { autoResizeImages?: boolean; useHashLines?: boolean },
): Promise<AgentMessage[]> {
	if (filePaths.length === 0) return [];

	const autoResizeImages = options?.autoResizeImages ?? true;

	const files: FileMentionMessage["files"] = [];
	let mentionCandidatesPromise: Promise<MentionCandidate[]> | null = null;
	const getMentionCandidates = (): Promise<MentionCandidate[]> => {
		mentionCandidatesPromise ??= listMentionCandidates(cwd);
		return mentionCandidatesPromise;
	};

	for (const filePath of filePaths) {
		const resolvedPath = await resolveMentionPath(filePath, cwd, getMentionCandidates);
		if (!resolvedPath) {
			continue;
		}
		const absolutePath = resolveReadPath(resolvedPath, cwd);
		try {
			const stat = await Bun.file(absolutePath).stat();
			if (stat.isDirectory()) {
				const { output, lineCount } = await buildDirectoryListing(absolutePath);
				files.push({ path: resolvedPath, content: output, lineCount });
				continue;
			}

			const imageMetadata = await readImageMetadata(absolutePath);
			const mimeType = imageMetadata?.mimeType;
			if (mimeType) {
				if (stat.size > MAX_AUTO_READ_IMAGE_BYTES) {
					files.push({
						path: resolvedPath,
						content: `(skipped auto-read: too large, ${formatBytes(stat.size)})`,
						byteSize: stat.size,
						skippedReason: "tooLarge",
					});
					continue;
				}
				const buffer = await fs.readFile(absolutePath);
				if (buffer.length === 0) {
					continue;
				}

				const base64Content = buffer.toBase64();
				let image: ImageContent = { type: "image", mimeType, data: base64Content };
				let dimensionNote: string | undefined;

				if (autoResizeImages) {
					try {
						const resized = await resizeImage({ type: "image", data: base64Content, mimeType });
						dimensionNote = formatDimensionNote(resized);
						image = {
							type: "image",
							mimeType: resized.mimeType,
							data: resized.data,
						};
					} catch {
						image = { type: "image", mimeType, data: base64Content };
					}
				}

				files.push({ path: resolvedPath, content: dimensionNote ?? "", image });
				continue;
			}

			if (stat.size > MAX_AUTO_READ_TEXT_BYTES) {
				files.push({
					path: resolvedPath,
					content: `(skipped auto-read: too large, ${formatBytes(stat.size)})`,
					byteSize: stat.size,
					skippedReason: "tooLarge",
				});
				continue;
			}

			const content = await Bun.file(absolutePath).text();
			let { output, lineCount } = buildTextOutput(content);
			if (options?.useHashLines) {
				output = formatHashLines(output);
			}
			files.push({ path: resolvedPath, content: output, lineCount });
		} catch {
			// File doesn't exist or isn't readable - skip silently
		}
	}

	if (files.length === 0) return [];

	const message: FileMentionMessage = {
		role: "fileMention",
		files,
		timestamp: Date.now(),
	};

	return [message];
}
