import type { NumstatEntry } from "../../commit/types";
import { isExcludedFile } from "../../commit/utils/exclusions";

interface ScopeCandidate {
	path: string;
	percentage: number;
	confidence: number;
}

const PLACEHOLDER_DIRS = new Set([
	"src",
	"lib",
	"bin",
	"crates",
	"benches",
	"examples",
	"internal",
	"pkg",
	"include",
	"tests",
	"test",
	"docs",
	"packages",
	"modules",
]);

const SKIP_DIRS = new Set(["test", "tests", "benches", "examples", "target", "build", "node_modules", ".github"]);

export interface ScopeCandidatesResult {
	scopeCandidates: string;
	isWide: boolean;
}

export function extractScopeCandidates(numstat: NumstatEntry[]): ScopeCandidatesResult {
	const componentLines = new Map<string, number>();
	const paths: string[] = [];
	const distinctRoots = new Set<string>();
	let totalLines = 0;

	for (const entry of numstat) {
		const linesChanged = entry.additions + entry.deletions;
		if (linesChanged === 0) continue;
		const normalizedPath = normalizePathForScope(entry.path);
		if (isExcludedFile(normalizedPath)) continue;
		paths.push(normalizedPath);
		const root = extractTopLevelRoot(normalizedPath);
		if (root) {
			distinctRoots.add(root);
		}
		totalLines += linesChanged;
		const components = extractComponentsFromPath(normalizedPath);
		for (const component of components) {
			if (component.split("/").some(segment => segment.includes("."))) {
				continue;
			}
			componentLines.set(component, (componentLines.get(component) ?? 0) + linesChanged);
		}
	}

	if (totalLines === 0) {
		return { scopeCandidates: "(none - no measurable changes)", isWide: false };
	}

	const candidates = buildScopeCandidates(componentLines, totalLines);
	const isWide = isWideChange(candidates, 0.6, distinctRoots.size);
	if (isWide) {
		const pattern = analyzeWideChange(paths);
		if (pattern) {
			return { scopeCandidates: `(cross-cutting: ${pattern})`, isWide: true };
		}
		return { scopeCandidates: "(none - multi-component change)", isWide: true };
	}

	const suggestionParts: string[] = [];
	for (const candidate of candidates.slice(0, 5)) {
		if (candidate.percentage < 10) continue;
		const confidenceLabel = candidate.path.includes("/")
			? candidate.percentage > 60
				? "high confidence"
				: "moderate confidence"
			: "high confidence";
		suggestionParts.push(`${candidate.path} (${candidate.percentage.toFixed(0)}%, ${confidenceLabel})`);
	}

	const scopeCandidates =
		suggestionParts.length === 0
			? "(none - unclear component)"
			: `${suggestionParts.join(", ")}\nPrefer 2-segment scopes marked 'high confidence'`;

	return { scopeCandidates, isWide: false };
}

function buildScopeCandidates(componentLines: Map<string, number>, totalLines: number): ScopeCandidate[] {
	const candidates: ScopeCandidate[] = [];
	for (const [path, lines] of componentLines.entries()) {
		if (!path.includes("/") && PLACEHOLDER_DIRS.has(path)) continue;
		const root = path.split("/")[0] ?? "";
		if (PLACEHOLDER_DIRS.has(root)) continue;
		const percentage = (lines / totalLines) * 100;
		const isTwoSegment = path.includes("/");
		const confidence = isTwoSegment ? (percentage > 60 ? percentage * 1.2 : percentage * 0.8) : percentage;
		candidates.push({ path, percentage, confidence });
	}
	return candidates.sort((a, b) => b.confidence - a.confidence);
}

function isWideChange(candidates: ScopeCandidate[], threshold: number, distinctRoots: number): boolean {
	if (distinctRoots >= 3) return true;
	const top = candidates[0];
	if (!top) return false;
	return top.percentage / 100 < threshold;
}

