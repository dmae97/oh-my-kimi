import * as fs from "node:fs/promises";
import * as path from "node:path";
import { glob } from "@oh-my-pi/pi-natives";
import { $which, formatAge, formatBytes, logger } from "@oh-my-pi/pi-utils";

export interface DirectoryTree {
	rootPath: string;
	rendered: string;
	truncated: boolean;
	totalLines: number;
}

export interface WorkspaceTree extends DirectoryTree {}

export interface DirectoryTreeOptions {
	/** Directory depth below the root to include. Root itself is depth 0. */
	maxDepth?: number;
	/** Per-directory child cap. Use null to disable per-directory truncation. */
	directoryEntryLimit?: number | null;
	/** Optional root child cap. Defaults to directoryEntryLimit; use null to keep all root children. */
	rootEntryLimit?: number | null;
	/** Hard rendered line cap. Use null to disable line-cap pruning. */
	lineCap?: number | null;
	/** Depth at or above which line-cap pruning is forbidden. Root is 0, root children are 1. */
	lineCapProtectedDepth?: number;
	/** Entry names to skip before stat/render. */
	excludedNames?: ReadonlySet<string> | readonly string[];
	/** Directory names to skip before traversal. */
	excludedDirectoryNames?: ReadonlySet<string> | readonly string[];
	/** Include hidden files and directories. */
	hidden?: boolean;
	/** Respect .gitignore while listing children. */
	gitignore?: boolean;
	/** Use native glob shared cache. */
	cache?: boolean;
	/** Rendered label for the root line. */
	rootLabel?: string;
	/**
	 * Pre-built map of `parentRelativePath` → child name set used in place of
	 * native directory listing. When provided, the tree builder consults this
	 * map for child enumeration instead of `glob` / `readdir`. Stat calls per
	 * displayed node are still performed for mtime/size/dir-ness.
	 */
	childIndex?: ReadonlyMap<string, ReadonlySet<string>>;
}

const WORKSPACE_TREE_MAX_DEPTH = 3;
const WORKSPACE_TREE_DIR_LIMIT = 12;
const WORKSPACE_TREE_LINE_CAP = 120;
const WORKSPACE_TREE_EXCLUDED_DIRS = new Set([
	"node_modules",
	".git",
	".next",
	"dist",
	"build",
	"target",
	".venv",
	".cache",
	".turbo",
	".parcel-cache",
	"coverage",
]);

const DIRECTORY_TREE_EXCLUDED_NAMES = new Set([".DS_Store"]);

const GLOB_SPECIAL_CHARS = new Set(["!", "(", ")", "*", "?", "[", "]", "{", "}", "\\"]);

interface DirectoryTreeNode {
	name: string;
	relativePath: string;
	depth: number;
	isDirectory: boolean;
	mtimeMs: number;
	size: number;
	children: DirectoryTreeNode[];
	droppedChildCount: number;
}

interface ResolvedDirectoryTreeOptions {
	maxDepth: number;
	directoryEntryLimit: number | null;
	rootEntryLimit: number | null;
	lineCap: number | null;
	lineCapProtectedDepth: number;
	excludedDirectoryNames: ReadonlySet<string>;
	excludedNames: ReadonlySet<string>;
	hidden: boolean;
	gitignore: boolean;
	cache: boolean;
	rootLabel: string;
	childIndex: ReadonlyMap<string, ReadonlySet<string>> | null;
}

interface RenderLine {
	label: string;
	depth: number;
	size?: string;
	age?: string;
	isRoot?: boolean;
}

function emptyWorkspaceTree(rootPath: string): WorkspaceTree {
	return {
		rootPath,
		rendered: "",
		truncated: false,
		totalLines: 0,
	};
}

function resolveDirectoryTreeOptions(options: DirectoryTreeOptions): ResolvedDirectoryTreeOptions {
	const directoryEntryLimit = options.directoryEntryLimit === undefined ? null : options.directoryEntryLimit;
	const rootEntryLimit = options.rootEntryLimit === undefined ? directoryEntryLimit : options.rootEntryLimit;
	const excludedDirectoryNames =
		options.excludedDirectoryNames instanceof Set
			? options.excludedDirectoryNames
			: new Set(options.excludedDirectoryNames ?? []);
	const providedExcludedNames =
		options.excludedNames instanceof Set ? options.excludedNames : new Set(options.excludedNames ?? []);
	const excludedNames = new Set([...DIRECTORY_TREE_EXCLUDED_NAMES, ...providedExcludedNames]);
	return {
		maxDepth: options.maxDepth ?? 1,
		directoryEntryLimit,
		rootEntryLimit,
		lineCap: options.lineCap === undefined ? null : options.lineCap,
		lineCapProtectedDepth: options.lineCapProtectedDepth ?? 0,
		excludedDirectoryNames,
		excludedNames,
		hidden: options.hidden ?? true,
		gitignore: options.gitignore ?? false,
		cache: options.cache ?? true,
		rootLabel: options.rootLabel ?? ".",
		childIndex: options.childIndex ?? null,
	};
}

