/**
 * Router feedback collector — privacy-safe learning ledger for `/think auto`.
 *
 * Default-off, privacy-safe local ledger for the v4 reasoning-router learning
 * path. This module is a pure utility; consent and wiring live in settings and
 * agent-session.ts.
 *
 * ============================================================================
 * SCHEMA (exactly ten allowed keys — see `RouterFeedbackRecord`)
 * ============================================================================
 * routerVersion, laneType, predictedClass, resolvedLevel, acceptedLevel,
 * signal, outcome, lenBucket, hadFence, hadDiff. Every field is a bounded
 * enum/number/boolean value. There is no field, in this type or in the runtime
 * validator below, that can carry raw prompt text, a prompt hash, an exact
 * prompt length, a file path, a diff/code blob, a session id, a model id, a
 * provider payload, or any hook/tool stdout/stderr. `isRouterFeedbackRecord`
 * rejects ANY object with an unrecognized key (including all of the fields
 * just listed) — the schema is the redaction policy, enforced structurally by
 * an exact key-set check, not by a best-effort denylist of forbidden names.
 * ============================================================================
 */

import {
	chmodSync,
	closeSync,
	existsSync,
	constants as fsConstants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	writeSync,
} from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../config.ts";
import type { ReasoningLaneTypeV4, TaskClassV4 } from "./reasoning-router-v4.ts";

/** Router version eligible to tag a feedback record. */
export type RouterFeedbackVersion = "v4";

/** Lane type at record time, or "none" for a non-subagent turn. */
export type RouterFeedbackLaneType = ReasoningLaneTypeV4 | "none";

/** Router task class; never a raw prompt. */
export type RouterFeedbackTaskClass = TaskClassV4;

/**
 * Reasoning ladder level, excluding "off". The router never *resolves* to
 * "off"; turning thinking off entirely is a distinct manual action outside
 * this ledger.
 */
export type RouterFeedbackLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

/** Feedback signal source. */
export type RouterFeedbackSignal = "s1-override" | "s2-accept" | "s3-hook-outcome" | "s4-regression";

/** Coarse outcome tag; never hook stdout/stderr or tool output. */
export type RouterFeedbackOutcome = "up" | "down" | "same" | "accepted" | "pass" | "fail" | "debug-follow-up";

/** floor(log2(len+1)) clamped to [0,7] — a coarse bucket, never the raw prompt length. */
export type RouterFeedbackLenBucket = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/**
 * One JSONL ledger record. Exactly these ten keys; see `isRouterFeedbackRecord`
 * for the runtime allowlist enforcement.
 */
export interface RouterFeedbackRecord {
	readonly routerVersion: RouterFeedbackVersion;
	readonly laneType: RouterFeedbackLaneType;
	readonly predictedClass: RouterFeedbackTaskClass;
	readonly resolvedLevel: RouterFeedbackLevel;
	readonly acceptedLevel: RouterFeedbackLevel;
	readonly signal: RouterFeedbackSignal;
	readonly outcome: RouterFeedbackOutcome;
	readonly lenBucket: RouterFeedbackLenBucket;
	readonly hadFence: boolean;
	readonly hadDiff: boolean;
}

export const ROUTER_FEEDBACK_VERSIONS: readonly RouterFeedbackVersion[] = ["v4"];
export const ROUTER_FEEDBACK_LANE_TYPES: readonly RouterFeedbackLaneType[] = [
	"planner",
	"security",
	"explorer",
	"coder",
	"reviewer",
	"tester",
	"none",
];
export const ROUTER_FEEDBACK_TASK_CLASSES: readonly RouterFeedbackTaskClass[] = [
	"trivial",
	"simple-edit",
	"code-gen",
	"debug",
	"refactor",
	"review",
	"plan",
];
export const ROUTER_FEEDBACK_LEVELS: readonly RouterFeedbackLevel[] = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"ultra",
];
const ROUTER_FEEDBACK_SIGNALS: readonly RouterFeedbackSignal[] = [
	"s1-override",
	"s2-accept",
	"s3-hook-outcome",
	"s4-regression",
];
const ROUTER_FEEDBACK_OUTCOMES: readonly RouterFeedbackOutcome[] = [
	"up",
	"down",
	"same",
	"accepted",
	"pass",
	"fail",
	"debug-follow-up",
];
export const ROUTER_FEEDBACK_LEN_BUCKETS: readonly RouterFeedbackLenBucket[] = [0, 1, 2, 3, 4, 5, 6, 7];

/** Exact allowed key set for `RouterFeedbackRecord`, sorted for canonical set-equality comparison. */
const ROUTER_FEEDBACK_RECORD_KEYS: readonly string[] = [
	"routerVersion",
	"laneType",
	"predictedClass",
	"resolvedLevel",
	"acceptedLevel",
	"signal",
	"outcome",
	"lenBucket",
	"hadFence",
	"hadDiff",
].sort();

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactRouterFeedbackKeySet(value: Record<string, unknown>): boolean {
	const keys = Object.keys(value).sort();
	if (keys.length !== ROUTER_FEEDBACK_RECORD_KEYS.length) return false;
	for (let i = 0; i < keys.length; i++) {
		if (keys[i] !== ROUTER_FEEDBACK_RECORD_KEYS[i]) return false;
	}
	return true;
}

/**
 * Strict runtime validator: exactly the ten allowed keys (no more, no fewer),
 * each within its bounded value set. Returns false for any extra key —
 * including a raw prompt, file path, diff, session id, model id, provider
 * payload, or hook/tool-output-shaped field — because ANY unrecognized key
 * fails the exact key-set check before any per-field check runs.
 */
