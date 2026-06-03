/**
 * /review command - Interactive code review launcher
 *
 * Provides a menu to select review mode:
 * 1. Review against a base branch (PR style)
 * 2. Review uncommitted changes
 * 3. Review a specific commit
 * 4. Custom review instructions
 *
 * Runs VCS diffs upfront, parses results, filters noise, and provides
 * rich context for the orchestrating agent to distribute work across
 * multiple reviewer agents based on diff weight and locality.
 */
import { prompt } from "@oh-my-pi/pi-utils";
import type { CustomCommand, CustomCommandAPI } from "../../../../extensibility/custom-commands/types";
import type { HookCommandContext } from "../../../../extensibility/hooks/types";
import reviewCustomRequestTemplate from "../../../../prompts/review-custom-request.md" with { type: "text" };
import reviewHeadlessRequestTemplate from "../../../../prompts/review-headless-request.md" with { type: "text" };
import reviewRequestTemplate from "../../../../prompts/review-request.md" with { type: "text" };
import * as git from "../../../../utils/git";
import * as jj from "../../../../utils/jj";

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

interface CurrentReviewDiff {
	diffInstruction: string;
	diffText: string;
	emptyMessage?: string;
	mode: string;
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
const DEFAULT_LARGE_DIFF_INSTRUCTION = "MUST run `git diff`/`git show` for assigned files";
const GIT_UNCOMMITTED_DIFF_INSTRUCTION =
	"MUST run both `git diff -- <path>` and `git diff --cached -- <path>` for assigned files";
const JJ_UNCOMMITTED_DIFF_INSTRUCTION = "MUST run `jj --ignore-working-copy diff --git -- <path>` for assigned files";

/**
 * Build the full review prompt with diff stats and distribution guidance.
 */
function buildReviewPrompt(
	mode: string,
	stats: DiffStats,
	rawDiff: string,
	options: { additionalInstructions?: string; diffInstruction?: string } = {},
): string {
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
		additionalInstructions: options.additionalInstructions,
		diffInstruction: options.diffInstruction ?? DEFAULT_LARGE_DIFF_INSTRUCTION,
	});
}

function buildCustomReviewPrompt(instructions: string): string {
	return prompt.render(reviewCustomRequestTemplate, { instructions });
}

function buildHeadlessReviewPrompt(focus?: string): string {
	return prompt.render(reviewHeadlessRequestTemplate, { focus });
}

export class ReviewCommand implements CustomCommand {
	name = "review";
	description = "Launch interactive code review";

	constructor(private api: CustomCommandAPI) {}

	async execute(args: string[], ctx: HookCommandContext): Promise<string | undefined> {
		if (!ctx.hasUI) {
			return buildHeadlessReviewPrompt(args.length > 0 ? args.join(" ") : undefined);
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
					{ additionalInstructions: extraInstructions },
				);
			}

			case 2: {
				const reviewDiff = await getUncommittedReviewDiff(this.api).catch(err => {
					ctx.ui.notify(`Failed to get diff: ${err instanceof Error ? err.message : String(err)}`, "error");
					return undefined;
				});
				if (!reviewDiff) return undefined;

				if (!reviewDiff.diffText.trim()) {
					ctx.ui.notify(reviewDiff.emptyMessage ?? "No diff content found", "warning");
					return undefined;
				}

				const stats = parseDiff(reviewDiff.diffText);
				if (stats.files.length === 0) {
					ctx.ui.notify("No reviewable files (all changes filtered out)", "warning");
					return undefined;
				}

				return buildReviewPrompt(reviewDiff.mode, stats, reviewDiff.diffText, {
					additionalInstructions: extraInstructions,
					diffInstruction: reviewDiff.diffInstruction,
				});
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

				return buildReviewPrompt(`Reviewing commit \`${hash}\``, stats, diffText, {
					additionalInstructions: extraInstructions,
				});
			}

			case 4: {
				// Custom instructions with opportunistic current-diff context.
				const instructions = await ctx.ui.editor(
					"Enter custom review instructions",
					"Review the following:\n\n",
					undefined,
					{ promptStyle: true },
				);
				if (!instructions?.trim()) return undefined;

				const reviewDiff = await getUncommittedReviewDiff(this.api).catch(() => undefined);

				if (reviewDiff?.diffText.trim()) {
					const stats = parseDiff(reviewDiff.diffText);
					// Even if all files filtered, include the custom instructions
					return buildReviewPrompt(
						`Custom review: ${instructions.split("\n")[0].slice(0, 60)}…`,
						stats,
						reviewDiff.diffText,
						{
							additionalInstructions: instructions,
							diffInstruction: reviewDiff.diffInstruction,
						},
					);
				}

				return buildCustomReviewPrompt(instructions);
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

async function getUncommittedReviewDiff(api: CustomCommandAPI): Promise<CurrentReviewDiff> {
	if (await jj.repo.is(api.cwd)) {
		return {
			diffText: await jj.diff(api.cwd),
			diffInstruction: JJ_UNCOMMITTED_DIFF_INSTRUCTION,
			emptyMessage: "No uncommitted changes found",
			mode: "Reviewing JJ working-copy changes",
		};
	}

	const status = await getGitStatus(api);
	if (!status.trim()) {
		return {
			diffText: "",
			diffInstruction: GIT_UNCOMMITTED_DIFF_INSTRUCTION,
			emptyMessage: "No uncommitted changes found",
			mode: "Reviewing uncommitted changes (staged + unstaged)",
		};
	}

	const [unstagedDiff, stagedDiff] = await Promise.all([git.diff(api.cwd), git.diff(api.cwd, { cached: true })]);
	const combinedDiff = [unstagedDiff, stagedDiff].filter(Boolean).join("\n");
	return {
		diffText: combinedDiff,
		diffInstruction: GIT_UNCOMMITTED_DIFF_INSTRUCTION,
		emptyMessage: "No diff content found",
		mode: "Reviewing uncommitted changes (staged + unstaged)",
	};
}

async function getRecentCommits(api: CustomCommandAPI, count: number): Promise<string[]> {
	try {
		return await git.log.onelines(api.cwd, count);
	} catch {
		return [];
	}
}

export default ReviewCommand;