function compareByRecency(a: DirectoryTreeNode, b: DirectoryTreeNode): number {
	const mtimeCompare = b.mtimeMs - a.mtimeMs;
	if (mtimeCompare !== 0) return mtimeCompare;
	return a.name.localeCompare(b.name);
}

function childRelativePath(parentRelativePath: string, name: string): string {
	return parentRelativePath ? `${parentRelativePath}/${name}` : name;
}

function escapeGlobSegment(segment: string): string {
	return Array.from(segment, char => (GLOB_SPECIAL_CHARS.has(char) ? `\\${char}` : char)).join("");
}

function directChildPattern(parentRelativePath: string): string {
	if (!parentRelativePath) return "*";
	return `${parentRelativePath.split("/").map(escapeGlobSegment).join("/")}/*`;
}

function matchChildName(parentRelativePath: string, matchPath: string): string | null {
	if (!parentRelativePath) return matchPath.includes("/") ? null : matchPath;
	const prefix = `${parentRelativePath}/`;
	if (!matchPath.startsWith(prefix)) return null;
	const name = matchPath.slice(prefix.length);
	return name.includes("/") ? null : name;
}

async function listDirectChildNames(
	rootPath: string,
	parent: DirectoryTreeNode,
	options: ResolvedDirectoryTreeOptions,
): Promise<string[]> {
	if (options.childIndex) {
		const names = options.childIndex.get(parent.relativePath);
		return names ? Array.from(names) : [];
	}
	if (!options.gitignore) {
		const directoryPath = parent.relativePath ? path.join(rootPath, parent.relativePath) : rootPath;
		return await fs.readdir(directoryPath);
	}

	const result = await glob({
		pattern: directChildPattern(parent.relativePath),
		path: rootPath,
		recursive: false,
		hidden: options.hidden,
		gitignore: true,
		cache: options.cache,
	});

	return result.matches
		.map(match => matchChildName(parent.relativePath, match.path))
		.filter((name): name is string => name !== null);
}

async function listDirectoryTreeChildren(
	rootPath: string,
	parent: DirectoryTreeNode,
	options: ResolvedDirectoryTreeOptions,
): Promise<DirectoryTreeNode[]> {
	const childNames = await listDirectChildNames(rootPath, parent, options);

	const children = await Promise.all(
		childNames.map(async (name): Promise<DirectoryTreeNode | null> => {
			if (options.excludedNames.has(name)) return null;
			if (!options.hidden && name.startsWith(".")) return null;
			const relativePath = childRelativePath(parent.relativePath, name);
			const absolutePath = path.join(rootPath, relativePath);
			try {
				const stat = await Bun.file(absolutePath).stat();
				const isDirectory = stat.isDirectory();
				if (isDirectory && options.excludedDirectoryNames.has(name)) return null;
				return {
					name,
					relativePath,
					depth: parent.depth + 1,
					isDirectory,
					mtimeMs: stat.mtimeMs,
					size: stat.size,
					children: [],
					droppedChildCount: 0,
				} satisfies DirectoryTreeNode;
			} catch {
				return null;
			}
		}),
	);

	return children.filter((child): child is DirectoryTreeNode => child !== null).sort(compareByRecency);
}

function entryLimitForNode(node: DirectoryTreeNode, options: ResolvedDirectoryTreeOptions): number | null {
	return node.depth === 0 ? options.rootEntryLimit : options.directoryEntryLimit;
}

function applyDirectoryLimit(
	node: DirectoryTreeNode,
	children: DirectoryTreeNode[],
	options: ResolvedDirectoryTreeOptions,
): { visibleChildren: DirectoryTreeNode[]; droppedCount: number } {
	const entryLimit = entryLimitForNode(node, options);
	if (entryLimit === null || children.length <= entryLimit) {
		return { visibleChildren: children, droppedCount: 0 };
	}
	if (entryLimit <= 1) {
		return {
			visibleChildren: children.slice(0, Math.max(0, entryLimit)),
			droppedCount: children.length - entryLimit,
		};
	}

	const recentChildren = children.slice(0, entryLimit - 1);
	const oldestChild = children[children.length - 1];
	return {
		visibleChildren: oldestChild ? [...recentChildren, oldestChild] : recentChildren,
		droppedCount: children.length - entryLimit,
	};
}

