/**
 * Reasoning-router bias compiler — privacy-safe learning ledger.
 *
 * Pure, deterministic compiler from v4 feedback records (see
 * router-feedback-collector.ts) to a bounded, per-cell reasoning-level bias
 * snapshot. No clock, randomness, network, or model calls: the same input array
 * always produces the same output (`JSON.stringify` byte-identical), regardless
 * of input record order. `parseRouterBiasSnapshot` performs no filesystem
 * access itself; the actual disk read lives in agent-session.ts.
 */

import { createHash } from "crypto";
import { join } from "path";
import { getAgentDir } from "../config.ts";
import {
	isRouterFeedbackRecord,
	ROUTER_FEEDBACK_LANE_TYPES,
	ROUTER_FEEDBACK_LEN_BUCKETS,
	ROUTER_FEEDBACK_TASK_CLASSES,
	type RouterFeedbackLaneType,
	type RouterFeedbackLenBucket,
	type RouterFeedbackRecord,
	type RouterFeedbackTaskClass,
	type RouterFeedbackVersion,
} from "./router-feedback-collector.ts";

/** Minimum non-neutral ("strong") record count per cell before any bias applies. */
export const BIAS_STRONG_THRESHOLD = 5;

/** Bias magnitude bound, matching the resolver's bias clamp. */
export const BIAS_MAX_STEPS = 2;

/** Bounded per-cell bias, in ladder steps. Never outside [-2, 2]. */
export type RouterBiasSteps = -2 | -1 | 0 | 1 | 2;

/** The feature tuple a bias cell is keyed on — identical dimensions the router already computes locally. */
export interface RouterBiasCellKey {
	readonly predictedClass: RouterFeedbackTaskClass;
	readonly laneType: RouterFeedbackLaneType;
	readonly lenBucket: RouterFeedbackLenBucket;
	readonly hadFence: boolean;
	readonly hadDiff: boolean;
}

export interface RouterBiasCell extends RouterBiasCellKey {
	readonly biasSteps: RouterBiasSteps;
	/** Non-neutral (up/down-signaling) record count for this cell. */
	readonly nStrong: number;
	/** Total record count for this cell, including neutral (accepted/same/pass) records. */
	readonly nTotal: number;
}

export interface RouterBiasSnapshot {
	readonly schemaVersion: "router-bias-snapshot/v1";
	/** sha256 hex digest of the canonicalized valid-record set actually compiled; not a prompt hash. */
	readonly sourceRecordDigest: string;
	/** Count of records that were validated and included in this snapshot. */
	readonly consideredCount: number;
	/** Count of records excluded from this snapshot (schema-invalid, or router-version mismatch). */
	readonly droppedCount: number;
	/** Bias cells, sorted deterministically. Sub-threshold cells remain visible with zero bias. */
	readonly biasCells: readonly RouterBiasCell[];
}

export interface CompileBiasSnapshotOptions {
	/**
	 * Restrict compilation to one router version. The only supported runtime
	 * router version is v4; records tagged with any other value are invalid and
	 * counted in `droppedCount`.
	 */
	readonly routerVersion?: RouterFeedbackVersion;
}

function cellKeyString(key: RouterBiasCellKey): string {
	return [key.predictedClass, key.laneType, String(key.lenBucket), String(key.hadFence), String(key.hadDiff)].join(
		"|",
	);
}

/** +1 "needed more effort", -1 "needed less effort", 0 neutral (no directional bias contribution). */
function outcomeDirection(outcome: RouterFeedbackRecord["outcome"]): -1 | 0 | 1 {
	if (outcome === "up" || outcome === "fail" || outcome === "debug-follow-up") return 1;
	if (outcome === "down") return -1;
	return 0;
}

/** Fixed-key-order JSON so identical records always canonicalize to identical bytes. */
function canonicalRecordJson(record: RouterFeedbackRecord): string {
	return JSON.stringify({
		routerVersion: record.routerVersion,
		laneType: record.laneType,
		predictedClass: record.predictedClass,
		resolvedLevel: record.resolvedLevel,
		acceptedLevel: record.acceptedLevel,
		signal: record.signal,
		outcome: record.outcome,
		lenBucket: record.lenBucket,
		hadFence: record.hadFence,
		hadDiff: record.hadDiff,
	});
}

interface CellAccumulator extends RouterBiasCellKey {
	nTotal: number;
	upVotes: number;
	downVotes: number;
}

function computeBiasSteps(upVotes: number, downVotes: number, nStrong: number): RouterBiasSteps {
	if (nStrong < BIAS_STRONG_THRESHOLD) return 0;
	const majority = upVotes - downVotes;
	if (majority === 0) return 0;

	const dominance = Math.abs(majority) / nStrong;
	const magnitude = dominance >= 0.75 ? BIAS_MAX_STEPS : 1;
	const signedMagnitude = majority > 0 ? magnitude : -magnitude;
	return Math.max(-BIAS_MAX_STEPS, Math.min(BIAS_MAX_STEPS, signedMagnitude)) as RouterBiasSteps;
}

