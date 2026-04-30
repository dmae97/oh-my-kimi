import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { StringEnum } from "@oh-my-pi/pi-ai";
import { abortableSleep, getWorktreesDir, isEnoent, prompt, untilAborted } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import githubDescription from "../prompts/tools/github.md" with { type: "text" };
import * as git from "../utils/git";
import type { ToolSession } from ".";
import { formatShortSha } from "./gh-format";
import type { OutputMeta } from "./output-meta";
import { ToolError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";

const GH_REPO_FIELDS = [
	"nameWithOwner",
	"description",
	"url",
	"defaultBranchRef",
	"homepageUrl",
	"forkCount",
	"isArchived",
	"isFork",
	"primaryLanguage",
	"repositoryTopics",
	"stargazerCount",
	"updatedAt",
	"viewerPermission",
	"visibility",
];
const GH_ISSUE_FIELDS = [
	"author",
	"body",
	"comments",
	"createdAt",
	"labels",
	"number",
	"state",
	"stateReason",
	"title",
	"updatedAt",
	"url",
];
const GH_ISSUE_FIELDS_NO_COMMENTS = [
	"author",
	"body",
	"createdAt",
	"labels",
	"number",
	"state",
	"stateReason",
	"title",
	"updatedAt",
	"url",
];
const GH_PR_FIELDS = [
	"author",
	"baseRefName",
	"body",
	"comments",
	"createdAt",
	"files",
	"headRefName",
	"isDraft",
	"labels",
	"mergeStateStatus",
	"number",
	"reviewDecision",
	"state",
	"title",
	"updatedAt",
	"url",
];
const GH_PR_FIELDS_NO_COMMENTS = [
	"author",
	"baseRefName",
	"body",
	"createdAt",
	"files",
	"headRefName",
	"isDraft",
	"labels",
	"mergeStateStatus",
	"number",
	"reviews",
	"reviewDecision",
	"state",
	"title",
	"updatedAt",
	"url",
];
const GH_REPO_CLONE_FIELDS = ["nameWithOwner", "sshUrl", "url"];
const GH_PR_CHECKOUT_FIELDS = [
	"baseRefName",
	"headRefName",
	"headRefOid",
	"headRepository",
	"headRepositoryOwner",
	"isCrossRepository",
	"maintainerCanModify",
	"number",
	"title",
	"url",
];
const GH_SEARCH_FIELDS = [
	"author",
	"createdAt",
	"labels",
	"number",
	"repository",
	"state",
	"title",
	"updatedAt",
	"url",
];
const SEARCH_LIMIT_DEFAULT = 10;
const SEARCH_LIMIT_MAX = 50;
const FILE_PREVIEW_LIMIT = 50;
const RUN_WATCH_INTERVAL_DEFAULT = 3;
const RUN_WATCH_GRACE_DEFAULT = 5;
const RUN_WATCH_TAIL_DEFAULT = 15;
const RUN_WATCH_TAIL_MAX = 200;
const REVIEW_COMMENTS_PAGE_SIZE = 100;
const RUN_JOBS_PAGE_SIZE = 100;
const PR_URL_PATTERN = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/.*)?$/;
const RUN_URL_PATTERN = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:\/.*)?$/;
const RUN_SUCCESS_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const RUN_FAILURE_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);
const JOB_FAILURE_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required"]);

const githubSchema = Type.Object({
	op: StringEnum(
		[
			"repo_view",
			"issue_view",
			"pr_view",
			"pr_diff",
			"pr_checkout",
			"pr_push",
			"search_issues",
			"search_prs",
			"run_watch",
		],
		{ description: "github operation" },
	),
	repo: Type.Optional(
		Type.String({
			description: "owner/repo (any op)",
			examples: ["facebook/react"],
		}),
	),
	branch: Type.Optional(
		Type.String({
			description: "branch (repo_view, pr_push local branch, run_watch)",
			examples: ["main", "develop"],
		}),
	),
	issue: Type.Optional(
		Type.String({
			description: "issue number or url (issue_view)",
			examples: ["123", "https://github.com/owner/repo/issues/123"],
		}),
	),
	pr: Type.Optional(
		Type.Union(
			[
				Type.String({ examples: ["123", "feature-branch"] }),
				Type.Array(Type.String(), {
					examples: [["123", "456"]],
				}),
			],
			{
				description:
					"pr number, url, or branch (pr_view, pr_diff, pr_checkout); pass an array to batch-process multiple pull requests in one call",
			},
		),
	),
	comments: Type.Optional(Type.Boolean({ description: "include comments (issue_view, pr_view)", default: true })),
	nameOnly: Type.Optional(Type.Boolean({ description: "return file names only (pr_diff)" })),
	exclude: Type.Optional(
		Type.Array(Type.String({ description: "glob to exclude" }), {
			description: "file globs to exclude (pr_diff)",
		}),
	),
	force: Type.Optional(Type.Boolean({ description: "reset existing local branch (pr_checkout)" })),
	forceWithLease: Type.Optional(Type.Boolean({ description: "force-with-lease push (pr_push)" })),
	query: Type.Optional(
		Type.String({
			description: "search query (search_issues, search_prs)",
			examples: ["is:open label:bug"],
		}),
	),
	limit: Type.Optional(Type.Number({ description: "max results (search_issues, search_prs)", default: 10 })),
	run: Type.Optional(Type.String({ description: "actions run id or url (run_watch)", examples: ["123456"] })),
	tail: Type.Optional(Type.Number({ description: "log lines per failed job (run_watch)", default: 15 })),
});

type GithubInput = Static<typeof githubSchema>;

export interface GhToolDetails {
	meta?: OutputMeta;
	artifactId?: string;
	repo?: string;
	branch?: string;
	worktreePath?: string;
	remote?: string;
	remoteBranch?: string;
	headSha?: string;
	runId?: number;
	runIds?: number[];
	status?: string;
	conclusion?: string;
	failedJobs?: string[];
	watch?: GhRunWatchViewDetails;
	checkouts?: GhPrCheckoutSummary[];
}

export interface GhPrCheckoutSummary {
	prNumber?: number;
	url?: string;
	branch: string;
	worktreePath: string;
	remote: string;
	remoteBranch: string;
	reused: boolean;
}

export interface GhRunWatchJobDetails {
	id: number;
	name: string;
	status?: string;
	conclusion?: string;
	durationSeconds?: number;
	url?: string;
}

export interface GhRunWatchRunDetails {
	id: number;
	workflowName?: string;
	displayTitle?: string;
	status?: string;
	conclusion?: string;
	branch?: string;
	headSha?: string;
	url?: string;
	jobs: GhRunWatchJobDetails[];
}

export interface GhRunWatchFailedLogDetails {
	runId: number;
	workflowName?: string;
	jobName: string;
	conclusion?: string;
	tail?: string;
	available: boolean;
}

export interface GhRunWatchViewDetails {
	mode: "run" | "commit";
	state: "watching" | "completed";
	repo: string;
	branch?: string;
	headSha?: string;
	pollCount?: number;
	note?: string;
	run?: GhRunWatchRunDetails;
	runs?: GhRunWatchRunDetails[];
	failedLogs?: GhRunWatchFailedLogDetails[];
}

interface GhUser {
	login?: string;
	name?: string | null;
}

interface GhLabel {
	name?: string;
}

interface GhComment {
	author?: GhUser | null;
	body?: string;
	createdAt?: string;
	url?: string;
	isMinimized?: boolean;
	minimizedReason?: string | null;
}

interface GhRepoTopic {
	name?: string;
	topic?: { name?: string };
}

interface GhRepoLanguage {
	name?: string;
}

interface GhRepoBranch {
	name?: string;
}

interface GhRepoViewData {
	nameWithOwner?: string;
	description?: string | null;
	url?: string;
	sshUrl?: string;
	defaultBranchRef?: GhRepoBranch | null;
	homepageUrl?: string | null;
	forkCount?: number;
	isArchived?: boolean;
	isFork?: boolean;
	primaryLanguage?: GhRepoLanguage | null;
	repositoryTopics?: GhRepoTopic[];
	stargazerCount?: number;
	updatedAt?: string;
	viewerPermission?: string | null;
	visibility?: string | null;
}

interface GhIssueViewData {
	author?: GhUser | null;
	body?: string | null;
	comments?: GhComment[];
	createdAt?: string;
	labels?: GhLabel[];
	number?: number;
	state?: string;
	stateReason?: string | null;
	title?: string;
	updatedAt?: string;
	url?: string;
}

interface GhPrFile {
	path?: string;
	additions?: number;
	deletions?: number;
	changeType?: string;
}

interface GhPrViewData extends GhIssueViewData {
	baseRefName?: string;
	files?: GhPrFile[];
	headRefName?: string;
	headRefOid?: string;
	headRepository?: GhRepoViewData | null;
	headRepositoryOwner?: GhUser | null;
	isCrossRepository?: boolean;
	isDraft?: boolean;
	maintainerCanModify?: boolean;
	mergeStateStatus?: string;
	reviewComments?: GhPrReviewComment[];
	reviews?: GhPrReview[];
	reviewDecision?: string;
}

interface GhPrReviewCommit {
	oid?: string | null;
}

interface GhPrReview {
	author?: GhUser | null;
	body?: string | null;
	commit?: GhPrReviewCommit | null;
	state?: string | null;
	submittedAt?: string | null;
}

interface GhPrReviewCommentApi {
	body?: string | null;
	created_at?: string | null;
	html_url?: string | null;
	id?: number;
	in_reply_to_id?: number | null;
	line?: number | null;
	original_line?: number | null;
	path?: string | null;
	side?: string | null;
	user?: GhUser | null;
}