async function collectDirectoryTree(
	rootPath: string,
	options: ResolvedDirectoryTreeOptions,
): Promise<{ root: DirectoryTreeNode; truncated: boolean }> {
	const rootStat = await Bun.file(rootPath).stat();
	const root: DirectoryTreeNode = {
		name: options.rootLabel,
		relativePath: "",
		depth: 0,
		isDirectory: true,
		mtimeMs: rootStat.mtimeMs,
		size: rootStat.size,
		children: [],
		droppedChildCount: 0,
	};

	let truncated = false;
	const queue: DirectoryTreeNode[] = [root];
	let cursor = 0;

	while (cursor < queue.length) {
		const parent = queue[cursor];
		cursor += 1;
		if (!parent || parent.depth >= options.maxDepth) continue;

		const children = await listDirectoryTreeChildren(rootPath, parent, options);
		const limited = applyDirectoryLimit(parent, children, options);
		parent.children = limited.visibleChildren;
		parent.droppedChildCount = limited.droppedCount;
		if (limited.droppedCount > 0) truncated = true;

		for (const child of parent.children) {
			if (child.isDirectory) queue.push(child);
		}
	}

	return { root, truncated };
}

function formatNodeAge(nowMs: number, mtimeMs: number): string {
	const ageSeconds = Math.max(0, Math.floor((nowMs - mtimeMs) / 1000));
	return formatAge(ageSeconds);
}

function pushNodeLine(lines: RenderLine[], node: DirectoryTreeNode, nowMs: number): void {
	if (node.depth === 0) {
		lines.push({ label: node.name, depth: 0, isRoot: true });
		return;
	}

	const indent = "  ".repeat(node.depth);
	const suffix = node.isDirectory ? "/" : "";
	lines.push({
		label: `${indent}- ${node.name}${suffix}`,
		depth: node.depth,
		size: node.isDirectory ? undefined : formatBytes(node.size),
		age: formatNodeAge(nowMs, node.mtimeMs),
	});
}

function pushDroppedChildrenLine(lines: RenderLine[], parent: DirectoryTreeNode): void {
	if (parent.droppedChildCount <= 0) return;
	const childDepth = parent.depth + 1;
	const indent = "  ".repeat(childDepth);
	lines.push({
		label: `${indent}- … ${parent.droppedChildCount} more`,
		depth: childDepth,
	});
}

function collectRenderLines(node: DirectoryTreeNode, nowMs: number, lines: RenderLine[]): void {
	pushNodeLine(lines, node, nowMs);

	if (node.droppedChildCount > 0) {
		const recentChildren = node.children.slice(0, -1);
		const oldestChild = node.children[node.children.length - 1];
		for (const child of recentChildren) collectRenderLines(child, nowMs, lines);
		pushDroppedChildrenLine(lines, node);
		if (oldestChild && !recentChildren.includes(oldestChild)) collectRenderLines(oldestChild, nowMs, lines);
		return;
	}

	for (const child of node.children) collectRenderLines(child, nowMs, lines);
}

function applyLineCap(
	lines: RenderLine[],
	options: ResolvedDirectoryTreeOptions,
): { lines: RenderLine[]; elidedCount: number } {
	if (options.lineCap === null || lines.length <= options.lineCap) return { lines, elidedCount: 0 };

	const targetLineCount = Math.max(1, options.lineCap - 1);
	const removeCount = lines.length - targetLineCount;
	const removable = lines
		.map((line, index) => ({ line, index }))
		.filter(item => !item.line.isRoot && item.line.depth > options.lineCapProtectedDepth)
		.sort((a, b) => b.line.depth - a.line.depth || b.index - a.index)
		.slice(0, removeCount);
	if (removable.length === 0) return { lines, elidedCount: 0 };

	const removedIndexes = new Set(removable.map(item => item.index));
	const cappedLines = lines.filter((_, index) => !removedIndexes.has(index));
	cappedLines.push({
		label: `… (${removable.length} lines elided beyond depth/cap)`,
		depth: 0,
	});

	return { lines: cappedLines, elidedCount: removable.length };
}