/**
 * Deterministically compile a bounded bias snapshot from raw (possibly
 * malformed) ledger entries. Unknown-shaped entries — including ones with
 * extra keys, missing keys, or out-of-range enum values — are dropped and
 * counted, never thrown. Records tagged with a `routerVersion` other than the
 * target version are also dropped and counted (never merged across router
 * versions into one snapshot). An empty or all-dropped input compiles to an
 * empty-bias snapshot (`biasCells: []`), which is exactly the shipped
 * no-learning behavior — this makes "empty ledger -> zero bias" true by
 * construction, not by a special case.
 *
 * Pure: same `records` (any order) -> same `RouterBiasSnapshot` (byte-
 * identical `JSON.stringify` output), because cells are grouped by an
 * order-independent key and the emitted cell/record ordering is always
 * sorted before serialization.
 */
export function compileBiasSnapshot(
	records: readonly unknown[],
	options: CompileBiasSnapshotOptions = {},
): RouterBiasSnapshot {
	const routerVersion = options.routerVersion ?? "v4";
	const valid: RouterFeedbackRecord[] = [];
	let droppedCount = 0;

	for (const entry of records) {
		if (isRouterFeedbackRecord(entry) && entry.routerVersion === routerVersion) {
			valid.push(entry);
		} else {
			droppedCount += 1;
		}
	}

	const cells = new Map<string, CellAccumulator>();
	for (const record of valid) {
		const key: RouterBiasCellKey = {
			predictedClass: record.predictedClass,
			laneType: record.laneType,
			lenBucket: record.lenBucket,
			hadFence: record.hadFence,
			hadDiff: record.hadDiff,
		};
		const mapKey = cellKeyString(key);
		const existing = cells.get(mapKey) ?? { ...key, nTotal: 0, upVotes: 0, downVotes: 0 };
		existing.nTotal += 1;
		const direction = outcomeDirection(record.outcome);
		if (direction === 1) existing.upVotes += 1;
		else if (direction === -1) existing.downVotes += 1;
		cells.set(mapKey, existing);
	}

	const biasCells: RouterBiasCell[] = [];
	for (const mapKey of [...cells.keys()].sort()) {
		const acc = cells.get(mapKey);
		if (!acc) continue;
		const nStrong = acc.upVotes + acc.downVotes;
		biasCells.push({
			predictedClass: acc.predictedClass,
			laneType: acc.laneType,
			lenBucket: acc.lenBucket,
			hadFence: acc.hadFence,
			hadDiff: acc.hadDiff,
			biasSteps: computeBiasSteps(acc.upVotes, acc.downVotes, nStrong),
			nStrong,
			nTotal: acc.nTotal,
		});
	}

	const canonicalValid = valid.map(canonicalRecordJson).sort();
	const sourceRecordDigest = createHash("sha256").update(canonicalValid.join("\n")).digest("hex");

	return {
		schemaVersion: "router-bias-snapshot/v1",
		sourceRecordDigest,
		consideredCount: valid.length,
		droppedCount,
		biasCells,
	};
}

/** Look up the compiled bias for one feature cell; 0 (no bias) when the cell is absent from the snapshot. */
export function getBiasStepsForCell(snapshot: RouterBiasSnapshot, key: RouterBiasCellKey): RouterBiasSteps {
	const wantKey = cellKeyString(key);
	for (const cell of snapshot.biasCells) {
		if (cellKeyString(cell) === wantKey) return cell.biasSteps;
	}
	return 0;
}

// ============================================================================
// Snapshot parser / loader (Goal 010 Lane I)
// ============================================================================
//
// Everything below lets a caller safely turn untrusted on-disk JSON text into
// a validated RouterBiasSnapshot. Same posture as isRouterFeedbackRecord in
// router-feedback-collector.ts: an exact positive key-set allowlist (not a
// denylist), bounded per-field checks reusing the ledger's own closed enums,
// and "never throw, return null/false instead" on any malformed input.

/** Bounded bias-step values a compiled cell may carry; mirrors RouterBiasSteps. */
const ROUTER_BIAS_STEPS_VALUES: readonly RouterBiasSteps[] = [-2, -1, 0, 1, 2];

/** Exact allowed key set for one compiled `RouterBiasCell`, sorted for canonical set-equality comparison. */
const ROUTER_BIAS_CELL_KEYS: readonly string[] = [
	"predictedClass",
	"laneType",
	"lenBucket",
	"hadFence",
	"hadDiff",
	"biasSteps",
	"nStrong",
	"nTotal",
].sort();

/** Exact allowed key set for a `RouterBiasSnapshot`, sorted for canonical set-equality comparison. */
const ROUTER_BIAS_SNAPSHOT_KEYS: readonly string[] = [
	"schemaVersion",
	"sourceRecordDigest",
	"consideredCount",
	"droppedCount",
	"biasCells",
].sort();