interface GhPrReviewComment {
	author?: GhUser | null;
	body?: string | null;
	createdAt?: string;
	id: number;
	inReplyToId?: number;
	line?: number;
	originalLine?: number;
	path?: string;
	side?: string;
	url?: string;
}

interface GhBranchApiResponse {
	commit?: {
		sha?: string | null;
	} | null;
}

interface GhSearchRepository {
	nameWithOwner?: string;
}

interface GhSearchResult {
	author?: GhUser | null;
	createdAt?: string;
	labels?: GhLabel[];
	number?: number;
	repository?: GhSearchRepository | null;
	state?: string;
	title?: string;
	updatedAt?: string;
	url?: string;
}

interface GhRunReference {
	repo?: string;
	runId?: number;
}

interface GhActionsRunListResponse {
	workflow_runs?: GhActionsRunApi[];
}

interface GhActionsRunApi {
	id?: number;
	name?: string | null;
	display_title?: string | null;
	status?: string | null;
	conclusion?: string | null;
	head_branch?: string | null;
	head_sha?: string | null;
	created_at?: string | null;
	updated_at?: string | null;
	html_url?: string | null;
}

interface GhActionsJobsResponse {
	total_count?: number;
	jobs?: GhActionsJobApi[];
}

interface GhActionsJobApi {
	id?: number;
	name?: string | null;
	status?: string | null;
	conclusion?: string | null;
	started_at?: string | null;
	completed_at?: string | null;
	html_url?: string | null;
}

interface GhRunJobSnapshot {
	id: number;
	name: string;
	status?: string;
	conclusion?: string;
	startedAt?: string;
	completedAt?: string;
	url?: string;
}

interface GhRunSnapshot {
	id: number;
	workflowName?: string;
	displayTitle?: string;
	status?: string;
	conclusion?: string;
	branch?: string;
	headSha?: string;
	createdAt?: string;
	updatedAt?: string;
	url?: string;
	jobs: GhRunJobSnapshot[];
}

interface GhFailedJobLog {
	run: GhRunSnapshot;
	job: GhRunJobSnapshot;
	full?: string;
	tail?: string;
	available: boolean;
}