function extractComponentsFromPath(path: string): string[] {
	const segments = path.split("/");
	const meaningful: string[] = [];

	const stripExt = (segment: string): string => {
		const index = segment.lastIndexOf(".");
		return index > 0 ? segment.slice(0, index) : segment;
	};

	const isFile = (segment: string): boolean => {
		return segment.includes(".") && !segment.startsWith(".") && segment.lastIndexOf(".") > 0;
	};

	for (let index = 0; index < segments.length; index += 1) {
		const segment = segments[index] ?? "";
		if (PLACEHOLDER_DIRS.has(segment) && segments.length > index + 1) {
			continue;
		}
		if (isFile(segment)) continue;
		if (SKIP_DIRS.has(segment)) continue;

		const stripped = stripExt(segment);
		if (stripped && !stripped.startsWith(".")) {
			meaningful.push(stripped);
		}
	}

	const components: string[] = [];
	if (meaningful.length > 0) {
		components.push(meaningful[0]!);
		if (meaningful.length >= 2) {
			components.push(`${meaningful[0]}/${meaningful[1]}`);
		}
	}

	return components;
}

function extractTopLevelRoot(path: string): string | null {
	const segments = path.split("/").filter(segment => segment.length > 0);
	if (segments.length === 0) return null;
	if (segments.length === 1) {
		return segments[0]!.startsWith(".") ? null : "(root)";
	}

	for (let index = 0; index < segments.length; index += 1) {
		const segment = segments[index] ?? "";
		if (PLACEHOLDER_DIRS.has(segment) && segments.length > index + 1) {
			continue;
		}
		if (SKIP_DIRS.has(segment)) continue;
		if (segment.startsWith(".")) continue;
		return segment;
	}

	return null;
}

function normalizePathForScope(path: string): string {
	const braceStart = path.indexOf("{");
	if (braceStart !== -1) {
		const arrowPos = path.indexOf(" => ", braceStart);
		if (arrowPos !== -1) {
			const braceEnd = path.indexOf("}", arrowPos);
			if (braceEnd !== -1) {
				const prefix = path.slice(0, braceStart);
				const newName = path.slice(arrowPos + 4, braceEnd).trim();
				return `${prefix}${newName}`;
			}
		}
	}

	if (path.includes(" => ")) {
		const parts = path.split(" => ");
		return parts[1]?.trim() ?? path.trim();
	}

	return path.trim();
}

function analyzeWideChange(paths: string[]): string | null {
	if (paths.length === 0) return null;
	const total = paths.length;
	let mdCount = 0;
	let testCount = 0;
	let configCount = 0;
	let hasCargoToml = false;
	let hasPackageJson = false;
	let errorKeywords = 0;
	let typeKeywords = 0;

	for (const path of paths) {
		const lowerPath = path.toLowerCase();
		if (lowerPath.endsWith(".md")) {
			mdCount += 1;
		}
		if (lowerPath.includes("/test") || lowerPath.includes("_test.")) {
			testCount += 1;
		}
		if (
			lowerPath.endsWith(".toml") ||
			lowerPath.endsWith(".yaml") ||
			lowerPath.endsWith(".yml") ||
			lowerPath.endsWith(".json")
		) {
			configCount += 1;
		}
		if (path.includes("Cargo.toml")) {
			hasCargoToml = true;
		}
		if (path.includes("package.json")) {
			hasPackageJson = true;
		}
		if (lowerPath.includes("error") || lowerPath.includes("result") || lowerPath.includes("err")) {
			errorKeywords += 1;
		}
		if (lowerPath.includes("type") || lowerPath.includes("struct") || lowerPath.includes("enum")) {
			typeKeywords += 1;
		}
	}

	if (hasCargoToml || hasPackageJson) return "deps";
	if ((mdCount * 100) / total > 70) return "docs";
	if ((testCount * 100) / total > 60) return "tests";
	if ((errorKeywords * 100) / total > 40) return "error-handling";
	if ((typeKeywords * 100) / total > 40) return "type-refactor";
	if ((configCount * 100) / total > 50) return "config";
	return null;
}