/** sha256 hex digest shape check for `sourceRecordDigest` (never trusts the value is actually a real digest of anything, only that it has the right shape). */
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeySet(value: Record<string, unknown>, allowedSortedKeys: readonly string[]): boolean {
	const keys = Object.keys(value).sort();
	if (keys.length !== allowedSortedKeys.length) return false;
	for (let i = 0; i < keys.length; i++) {
		if (keys[i] !== allowedSortedKeys[i]) return false;
	}
	return true;
}

function isBoundedNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Strict runtime validator for one compiled bias cell. Exact eight-key
 * allowlist plus bounded per-field checks, reusing the same closed enums as
 * `isRouterFeedbackRecord` (`ROUTER_FEEDBACK_TASK_CLASSES`,
 * `ROUTER_FEEDBACK_LANE_TYPES`, `ROUTER_FEEDBACK_LEN_BUCKETS`) so this
 * validator cannot silently drift from the ledger's own schema. `nStrong` is
 * additionally required to never exceed `nTotal`, and a nonzero bias requires
 * the compiler's strong-evidence threshold. Both hold for every cell the
 * compiler can produce and fail closed for a hand-tampered file.
 */
export function isRouterBiasCell(value: unknown): value is RouterBiasCell {
	if (!isPlainObject(value)) return false;
	if (!hasExactKeySet(value, ROUTER_BIAS_CELL_KEYS)) return false;
	if (!ROUTER_FEEDBACK_TASK_CLASSES.includes(value.predictedClass as RouterFeedbackTaskClass)) return false;
	if (!ROUTER_FEEDBACK_LANE_TYPES.includes(value.laneType as RouterFeedbackLaneType)) return false;
	if (!ROUTER_FEEDBACK_LEN_BUCKETS.includes(value.lenBucket as RouterFeedbackLenBucket)) return false;
	if (typeof value.hadFence !== "boolean") return false;
	if (typeof value.hadDiff !== "boolean") return false;
	if (!ROUTER_BIAS_STEPS_VALUES.includes(value.biasSteps as RouterBiasSteps)) return false;
	if (!isBoundedNonNegativeInteger(value.nStrong)) return false;
	if (!isBoundedNonNegativeInteger(value.nTotal)) return false;
	if ((value.nStrong as number) > (value.nTotal as number)) return false;
	if (value.biasSteps !== 0 && (value.nStrong as number) < BIAS_STRONG_THRESHOLD) return false;
	return true;
}

/**
 * Strict runtime validator for a compiled bias snapshot. Exact five-key
 * allowlist; `biasCells` must be unique, every element must pass
 * `isRouterBiasCell`, and their totals must equal `consideredCount`. Never
 * trusts on-disk content: inconsistent counts, unexpected shapes, extra keys,
 * or out-of-range values return `false` rather than throwing.
 */
export function isRouterBiasSnapshot(value: unknown): value is RouterBiasSnapshot {
	if (!isPlainObject(value)) return false;
	if (!hasExactKeySet(value, ROUTER_BIAS_SNAPSHOT_KEYS)) return false;
	if (value.schemaVersion !== "router-bias-snapshot/v1") return false;
	if (typeof value.sourceRecordDigest !== "string" || !SHA256_HEX_PATTERN.test(value.sourceRecordDigest)) return false;
	if (!isBoundedNonNegativeInteger(value.consideredCount)) return false;
	if (!isBoundedNonNegativeInteger(value.droppedCount)) return false;
	if (!Array.isArray(value.biasCells)) return false;
	const cellKeys = new Set<string>();
	let totalRecords = 0;
	for (const cell of value.biasCells) {
		if (!isRouterBiasCell(cell)) return false;
		const key = cellKeyString(cell);
		if (cellKeys.has(key)) return false;
		cellKeys.add(key);
		if (totalRecords > Number.MAX_SAFE_INTEGER - cell.nTotal) return false;
		totalRecords += cell.nTotal;
	}
	return totalRecords === value.consideredCount;
}

/**
 * Safe parse of raw (untrusted, e.g. on-disk) JSON text into a validated
 * `RouterBiasSnapshot`. Never throws: malformed JSON or any schema violation
 * returns `null`. Performs no filesystem access itself — callers own the
 * actual read — so this module's zero-I/O determinism guarantee for
 * `compileBiasSnapshot`/`getBiasStepsForCell` is unaffected.
 */
export function parseRouterBiasSnapshot(raw: string): RouterBiasSnapshot | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	return isRouterBiasSnapshot(parsed) ? parsed : null;
}

/**
 * Legacy shared snapshot path. Agent sessions and the shipped compiler now use
 * repository-scoped defaults unless a caller explicitly selects a fixed path.
 */
export function getDefaultRouterBiasSnapshotPath(version: RouterFeedbackVersion = "v4"): string {
	return join(getAgentDir(), "router-feedback", "weights", `router-bias-snapshot.${version}.json`);
}
