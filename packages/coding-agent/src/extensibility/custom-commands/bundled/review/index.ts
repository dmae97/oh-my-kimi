/**
 * /review command - Interactive code review launcher
 *
 * Provides a menu to select review mode:
 * 1. Review against a base branch (PR style)
 * 2. Review uncommitted changes
 * 3. Review a specific commit
 * 4. Custom review instructions
 *
 * Runs git diff upfront, parses results, filters noise, and provides
 * rich context for the orchestrating agent to distribute work across
 * multiple reviewer agents based on diff weight and locality.
 */
import { prompt } from "@oh-my-pi/pi-utils";
import type { CustomCommand, CustomCommandAPI } from "../../../../extensibility/custom-commands/types";
import type { HookCommandContext } from "../../../../extensibility/hooks/types";
import reviewRequestTemplate from "../../../../prompts/review-request.md" with { type: "text" };
import * as git from "../../../../utils/git";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface FileDiff {
	path: string;
	linesAdded: number;
	linesRemoved: number;
	hunks: string;
}

interface DiffStats {
	files: FileDiff[];
	totalAdded: number;
	totalRemoved: number;
	excluded: { path: string; reason: string; linesAdded: number; linesRemoved: number }[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Exclusion patterns for noise files
// ─────────────────────────────────────────────────────────────────────────────

const EXCLUDED_PATTERNS: { pattern: RegExp; reason: string }[] = [
	// Lock files
	{ pattern: /\.lock$/, reason: "lock file" },
	{ pattern: /-lock\.(json|yaml|yml)$/, reason: "lock file" },
	{ pattern: /package-lock\.json$/, reason: "lock file" },
	{ pattern: /yarn\.lock$/, reason: "lock file" },
	{ pattern: /pnpm-lock\.yaml$/, reason: "lock file" },
	{ pattern: /Cargo\.lock$/, reason: "lock file" },
	{ pattern: /Gemfile\.lock$/, reason: "lock file" },
	{ pattern: /poetry\.lock$/, reason: "lock file" },
	{ pattern: /composer\.lock$/, reason: "lock file" },
	{ pattern: /flake\.lock$/, reason: "lock file" },

	// Generated/build artifacts
	{ pattern: /\.min\.(js|css)$/, reason: "minified" },
	{ pattern: /\.generated\./, reason: "generated" },
	{ pattern: /\.snap$/, reason: "snapshot" },
	{ pattern: /\.map$/, reason: "source map" },
	{ pattern: /^dist\//, reason: "build output" },
	{ pattern: /^build\//, reason: "build output" },
	{ pattern: /^out\//, reason: "build output" },
	{ pattern: /node_modules\//, reason: "vendor" },
	{ pattern: /vendor\//, reason: "vendor" },

	// Binary/assets (usually shown as binary in diff anyway)
	{ pattern: /\.(png|jpg|jpeg|gif|ico|webp|avif)$/i, reason: "image" },
	{ pattern: /\.(woff|woff2|ttf|eot|otf)$/i, reason: "font" },
	{ pattern: /\.(pdf|zip|tar|gz|rar|7z)$/i, reason: "binary" },
];

// ─────────────────────────────────────────────────────────────────────────────
// Diff parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a file path should be excluded from review.
 * Returns the exclusion reason if excluded, undefined otherwise.
 */
function getExclusionReason(path: string): string | undefined {
	for (const { pattern, reason } of EXCLUDED_PATTERNS) {
		if (pattern.test(path)) return reason;
	}
	return undefined;
}

/**
 * Parse unified diff output into per-file stats.
 * Splits on file boundaries, counts +/- lines, and filters excluded files.
 */
function parseDiff(diffOutput: string): DiffStats {
	const files: FileDiff[] = [];
	const excluded: DiffStats["excluded"] = [];
	let totalAdded = 0;
	let totalRemoved = 0;

	// Split by file boundary: "diff --git a/... b/..."
	const fileChunks = diffOutput.split(/^diff --git /m).filter(Boolean);

	for (const chunk of fileChunks) {
		// Extract file path from "a/path b/path" line
		const headerMatch = chunk.match(/^a\/(.+?) b\/(.+)/);
		if (!headerMatch) continue;

		const path = headerMatch[2];

		// Count added/removed lines (lines starting with + or - but not ++ or --)
		let linesAdded = 0;
		let linesRemoved = 0;

		const lines = chunk.split("\n");
		for (const line of lines) {
			if (line.startsWith("+") && !line.startsWith("+++")) {
				linesAdded++;
			} else if (line.startsWith("-") && !line.startsWith("---")) {
				linesRemoved++;
			}
		}

		const exclusionReason = getExclusionReason(path);
		if (exclusionReason) {
			excluded.push({ path, reason: exclusionReason, linesAdded, linesRemoved });
		} else {
			files.push({
				path,
				linesAdded,
				linesRemoved,
				hunks: `diff --git ${chunk}`,
			});
			totalAdded += linesAdded;
			totalRemoved += linesRemoved;
		}
	}

	return { files, totalAdded, totalRemoved, excluded };
}

/**
 * Get file extension for display purposes.
 */
function getFileExt(path: string): string {
	const match = path.match(/\.([^.]+)$/);
	return match ? match[1] : "";
}

/**
 * Determine recommended number of reviewer agents based on diff weight.
 * Uses total lines changed as the primary metric.
 */
function getRecommendedAgentCount(stats: DiffStats): number {
	const totalLines = stats.totalAdded + stats.totalRemoved;
	const fileCount = stats.files.length;

	// Heuristics:
	// - Tiny (<100 lines or 1-2 files): 1 agent
	// - Small (<500 lines): 1-2 agents
	// - Medium (<2000 lines): 2-4 agents
	// - Large (<5000 lines): 4-8 agents
	// - Huge (>5000 lines): 8-16 agents

	if (totalLines < 100 || fileCount <= 2) return 1;
	if (totalLines < 500) return Math.min(2, fileCount);
	if (totalLines < 2000) return Math.min(4, Math.ceil(fileCount / 3));
	if (totalLines < 5000) return Math.min(8, Math.ceil(fileCount / 2));
	return Math.min(16, fileCount);
}

/**
 * Extract first N lines of actual diff content (excluding headers) for preview.
 */
function getDiffPreview(hunks: string, maxLines: number): string {
	const lines = hunks.split("\n");
	const contentLines: string[] = [];

	for (const line of lines) {
		// Skip diff headers, keep actual content
		if (
			line.startsWith("diff --git") ||
			line.startsWith("index ") ||
			line.startsWith("---") ||
			line.startsWith("+++") ||
			line.startsWith("@@")
		) {
			continue;
		}
		contentLines.push(line);
		if (contentLines.length >= maxLines) break;
	}

	return contentLines.join("\n");
}

// Thresholds for diff inclusion
const MAX_DIFF_CHARS = 50_000; // Don't include diff above this
const MAX_FILES_FOR_INLINE_DIFF = 20; // Don't include diff if more files than this

/**
 * Build the full review prompt with diff stats and distribution guidance.
 */
function buildReviewPrompt(mode: string, stats: DiffStats, rawDiff: string, additionalInstructions?: string): string {
	const agentCount = getRecommendedAgentCount(stats);
	const skipDiff = rawDiff.length > MAX_DIFF_CHARS || stats.files.length > MAX_FILES_FOR_INLINE_DIFF;
	const totalLines = stats.totalAdded + stats.totalRemoved;
	const linesPerFile = skipDiff ? Math.max(5, Math.floor(100 / stats.files.length)) : 0;

	const filesWithExt = stats.files.map(f => ({
		...f,
		ext: getFileExt(f.path),
		hunksPreview: skipDiff ? getDiffPreview(f.hunks, linesPerFile) : "",
	}));

	return prompt.render(reviewRequestTemplate, {
		mode,
		files: filesWithExt,
		excluded: stats.excluded,
		totalAdded: stats.totalAdded,
		totalRemoved: stats.totalRemoved,
		totalLines,
		agentCount,
		multiAgent: agentCount > 1,
		skipDiff,
		rawDiff: rawDiff.trim(),
		linesPerFile,
		additionalInstructions,
	});
}

export class ReviewCommand implements CustomCommand {
	name = "review";
	description = "Launch interactive code review";

	constructor(private api: CustomCommandAPI) {}

	async execute(args: string[], ctx: HookCommandContext): Promise<string | undefined> {
		if (!ctx.hasUI) {
			const base = "Use the Task tool to run the 'reviewer' agent to review recent code changes.";
			return args.length > 0 ? `${base} Focus: ${args.join(" ")}` : base;
		}

		// Inline args act as additional instructions appended to the generated prompt.
		// When present, skip option 4 (editor) — the args already provide the instructions.
		const extraInstructions = args.length > 0 ? args.join(" ") : undefined;

		const menuItems = extraInstructions
			? [
					"1. Review against a base branch (PR Style)",
					"2. Review uncommitted changes",
					"3. Review a specific commit",
				]
			: [
					"1. Review against a base branch (PR Style)",
					"2. Review uncommitted changes",
					"3. Review a specific commit",
					"4. Custom review instructions",
				];

		const mode = await ctx.ui.select("Review Mode", menuItems);

		if (!mode) return undefined;

		const modeNum = parseInt(mode[0], 10);

		switch (modeNum) {
			case 1: {
				// PR-style review against base branch
				const branches = await getGitBranches(this.api);
				if (branches.length === 0) {
					ctx.ui.notify("No git branches found", "error");
					return undefined;
				}

				const baseBranch = await ctx.ui.select("Select base branch to compare against", branches);
				if (!baseBranch) return undefined;

				const currentBranch = await getCurrentBranch(this.api);
				let diffText: string;
				try {
					diffText = await git.diff(this.api.cwd, { base: `${baseBranch}...${currentBranch}` });
				} catch (err) {
					ctx.ui.notify(`Failed to get diff: ${err instanceof Error ? err.message : String(err)}`, "error");
					return undefined;
				}

				if (!diffText.trim()) {
					ctx.ui.notify(`No changes between ${baseBranch} and ${currentBranch}`, "warning");
					return undefined;
				}

				const stats = parseDiff(diffText);
				if (stats.files.length === 0) {
					ctx.ui.notify("No reviewable files (all changes filtered out)", "warning");
					return undefined;
				}

				return buildReviewPrompt(
					`Reviewing changes between \`${baseBranch}\` and \`${currentBranch}\` (PR-style)`,
					stats,
					diffText,
					extraInstructions,
				);
			}

			case 2: {
				// Uncommitted changes - combine staged and unstaged
				const status = await getGitStatus(this.api);
				if (!status.trim()) {
					ctx.ui.notify("No uncommitted changes found", "warning");
					return undefined;
				}

				let unstagedDiff: string;
				let stagedDiff: string;
				try {
					[unstagedDiff, stagedDiff] = await Promise.all([
						git.diff(this.api.cwd),
						git.diff(this.api.cwd, { cached: true }),
					]);
				} catch (err) {
					ctx.ui.notify(`Failed to get diff: ${err instanceof Error ? err.message : String(err)}`, "error");
					return undefined;
				}

				const combinedDiff = [unstagedDiff, stagedDiff].filter(Boolean).join("\n");

				if (!combinedDiff.trim()) {
					ctx.ui.notify("No diff content found", "warning");
					return undefined;
				}

				const stats = parseDiff(combinedDiff);
				if (stats.files.length === 0) {
					ctx.ui.notify("No reviewable files (all changes filtered out)", "warning");
					return undefined;
				}

				return buildReviewPrompt(
					"Reviewing uncommitted changes (staged + unstaged)",
					stats,
					combinedDiff,
					extraInstructions,
				);
			}

			case 3: {
				// Specific commit
				const commits = await getRecentCommits(this.api, 20);
				if (commits.length === 0) {
					ctx.ui.notify("No commits found", "error");
					return undefined;
				}

				const selected = await ctx.ui.select("Select commit to review", commits);
				if (!selected) return undefined;

				// Extract commit hash from selection (format: "abc1234 message")
				const hash = selected.split(" ")[0];

				let diffText: string;
				try {
					diffText = await git.show(this.api.cwd, hash, { format: "" });
				} catch (err) {
					ctx.ui.notify(`Failed to get commit: ${err instanceof Error ? err.message : String(err)}`, "error");
					return undefined;
				}

				if (!diffText.trim()) {
					ctx.ui.notify("Commit has no diff content", "warning");
					return undefined;
				}

				const stats = parseDiff(diffText);
				if (stats.files.length === 0) {
					ctx.ui.notify("No reviewable files in commit (all changes filtered out)", "warning");
					return undefined;
				}

				return buildReviewPrompt(`Reviewing commit \`${hash}\``, stats, diffText, extraInstructions);
			}

			case 4: {
				// Custom instructions - still uses the old approach since user provides context
				const instructions = await ctx.ui.editor("Enter custom review instructions", "Review the following:\n\n");
				if (!instructions?.trim()) return undefined;

				// For custom, we still try to get current diff for context
				let diffText: string | undefined;
				try {
					diffText = await git.diff(this.api.cwd, { base: "HEAD" });
				} catch {
					diffText = undefined;
				}
				const reviewDiff = diffText?.trim();

				if (reviewDiff) {
					const stats = parseDiff(reviewDiff);
					// Even if all files filtered, include the custom instructions
					return buildReviewPrompt(
						`Custom review: ${instructions.split("\n")[0].slice(0, 60)}…`,
						stats,
						reviewDiff,
						instructions,
					);
				}

				// No diff available, just pass instructions
				return `## Code Review Request

### Mode
Custom review instructions

### Instructions

${instructions}

Use the Task tool with \`agent: "reviewer"\` to execute this review.`;
			}

			default:
				return undefined;
		}
	}
}

async function getGitBranches(api: CustomCommandAPI): Promise<string[]> {
	try {
		return await git.branch.list(api.cwd, { all: true });
	} catch {
		return [];
	}
}

async function getCurrentBranch(api: CustomCommandAPI): Promise<string> {
	try {
		return (await git.branch.current(api.cwd)) ?? "HEAD";
	} catch {
		return "HEAD";
	}
}

async function getGitStatus(api: CustomCommandAPI): Promise<string> {
	try {
		return await git.status(api.cwd);
	} catch {
		return "";
	}
}

async function getRecentCommits(api: CustomCommandAPI, count: number): Promise<string[]> {
	try {
		return await git.log.onelines(api.cwd, count);
	} catch {
		return [];
	}
}

export default ReviewCommand;
