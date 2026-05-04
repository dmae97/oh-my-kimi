import * as path from "node:path";
import { glob } from "@oh-my-pi/pi-natives";
import { formatAge, formatBytes } from "@oh-my-pi/pi-utils";

export interface WorkspaceTree {
	rootPath: string;
	rendered: string;
	truncated: boolean;
	totalLines: number;
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

const GLOB_SPECIAL_CHARS = new Set(["!", "(", ")", "*", "?", "[", "]", "{", "}", "\\"]);

interface WorkspaceTreeNode {
	name: string;
	relativePath: string;
	depth: number;
	isDirectory: boolean;
	mtimeMs: number;
	size: number;
	children: WorkspaceTreeNode[];
	droppedChildCount: number;
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

function compareByRecency(a: WorkspaceTreeNode, b: WorkspaceTreeNode): number {
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

async function listWorkspaceTreeChildren(rootPath: string, parent: WorkspaceTreeNode): Promise<WorkspaceTreeNode[]> {
	const result = await glob({
		pattern: directChildPattern(parent.relativePath),
		path: rootPath,
		recursive: false,
		hidden: false,
		gitignore: true,
		cache: true,
	});

	const children = await Promise.all(
		result.matches.map(async (match): Promise<WorkspaceTreeNode | null> => {
			const name = matchChildName(parent.relativePath, match.path);
			if (!name) return null;
			if (name.startsWith(".")) return null;
			const absolutePath = path.join(rootPath, childRelativePath(parent.relativePath, name));
			try {
				const stat = await Bun.file(absolutePath).stat();
				const isDirectory = stat.isDirectory();
				if (isDirectory && WORKSPACE_TREE_EXCLUDED_DIRS.has(name)) return null;
				return {
					name,
					relativePath: childRelativePath(parent.relativePath, name),
					depth: parent.depth + 1,
					isDirectory,
					mtimeMs: stat.mtimeMs,
					size: stat.size,
					children: [],
					droppedChildCount: 0,
				} satisfies WorkspaceTreeNode;
			} catch {
				return null;
			}
		}),
	);

	return children.filter((child): child is WorkspaceTreeNode => child !== null).sort(compareByRecency);
}

function applyDirectoryLimit(children: WorkspaceTreeNode[]): {
	visibleChildren: WorkspaceTreeNode[];
	droppedCount: number;
} {
	if (children.length <= WORKSPACE_TREE_DIR_LIMIT) {
		return { visibleChildren: children, droppedCount: 0 };
	}

	const recentChildren = children.slice(0, WORKSPACE_TREE_DIR_LIMIT - 1);
	const oldestChild = children[children.length - 1];
	return {
		visibleChildren: oldestChild ? [...recentChildren, oldestChild] : recentChildren,
		droppedCount: children.length - WORKSPACE_TREE_DIR_LIMIT,
	};
}

async function collectWorkspaceTree(rootPath: string): Promise<{ root: WorkspaceTreeNode; truncated: boolean }> {
	const rootStat = await Bun.file(rootPath).stat();
	const root: WorkspaceTreeNode = {
		name: ".",
		relativePath: "",
		depth: 0,
		isDirectory: true,
		mtimeMs: rootStat.mtimeMs,
		size: rootStat.size,
		children: [],
		droppedChildCount: 0,
	};

	let truncated = false;
	const queue: WorkspaceTreeNode[] = [root];
	let cursor = 0;

	while (cursor < queue.length) {
		const parent = queue[cursor];
		cursor += 1;
		if (!parent || parent.depth >= WORKSPACE_TREE_MAX_DEPTH) continue;

		const children = await listWorkspaceTreeChildren(rootPath, parent);
		const limited = applyDirectoryLimit(children);
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

function pushNodeLine(lines: RenderLine[], node: WorkspaceTreeNode, nowMs: number): void {
	if (node.depth === 0) {
		lines.push({ label: ".", depth: 0, isRoot: true });
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

function pushDroppedChildrenLine(lines: RenderLine[], parent: WorkspaceTreeNode): void {
	if (parent.droppedChildCount <= 0) return;
	const childDepth = parent.depth + 1;
	const indent = "  ".repeat(childDepth);
	lines.push({
		label: `${indent}- … ${parent.droppedChildCount} more`,
		depth: childDepth,
	});
}

function collectRenderLines(node: WorkspaceTreeNode, nowMs: number, lines: RenderLine[]): void {
	pushNodeLine(lines, node, nowMs);

	if (node.droppedChildCount > 0) {
		const recentChildren = node.children.slice(0, WORKSPACE_TREE_DIR_LIMIT - 1);
		const oldestChild = node.children[node.children.length - 1];
		for (const child of recentChildren) collectRenderLines(child, nowMs, lines);
		pushDroppedChildrenLine(lines, node);
		if (oldestChild && !recentChildren.includes(oldestChild)) collectRenderLines(oldestChild, nowMs, lines);
		return;
	}

	for (const child of node.children) collectRenderLines(child, nowMs, lines);
}

function applyLineCap(lines: RenderLine[]): { lines: RenderLine[]; elidedCount: number } {
	if (lines.length <= WORKSPACE_TREE_LINE_CAP) return { lines, elidedCount: 0 };

	const targetLineCount = WORKSPACE_TREE_LINE_CAP - 1;
	const removeCount = lines.length - targetLineCount;
	const removable = lines
		.map((line, index) => ({ line, index }))
		.filter(item => !item.line.isRoot)
		.sort((a, b) => b.line.depth - a.line.depth || b.index - a.index)
		.slice(0, removeCount);
	const removedIndexes = new Set(removable.map(item => item.index));
	const cappedLines = lines.filter((_, index) => !removedIndexes.has(index));
	cappedLines.push({
		label: `… (${removeCount} lines elided beyond depth/cap)`,
		depth: 0,
	});

	return { lines: cappedLines, elidedCount: removeCount };
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

export async function buildWorkspaceTree(cwd: string): Promise<WorkspaceTree> {
	const rootPath = path.resolve(cwd);
	try {
		const nowMs = Date.now();
		const { root, truncated: directoryTruncated } = await collectWorkspaceTree(rootPath);
		const lines: RenderLine[] = [];
		collectRenderLines(root, nowMs, lines);
		const { lines: cappedLines, elidedCount } = applyLineCap(lines);
		return {
			rootPath,
			rendered: renderLines(cappedLines),
			truncated: directoryTruncated || elidedCount > 0,
			totalLines: cappedLines.length,
		};
	} catch {
		return emptyWorkspaceTree(rootPath);
	}
}