function renderLines(lines: RenderLine[]): string {
	const maxLabelLength = lines.reduce((max, line) => Math.max(max, line.label.length), 0);
	return lines
		.map(line => {
			if (!line.age) return line.label;
			const sizeColumn = (line.size ?? "").padEnd(8);
			return `${line.label.padEnd(maxLabelLength + 2)}${sizeColumn}  ${line.age.padEnd(4)}`.trimEnd();
		})
		.join("\n");
}

export async function buildDirectoryTree(rootPath: string, options: DirectoryTreeOptions = {}): Promise<DirectoryTree> {
	const resolvedRootPath = path.resolve(rootPath);
	const resolvedOptions = resolveDirectoryTreeOptions(options);
	const nowMs = Date.now();
	const { root, truncated: directoryTruncated } = await collectDirectoryTree(resolvedRootPath, resolvedOptions);
	const lines: RenderLine[] = [];
	collectRenderLines(root, nowMs, lines);
	const { lines: cappedLines, elidedCount } = applyLineCap(lines, resolvedOptions);
	return {
		rootPath: resolvedRootPath,
		rendered: renderLines(cappedLines),
		truncated: directoryTruncated || elidedCount > 0,
		totalLines: cappedLines.length,
	};
}

/**
 * Build a `parentRelativePath` → child name index from a flat list of POSIX
 * paths. Intermediate directory components are inferred from path segments;
 * the index covers every ancestor directory implied by the input.
 */
function buildChildIndexFromPaths(paths: readonly string[]): Map<string, Set<string>> {
	const index = new Map<string, Set<string>>();
	const ensure = (parent: string): Set<string> => {
		let bucket = index.get(parent);
		if (!bucket) {
			bucket = new Set<string>();
			index.set(parent, bucket);
		}
		return bucket;
	};
	for (const raw of paths) {
		if (!raw) continue;
		const normalized = raw.replace(/\\/g, "/");
		const parts = normalized.split("/").filter(segment => segment.length > 0);
		if (parts.length === 0) continue;
		for (let i = 0; i < parts.length; i += 1) {
			const parent = parts.slice(0, i).join("/");
			const segment = parts[i];
			if (segment !== undefined) ensure(parent).add(segment);
		}
	}
	return index;
}

const GIT_LS_FILES_TIMEOUT_MS = 3000;

/**
 * List tracked + untracked-not-ignored files at `rootPath` via `git ls-files`.
 * Returns `null` when git is unavailable, the directory is not inside a
 * worktree, or the call fails / times out — caller falls back to native
 * directory listing.
 */
async function tryListGitFiles(rootPath: string): Promise<string[] | null> {
	const gitPath = $which("git");
	if (!gitPath) return null;
	const signal = AbortSignal.timeout(GIT_LS_FILES_TIMEOUT_MS);
	try {
		const child = Bun.spawn([gitPath, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
			cwd: rootPath,
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
			signal,
		});
		const [stdout, exitCode] = await Promise.all([
			new Response(child.stdout as ReadableStream<Uint8Array>).text(),
			child.exited,
		]);
		if (exitCode !== 0) return null;
		if (!stdout) return [];
		// `-z` separates entries with NUL; trailing NUL after final entry.
		return stdout.split("\0").filter(entry => entry.length > 0);
	} catch (error) {
		logger.debug("git ls-files failed; falling back to native directory listing", {
			rootPath,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

export async function buildWorkspaceTree(cwd: string): Promise<WorkspaceTree> {
	const rootPath = path.resolve(cwd);
	const baseOptions = {
		maxDepth: WORKSPACE_TREE_MAX_DEPTH,
		directoryEntryLimit: WORKSPACE_TREE_DIR_LIMIT,
		lineCap: WORKSPACE_TREE_LINE_CAP,
		excludedDirectoryNames: WORKSPACE_TREE_EXCLUDED_DIRS,
		hidden: false,
		cache: true,
		rootLabel: ".",
	} satisfies DirectoryTreeOptions;

	try {
		const gitFiles = await tryListGitFiles(rootPath);
		if (gitFiles !== null) {
			// Git already applied gitignore + tracking semantics: bypass native
			// recursive scan and feed the index directly to the tree builder.
			return await buildDirectoryTree(rootPath, {
				...baseOptions,
				gitignore: false,
				childIndex: buildChildIndexFromPaths(gitFiles),
			});
		}
		return await buildDirectoryTree(rootPath, { ...baseOptions, gitignore: true });
	} catch {
		return emptyWorkspaceTree(rootPath);
	}
}
