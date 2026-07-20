/**
 * Types for the omp commit pipeline.
 */
export type CommitType =
	| "feat"
	| "fix"
	| "refactor"
	| "perf"
	| "docs"
	| "test"
	| "build"
	| "ci"
	| "chore"
	| "style"
	| "revert";

export type ChangelogCategory =
	| "Breaking Changes"
	| "Added"
	| "Changed"
	| "Deprecated"
	| "Removed"
	| "Fixed"
	| "Security";

export const CHANGELOG_CATEGORIES: ChangelogCategory[] = [
	"Breaking Changes",
	"Added",
	"Changed",
	"Deprecated",
	"Removed",
	"Fixed",
	"Security",
];

export interface CommitCommandArgs {
	/** Push after commit */
	push: boolean;
	/** Preview without committing */
	dryRun: boolean;
	/** Skip changelog updates */
	noChangelog: boolean;
	/** Use legacy deterministic pipeline */
	legacy?: boolean;
	/** Additional user context for the model */
	context?: string;
	/** Override the model selection */
	model?: string;
}

export interface NumstatEntry {
	path: string;
	additions: number;
	deletions: number;
}

export interface ConventionalDetail {
	text: string;
	changelogCategory?: ChangelogCategory;
	userVisible: boolean;
}

export interface ConventionalAnalysis {
	type: CommitType;
	scope: string | null;
	details: ConventionalDetail[];
	issueRefs: string[];
}

export interface CommitSummary {
	summary: string;
}

export interface FileObservation {
	file: string;
	observations: string[];
	additions: number;
	deletions: number;
}

export interface FileDiff {
	filename: string;
	content: string;
	additions: number;
	deletions: number;
	isBinary: boolean;
}

export interface DiffHunk {
	index: number;
	header: string;
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	content: string;
}

export interface FileHunks {
	filename: string;
	isBinary: boolean;
	hunks: DiffHunk[];
}

export interface ChangelogBoundary {
	changelogPath: string;
	files: string[];
}

export interface UnreleasedSection {
	startLine: number;
	endLine: number;
	entries: Record<string, string[]>;
}

export interface ChangelogGenerationResult {
	entries: Record<string, string[]>;
}
