/**
 * Pure, browser-safe deterministic resource-claim DAG scheduler.
 *
 * Given a source-ordered batch of tool calls and their resolved resource
 * claims, this module assigns each call after every earlier call it conflicts
 * with. Levels run in source order; calls inside one level are mutually
 * conflict-free and may execute concurrently. A positive `maxConcurrency`
 * width cap splits each level into deterministic contiguous source-ordered
 * chunks.
 *
 * Determinism contract:
 * - The level assignment is a pure function of the source-ordered input
 *   claims. The canonical example is the head-of-line example
 *   `write x, write x, write y`, which schedules as `[[0, 2], [1]]`: the second
 *   write to `x` is pushed to level 1, but the independent write to `y` is not
 *   blocked and joins level 0.
 * - Reordering claims *within* a single call does not change the plan: claims
 *   are canonicalized (sorted, fixed property order) before comparison.
 * - {@link DagSchedulePlan.planKey} is a canonical serialization of the
 *   resolved claim sequence (canonical claim data only — never execution
 *   timing or outcomes). It is collision-free for distinct canonical claim
 *   sequences.
 *
 * This module uses no platform APIs (no `process`, fs, `node:path`, or timers).
 */

import {
	type ClaimableToolCall,
	canonicalizeClaims,
	claimsConflict,
	type ResolveToolClaimsOptions,
	resolveToolClaimsForCall,
	type ToolClaimResolution,
	type ToolResourceClaim,
} from "./tool-resource-claims.ts";

/** Options for scheduling a batch into DAG levels. */
export interface ScheduleDagLevelsOptions extends ResolveToolClaimsOptions {
	/**
	 * Optional positive width cap. When set, each level is split into contiguous
	 * source-ordered chunks of at most this many calls so a wide conflict-free
	 * level does not fan out unbounded. Absent, non-finite, or non-positive
	 * values leave each level whole. Does not affect `planKey`.
	 */
	maxConcurrency?: number;
}

/** A scheduled plan: ordered levels of source indices plus a canonical key. */
export interface DagSchedulePlan {
	/** Levels in execution order; each level holds source indices that may run concurrently. */
	levels: number[][];
	/**
	 * Canonical deterministic key over the resolved claim sequence only (never
	 * execution timing/outcomes). Stable under claim reordering within a call.
	 */
	planKey: string;
}

/** One tool call's resolved claim data, canonicalized for stable planning. */
export interface ResolvedClaimEntry {
	sourceIndex: number;
	resolution: ToolClaimResolution;
	canonicalClaims: ToolResourceClaim[];
}

/**
 * Resolve and canonicalize claims for a whole batch, preserving source order.
 * Registered custom resolvers are awaited one call at a time in source order,
 * and every resolution completes before a schedule is constructed.
 */
export async function resolveBatchClaims(
	toolCalls: readonly ClaimableToolCall[],
	options: ResolveToolClaimsOptions,
): Promise<ResolvedClaimEntry[]> {
	const entries: ResolvedClaimEntry[] = [];
	for (let index = 0; index < toolCalls.length; index++) {
		const resolution = await resolveToolClaimsForCall(toolCalls[index], options);
		const canonicalClaims = resolution.kind === "claims" ? canonicalizeClaims(resolution.claims) : [];
		entries.push({ sourceIndex: index, resolution, canonicalClaims });
	}
	return entries;
}

interface DagLevel {
	indices: number[];
	/** Write claims currently placed in this level (for fast read-vs-write checks). */
	writeClaims: ToolResourceClaim[];
	/** Read claims currently placed in this level (for fast write-vs-read checks). */
	readClaims: ToolResourceClaim[];
	/** True once an exclusive call is placed here; such a level accepts no more. */
	hasExclusive: boolean;
}

function claimConflictsAny(claim: ToolResourceClaim, candidates: readonly ToolResourceClaim[]): boolean {
	for (const candidate of candidates) {
		if (claimsConflict(claim, candidate)) {
			return true;
		}
	}
	return false;
}

/**
 * True when `resolution` cannot join `level`. Equivalent to the full pairwise
 * `resolutionsConflict` check, optimized so read/read never triggers a scan:
 * a read claim only needs to scan the level's writes, and a write claim scans
 * both writes and reads. An exclusive resolution, or a level that already holds
 * an exclusive call, conflicts unconditionally.
 */