export function isRouterFeedbackRecord(value: unknown): value is RouterFeedbackRecord {
	if (!isPlainObject(value)) return false;
	if (!hasExactRouterFeedbackKeySet(value)) return false;

	if (!ROUTER_FEEDBACK_VERSIONS.includes(value.routerVersion as RouterFeedbackVersion)) return false;
	if (!ROUTER_FEEDBACK_LANE_TYPES.includes(value.laneType as RouterFeedbackLaneType)) return false;
	if (!ROUTER_FEEDBACK_TASK_CLASSES.includes(value.predictedClass as RouterFeedbackTaskClass)) return false;
	if (!ROUTER_FEEDBACK_LEVELS.includes(value.resolvedLevel as RouterFeedbackLevel)) return false;
	if (!ROUTER_FEEDBACK_LEVELS.includes(value.acceptedLevel as RouterFeedbackLevel)) return false;
	if (!ROUTER_FEEDBACK_SIGNALS.includes(value.signal as RouterFeedbackSignal)) return false;
	if (!ROUTER_FEEDBACK_OUTCOMES.includes(value.outcome as RouterFeedbackOutcome)) return false;
	if (!ROUTER_FEEDBACK_LEN_BUCKETS.includes(value.lenBucket as RouterFeedbackLenBucket)) return false;
	if (typeof value.hadFence !== "boolean") return false;
	if (typeof value.hadDiff !== "boolean") return false;

	return true;
}

/** Legacy shared ledger path. Agent sessions use repository-scoped defaults unless explicitly overridden. */
export function getDefaultRouterFeedbackLedgerPath(): string {
	return join(getAgentDir(), "router-feedback", "ledger.jsonl");
}

export interface AppendRouterFeedbackOptions {
	/** Consent gate. Must be exactly `true`; anything else performs zero filesystem access. */
	readonly enabled: boolean;
	/** Ledger file path override (tests / callers only); defaults to the owner-only agent-dir ledger. */
	readonly ledgerPath?: string;
}

export type AppendRouterFeedbackReason =
	| "disabled"
	| "invalid-schema"
	| "symlink-refused"
	| "not-regular-file"
	| "io-error";

export type AppendRouterFeedbackResult =
	| { readonly appended: true }
	| { readonly appended: false; readonly reason: AppendRouterFeedbackReason };

/** True when `path` exists and is a symlink. Uses `lstat` so it never follows the link. */
function isSymlinkPath(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

function acquireLedgerLockSync(path: string): () => void {
	const maxAttempts = 10;
	const delayMs = 20;
	let lastError: unknown;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return lockfile.lockSync(path, { realpath: false });
		} catch (error) {
			if (errorCode(error) !== "ELOCKED" || attempt === maxAttempts) {
				throw error;
			}
			lastError = error;
			const start = Date.now();
			while (Date.now() - start < delayMs) {
				// Busy-wait briefly; mirrors the auth-storage/settings-manager sync retry pattern.
			}
		}
	}

	throw (lastError as Error) ?? new Error("Failed to acquire router-feedback ledger lock");
}

/**
 * O_NOFOLLOW is undefined on some platforms (notably Windows); `?? 0` keeps
 * the flag combination valid there, and the `lstat` pre-checks above/below
 * remain the fallback symlink guard on platforms without O_NOFOLLOW.
 */
const LEDGER_OPEN_FLAGS =
	fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0);

/**
 * Append one validated feedback record as a single JSONL line.
 *
 * Requires `options.enabled === true` (checked first, before any filesystem
 * access whatsoever — disabled or omitted consent never touches disk).
 * Validates the record against the exact ten-key schema before any I/O.
 * Refuses symlinks and non-regular files where the platform allows detecting
 * them (`O_NOFOLLOW` plus an `lstat` pre-check as defense-in-depth; `O_NOFOLLOW`
 * is unavailable on some platforms, hence "when possible"). Reuses the same
 * `proper-lockfile` dependency as settings-manager.ts/auth-storage.ts for
 * concurrent-session safety. Never throws for expected failure modes — it
 * returns a tagged result so a caller can fail closed silently.
 */
export function appendRouterFeedbackRecord(
	record: unknown,
	options: AppendRouterFeedbackOptions,
): AppendRouterFeedbackResult {
	if (options.enabled !== true) {
		return { appended: false, reason: "disabled" };
	}
	if (!isRouterFeedbackRecord(record)) {
		return { appended: false, reason: "invalid-schema" };
	}

	const ledgerPath = options.ledgerPath ?? getDefaultRouterFeedbackLedgerPath();
	const ledgerDir = dirname(ledgerPath);

	try {
		if (isSymlinkPath(ledgerDir)) {
			return { appended: false, reason: "symlink-refused" };
		}
		if (!existsSync(ledgerDir)) {
			mkdirSync(ledgerDir, { recursive: true, mode: 0o700 });
		}
		if (isSymlinkPath(ledgerPath)) {
			return { appended: false, reason: "symlink-refused" };
		}

		let release: (() => void) | undefined;
		try {
			release = acquireLedgerLockSync(ledgerPath);

			if (isSymlinkPath(ledgerPath)) {
				return { appended: false, reason: "symlink-refused" };
			}

			let fd: number;
			try {
				fd = openSync(ledgerPath, LEDGER_OPEN_FLAGS, 0o600);
			} catch (error) {
				if (errorCode(error) === "ELOOP") {
					return { appended: false, reason: "symlink-refused" };
				}
				throw error;
			}

			try {
				if (!fstatSync(fd).isFile()) {
					return { appended: false, reason: "not-regular-file" };
				}
				writeSync(fd, `${JSON.stringify(record)}\n`);
			} finally {
				closeSync(fd);
			}
			chmodSync(ledgerPath, 0o600);
			return { appended: true };
		} finally {
			if (release) release();
		}
	} catch {
		return { appended: false, reason: "io-error" };
	}
}
