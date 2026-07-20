/**
 * Typed runtime facade over the flag-gated OMP pure-seam loader.
 *
 * Wiring boundary for I2 (ADR-OMP-008): when `OMK_OMP_SEAMS=1`, the read and
 * grep tools delegate request validation and output presentation to the
 * vendored OMP pure seams. When the flag is off (default), this module
 * returns undefined and tool behavior is byte-identical to before.
 *
 * The loader exposes unknown-in/unknown-out signatures; all structural
 * assertions live in this single file so tool code stays clean.
 */
import { isOmpSeamsEnabled, loadOmpPureSeams, type OmpPureSeams } from "./omp-pure-seams.ts";

export interface OmpIssue {
	readonly field: string;
	readonly code: string;
	readonly message: string;
}

export interface OmpReadPlan {
	readonly path: string;
	readonly offset: number;
	readonly limit: number;
}

export type OmpReadPlanResult =
	| { readonly ok: true; readonly plan: OmpReadPlan }
	| { readonly ok: false; readonly issues: readonly OmpIssue[] };

export interface OmpReadPresentation {
	readonly text: string;
	readonly window: {
		readonly startLine: number;
		readonly endLine: number;
		readonly totalLines: number;
		readonly truncated: boolean;
	};
}

export type OmpReadPresentResult =
	| { readonly ok: true; readonly presentation: OmpReadPresentation }
	| { readonly ok: false; readonly conflicts: readonly unknown[] };

export interface OmpSearchPlan {
	readonly pattern: string;
	readonly path: string;
	readonly glob?: string;
	readonly ignoreCase: boolean;
	readonly literal: boolean;
	readonly context: number;
	readonly limit: number;
}

export type OmpSearchPlanResult =
	| { readonly ok: true; readonly plan: OmpSearchPlan }
	| { readonly ok: false; readonly issues: readonly OmpIssue[] };

export interface OmpSearchHostMatch {
	readonly file: string;
	readonly line: number;
	readonly column?: number;
	readonly text: string;
	readonly expectedLineHash?: string;
}

export interface OmpSearchPresentation {
	readonly text: string;
	readonly totalMatches: number;
	readonly omittedMatches: number;
	readonly truncated: boolean;
}

export type OmpSearchPresentResult =
	| { readonly ok: true; readonly presentation: OmpSearchPresentation }
	| { readonly ok: false; readonly conflicts: readonly unknown[] };

let cached: Promise<OmpPureSeams> | undefined;

/**
 * Returns the memoized seam set when `OMK_OMP_SEAMS=1`; `undefined` when the
 * flag is off. Loader errors (VENDOR_NOT_FOUND, INVALID_SEAM) propagate to
 * the caller of the returned promise — the flag is an explicit opt-in.
 */
export function getOmpSeams(): Promise<OmpPureSeams> | undefined {
	if (!isOmpSeamsEnabled()) return undefined;
	cached ??= loadOmpPureSeams();
	return cached;
}

export function planRead(seams: OmpPureSeams, input: unknown): OmpReadPlanResult {
	return seams.planRead(input) as OmpReadPlanResult;
}

export function presentRead(
	seams: OmpPureSeams,
	plan: OmpReadPlan,
	file: { text: string; sourceDigest?: string; lineDigests?: readonly { line: number; digest: string }[] },
): OmpReadPresentResult {
	return seams.presentRead(plan, file) as OmpReadPresentResult;
}

export function planSearch(seams: OmpPureSeams, input: unknown): OmpSearchPlanResult {
	return seams.planSearch(input) as OmpSearchPlanResult;
}

export function presentSearch(
	seams: OmpPureSeams,
	plan: OmpSearchPlan,
	matches: readonly OmpSearchHostMatch[],
): OmpSearchPresentResult {
	return seams.presentSearch(plan, matches) as OmpSearchPresentResult;
}

export function formatOmpIssues(issues: readonly OmpIssue[]): string {
	return issues.map((issue) => `${issue.field}: ${issue.message}`).join("; ");
}
