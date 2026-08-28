/**
 * Workload classification vocabulary.
 *
 * These declarations sat in `workload-classifier.ts`, which imports the family
 * matcher, while the matcher imported the declarations back — a two-module
 * import cycle. Neither module was wrong to want the other: the classifier owns
 * the decision, the matcher owns the command-family table, and both speak the
 * same vocabulary. Giving the vocabulary its own module lets both depend on it
 * without depending on each other.
 *
 * Types only, no imports: this module is the bottom of that dependency chain
 * and must stay there.
 */

export type WorkloadClass = "light" | "io" | "cpu" | "memory" | "heavy" | "unknown";

export type WorkloadCommandFamily =
	| "node-test"
	| "node-build"
	| "typescript"
	| "go-test"
	| "rust-build"
	| "container-build"
	| "monorepo"
	| "archive"
	| "generic-process"
	| "unknown";

export type WorkloadShellComplexity = "simple-argv" | "complex-shell";

export interface WorkloadClassification {
	readonly workloadClass: WorkloadClass;
	readonly commandFamily: WorkloadCommandFamily;
	readonly complexity: WorkloadShellComplexity;
	readonly safeToAutoShard: boolean;
	readonly reasonCodes: readonly string[];
}