function resolutionConflictsLevel(resolution: ToolClaimResolution, level: DagLevel): boolean {
	if (level.hasExclusive) {
		return true;
	}
	if (resolution.kind === "exclusive") {
		return true;
	}
	for (const claim of resolution.claims) {
		if (claim.access === "exclusive") {
			return true;
		}
		if (claim.access === "write") {
			if (claimConflictsAny(claim, level.writeClaims)) {
				return true;
			}
			if (claimConflictsAny(claim, level.readClaims)) {
				return true;
			}
		} else if (claimConflictsAny(claim, level.writeClaims)) {
			return true;
		}
	}
	return false;
}

/**
 * Assign each source-ordered claim entry one level after its latest earlier
 * conflict. Deterministic and stable: equal inputs (including claim reordering
 * within a call, which is canonicalized away) always produce equal levels, and
 * every directed conflict edge advances at least one level.
 */
export function assignDagLevels(entries: readonly ResolvedClaimEntry[]): number[][] {
	const levels: DagLevel[] = [];
	for (const entry of entries) {
		const resolution = entry.resolution;
		let targetIndex = 0;
		for (let levelIndex = 0; levelIndex < levels.length; levelIndex++) {
			if (resolutionConflictsLevel(resolution, levels[levelIndex])) {
				targetIndex = levelIndex + 1;
			}
		}
		let target = levels[targetIndex];
		if (!target) {
			target = { indices: [], writeClaims: [], readClaims: [], hasExclusive: false };
			levels.push(target);
		}
		target.indices.push(entry.sourceIndex);
		if (resolution.kind === "exclusive" || entry.canonicalClaims.some((claim) => claim.access === "exclusive")) {
			target.hasExclusive = true;
		} else {
			for (const claim of entry.canonicalClaims) {
				if (claim.access === "write") {
					target.writeClaims.push(claim);
				} else {
					target.readClaims.push(claim);
				}
			}
		}
	}
	return levels.map((level) => level.indices);
}

/**
 * Split each level into contiguous source-ordered chunks of at most `cap` calls.
 * Absent/non-finite/non-positive `cap` returns the levels unchanged.
 */
export function applyConcurrencyCap(levels: readonly number[][], cap: number | undefined): number[][] {
	if (typeof cap !== "number" || !Number.isFinite(cap) || cap <= 0) {
		return levels.map((level) => level.slice());
	}
	const integerCap = Math.max(1, Math.floor(cap));
	const chunked: number[][] = [];
	for (const level of levels) {
		if (level.length <= integerCap) {
			chunked.push(level.slice());
			continue;
		}
		for (let start = 0; start < level.length; start += integerCap) {
			chunked.push(level.slice(start, start + integerCap));
		}
	}
	return chunked;
}

/**
 * Canonical deterministic key over the resolved claim sequence. Uses
 * `JSON.stringify` of each call's canonicalized claims (fixed property order,
 * sorted) with an `"E"`/`"C"` discriminator, so it is collision-free for
 * distinct canonical claim sequences and stable under claim reordering within a
 * call. Contains no execution timing or outcomes.
 */
export function computePlanKey(entries: readonly ResolvedClaimEntry[]): string {
	let key = "";
	for (const entry of entries) {
		if (entry.resolution.kind === "exclusive") {
			key += "E,";
		} else {
			key += `C${JSON.stringify(entry.canonicalClaims)},`;
		}
	}
	return key;
}

/**
 * Schedule a source-ordered tool-call batch into deterministic DAG levels.
 * Resolves default claims, computes source-directed dependency levels, applies
 * the optional width cap, and computes the canonical plan key. Pure and
 * deterministic.
 */
export async function scheduleDagLevels(
	toolCalls: readonly ClaimableToolCall[],
	options: ScheduleDagLevelsOptions,
): Promise<DagSchedulePlan> {
	const entries = await resolveBatchClaims(toolCalls, options);
	const baseLevels = assignDagLevels(entries);
	const levels = applyConcurrencyCap(baseLevels, options.maxConcurrency);
	return { levels, planKey: computePlanKey(entries) };
}