function normalizeText(value: string | null | undefined): string {
	return (value ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\t", "    ").trim();
}

function normalizeBlock(value: string | null | undefined): string {
	return (value ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\t", "    ").trimEnd();
}

function looksLikeGitHubUrl(value: string | undefined): boolean {
	return value?.startsWith("https://github.com/") ?? false;
}

function normalizeOptionalString(value: string | null | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}

function normalizePrIdentifierList(value: string | string[] | undefined): string[] {
	if (value === undefined) return [];
	const raw = typeof value === "string" ? [value] : value;
	const cleaned: string[] = [];
	for (const entry of raw) {
		const trimmed = entry?.trim();
		if (trimmed) cleaned.push(trimmed);
	}
	return cleaned;
}

function requireNonEmpty(value: string | null | undefined, label: string): string {
	const normalized = normalizeOptionalString(value);
	if (!normalized) {
		throw new ToolError(`${label} must not be empty`);
	}
	return normalized;
}

function resolveSearchLimit(value: number | undefined): number {
	if (value === undefined) {
		return SEARCH_LIMIT_DEFAULT;
	}

	if (!Number.isFinite(value) || value <= 0) {
		throw new ToolError("limit must be a positive number");
	}

	return Math.min(Math.floor(value), SEARCH_LIMIT_MAX);
}

function resolveTailLimit(value: number | undefined): number {
	if (value === undefined) {
		return RUN_WATCH_TAIL_DEFAULT;
	}

	if (!Number.isFinite(value) || value <= 0) {
		throw new ToolError("tail must be a positive number");
	}

	return Math.min(Math.floor(value), RUN_WATCH_TAIL_MAX);
}

function appendRepoFlag(args: string[], repo: string | undefined, identifier?: string): void {
	if (!repo || looksLikeGitHubUrl(identifier)) {
		return;
	}

	args.push("--repo", repo);
}

function buildGhSearchArgs(
	command: "issues" | "prs",
	query: string,
	limit: number,
	repo: string | undefined,
): string[] {
	const args = ["search", command, "--limit", String(limit), "--json", GH_SEARCH_FIELDS.join(",")];
	appendRepoFlag(args, repo);
	args.push("--", query);
	return args;
}

function sanitizeRemoteName(value: string): string {
	const sanitized = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+/g, "")
		.replace(/-+$/g, "");
	return sanitized.length > 0 ? `fork-${sanitized}` : "fork";
}

/**
 * Encode an absolute repository path into a single filesystem-safe segment.
 * Mirrors the legacy session-dir encoding used elsewhere in the project: drop
 * the leading separator, then collapse `/`, `\\`, and `:` to `-`. The result
 * is not strictly injective for pathological inputs (e.g. `/a/b` vs `/a-b`)
 * but matches the rest of the codebase and stays human-readable.
 */
function encodeRepoPathForFilesystem(repoPath: string): string {
	const resolved = path.resolve(repoPath);
	const encoded = resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
	return encoded || "root";
}

function toLocalBranchRef(value: string): string {
	return `refs/heads/${value}`;
}

async function requireGitRepoRoot(cwd: string, signal?: AbortSignal): Promise<string> {
	const repoRoot = await git.repo.root(cwd, signal);
	if (!repoRoot) {
		throw new ToolError("Current git repository is unavailable.");
	}

	return repoRoot;
}

async function requirePrimaryGitRepoRoot(cwd: string, signal?: AbortSignal): Promise<string> {
	const primaryRepoRoot = await git.repo.primaryRoot(cwd, signal);
	if (!primaryRepoRoot) {
		throw new ToolError("Current git repository is unavailable.");
	}

	return primaryRepoRoot;
}

async function requireCurrentGitBranch(cwd: string, signal?: AbortSignal): Promise<string> {
	const branch = await git.branch.current(cwd, signal);
	if (!branch) {
		throw new ToolError("Current git branch is unavailable. Pass `branch` or `run` explicitly.");
	}

	return branch;
}

async function requireCurrentGitHead(cwd: string, signal?: AbortSignal): Promise<string> {
	const headSha = await git.head.sha(cwd, signal);
	if (!headSha) {
		throw new ToolError("Current git HEAD is unavailable. Pass `run` explicitly.");
	}

	return headSha;
}

async function ensureGitWorktreePathAvailable(
	worktreePath: string,
	existingWorktrees: git.GitWorktreeEntry[],
): Promise<void> {
	const normalizedTarget = path.resolve(worktreePath);
	const conflictingWorktree = existingWorktrees.find(entry => path.resolve(entry.path) === normalizedTarget);
	if (conflictingWorktree) {
		throw new ToolError(`worktree path is already registered: ${conflictingWorktree.path}`);
	}

	try {
		await fs.stat(normalizedTarget);
		throw new ToolError(`worktree path already exists: ${normalizedTarget}`);
	} catch (error) {
		if (isEnoent(error)) {
			return;
		}
		throw error;
	}
}

function selectPrCloneUrl(originUrl: string | undefined, repo: Pick<GhRepoViewData, "url" | "sshUrl">): string {
	if (originUrl?.startsWith("http://") || originUrl?.startsWith("https://")) {
		return normalizeOptionalString(repo.url) ?? normalizeOptionalString(repo.sshUrl) ?? "";
	}

	return normalizeOptionalString(repo.sshUrl) ?? normalizeOptionalString(repo.url) ?? "";
}

async function getRemoteUrls(repoRoot: string, signal?: AbortSignal): Promise<Map<string, string>> {
	const remotes = await git.remote.list(repoRoot, signal);
	const urls = new Map<string, string>();
	for (const remoteName of remotes) {
		const remoteUrl = await git.remote.url(repoRoot, remoteName, signal);
		if (remoteUrl) {
			urls.set(remoteName, remoteUrl);
		}
	}
	return urls;
}

async function ensurePrRemote(
	repoRoot: string,
	data: GhPrViewData,
	signal?: AbortSignal,
): Promise<{ name: string; url: string }> {
	if (!data.isCrossRepository) {
		const originUrl = await git.remote.url(repoRoot, "origin", signal);
		if (!originUrl) {
			throw new ToolError("origin remote is unavailable for this repository.");
		}

		return {
			name: "origin",
			url: originUrl,
		};
	}

	const headRepository = requireNonEmpty(data.headRepository?.nameWithOwner, "head repository");
	const repoSummary = await git.github.json<GhRepoViewData>(
		repoRoot,
		["repo", "view", headRepository, "--json", GH_REPO_CLONE_FIELDS.join(",")],
		signal,
		{ repoProvided: true },
	);
	const originUrl = await git.remote.url(repoRoot, "origin", signal);
	const remoteUrl = selectPrCloneUrl(originUrl, repoSummary);
	if (!remoteUrl) {
		throw new ToolError(`Could not determine a clone URL for ${headRepository}.`);
	}

	const remotes = await getRemoteUrls(repoRoot, signal);
	for (const [remoteName, url] of remotes) {
		if (url === remoteUrl) {
			return { name: remoteName, url };
		}
	}

	const preferredRemoteName = sanitizeRemoteName(
		data.headRepositoryOwner?.login ?? headRepository.split("/")[0] ?? "fork",
	);
	let remoteName = preferredRemoteName;
	let suffix = 2;
	while (remotes.has(remoteName)) {
		remoteName = `${preferredRemoteName}-${suffix}`;
		suffix += 1;
	}

	await git.remote.add(repoRoot, remoteName, remoteUrl, signal);

	return {
		name: remoteName,
		url: remoteUrl,
	};
}

async function resolvePrBranchPushTarget(
	repoRoot: string,
	localBranch: string,
	signal?: AbortSignal,
): Promise<{
	remoteName: string;
	remoteBranch: string;
	remoteUrl?: string;
	prUrl?: string;
	maintainerCanModify?: boolean;
	isCrossRepository: boolean;
}> {
	const headRef = await git.config.getBranch(repoRoot, localBranch, "ompPrHeadRef", signal);
	if (!headRef) {
		throw new ToolError(`branch ${localBranch} has no PR push metadata; check it out via op: pr_checkout first`);
	}

	const pushRemote = await git.config.getBranch(repoRoot, localBranch, "pushRemote", signal);
	const remote = await git.config.getBranch(repoRoot, localBranch, "remote", signal);
	const prUrl = await git.config.getBranch(repoRoot, localBranch, "ompPrUrl", signal);
	const maintainerCanModifyValue = await git.config.getBranch(
		repoRoot,
		localBranch,
		"ompPrMaintainerCanModify",
		signal,
	);
	const isCrossRepositoryValue = await git.config.getBranch(repoRoot, localBranch, "ompPrIsCrossRepository", signal);

	const remoteName = pushRemote ?? remote;
	if (!remoteName) {
		throw new ToolError(`branch ${localBranch} has no configured push remote`);
	}

	return {
		remoteName,
		remoteBranch: headRef,
		remoteUrl: await git.remote.url(repoRoot, remoteName, signal),
		prUrl,
		maintainerCanModify:
			maintainerCanModifyValue === undefined
				? undefined
				: ["1", "true", "yes", "on"].includes(maintainerCanModifyValue.toLowerCase()),
		isCrossRepository: ["1", "true", "yes", "on"].includes((isCrossRepositoryValue ?? "").toLowerCase()),
	};
}

function formatAuthor(author: GhUser | null | undefined): string | undefined {
	if (!author) return undefined;
	if (author.login) return `@${author.login}`;
	if (author.name) return author.name;
	return undefined;
}

function formatLabels(labels: GhLabel[] | undefined): string | undefined {
	const names = labels?.map(label => label.name).filter((value): value is string => Boolean(value)) ?? [];
	if (names.length === 0) return undefined;
	return names.join(", ");
}

function pushLine(lines: string[], label: string, value: string | number | boolean | undefined): void {
	if (value === undefined || value === "") return;
	lines.push(`${label}: ${value}`);
}

function parseRunReference(value: string | undefined): GhRunReference {
	const run = normalizeOptionalString(value);
	if (!run) {
		return {};
	}

	if (/^\d+$/.test(run)) {
		return { runId: Number(run) };
	}

	const match = run.match(RUN_URL_PATTERN);
	if (!match) {
		throw new ToolError("run must be a numeric workflow run ID or a full GitHub Actions run URL");
	}

	return {
		repo: match[1],
		runId: Number(match[2]),
	};
}

function parsePullRequestUrl(value: string | undefined): { repo?: string; prNumber?: number } {
	const normalized = normalizeOptionalString(value);
	if (!normalized) {
		return {};
	}

	const match = normalized.match(PR_URL_PATTERN);
	if (!match) {
		return {};
	}

	return {
		repo: match[1],
		prNumber: Number(match[2]),
	};
}

function normalizePrReviewComment(comment: GhPrReviewCommentApi): GhPrReviewComment | null {
	if (typeof comment.id !== "number") {
		return null;
	}

	return {
		author: comment.user ?? null,
		body: comment.body,
		createdAt: normalizeOptionalString(comment.created_at),
		id: comment.id,
		inReplyToId: typeof comment.in_reply_to_id === "number" ? comment.in_reply_to_id : undefined,
		line: typeof comment.line === "number" ? comment.line : undefined,
		originalLine: typeof comment.original_line === "number" ? comment.original_line : undefined,
		path: normalizeOptionalString(comment.path),
		side: normalizeOptionalString(comment.side),
		url: normalizeOptionalString(comment.html_url),
	};
}

function normalizeRunJob(job: GhActionsJobApi): GhRunJobSnapshot | null {
	if (typeof job.id !== "number") {
		return null;
	}

	return {
		id: job.id,
		name: normalizeOptionalString(job.name) ?? `job-${job.id}`,
		status: normalizeOptionalString(job.status),
		conclusion: normalizeOptionalString(job.conclusion),
		startedAt: normalizeOptionalString(job.started_at),
		completedAt: normalizeOptionalString(job.completed_at),
		url: normalizeOptionalString(job.html_url),
	};
}

function normalizeRunSnapshot(run: GhActionsRunApi, jobs: GhRunJobSnapshot[]): GhRunSnapshot {
	if (typeof run.id !== "number") {
		throw new ToolError("GitHub Actions run response did not include a run ID.");
	}

	return {
		id: run.id,
		workflowName: normalizeOptionalString(run.name),
		displayTitle: normalizeOptionalString(run.display_title),
		status: normalizeOptionalString(run.status),
		conclusion: normalizeOptionalString(run.conclusion),
		branch: normalizeOptionalString(run.head_branch),
		headSha: normalizeOptionalString(run.head_sha),
		createdAt: normalizeOptionalString(run.created_at),
		updatedAt: normalizeOptionalString(run.updated_at),
		url: normalizeOptionalString(run.html_url),
		jobs,
	};
}

function getRunOutcome(value: string | undefined): "success" | "failure" | "pending" {
	if (!value) {
		return "pending";
	}

	if (RUN_SUCCESS_CONCLUSIONS.has(value)) {
		return "success";
	}

	if (RUN_FAILURE_CONCLUSIONS.has(value)) {
		return "failure";
	}

	return "pending";
}

function getRunSnapshotOutcome(run: GhRunSnapshot): "success" | "failure" | "pending" {
	if (run.status !== "completed") {
		return "pending";
	}

	return getRunOutcome(run.conclusion);
}

function getRunCollectionOutcome(runs: GhRunSnapshot[]): "success" | "failure" | "pending" {
	if (runs.length === 0) {
		return "pending";
	}

	let pending = false;
	for (const run of runs) {
		if (run.jobs.some(isFailedJob)) {
			return "failure";
		}

		const outcome = getRunSnapshotOutcome(run);
		if (outcome === "failure") {
			return "failure";
		}
		if (outcome === "pending") {
			pending = true;
		}
	}

	return pending ? "pending" : "success";
}

function getRunCollectionSignature(runs: GhRunSnapshot[]): string {
	return runs
		.map(run => run.id)
		.sort((left, right) => left - right)
		.join(",");
}

function isFailedJob(job: GhRunJobSnapshot): boolean {
	return job.conclusion !== undefined && JOB_FAILURE_CONCLUSIONS.has(job.conclusion);
}

function formatJobState(job: GhRunJobSnapshot): string {
	return job.conclusion ?? job.status ?? "unknown";
}

function parseTimestampMs(value: string | undefined): number | undefined {
	if (!value) {
		return undefined;
	}

	const timestamp = Date.parse(value);
	return Number.isNaN(timestamp) ? undefined : timestamp;
}

function getJobDurationSeconds(job: GhRunJobSnapshot, observedAtMs: number): number | undefined {
	const startedAtMs = parseTimestampMs(job.startedAt);
	if (startedAtMs === undefined) {
		return undefined;
	}

	const completedAtMs = parseTimestampMs(job.completedAt) ?? observedAtMs;
	return Math.max(0, Math.floor((completedAtMs - startedAtMs) / 1000));
}

function buildRunWatchJobDetails(job: GhRunJobSnapshot, observedAtMs: number): GhRunWatchJobDetails {
	return {
		id: job.id,
		name: job.name,
		status: job.status,
		conclusion: job.conclusion,
		durationSeconds: getJobDurationSeconds(job, observedAtMs),
		url: job.url,
	};
}

function buildRunWatchRunDetails(run: GhRunSnapshot, observedAtMs: number): GhRunWatchRunDetails {
	return {
		id: run.id,
		workflowName: run.workflowName,
		displayTitle: run.displayTitle,
		status: run.status,
		conclusion: run.conclusion,
		branch: run.branch,
		headSha: run.headSha,
		url: run.url,
		jobs: run.jobs.map(job => buildRunWatchJobDetails(job, observedAtMs)),
	};
}

function buildFailedLogDetails(failedJobLogs: GhFailedJobLog[]): GhRunWatchFailedLogDetails[] {
	return failedJobLogs.map(entry => ({
		runId: entry.run.id,
		workflowName: entry.run.workflowName,
		jobName: entry.job.name,
		conclusion: entry.job.conclusion,
		tail: entry.tail,
		available: entry.available,
	}));
}

function renderJobsSection(jobs: GhRunJobSnapshot[]): string[] {
	if (jobs.length === 0) {
		return ["## Jobs", "", "No jobs reported yet."];
	}

	const lines: string[] = [`## Jobs (${jobs.length})`, ""];
	for (const job of jobs) {
		lines.push(`- [${formatJobState(job)}] ${job.name}`);
		if (job.startedAt) {
			pushLine(lines, "  Started", job.startedAt);
		}
		if (job.completedAt) {
			pushLine(lines, "  Completed", job.completedAt);
		}
		if (job.url) {
			pushLine(lines, "  URL", job.url);
		}
	}

	return lines;
}

function renderFailedJobLogs(
	failedJobLogs: GhFailedJobLog[],
	options: { mode: "tail"; tail: number } | { mode: "full" },
): string[] {
	if (failedJobLogs.length === 0) {
		return [];
	}

	const lines: string[] = ["## Failed Jobs", ""];
	for (const entry of failedJobLogs) {
		lines.push(`### ${entry.job.name} [${entry.job.conclusion ?? "failed"}]`);
		pushLine(lines, "Run", `#${entry.run.id}`);
		pushLine(lines, "Workflow", entry.run.workflowName ?? undefined);
		if (entry.job.startedAt) {
			pushLine(lines, "Started", entry.job.startedAt);
		}
		if (entry.job.completedAt) {
			pushLine(lines, "Completed", entry.job.completedAt);
		}
		if (entry.job.url) {
			pushLine(lines, "URL", entry.job.url);
		}
		lines.push("");
		const logText = options.mode === "full" ? entry.full : entry.tail;
		if (entry.available && logText) {
			lines.push(options.mode === "full" ? "Full log:" : `Last ${options.tail} log lines:`);
			lines.push("```text");
			lines.push(logText);
			lines.push("```");
		} else {
			lines.push(options.mode === "full" ? "Full log unavailable." : "Log tail unavailable.");
		}
		lines.push("");
	}

	return lines;
}

function renderRunSection(run: GhRunSnapshot): string[] {
	const label = run.workflowName ? `### Run #${run.id} - ${run.workflowName}` : `### Run #${run.id}`;
	const lines: string[] = [label, ""];
	pushLine(lines, "Title", run.displayTitle ?? undefined);
	pushLine(lines, "Branch", run.branch ?? undefined);
	pushLine(lines, "Commit", formatShortSha(run.headSha));
	pushLine(lines, "Status", run.status);
	pushLine(lines, "Conclusion", run.conclusion ?? undefined);
	pushLine(lines, "Created", run.createdAt);
	pushLine(lines, "Updated", run.updatedAt);
	pushLine(lines, "URL", run.url);
	lines.push("");
	lines.push(...renderJobsSection(run.jobs));
	return lines;
}

function formatRunWatchSnapshot(
	repo: string,
	run: GhRunSnapshot,
	pollCount: number,
	note?: string,
	includeOutcome: boolean = false,
): string {
	const failedJobs = run.jobs.filter(isFailedJob);
	const lines: string[] = [`# Watching GitHub Actions Run #${run.id}`, ""];
	pushLine(lines, "Repository", repo);
	pushLine(lines, "Workflow", run.workflowName ?? undefined);
	pushLine(lines, "Title", run.displayTitle ?? undefined);
	pushLine(lines, "Branch", run.branch ?? undefined);
	pushLine(lines, "Status", run.status);
	pushLine(lines, "Conclusion", run.conclusion ?? undefined);
	pushLine(lines, "Created", run.createdAt);
	pushLine(lines, "Updated", run.updatedAt);
	pushLine(lines, "URL", run.url);
	pushLine(lines, "Poll", pollCount);
	pushLine(lines, "Failed jobs", failedJobs.length || undefined);

	if (note) {
		lines.push("");
		lines.push(`Note: ${note}`);
	}

	lines.push("");
	lines.push(...renderJobsSection(run.jobs));

	if (includeOutcome) {
		lines.push("");
		lines.push(failedJobs.length > 0 ? "Failures detected." : "All jobs passed.");
	}

	return lines.join("\n").trim();
}

function formatRunWatchResult(
	repo: string,
	run: GhRunSnapshot,
	failedJobLogs: GhFailedJobLog[],
	tail: number,
	options?: { mode?: "tail" | "full" },
): string {
	const failedJobs = run.jobs.filter(isFailedJob);
	const lines: string[] = [`# GitHub Actions Run #${run.id}`, ""];
	pushLine(lines, "Repository", repo);
	pushLine(lines, "Workflow", run.workflowName ?? undefined);
	pushLine(lines, "Title", run.displayTitle ?? undefined);
	pushLine(lines, "Branch", run.branch ?? undefined);
	pushLine(lines, "Status", run.status);
	pushLine(lines, "Conclusion", run.conclusion ?? undefined);
	pushLine(lines, "Created", run.createdAt);
	pushLine(lines, "Updated", run.updatedAt);
	pushLine(lines, "URL", run.url);
	lines.push("");
	lines.push(...renderJobsSection(run.jobs));

	if (failedJobs.length > 0) {
		lines.push("");
		lines.push(
			...renderFailedJobLogs(failedJobLogs, options?.mode === "full" ? { mode: "full" } : { mode: "tail", tail }),
		);
		lines.push("Run failed.");
	} else if (getRunOutcome(run.conclusion) === "success") {
		lines.push("");
		lines.push("All jobs passed.");
	} else {
		lines.push("");
		lines.push("Run completed without successful jobs, but no failed job logs were available.");
	}

	return lines.join("\n").trim();
}

function formatCommitRunWatchSnapshot(
	repo: string,
	headSha: string,
	branch: string | undefined,
	runs: GhRunSnapshot[],
	pollCount: number,
	note?: string,
): string {
	const failedJobs = runs.flatMap(run => run.jobs.filter(isFailedJob));
	const completedRuns = runs.filter(run => run.status === "completed").length;
	const lines: string[] = [`# Watching GitHub Actions for ${formatShortSha(headSha) ?? headSha}`, ""];
	pushLine(lines, "Repository", repo);
	pushLine(lines, "Branch", branch);
	pushLine(lines, "Commit", headSha);
	pushLine(lines, "Poll", pollCount);
	pushLine(lines, "Runs", runs.length);
	pushLine(lines, "Completed runs", `${completedRuns}/${runs.length}`);
	pushLine(lines, "Failed jobs", failedJobs.length || undefined);

	if (note) {
		lines.push("");
		lines.push(`Note: ${note}`);
	}

	if (runs.length === 0) {
		lines.push("");
		lines.push("Waiting for workflow runs for this commit.");
		return lines.join("\n").trim();
	}

	for (const run of runs) {
		lines.push("");
		lines.push(...renderRunSection(run));
	}

	return lines.join("\n").trim();
}

function formatCommitRunWatchResult(
	repo: string,
	headSha: string,
	branch: string | undefined,
	runs: GhRunSnapshot[],
	failedJobLogs: GhFailedJobLog[],
	tail: number,
	options?: { mode?: "tail" | "full" },
): string {
	const outcome = getRunCollectionOutcome(runs);
	const lines: string[] = [`# GitHub Actions for ${formatShortSha(headSha) ?? headSha}`, ""];
	pushLine(lines, "Repository", repo);
	pushLine(lines, "Branch", branch);
	pushLine(lines, "Commit", headSha);
	pushLine(lines, "Runs", runs.length);

	for (const run of runs) {
		lines.push("");
		lines.push(...renderRunSection(run));
	}

	if (failedJobLogs.length > 0) {
		lines.push("");
		lines.push(
			...renderFailedJobLogs(failedJobLogs, options?.mode === "full" ? { mode: "full" } : { mode: "tail", tail }),
		);
		lines.push("Workflow runs for this commit failed.");
	} else if (outcome === "success") {
		lines.push("");
		lines.push("All workflow runs for this commit passed.");
	} else {
		lines.push("");
		lines.push("Workflow runs for this commit did not complete successfully.");
	}

	return lines.join("\n").trim();
}

function buildGhDetails(repo: string, run: GhRunSnapshot): GhToolDetails {
	return {
		repo,
		branch: run.branch,
		headSha: run.headSha,
		runId: run.id,
		runIds: [run.id],
		status: run.status,
		conclusion: run.conclusion,
		failedJobs: run.jobs.filter(isFailedJob).map(job => job.name),
	};
}

function buildRunWatchDetails(
	repo: string,
	run: GhRunSnapshot,
	options?: {
		state?: GhRunWatchViewDetails["state"];
		pollCount?: number;
		note?: string;
		failedJobLogs?: GhFailedJobLog[];
	},
): GhToolDetails {
	const observedAtMs = Date.now();
	return {
		...buildGhDetails(repo, run),
		watch: {
			mode: "run",
			state: options?.state ?? "completed",
			repo,
			branch: run.branch,
			headSha: run.headSha,
			pollCount: options?.pollCount,
			note: options?.note,
			run: buildRunWatchRunDetails(run, observedAtMs),
			failedLogs: buildFailedLogDetails(options?.failedJobLogs ?? []),
		},
	};
}

function buildGhRunCollectionDetails(
	repo: string,
	headSha: string,
	branch: string | undefined,
	runs: GhRunSnapshot[],
): GhToolDetails {
	const outcome = getRunCollectionOutcome(runs);
	return {
		repo,
		branch,
		headSha,
		runIds: runs.map(run => run.id),
		status: runs.length > 0 && runs.every(run => run.status === "completed") ? "completed" : "in_progress",
		conclusion: outcome,
		failedJobs: runs.flatMap(run =>
			run.jobs.filter(isFailedJob).map(job => `${run.workflowName ?? `run ${run.id}`}: ${job.name}`),
		),
	};
}

function buildCommitRunWatchDetails(
	repo: string,
	headSha: string,
	branch: string | undefined,
	runs: GhRunSnapshot[],
	options?: {
		state?: GhRunWatchViewDetails["state"];
		pollCount?: number;
		note?: string;
		failedJobLogs?: GhFailedJobLog[];
	},
): GhToolDetails {
	const observedAtMs = Date.now();
	return {
		...buildGhRunCollectionDetails(repo, headSha, branch, runs),
		watch: {
			mode: "commit",
			state: options?.state ?? "completed",
			repo,
			branch,
			headSha,
			pollCount: options?.pollCount,
			note: options?.note,
			runs: runs.map(run => buildRunWatchRunDetails(run, observedAtMs)),
			failedLogs: buildFailedLogDetails(options?.failedJobLogs ?? []),
		},
	};
}

async function resolveGitHubRepo(
	cwd: string,
	repo: string | undefined,
	runRepo: string | undefined,
	signal?: AbortSignal,
): Promise<string> {
	if (repo && runRepo && repo !== runRepo) {
		throw new ToolError("run URL repository does not match the provided repo");
	}

	if (repo) {
		return repo;
	}

	if (runRepo) {
		return runRepo;
	}

	const resolved = await git.github.text(
		cwd,
		["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
		signal,
	);
	return requireNonEmpty(resolved, "repo");
}

async function resolveGitHubBranchHead(
	cwd: string,
	repo: string,
	branch: string,
	signal?: AbortSignal,
): Promise<string> {
	const response = await git.github.json<GhBranchApiResponse>(
		cwd,
		["api", "--method", "GET", `/repos/${repo}/branches/${encodeURIComponent(branch)}`],
		signal,
		{ repoProvided: true },
	);
	return requireNonEmpty(response.commit?.sha, `head SHA for branch ${branch}`);
}

async function fetchRunsForCommit(
	cwd: string,
	repo: string,
	headSha: string,
	branch: string | undefined,
	signal?: AbortSignal,
): Promise<GhRunSnapshot[]> {
	const response = await git.github.json<GhActionsRunListResponse>(
		cwd,
		[
			"api",
			"--method",
			"GET",
			`/repos/${repo}/actions/runs`,
			"-F",
			`head_sha=${headSha}`,
			"-F",
			`per_page=${RUN_JOBS_PAGE_SIZE}`,
			...(branch ? ["-F", `branch=${branch}`] : []),
		],
		signal,
		{ repoProvided: true },
	);

	return Promise.all(
		(response.workflow_runs ?? [])
			.filter((run): run is GhActionsRunApi & { id: number } => typeof run.id === "number")
			.map(async run => {
				const jobs = await fetchRunJobs(cwd, repo, run.id, signal);
				return normalizeRunSnapshot(run, jobs);
			}),
	);
}

async function fetchRunJobs(
	cwd: string,
	repo: string,
	runId: number,
	signal?: AbortSignal,
): Promise<GhRunJobSnapshot[]> {
	const jobs: GhRunJobSnapshot[] = [];
	let page = 1;

	while (true) {
		const response = await git.github.json<GhActionsJobsResponse>(
			cwd,
			[
				"api",
				"--method",
				"GET",
				`/repos/${repo}/actions/runs/${runId}/jobs`,
				"-F",
				`per_page=${RUN_JOBS_PAGE_SIZE}`,
				"-F",
				`page=${page}`,
			],
			signal,
			{ repoProvided: true },
		);
		const pageJobs = (response.jobs ?? [])
			.map(job => normalizeRunJob(job))
			.filter((job): job is GhRunJobSnapshot => job !== null);
		jobs.push(...pageJobs);

		if (pageJobs.length < RUN_JOBS_PAGE_SIZE) {
			break;
		}

		if ((response.total_count ?? 0) <= jobs.length) {
			break;
		}

		page += 1;
	}

	return jobs;
}

async function fetchPrReviewComments(
	cwd: string,
	repo: string,
	prNumber: number,
	signal?: AbortSignal,
): Promise<GhPrReviewComment[]> {
	const reviewComments: GhPrReviewComment[] = [];
	let page = 1;

	while (true) {
		const response = await git.github.json<GhPrReviewCommentApi[]>(
			cwd,
			[
				"api",
				"--method",
				"GET",
				`/repos/${repo}/pulls/${prNumber}/comments`,
				"-F",
				`per_page=${REVIEW_COMMENTS_PAGE_SIZE}`,
				"-F",
				`page=${page}`,
			],
			signal,
			{ repoProvided: true },
		);

		const pageComments = response
			.map(comment => normalizePrReviewComment(comment))
			.filter((comment): comment is GhPrReviewComment => comment !== null);
		reviewComments.push(...pageComments);

		if (pageComments.length < REVIEW_COMMENTS_PAGE_SIZE) {
			break;
		}

		page += 1;
	}

	return reviewComments;
}

async function fetchRunSnapshot(
	cwd: string,
	repo: string,
	runId: number,
	signal?: AbortSignal,
): Promise<GhRunSnapshot> {
	const [run, jobs] = await Promise.all([
		git.github.json<GhActionsRunApi>(
			cwd,
			["api", "--method", "GET", `/repos/${repo}/actions/runs/${runId}`],
			signal,
			{
				repoProvided: true,
			},
		),
		fetchRunJobs(cwd, repo, runId, signal),
	]);

	return normalizeRunSnapshot(run, jobs);
}

function tailLogLines(log: string, tail: number): string | undefined {
	const normalized = normalizeBlock(log);
	if (!normalized) {
		return undefined;
	}

	const lines = normalized.split("\n");
	return lines.slice(-tail).join("\n").trimEnd();
}

async function fetchFailedJobLogs(
	cwd: string,
	repo: string,
	failedJobs: Array<{ run: GhRunSnapshot; job: GhRunJobSnapshot }>,
	tail: number,
	signal?: AbortSignal,
): Promise<GhFailedJobLog[]> {
	return Promise.all(
		failedJobs.map(async entry => {
			const result = await git.github.run(cwd, ["api", `/repos/${repo}/actions/jobs/${entry.job.id}/logs`], signal);
			const fullLog = result.exitCode === 0 ? normalizeBlock(result.stdout) : undefined;
			const logTail = fullLog ? tailLogLines(fullLog, tail) : undefined;
			return {
				run: entry.run,
				job: entry.job,
				full: fullLog,
				tail: logTail,
				available: Boolean(fullLog),
			};
		}),
	);
}

function formatCommentsSection(comments: GhComment[] | undefined): string[] {
	if (!comments || comments.length === 0) {
		return [];
	}

	const visible = comments.filter(comment => !comment.isMinimized);
	const hiddenCount = comments.length - visible.length;
	const lines: string[] = ["## Comments", ""];

	if (visible.length === 0) {
		lines.push(`No visible comments. Minimized comments omitted: ${hiddenCount}.`);
		return lines;
	}

	lines[0] = `## Comments (${visible.length})`;

	for (const comment of visible) {
		const author = formatAuthor(comment.author) ?? "unknown";
		const createdAt = comment.createdAt ? ` · ${comment.createdAt}` : "";
		lines.push(`### ${author}${createdAt}`);
		lines.push("");
		lines.push(normalizeText(comment.body) || "No comment body.");
		if (comment.url) {
			lines.push("");
			lines.push(`URL: ${comment.url}`);
		}
		lines.push("");
	}

	if (hiddenCount > 0) {
		lines.push(`Minimized comments omitted: ${hiddenCount}.`);
	}

	return lines;
}

function formatReviewsSection(reviews: GhPrReview[] | undefined): string[] {
	if (!reviews || reviews.length === 0) {
		return [];
	}

	const lines: string[] = [`## Reviews (${reviews.length})`, ""];
	for (const review of reviews) {
		const author = formatAuthor(review.author) ?? "unknown";
		const submittedAt = review.submittedAt ? ` - ${review.submittedAt}` : "";
		const state = review.state ? ` [${review.state}]` : "";
		lines.push(`### ${author}${submittedAt}${state}`);
		if (review.commit?.oid) {
			lines.push("");
			lines.push(`Commit: ${formatShortSha(review.commit.oid)}`);
		}
		lines.push("");
		lines.push(normalizeText(review.body) || "No review body.");
		lines.push("");
	}

	return lines;
}

function formatReviewCommentLocation(comment: GhPrReviewComment): string | undefined {
	if (!comment.path) {
		return undefined;
	}

	const line = comment.line ?? comment.originalLine;
	return line === undefined ? comment.path : `${comment.path}:${line}`;
}

function formatReviewCommentsSection(comments: GhPrReviewComment[] | undefined): string[] {
	if (!comments || comments.length === 0) {
		return [];
	}

	const lines: string[] = [`## Review Comments (${comments.length})`, ""];
	for (const comment of comments) {
		const author = formatAuthor(comment.author) ?? "unknown";
		const createdAt = comment.createdAt ? ` · ${comment.createdAt}` : "";
		lines.push(`### ${author}${createdAt}`);
		lines.push("");
		pushLine(lines, "Location", formatReviewCommentLocation(comment));
		pushLine(lines, "Side", comment.side);
		pushLine(lines, "Reply to", comment.inReplyToId);
		pushLine(lines, "URL", comment.url);
		lines.push("");
		lines.push(normalizeText(comment.body) || "No review comment body.");
		lines.push("");
	}

	return lines;
}

function formatRepoView(data: GhRepoViewData, input: { repo?: string; branch?: string }): string {
	const lines: string[] = [];
	const name = data.nameWithOwner ?? input.repo ?? "GitHub Repository";
	lines.push(`# ${name}`);
	lines.push("");
	lines.push(normalizeText(data.description) || "No description provided.");
	lines.push("");
	pushLine(lines, "URL", data.url);
	pushLine(lines, "Default branch", data.defaultBranchRef?.name);
	pushLine(lines, "Branch", normalizeOptionalString(input.branch));
	pushLine(lines, "Visibility", data.visibility ?? undefined);
	pushLine(lines, "Viewer permission", data.viewerPermission ?? undefined);
	pushLine(lines, "Primary language", data.primaryLanguage?.name);
	pushLine(lines, "Stars", data.stargazerCount);
	pushLine(lines, "Forks", data.forkCount);
	pushLine(lines, "Archived", data.isArchived);
	pushLine(lines, "Fork", data.isFork);
	pushLine(lines, "Updated", data.updatedAt);
	pushLine(lines, "Homepage", data.homepageUrl ?? undefined);
	const topics = data.repositoryTopics
		?.map(topic => topic.name ?? topic.topic?.name)
		.filter((value): value is string => Boolean(value))
		.join(", ");
	pushLine(lines, "Topics", topics || undefined);
	return lines.join("\n").trim();
}

function formatIssueView(data: GhIssueViewData, input: { issue: string; repo?: string; comments?: boolean }): string {
	const lines: string[] = [];
	const issueNumber = data.number ?? input.issue;
	lines.push(`# Issue #${issueNumber}: ${data.title ?? "Untitled"}`);
	lines.push("");
	pushLine(lines, "State", data.state);
	pushLine(lines, "State reason", data.stateReason ?? undefined);
	pushLine(lines, "Author", formatAuthor(data.author));
	pushLine(lines, "Created", data.createdAt);
	pushLine(lines, "Updated", data.updatedAt);
	pushLine(lines, "Labels", formatLabels(data.labels));
	pushLine(lines, "URL", data.url);
	lines.push("");
	lines.push("## Body");
	lines.push("");
	lines.push(normalizeText(data.body) || "No description provided.");

	if ((input.comments ?? true) && data.comments) {
		const commentSection = formatCommentsSection(data.comments);
		if (commentSection.length > 0) {
			lines.push("");
			lines.push(...commentSection);
		}
	}

	return lines.join("\n").trim();
}

function formatPrFiles(files: GhPrFile[] | undefined): string[] {
	if (!files || files.length === 0) return [];

	const lines: string[] = [`## Files (${files.length})`, ""];
	for (const file of files.slice(0, FILE_PREVIEW_LIMIT)) {
		const changeType = file.changeType ?? "CHANGED";
		const additions = file.additions ?? 0;
		const deletions = file.deletions ?? 0;
		lines.push(`- ${file.path ?? "(unknown file)"} [${changeType}] (+${additions} -${deletions})`);
	}

	if (files.length > FILE_PREVIEW_LIMIT) {
		lines.push(`- ... ${files.length - FILE_PREVIEW_LIMIT} more files`);
	}

	return lines;
}

function formatPrView(data: GhPrViewData, input: { pr?: string; repo?: string; comments?: boolean }): string {
	const lines: string[] = [];
	const prIdentifier = data.number ?? input.pr ?? "current";
	lines.push(`# Pull Request #${prIdentifier}: ${data.title ?? "Untitled"}`);
	lines.push("");
	pushLine(lines, "State", data.state);
	pushLine(lines, "Draft", data.isDraft);
	pushLine(lines, "Author", formatAuthor(data.author));
	pushLine(lines, "Base", data.baseRefName);
	pushLine(lines, "Head", data.headRefName);
	pushLine(lines, "Review decision", data.reviewDecision ?? undefined);
	pushLine(lines, "Merge state", data.mergeStateStatus);
	pushLine(lines, "Created", data.createdAt);
	pushLine(lines, "Updated", data.updatedAt);
	pushLine(lines, "Labels", formatLabels(data.labels));
	pushLine(lines, "URL", data.url);
	lines.push("");
	lines.push("## Body");
	lines.push("");
	lines.push(normalizeText(data.body) || "No description provided.");

	const fileSection = formatPrFiles(data.files);
	if (fileSection.length > 0) {
		lines.push("");
		lines.push(...fileSection);
	}

	if ((input.comments ?? true) && data.reviews) {
		const reviewSection = formatReviewsSection(data.reviews);
		if (reviewSection.length > 0) {
			lines.push("");
			lines.push(...reviewSection);
		}
	}

	if ((input.comments ?? true) && data.reviewComments) {
		const reviewCommentsSection = formatReviewCommentsSection(data.reviewComments);
		if (reviewCommentsSection.length > 0) {
			lines.push("");
			lines.push(...reviewCommentsSection);
		}
	}

	if ((input.comments ?? true) && data.comments) {
		const commentSection = formatCommentsSection(data.comments);
		if (commentSection.length > 0) {
			lines.push("");
			lines.push(...commentSection);
		}
	}

	return lines.join("\n").trim();
}

function formatPrCheckoutResult(options: {
	data: GhPrViewData;
	localBranch: string;
	worktreePath: string;
	remoteName: string;
	remoteUrl: string;
	reused: boolean;
}): string {
	const { data, localBranch, worktreePath, remoteName, remoteUrl, reused } = options;
	const lines: string[] = [
		reused ? `# Pull Request #${data.number ?? "?"} Worktree` : `# Checked Out Pull Request #${data.number ?? "?"}`,
		"",
	];
	pushLine(lines, "Title", data.title ?? undefined);
	pushLine(lines, "URL", data.url);
	pushLine(lines, "Base", data.baseRefName);
	pushLine(lines, "Head", data.headRefName);
	pushLine(lines, "Local branch", localBranch);
	pushLine(lines, "Worktree", worktreePath);
	pushLine(lines, "Remote", remoteName);
	pushLine(lines, "Remote URL", remoteUrl);
	pushLine(lines, "Cross repository", data.isCrossRepository);
	pushLine(lines, "Maintainer can modify", data.maintainerCanModify);
	lines.push("");
	lines.push(
		reused
			? "Reused the existing PR worktree."
			: "Created a dedicated worktree for this PR and configured the local branch to push back to the PR head branch.",
	);
	return lines.join("\n").trim();
}

function formatPrPushResult(options: {
	localBranch: string;
	remoteName: string;
	remoteBranch: string;
	remoteUrl?: string;
	prUrl?: string;
	forceWithLease: boolean;
}): string {
	const lines: string[] = ["# Pushed Pull Request Branch", ""];
	pushLine(lines, "Local branch", options.localBranch);
	pushLine(lines, "Remote", options.remoteName);
	pushLine(lines, "Remote branch", options.remoteBranch);
	pushLine(lines, "Remote URL", options.remoteUrl);
	pushLine(lines, "PR", options.prUrl);
	pushLine(lines, "Force with lease", options.forceWithLease);
	lines.push("");
	lines.push(`Pushed ${options.localBranch} to ${options.remoteName}:${options.remoteBranch}.`);
	return lines.join("\n").trim();
}

function formatSearchResults(
	kind: "issues" | "pull requests",
	query: string,
	repo: string | undefined,
	items: GhSearchResult[],
): string {
	const lines: string[] = [`# GitHub ${kind} search`, "", `Query: ${query}`];
	pushLine(lines, "Repository", repo);
	pushLine(lines, "Results", items.length);

	if (items.length === 0) {
		lines.push("");
		lines.push(`No ${kind} found.`);
		return lines.join("\n").trim();
	}

	for (const item of items) {
		lines.push("");
		lines.push(`- #${item.number ?? "?"} ${item.title ?? "Untitled"}`);
		pushLine(lines, "  Repo", item.repository?.nameWithOwner);
		pushLine(lines, "  State", item.state);
		pushLine(lines, "  Author", formatAuthor(item.author));
		pushLine(lines, "  Labels", formatLabels(item.labels));
		pushLine(lines, "  Created", item.createdAt);
		pushLine(lines, "  Updated", item.updatedAt);
		pushLine(lines, "  URL", item.url);
	}

	return lines.join("\n").trim();
}

async function saveArtifactText(session: ToolSession, toolType: string, text: string): Promise<string | undefined> {
	const { path: artifactPath, id: artifactId } = (await session.allocateOutputArtifact?.(toolType)) ?? {};
	if (!artifactPath || !artifactId) {
		return undefined;
	}

	await Bun.write(artifactPath, text);
	return artifactId;
}

function appendArtifactReference(text: string, artifactId: string | undefined, label: string): string {
	if (!artifactId) {
		return text;
	}

	return `${text}\n\n${label}: artifact://${artifactId}`;
}

function buildTextResult(
	text: string,
	sourceUrl?: string,
	details?: GhToolDetails,
	options?: { artifactId?: string; artifactLabel?: string },
): AgentToolResult<GhToolDetails> {
	const builder = toolResult<GhToolDetails>(details).text(
		appendArtifactReference(text, options?.artifactId, options?.artifactLabel ?? "Saved artifact"),
	);
	if (sourceUrl) {
		builder.sourceUrl(sourceUrl);
	}
	return builder.done();
}

export class GithubTool implements AgentTool<typeof githubSchema, GhToolDetails> {
	readonly name = "github";
	readonly label = "GitHub";
	readonly description = prompt.render(githubDescription);
	readonly parameters = githubSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): GithubTool | null {
		if (!git.github.available()) return null;
		return new GithubTool(session);
	}

	async execute(
		_toolCallId: string,
		params: GithubInput,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<GhToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<GhToolDetails>> {
		return untilAborted(signal, async () => {
			switch (params.op) {
				case "repo_view":
					return executeRepoView(this.session, params, signal);
				case "issue_view":
					return executeIssueView(this.session, params, signal);
				case "pr_view":
					return executePrView(this.session, params, signal);
				case "pr_diff":
					return executePrDiff(this.session, params, signal);
				case "pr_checkout":
					return executePrCheckout(this.session, params, signal);
				case "pr_push":
					return executePrPush(this.session, params, signal);
				case "search_issues":
					return executeSearchIssues(this.session, params, signal);
				case "search_prs":
					return executeSearchPrs(this.session, params, signal);
				case "run_watch":
					return executeRunWatch(this.session, this.name, params, signal, onUpdate);
			}
		});
	}
}

async function executeRepoView(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const repo = normalizeOptionalString(params.repo);
	const branch = normalizeOptionalString(params.branch);
	const args = ["repo", "view"];
	if (repo) {
		args.push(repo);
	}
	if (branch) {
		args.push("--branch", branch);
	}
	args.push("--json", GH_REPO_FIELDS.join(","));

	const data = await git.github.json<GhRepoViewData>(session.cwd, args, signal, {
		repoProvided: Boolean(repo),
	});
	return buildTextResult(formatRepoView(data, { repo, branch }), data.url);
}

async function executeIssueView(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const issue = requireNonEmpty(params.issue, "issue");
	const repo = normalizeOptionalString(params.repo);
	const includeComments = params.comments ?? true;
	const args = ["issue", "view", issue];
	appendRepoFlag(args, repo, issue);
	args.push("--json", (includeComments ? GH_ISSUE_FIELDS : GH_ISSUE_FIELDS_NO_COMMENTS).join(","));

	const data = await git.github.json<GhIssueViewData>(session.cwd, args, signal, {
		repoProvided: Boolean(repo),
	});
	return buildTextResult(formatIssueView(data, { issue, repo, comments: includeComments }), data.url);
}

async function executePrView(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const repo = normalizeOptionalString(params.repo);
	const includeComments = params.comments ?? true;
	const prList = normalizePrIdentifierList(params.pr);
	const prRefs: (string | undefined)[] = prList.length > 0 ? prList : [undefined];

	const views = await Promise.all(
		prRefs.map(async prRef => {
			const args = ["pr", "view"];
			if (prRef) args.push(prRef);
			appendRepoFlag(args, repo, prRef);
			args.push("--json", (includeComments ? GH_PR_FIELDS : GH_PR_FIELDS_NO_COMMENTS).join(","));

			const data = await git.github.json<GhPrViewData>(session.cwd, args, signal, {
				repoProvided: Boolean(repo),
			});
			const resolvedRepo = repo ?? parsePullRequestUrl(data.url).repo;
			if (includeComments && resolvedRepo && typeof data.number === "number") {
				data.reviewComments = await fetchPrReviewComments(session.cwd, resolvedRepo, data.number, signal);
			}
			return { prRef, data };
		}),
	);

	if (views.length === 1) {
		const [view] = views;
		return buildTextResult(
			formatPrView(view.data, { pr: view.prRef, repo, comments: includeComments }),
			view.data.url,
		);
	}

	const sections = views.map(view => formatPrView(view.data, { pr: view.prRef, repo, comments: includeComments }));
	const text = [`# ${views.length} Pull Requests`, "", ...joinSections(sections)].join("\n").trim();
	return buildTextResult(text);
}

async function executePrDiff(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const repo = normalizeOptionalString(params.repo);
	const prList = normalizePrIdentifierList(params.pr);
	const prRefs: (string | undefined)[] = prList.length > 0 ? prList : [undefined];

	const diffs = await Promise.all(
		prRefs.map(async prRef => {
			const args = ["pr", "diff"];
			if (prRef) args.push(prRef);
			appendRepoFlag(args, repo, prRef);
			args.push("--color", "never");
			if (params.nameOnly) args.push("--name-only");
			for (const pattern of params.exclude ?? []) {
				args.push("--exclude", requireNonEmpty(pattern, "exclude pattern"));
			}
			const output = await git.github.text(session.cwd, args, signal, {
				repoProvided: Boolean(repo),
				trimOutput: false,
			});
			return { prRef, output };
		}),
	);

	const singleTitle = params.nameOnly ? "# Pull Request Files" : "# Pull Request Diff";
	const emptyBody = params.nameOnly ? "No changed files." : "No diff output.";

	if (diffs.length === 1) {
		const [diff] = diffs;
		const body = diff.output.length > 0 ? diff.output : emptyBody;
		return buildTextResult(`${singleTitle}\n\n${body}`);
	}

	const header = params.nameOnly
		? `# ${diffs.length} Pull Request File Lists`
		: `# ${diffs.length} Pull Request Diffs`;
	const sections = diffs.map(diff => {
		const label = diff.prRef ? `PR ${diff.prRef}` : "PR (current branch)";
		const body = diff.output.length > 0 ? diff.output : emptyBody;
		return `## ${label}\n\n${body}`;
	});
	const text = [header, "", ...joinSections(sections)].join("\n").trim();
	return buildTextResult(text);
}

function joinSections(sections: string[]): string[] {
	return sections.flatMap((section, idx) => (idx === 0 ? [section] : ["", "---", "", section]));
}

async function executePrCheckout(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const repo = normalizeOptionalString(params.repo);
	const force = params.force ?? false;
	const prList = normalizePrIdentifierList(params.pr);
	const prRefs = prList.length > 0 ? prList : [undefined];
	const isMulti = prRefs.length > 1;

	const outcomes = await Promise.all(
		prRefs.map(prRef => checkoutPullRequest(session, signal, { prRef, repo, force })),
	);

	if (!isMulti) {
		const [outcome] = outcomes;
		return buildTextResult(formatPrCheckoutResult(outcome), outcome.data.url, {
			repo: repo ?? outcome.data.headRepository?.nameWithOwner,
			branch: outcome.localBranch,
			worktreePath: outcome.worktreePath,
			remote: outcome.remoteName,
			remoteBranch: outcome.headRefName,
			checkouts: [outcomeToSummary(outcome)],
		});
	}

	const sections = outcomes.map(formatPrCheckoutResult);
	const reusedCount = outcomes.reduce((acc, o) => acc + (o.reused ? 1 : 0), 0);
	const newCount = outcomes.length - reusedCount;
	const headerParts: string[] = [];
	if (newCount > 0) headerParts.push(`${newCount} checked out`);
	if (reusedCount > 0) headerParts.push(`${reusedCount} reused`);
	const header = `# ${outcomes.length} Pull Request Worktrees (${headerParts.join(", ")})`;
	const text = [header, "", ...joinSections(sections)].join("\n").trim();

	return buildTextResult(text, undefined, {
		repo,
		checkouts: outcomes.map(outcomeToSummary),
	});
}

interface PrCheckoutOptions {
	prRef: string | undefined;
	repo: string | undefined;
	force: boolean;
}

interface PrCheckoutOutcome {
	data: GhPrViewData;
	localBranch: string;
	worktreePath: string;
	remoteName: string;
	remoteUrl: string;
	headRefName: string;
	reused: boolean;
}

async function checkoutPullRequest(
	session: ToolSession,
	signal: AbortSignal | undefined,
	options: PrCheckoutOptions,
): Promise<PrCheckoutOutcome> {
	const { prRef, repo, force } = options;
	const args = ["pr", "view"];
	if (prRef) args.push(prRef);
	appendRepoFlag(args, repo, prRef);
	args.push("--json", GH_PR_CHECKOUT_FIELDS.join(","));

	const data = await git.github.json<GhPrViewData>(session.cwd, args, signal, {
		repoProvided: Boolean(repo),
	});
	const prNumber = data.number;
	if (typeof prNumber !== "number") {
		throw new ToolError("GitHub CLI did not return a pull request number.");
	}

	const headRefName = requireNonEmpty(data.headRefName, "head branch");
	const headRefOid = requireNonEmpty(data.headRefOid, "head commit");
	const repoRoot = await requireGitRepoRoot(session.cwd, signal);
	const primaryRepoRoot = await requirePrimaryGitRepoRoot(repoRoot, signal);
	const localBranch = `pr-${prNumber}`;
	const worktreePath = path.join(getWorktreesDir(), encodeRepoPathForFilesystem(primaryRepoRoot), localBranch);

	// Every git mutation against `repoRoot` from here on must run under the
	// per-repo lock. Worktrees of the same primary repo share `.git/config`,
	// `commit-graph` chain, `packed-refs`, and worktree metadata files — git
	// uses O_EXCL lock files for each, with no waiter. Concurrent in-process
	// callers (e.g. parallel `pr_checkout` calls) would otherwise lose lock
	// races and surface "could not lock config file" / "Another git process
	// seems to be running" errors. The gh API call above stays outside the
	// lock so multiple checkouts can fetch PR metadata in parallel.
	return git.withRepoLock(
		repoRoot,
		async () => {
			const existingWorktrees = await git.worktree.list(repoRoot, signal);
			const existingWorktree = existingWorktrees.find(entry => entry.branch === toLocalBranchRef(localBranch));

			const remote = await ensurePrRemote(repoRoot, data, signal);
			await git.fetch(
				repoRoot,
				remote.name,
				`refs/heads/${headRefName}`,
				`refs/remotes/${remote.name}/${headRefName}`,
				signal,
			);

			if (!existingWorktree) {
				const localBranchRef = toLocalBranchRef(localBranch);
				const localBranchExists = await git.ref.exists(repoRoot, localBranchRef, signal);
				if (localBranchExists) {
					const existingOid = await git.ref.resolve(repoRoot, localBranchRef, signal);
					if (existingOid !== headRefOid) {
						if (!force) {
							throw new ToolError(
								`local branch ${localBranch} already exists at ${formatShortSha(existingOid ?? undefined) ?? existingOid ?? "unknown commit"}; pass force=true to reset it`,
							);
						}

						await git.branch.force(repoRoot, localBranch, `refs/remotes/${remote.name}/${headRefName}`, signal);
					}
				} else {
					await git.branch.create(repoRoot, localBranch, `refs/remotes/${remote.name}/${headRefName}`, signal);
				}
			}

			await git.config.setBranch(repoRoot, localBranch, "remote", remote.name, signal);
			await git.config.setBranch(repoRoot, localBranch, "merge", `refs/heads/${headRefName}`, signal);
			await git.config.setBranch(repoRoot, localBranch, "pushRemote", remote.name, signal);
			await git.config.setBranch(repoRoot, localBranch, "ompPrHeadRef", headRefName, signal);
			await git.config.setBranch(repoRoot, localBranch, "ompPrUrl", data.url ?? "", signal);
			await git.config.setBranch(
				repoRoot,
				localBranch,
				"ompPrIsCrossRepository",
				String(Boolean(data.isCrossRepository)),
				signal,
			);
			await git.config.setBranch(
				repoRoot,
				localBranch,
				"ompPrMaintainerCanModify",
				String(Boolean(data.maintainerCanModify)),
				signal,
			);

			const finalWorktreePath = existingWorktree?.path ?? worktreePath;
			if (!existingWorktree) {
				await ensureGitWorktreePathAvailable(finalWorktreePath, existingWorktrees);
				await fs.mkdir(path.dirname(finalWorktreePath), { recursive: true });
				await git.worktree.add(repoRoot, finalWorktreePath, localBranch, { signal });
			}
			const resolvedWorktreePath = await fs.realpath(finalWorktreePath);

			return {
				data,
				localBranch,
				worktreePath: resolvedWorktreePath,
				remoteName: remote.name,
				remoteUrl: remote.url,
				headRefName,
				reused: Boolean(existingWorktree),
			};
		},
		signal,
	);
}

function outcomeToSummary(outcome: PrCheckoutOutcome): GhPrCheckoutSummary {
	return {
		prNumber: typeof outcome.data.number === "number" ? outcome.data.number : undefined,
		url: outcome.data.url ?? undefined,
		branch: outcome.localBranch,
		worktreePath: outcome.worktreePath,
		remote: outcome.remoteName,
		remoteBranch: outcome.headRefName,
		reused: outcome.reused,
	};
}

async function executePrPush(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const repoRoot = await requireGitRepoRoot(session.cwd, signal);
	const localBranch = normalizeOptionalString(params.branch) ?? (await requireCurrentGitBranch(repoRoot, signal));
	const refExists = await git.ref.exists(repoRoot, toLocalBranchRef(localBranch), signal);
	if (!refExists) {
		throw new ToolError(`local branch ${localBranch} does not exist`);
	}

	const target = await resolvePrBranchPushTarget(repoRoot, localBranch, signal);
	const currentBranch = await git.branch.current(repoRoot, signal);
	const sourceRef = currentBranch === localBranch ? "HEAD" : toLocalBranchRef(localBranch);
	const refspec = `${sourceRef}:refs/heads/${target.remoteBranch}`;
	await git.push(repoRoot, {
		forceWithLease: params.forceWithLease,
		refspec,
		remote: target.remoteName,
		signal,
	});

	return buildTextResult(
		formatPrPushResult({
			localBranch,
			remoteName: target.remoteName,
			remoteBranch: target.remoteBranch,
			remoteUrl: target.remoteUrl,
			prUrl: target.prUrl,
			forceWithLease: params.forceWithLease ?? false,
		}),
		target.prUrl,
		{
			branch: localBranch,
			remote: target.remoteName,
			remoteBranch: target.remoteBranch,
		},
	);
}

async function executeSearchIssues(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const query = requireNonEmpty(params.query, "query");
	const repo = normalizeOptionalString(params.repo);
	const limit = resolveSearchLimit(params.limit);
	const args = buildGhSearchArgs("issues", query, limit, repo);

	const items = await git.github.json<GhSearchResult[]>(session.cwd, args, signal, {
		repoProvided: Boolean(repo),
	});
	return buildTextResult(formatSearchResults("issues", query, repo, items));
}

async function executeSearchPrs(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const query = requireNonEmpty(params.query, "query");
	const repo = normalizeOptionalString(params.repo);
	const limit = resolveSearchLimit(params.limit);
	const args = buildGhSearchArgs("prs", query, limit, repo);

	const items = await git.github.json<GhSearchResult[]>(session.cwd, args, signal, {
		repoProvided: Boolean(repo),
	});
	return buildTextResult(formatSearchResults("pull requests", query, repo, items));
}

async function executeRunWatch(
	session: ToolSession,
	toolName: string,
	params: GithubInput,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<GhToolDetails> | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const branchInput = normalizeOptionalString(params.branch);
	const runReference = parseRunReference(params.run);
	const repo = await resolveGitHubRepo(session.cwd, undefined, runReference.repo, signal);
	const intervalSeconds = RUN_WATCH_INTERVAL_DEFAULT;
	const graceSeconds = RUN_WATCH_GRACE_DEFAULT;
	const tail = resolveTailLimit(params.tail);
	if (runReference.runId !== undefined) {
		const runId = runReference.runId;
		let pollCount = 0;

		while (true) {
			throwIfAborted(signal);
			pollCount += 1;

			let run = await fetchRunSnapshot(session.cwd, repo, runId, signal);
			const details = buildRunWatchDetails(repo, run, {
				state: "watching",
				pollCount,
			});
			onUpdate?.({
				content: [{ type: "text", text: formatRunWatchSnapshot(repo, run, pollCount) }],
				details,
			});

			const failedJobs = run.jobs.filter(isFailedJob);
			const runCompleted = run.status === "completed";

			if (failedJobs.length > 0) {
				if (!runCompleted && graceSeconds > 0) {
					const note = `Failure detected. Waiting ${graceSeconds}s to capture concurrent failures before fetching logs.`;
					onUpdate?.({
						content: [
							{
								type: "text",
								text: formatRunWatchSnapshot(repo, run, pollCount, note),
							},
						],
						details: buildRunWatchDetails(repo, run, {
							state: "watching",
							pollCount,
							note,
						}),
					});
					await abortableSleep(graceSeconds * 1000, signal);
					run = await fetchRunSnapshot(session.cwd, repo, runId, signal);
				}

				const failedJobLogs = await fetchFailedJobLogs(
					session.cwd,
					repo,
					run.jobs.filter(isFailedJob).map(job => ({ run, job })),
					tail,
					signal,
				);
				const finalDetails = buildRunWatchDetails(repo, run, {
					state: "completed",
					failedJobLogs,
				});
				const artifactId = await saveArtifactText(
					session,
					toolName,
					formatRunWatchResult(repo, run, failedJobLogs, tail, { mode: "full" }),
				);
				return buildTextResult(
					formatRunWatchResult(repo, run, failedJobLogs, tail),
					run.url,
					{ ...finalDetails, artifactId },
					{ artifactId, artifactLabel: "Full failed-job logs" },
				);
			}

			if (runCompleted) {
				const finalDetails = buildRunWatchDetails(repo, run, {
					state: "completed",
				});
				return buildTextResult(formatRunWatchResult(repo, run, [], tail), run.url, finalDetails);
			}

			await abortableSleep(intervalSeconds * 1000, signal);
		}
	}

	const branch = branchInput ?? (await requireCurrentGitBranch(session.cwd, signal));
	const headSha = branchInput
		? await resolveGitHubBranchHead(session.cwd, repo, branch, signal)
		: await requireCurrentGitHead(session.cwd, signal);
	let pollCount = 0;
	let settledSuccessSignature: string | undefined;

	while (true) {
		throwIfAborted(signal);
		pollCount += 1;

		let runs = await fetchRunsForCommit(session.cwd, repo, headSha, branch, signal);
		const details = buildCommitRunWatchDetails(repo, headSha, branch, runs, {
			state: "watching",
			pollCount,
		});
		onUpdate?.({
			content: [{ type: "text", text: formatCommitRunWatchSnapshot(repo, headSha, branch, runs, pollCount) }],
			details,
		});

		const outcome = getRunCollectionOutcome(runs);
		if (outcome === "failure") {
			if (graceSeconds > 0) {
				const note = `Failure detected. Waiting ${graceSeconds}s to capture concurrent failures before fetching logs.`;
				onUpdate?.({
					content: [
						{
							type: "text",
							text: formatCommitRunWatchSnapshot(repo, headSha, branch, runs, pollCount, note),
						},
					],
					details: buildCommitRunWatchDetails(repo, headSha, branch, runs, {
						state: "watching",
						pollCount,
						note,
					}),
				});
				await abortableSleep(graceSeconds * 1000, signal);
				runs = await fetchRunsForCommit(session.cwd, repo, headSha, branch, signal);
			}

			const failedJobLogs = await fetchFailedJobLogs(
				session.cwd,
				repo,
				runs.flatMap(run => run.jobs.filter(isFailedJob).map(job => ({ run, job }))),
				tail,
				signal,
			);
			const finalDetails = buildCommitRunWatchDetails(repo, headSha, branch, runs, {
				state: "completed",
				failedJobLogs,
			});
			const artifactId = await saveArtifactText(
				session,
				toolName,
				formatCommitRunWatchResult(repo, headSha, branch, runs, failedJobLogs, tail, { mode: "full" }),
			);
			return buildTextResult(
				formatCommitRunWatchResult(repo, headSha, branch, runs, failedJobLogs, tail),
				undefined,
				{ ...finalDetails, artifactId },
				{ artifactId, artifactLabel: "Full failed-job logs" },
			);
		}

		if (outcome === "success") {
			const signature = getRunCollectionSignature(runs);
			if (signature === settledSuccessSignature) {
				const finalDetails = buildCommitRunWatchDetails(repo, headSha, branch, runs, {
					state: "completed",
				});
				return buildTextResult(
					formatCommitRunWatchResult(repo, headSha, branch, runs, [], tail),
					undefined,
					finalDetails,
				);
			}

			settledSuccessSignature = signature;
			const note = `All known workflow runs completed successfully. Waiting ${intervalSeconds}s to ensure no additional runs appear for this commit.`;
			onUpdate?.({
				content: [
					{
						type: "text",
						text: formatCommitRunWatchSnapshot(repo, headSha, branch, runs, pollCount, note),
					},
				],
				details: buildCommitRunWatchDetails(repo, headSha, branch, runs, {
					state: "watching",
					pollCount,
					note,
				}),
			});
			await abortableSleep(intervalSeconds * 1000, signal);
			continue;
		}

		settledSuccessSignature = undefined;
		await abortableSleep(intervalSeconds * 1000, signal);
	}
}
