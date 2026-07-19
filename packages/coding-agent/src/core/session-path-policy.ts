/**
 * Pure, browser-safe session path security policy (task I34).
 *
 * This module is deliberately dependency-free: no imports, no node:/process/
 * fs/path/Buffer, no timers, no Date.now, no Math.random, no crypto, and no I/O
 * of any kind. Every decision is derived from plain-data evidence that the
 * caller attests. The policy never touches the filesystem and never executes a
 * repair; it only authorizes, denies, or describes what a caller may do.
 *
 * Inputs are validated strictly (plain data, exact keys, accessor-free) and the
 * returned decision is a deep-frozen copy built from primitives, so a caller
 * cannot mutate the decision's internals by mutating the evidence afterwards.
 */

const SESSION_PATH_POLICY_SCHEMA_VERSION = 1 as const;
const SESSION_PATH_MAX_LENGTH = 4096;
/** Maximum number of entries accepted in an evidence chain (DoS guardrail). */
export const MAX_SESSION_PATH_CHAIN_ENTRIES = 256;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
const CANONICAL_DECIMAL_RE = /^(0|[1-9]\d{0,19})$/;
const WIN_DRIVE_ABSOLUTE_RE = /^([A-Za-z]):\/+(.*)$/;
const WIN_CANONICAL_RE = /^([a-z]):\/(.*)$/;

export type SessionPathPlatform = "posix" | "win32";
export type SessionPathIntent = "inspect_metadata" | "inspect_content" | "repair" | "repair_dry_run";
export type SessionPathLinkKind = "none" | "symlink" | "reparse";
export type SessionPathLockState = "absent" | "live" | "stale" | "foreign" | "unknown";

export type SessionPathReason =
	| "authorized"
	| "metadata_only"
	| "lexical_invalid"
	| "evidence_mismatch"
	| "target_external"
	| "target_is_root"
	| "identity_required"
	| "lock_required"
	| "symlink_in_chain"
	| "outside_realpath"
	| "nonregular"
	| "nlink_not_one"
	| "owner_mismatch"
	| "stat_race"
	| "stat_after_mismatch"
	| "lock_live"
	| "lock_foreign"
	| "lock_unknown"
	| "lock_stale_ineligible";

export type SessionPathStatus = "authorized" | "metadata_only" | "rejected" | "blocked";
export type SessionPathClassification = "root" | "inside" | "external";

export interface SessionPathIdentity {
	readonly owner: string;
}

export interface SessionPathStat {
	readonly dev: string;
	readonly ino: string;
	readonly nlink: number;
	readonly size: number;
	readonly mtime: number;
	readonly regular: boolean;
	readonly owner: string;
}

export interface SessionPathChainEntry {
	readonly lexical: string;
	readonly realpath: string;
	readonly linkKind: SessionPathLinkKind;
}

export interface SessionPathTarget {
	readonly lexical: string;
	readonly realpath: string;
}

export interface SessionPathOpened {
	readonly dev: string;
	readonly ino: string;
}

export interface SessionPathEvidence {
	readonly schemaVersion: 1;
	readonly platform: SessionPathPlatform;
	readonly trustedRootLexical: string;
	readonly trustedRootRealpath: string;
	readonly target: SessionPathTarget;
	readonly chain: readonly SessionPathChainEntry[];
	readonly statBefore: SessionPathStat;
	readonly statAfter: SessionPathStat | null;
	readonly opened: SessionPathOpened;
}

export interface SessionPathLockEvidence {
	readonly state: SessionPathLockState;
	readonly sameHost: boolean;
	readonly pidDefinitelyAbsent: boolean;
	readonly holderPid: string | null;
}

export type SessionPathPlannedAction = {
	readonly kind: "remove_stale_lock";
	readonly holderPid: string | null;
};

export interface SessionPathCapabilities {
	readonly canInspectMetadata: boolean;
	readonly canReadContents: boolean;
	readonly canRepair: boolean;
}

export interface SessionPathDecision {
	readonly schemaVersion: typeof SESSION_PATH_POLICY_SCHEMA_VERSION;
	readonly platform: SessionPathPlatform;
	readonly intent: SessionPathIntent;
	readonly status: SessionPathStatus;
	readonly reason: SessionPathReason;
	readonly dryRun: boolean;
	readonly classification: SessionPathClassification;
	readonly targetLexical: string;
	readonly targetRealpath: string;
	readonly trustedRootLexical: string;
	readonly trustedRootRealpath: string;
	readonly capabilities: SessionPathCapabilities;
	readonly plannedActions: readonly SessionPathPlannedAction[];
	readonly scheduledWrites: number;
}

export interface SessionPathAccessInput {
	readonly platform: SessionPathPlatform;
	readonly root: string;
	readonly target: string;
	readonly intent: SessionPathIntent;
	readonly identity?: SessionPathIdentity;
	readonly evidence: SessionPathEvidence;
	readonly lock?: SessionPathLockEvidence;
}

const PLATFORMS = new Set<SessionPathPlatform>(["posix", "win32"]);
const INTENTS = new Set<SessionPathIntent>(["inspect_metadata", "inspect_content", "repair", "repair_dry_run"]);
const LINK_KINDS = new Set<SessionPathLinkKind>(["none", "symlink", "reparse"]);
const LOCK_STATES = new Set<SessionPathLockState>(["absent", "live", "stale", "foreign", "unknown"]);

const WIN_RESERVED_NAMES = (() => {
	const set = new Set<string>();
	set.add("con");
	set.add("prn");
	set.add("aux");
	set.add("nul");
	for (let i = 1; i <= 9; i++) {
		set.add(`com${i}`);
		set.add(`lpt${i}`);
	}
	return set;
})();

const EVIDENCE_KEYS = [
	"schemaVersion",
	"platform",
	"trustedRootLexical",
	"trustedRootRealpath",
	"target",
	"chain",
	"statBefore",
	"statAfter",
	"opened",
] as const;
const STAT_KEYS = ["dev", "ino", "nlink", "size", "mtime", "regular", "owner"] as const;
const TARGET_KEYS = ["lexical", "realpath"] as const;
const OPENED_KEYS = ["dev", "ino"] as const;
const CHAIN_ENTRY_KEYS = ["lexical", "realpath", "linkKind"] as const;
const LOCK_KEYS = ["state", "sameHost", "pidDefinitelyAbsent", "holderPid"] as const;
const INPUT_ALLOWED_KEYS = new Set(["platform", "root", "target", "intent", "identity", "evidence", "lock"]);

// -------------------------------------------------------------------------------------------------
// Generic plain-data / exact-key / accessor-free guards.
// -------------------------------------------------------------------------------------------------

function isPlainDataObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	if (proto !== null && proto !== Object.prototype) return false;
	if (Object.getOwnPropertySymbols(value).length > 0) return false;
	for (const key of Object.keys(value)) {
		const desc = Object.getOwnPropertyDescriptor(value, key);
		if (desc === undefined || desc.get !== undefined || desc.set !== undefined || !("value" in desc)) {
			return false;
		}
	}
	return true;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const present = Object.keys(value);
	if (present.length !== keys.length) return false;
	for (const key of keys) {
		if (!Object.hasOwn(value, key)) return false;
	}
	return true;
}

function isCanonicalDecimal(value: unknown): value is string {
	return typeof value === "string" && CANONICAL_DECIMAL_RE.test(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && Number.isSafeInteger(value) && (value as number) >= 0;
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	if (Array.isArray(value)) {
		for (const item of value) deepFreeze(item);
	} else {
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	}
	return Object.freeze(value);
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
	if (!isPlainDataObject(value)) {
		throw new TypeError(`${label} must be a plain data object without accessors or a foreign prototype`);
	}
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
	if (!hasExactKeys(value, keys)) {
		throw new TypeError(`${label} must have exactly the keys: ${keys.join(", ")}`);
	}
}

function assertString(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
}

function assertBoolean(value: unknown, label: string): asserts value is boolean {
	if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
}

function assertCanonicalDecimal(value: unknown, label: string): asserts value is string {
	if (!isCanonicalDecimal(value)) {
		throw new TypeError(
			`${label} must be a canonical decimal string ("0" or a nonzero decimal without leading zeros, up to 20 digits)`,
		);
	}
}

function assertSafeNonNegInt(value: unknown, label: string): asserts value is number {
	if (!isSafeNonNegativeInteger(value)) throw new TypeError(`${label} must be a finite safe non-negative integer`);
}

/**
 * Assert a path-shaped evidence string: a string within the 4096 cap and free
 * of C0/DEL control characters. This caps every lexical/realpath evidence
 * string at validation time (fail-closed) before any canonicalization runs.
 */
function assertPathString(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
	if (value.length > SESSION_PATH_MAX_LENGTH) {
		throw new TypeError(`${label} exceeds the ${SESSION_PATH_MAX_LENGTH} character cap`);
	}
	if (CONTROL_CHAR_RE.test(value)) throw new TypeError(`${label} must not contain C0/DEL control characters`);
}

/**
 * Strictly validate a plain dense array before any indexed value access: it
 * must be a real Array whose prototype is exactly Array.prototype, carry no
 * symbol properties or extra own properties, and expose every index 0..length-1
 * as an own data descriptor (no holes, no getters/setters). Accessor indices are
 * rejected without their getters ever executing. The length is captured once.
 */
function assertStrictPlainArray(value: unknown, label: string): asserts value is unknown[] {
	if (typeof value !== "object" || value === null || !Array.isArray(value)) {
		throw new TypeError(`${label} must be an array`);
	}
	if (Object.getPrototypeOf(value) !== Array.prototype) {
		throw new TypeError(`${label} must use the Array prototype`);
	}
	if (Object.getOwnPropertySymbols(value).length > 0) {
		throw new TypeError(`${label} must not carry symbol properties`);
	}
	const length = value.length;
	for (const name of Object.getOwnPropertyNames(value)) {
		if (name === "length") continue;
		const index = Number(name);
		if (!Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== name) {
			throw new TypeError(`${label} must not carry extra own properties`);
		}
	}
	for (let i = 0; i < length; i++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
		if (descriptor === undefined) throw new TypeError(`${label} must be dense (no holes)`);
		if (descriptor.get !== undefined || descriptor.set !== undefined || !("value" in descriptor)) {
			throw new TypeError(`${label} must not expose accessor or non-data element descriptors`);
		}
	}
}

// -------------------------------------------------------------------------------------------------
// Stage 1: pure lexical canonicalizer + segment-boundary containment.
// -------------------------------------------------------------------------------------------------

function splitSegments(value: string): string[] {
	return value.split("/").filter((segment) => segment.length > 0);
}

/**
 * Canonicalize a session path lexically for the given platform without any
 * filesystem access. Returns null (fail-closed) for any disallowed form:
 * non-string, empty, longer than 4096, C0/DEL control characters, POSIX
 * non-absolute or above-root `..`, or any Win32 hazard (namespace prefixes,
 * UNC, drive-relative, non-absolute, ADS colons, trailing dot/space, reserved
 * device names, above-drive-root escape). Drive letters are lower-cased.
 */
export function canonicalizeSessionPath(raw: unknown, platform: SessionPathPlatform): string | null {
	if (typeof raw !== "string") return null;
	if (raw.length === 0 || raw.length > SESSION_PATH_MAX_LENGTH) return null;
	if (CONTROL_CHAR_RE.test(raw)) return null;
	if (platform === "posix") return canonicalizePosix(raw);
	if (platform === "win32") return canonicalizeWin32(raw);
	return null;
}

function canonicalizePosix(raw: string): string | null {
	if (raw.charCodeAt(0) !== 47 /* '/' */) return null;
	const collapsed: string[] = [];
	for (const segment of splitSegments(raw)) {
		if (segment === ".") continue;
		if (segment === "..") {
			if (collapsed.length === 0) return null;
			collapsed.pop();
			continue;
		}
		collapsed.push(segment);
	}
	return `/${collapsed.join("/")}`;
}

function canonicalizeWin32(raw: string): string | null {
	const normalized = raw.replace(/\\/g, "/");
	if (normalized.startsWith("//?/") || normalized.startsWith("//./")) return null;
	if (normalized.startsWith("//")) return null;
	const match = WIN_DRIVE_ABSOLUTE_RE.exec(normalized);
	if (match === null) return null;
	const drive = match[1].toLowerCase();
	const collapsed: string[] = [];
	for (const segment of splitSegments(match[2])) {
		if (segment === ".") continue;
		if (segment === "..") {
			if (collapsed.length === 0) return null;
			collapsed.pop();
			continue;
		}
		if (segment.includes(":")) return null;
		if (segment.endsWith(".") || segment.endsWith(" ")) return null;
		const stem = segment.split(".", 1)[0].toLowerCase();
		if (WIN_RESERVED_NAMES.has(stem)) return null;
		collapsed.push(segment);
	}
	return `${drive}:/${collapsed.join("/")}`;
}

interface CanonicalParts {
	readonly drive: string | null;
	readonly segments: readonly string[];
}

function parseCanonical(canonical: string, platform: SessionPathPlatform): CanonicalParts | null {
	if (platform === "posix") {
		if (canonical.charCodeAt(0) !== 47) return null;
		return { drive: null, segments: splitSegments(canonical) };
	}
	if (platform === "win32") {
		const match = WIN_CANONICAL_RE.exec(canonical);
		if (match === null) return null;
		return { drive: match[1], segments: splitSegments(match[2]) };
	}
	return null;
}

function segmentEqual(left: string, right: string, platform: SessionPathPlatform): boolean {
	return platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function partsContain(root: CanonicalParts, candidate: CanonicalParts, platform: SessionPathPlatform): boolean {
	if (root.drive !== candidate.drive) return false;
	if (candidate.segments.length < root.segments.length) return false;
	for (let i = 0; i < root.segments.length; i++) {
		if (!segmentEqual(root.segments[i], candidate.segments[i], platform)) return false;
	}
	return true;
}

/**
 * Canonical path equality: compares drive and every segment using platform
 * semantics (win32 case-insensitive, posix exact). Returns false if either
 * input is null or non-canonical. Unlike a raw string compare, two win32 paths
 * that differ only in segment case are equal here, so mixed-case evidence binds
 * correctly while the canonical output still preserves segment case.
 */
function canonicalPathEqual(a: string | null, b: string | null, platform: SessionPathPlatform): boolean {
	if (a === null || b === null) return false;
	const aParts = parseCanonical(a, platform);
	const bParts = parseCanonical(b, platform);
	if (aParts === null || bParts === null) return false;
	if (aParts.drive !== bParts.drive) return false;
	if (aParts.segments.length !== bParts.segments.length) return false;
	for (let i = 0; i < aParts.segments.length; i++) {
		if (!segmentEqual(aParts.segments[i], bParts.segments[i], platform)) return false;
	}
	return true;
}

/**
 * True when `candidate` is within `root` at a segment boundary (root may equal
 * candidate). Win32 compares segments case-insensitively; POSIX is exact.
 * Cross-drive and any non-canonical input return false (fail-closed).
 */
export function sessionPathContains(root: unknown, candidate: unknown, platform: SessionPathPlatform): boolean {
	const rootCanonical = canonicalizeSessionPath(root, platform);
	const candidateCanonical = canonicalizeSessionPath(candidate, platform);
	if (rootCanonical === null || candidateCanonical === null) return false;
	const rootParts = parseCanonical(rootCanonical, platform);
	const candidateParts = parseCanonical(candidateCanonical, platform);
	if (rootParts === null || candidateParts === null) return false;
	return partsContain(rootParts, candidateParts, platform);
}

function classifyTarget(
	rootCanonical: string,
	targetCanonical: string,
	platform: SessionPathPlatform,
): SessionPathClassification {
	const rootParts = parseCanonical(rootCanonical, platform);
	const targetParts = parseCanonical(targetCanonical, platform);
	if (rootParts === null || targetParts === null) return "external";
	if (!partsContain(rootParts, targetParts, platform)) return "external";
	if (rootParts.drive === targetParts.drive && rootParts.segments.length === targetParts.segments.length) {
		return "root";
	}
	return "inside";
}

// -------------------------------------------------------------------------------------------------
// Strict evidence / lock validation. Identity is normalized leniently.
// -------------------------------------------------------------------------------------------------

function validateStat(value: unknown, label: string): SessionPathStat {
	assertPlainObject(value, label);
	assertExactKeys(value, STAT_KEYS, label);
	assertCanonicalDecimal(value.dev, `${label}.dev`);
	assertCanonicalDecimal(value.ino, `${label}.ino`);
	assertSafeNonNegInt(value.nlink, `${label}.nlink`);
	assertSafeNonNegInt(value.size, `${label}.size`);
	assertSafeNonNegInt(value.mtime, `${label}.mtime`);
	assertBoolean(value.regular, `${label}.regular`);
	assertCanonicalDecimal(value.owner, `${label}.owner`);
	return {
		dev: value.dev,
		ino: value.ino,
		nlink: value.nlink,
		size: value.size,
		mtime: value.mtime,
		regular: value.regular,
		owner: value.owner,
	};
}

function validateChainEntry(value: unknown, label: string): SessionPathChainEntry {
	assertPlainObject(value, label);
	assertExactKeys(value, CHAIN_ENTRY_KEYS, label);
	assertPathString(value.lexical, `${label}.lexical`);
	assertPathString(value.realpath, `${label}.realpath`);
	if (!LINK_KINDS.has(value.linkKind as SessionPathLinkKind)) {
		throw new TypeError(`${label}.linkKind must be none|symlink|reparse`);
	}
	return { lexical: value.lexical, realpath: value.realpath, linkKind: value.linkKind as SessionPathLinkKind };
}

function validateEvidence(evidence: unknown): SessionPathEvidence {
	assertPlainObject(evidence, "evidence");
	assertExactKeys(evidence, EVIDENCE_KEYS, "evidence");
	if (evidence.schemaVersion !== 1) throw new TypeError("evidence.schemaVersion must be 1");
	if (!PLATFORMS.has(evidence.platform as SessionPathPlatform)) {
		throw new TypeError("evidence.platform must be posix|win32");
	}
	assertPathString(evidence.trustedRootLexical, "evidence.trustedRootLexical");
	assertPathString(evidence.trustedRootRealpath, "evidence.trustedRootRealpath");

	assertPlainObject(evidence.target, "evidence.target");
	assertExactKeys(evidence.target, TARGET_KEYS, "evidence.target");
	assertPathString(evidence.target.lexical, "evidence.target.lexical");
	assertPathString(evidence.target.realpath, "evidence.target.realpath");

	if (!Array.isArray(evidence.chain)) throw new TypeError("evidence.chain must be an array");
	const chainLength = evidence.chain.length;
	if (chainLength === 0) throw new TypeError("evidence.chain must be non-empty");
	if (chainLength > MAX_SESSION_PATH_CHAIN_ENTRIES) {
		throw new TypeError(`evidence.chain exceeds MAX_SESSION_PATH_CHAIN_ENTRIES (${MAX_SESSION_PATH_CHAIN_ENTRIES})`);
	}
	assertStrictPlainArray(evidence.chain, "evidence.chain");
	const chain: SessionPathChainEntry[] = [];
	for (let index = 0; index < chainLength; index++) {
		chain.push(validateChainEntry(evidence.chain[index], `evidence.chain[${index}]`));
	}

	const statBefore = validateStat(evidence.statBefore, "evidence.statBefore");
	let statAfter: SessionPathStat | null = null;
	if (evidence.statAfter !== null) {
		statAfter = validateStat(evidence.statAfter, "evidence.statAfter");
	}

	assertPlainObject(evidence.opened, "evidence.opened");
	assertExactKeys(evidence.opened, OPENED_KEYS, "evidence.opened");
	assertCanonicalDecimal(evidence.opened.dev, "evidence.opened.dev");
	assertCanonicalDecimal(evidence.opened.ino, "evidence.opened.ino");

	return {
		schemaVersion: 1,
		platform: evidence.platform as SessionPathPlatform,
		trustedRootLexical: evidence.trustedRootLexical,
		trustedRootRealpath: evidence.trustedRootRealpath,
		target: { lexical: evidence.target.lexical, realpath: evidence.target.realpath },
		chain,
		statBefore,
		statAfter,
		opened: { dev: evidence.opened.dev, ino: evidence.opened.ino },
	};
}

function validateLock(lock: unknown): SessionPathLockEvidence {
	assertPlainObject(lock, "lock");
	assertExactKeys(lock, LOCK_KEYS, "lock");
	if (!LOCK_STATES.has(lock.state as SessionPathLockState)) {
		throw new TypeError("lock.state must be absent|live|stale|foreign|unknown");
	}
	assertBoolean(lock.sameHost, "lock.sameHost");
	assertBoolean(lock.pidDefinitelyAbsent, "lock.pidDefinitelyAbsent");
	if (lock.holderPid !== null) {
		assertCanonicalDecimal(lock.holderPid, "lock.holderPid");
	}
	return {
		state: lock.state as SessionPathLockState,
		sameHost: lock.sameHost,
		pidDefinitelyAbsent: lock.pidDefinitelyAbsent,
		holderPid: lock.holderPid === null ? null : lock.holderPid,
	};
}

/**
 * Identity is normalized leniently: a missing or structurally incomplete
 * identity yields undefined, which the policy treats as "not provided". This
 * matches the requirement that missing/incomplete identity *blocks* privileged
 * intents rather than throwing.
 */
function normalizeIdentity(value: unknown): SessionPathIdentity | undefined {
	if (!isPlainDataObject(value)) return undefined;
	if (!hasExactKeys(value, ["owner"])) return undefined;
	if (!isCanonicalDecimal(value.owner)) return undefined;
	return { owner: value.owner };
}

function validateInput(rawInput: unknown): SessionPathAccessInput {
	assertPlainObject(rawInput, "input");
	for (const key of Object.keys(rawInput)) {
		if (!INPUT_ALLOWED_KEYS.has(key)) throw new TypeError(`input has an unknown key: ${key}`);
	}
	if (!PLATFORMS.has(rawInput.platform as SessionPathPlatform)) {
		throw new TypeError("input.platform must be posix|win32");
	}
	assertString(rawInput.root, "input.root");
	assertString(rawInput.target, "input.target");
	if (!INTENTS.has(rawInput.intent as SessionPathIntent)) {
		throw new TypeError("input.intent must be inspect_metadata|inspect_content|repair|repair_dry_run");
	}
	if (!Object.hasOwn(rawInput, "evidence")) {
		throw new TypeError("input.evidence is required");
	}
	const evidence = validateEvidence(rawInput.evidence);
	let identity: SessionPathIdentity | undefined;
	if (Object.hasOwn(rawInput, "identity") && rawInput.identity !== undefined) {
		identity = normalizeIdentity(rawInput.identity);
	}
	let lock: SessionPathLockEvidence | undefined;
	if (Object.hasOwn(rawInput, "lock") && rawInput.lock !== undefined) {
		lock = validateLock(rawInput.lock);
	}
	return {
		platform: rawInput.platform as SessionPathPlatform,
		root: rawInput.root,
		target: rawInput.target,
		intent: rawInput.intent as SessionPathIntent,
		identity,
		evidence,
		lock,
	};
}

// -------------------------------------------------------------------------------------------------
// Decision assembly.
// -------------------------------------------------------------------------------------------------

function statEqual(a: SessionPathStat, b: SessionPathStat): boolean {
	return (
		a.dev === b.dev &&
		a.ino === b.ino &&
		a.nlink === b.nlink &&
		a.size === b.size &&
		a.mtime === b.mtime &&
		a.regular === b.regular &&
		a.owner === b.owner
	);
}

function buildDecision(fields: {
	platform: SessionPathPlatform;
	intent: SessionPathIntent;
	status: SessionPathStatus;
	reason: SessionPathReason;
	classification: SessionPathClassification;
	evidence: SessionPathEvidence;
	canInspectMetadata: boolean;
	canReadContents: boolean;
	canRepair: boolean;
	plannedActions: readonly SessionPathPlannedAction[];
	scheduledWrites: number;
}): SessionPathDecision {
	const decision: SessionPathDecision = {
		schemaVersion: SESSION_PATH_POLICY_SCHEMA_VERSION,
		platform: fields.platform,
		intent: fields.intent,
		status: fields.status,
		reason: fields.reason,
		dryRun: fields.intent === "repair_dry_run",
		classification: fields.classification,
		targetLexical: fields.evidence.target.lexical,
		targetRealpath: fields.evidence.target.realpath,
		trustedRootLexical: fields.evidence.trustedRootLexical,
		trustedRootRealpath: fields.evidence.trustedRootRealpath,
		capabilities: {
			canInspectMetadata: fields.canInspectMetadata,
			canReadContents: fields.canReadContents,
			canRepair: fields.canRepair,
		},
		plannedActions: fields.plannedActions.map((action) => ({ kind: action.kind, holderPid: action.holderPid })),
		scheduledWrites: fields.scheduledWrites,
	};
	return deepFreeze(decision);
}

function rejected(
	platform: SessionPathPlatform,
	intent: SessionPathIntent,
	reason: SessionPathReason,
	evidence: SessionPathEvidence,
	classification: SessionPathClassification = "external",
): SessionPathDecision {
	return buildDecision({
		platform,
		intent,
		status: "rejected",
		reason,
		classification,
		evidence,
		canInspectMetadata: false,
		canReadContents: false,
		canRepair: false,
		plannedActions: [],
		scheduledWrites: 0,
	});
}

function blocked(
	platform: SessionPathPlatform,
	intent: SessionPathIntent,
	reason: SessionPathReason,
	evidence: SessionPathEvidence,
	classification: SessionPathClassification,
): SessionPathDecision {
	return buildDecision({
		platform,
		intent,
		status: "blocked",
		reason,
		classification,
		evidence,
		canInspectMetadata: false,
		canReadContents: false,
		canRepair: false,
		plannedActions: [],
		scheduledWrites: 0,
	});
}

function metadataOnly(
	platform: SessionPathPlatform,
	intent: SessionPathIntent,
	evidence: SessionPathEvidence,
	classification: SessionPathClassification,
): SessionPathDecision {
	return buildDecision({
		platform,
		intent,
		status: "metadata_only",
		reason: "metadata_only",
		classification,
		evidence,
		canInspectMetadata: true,
		canReadContents: false,
		canRepair: false,
		plannedActions: [],
		scheduledWrites: 0,
	});
}

function authorized(
	platform: SessionPathPlatform,
	intent: SessionPathIntent,
	evidence: SessionPathEvidence,
	classification: SessionPathClassification,
	canReadContents: boolean,
	canRepair: boolean,
	plannedActions: readonly SessionPathPlannedAction[],
	scheduledWrites: number,
): SessionPathDecision {
	return buildDecision({
		platform,
		intent,
		status: "authorized",
		reason: "authorized",
		classification,
		evidence,
		canInspectMetadata: true,
		canReadContents,
		canRepair,
		plannedActions,
		scheduledWrites,
	});
}

/**
 * True when `childCanonical` is exactly one segment deeper than
 * `parentCanonical` and shares its entire prefix (a direct child at a segment
 * boundary). Win32 compares segments case-insensitively.
 */
function isDirectChild(parentCanonical: string, childCanonical: string, platform: SessionPathPlatform): boolean {
	const parentParts = parseCanonical(parentCanonical, platform);
	const childParts = parseCanonical(childCanonical, platform);
	if (parentParts === null || childParts === null) return false;
	if (parentParts.drive !== childParts.drive) return false;
	if (childParts.segments.length !== parentParts.segments.length + 1) return false;
	for (let i = 0; i < parentParts.segments.length; i++) {
		if (!segmentEqual(parentParts.segments[i], childParts.segments[i], platform)) return false;
	}
	return true;
}

/**
 * Strict chain binding (P3). The configured root is conservative (no symlinks),
 * so its lexical and real canonical forms must be identical. The chain must
 * start at the roots, end at the target lexical/real, have exactly the lexical
 * depth-delta plus one entries, and every adjacent lexical path and realpath
 * must be a direct child at a segment boundary. Every entry's lexical path must
 * stay inside the lexical root and every realpath inside the real root. Any
 * linkKind other than "none" blocks. Returns the first closed reason, or null
 * when the chain is fully bound.
 */
function bindChain(
	evidence: SessionPathEvidence,
	rootCanonical: string,
	rootRealpathCanonical: string,
	targetCanonical: string,
	targetRealpathCanonical: string,
	platform: SessionPathPlatform,
): SessionPathReason | null {
	if (!canonicalPathEqual(rootCanonical, rootRealpathCanonical, platform)) return "evidence_mismatch";

	const rootParts = parseCanonical(rootCanonical, platform);
	const targetLexicalParts = parseCanonical(targetCanonical, platform);
	if (rootParts === null || targetLexicalParts === null) return "evidence_mismatch";

	const expectedLength = targetLexicalParts.segments.length - rootParts.segments.length + 1;
	if (evidence.chain.length !== expectedLength) return "evidence_mismatch";

	const firstLexical = canonicalizeSessionPath(evidence.chain[0].lexical, platform);
	const firstReal = canonicalizeSessionPath(evidence.chain[0].realpath, platform);
	if (firstLexical === null || firstReal === null) return "evidence_mismatch";
	if (
		!canonicalPathEqual(firstLexical, rootCanonical, platform) ||
		!canonicalPathEqual(firstReal, rootRealpathCanonical, platform)
	)
		return "evidence_mismatch";

	const last = evidence.chain[evidence.chain.length - 1];
	const lastLexical = canonicalizeSessionPath(last.lexical, platform);
	const lastReal = canonicalizeSessionPath(last.realpath, platform);
	if (
		!canonicalPathEqual(lastLexical, targetCanonical, platform) ||
		!canonicalPathEqual(lastReal, targetRealpathCanonical, platform)
	)
		return "evidence_mismatch";

	let prevLexical = firstLexical;
	let prevReal = firstReal;
	for (let index = 0; index < evidence.chain.length; index++) {
		const entry = evidence.chain[index];
		if (entry.linkKind !== "none") return "symlink_in_chain";
		const entryLexical = canonicalizeSessionPath(entry.lexical, platform);
		const entryReal = canonicalizeSessionPath(entry.realpath, platform);
		if (entryLexical === null || entryReal === null) return "evidence_mismatch";
		const entryLexicalParts = parseCanonical(entryLexical, platform);
		const entryRealParts = parseCanonical(entryReal, platform);
		if (entryLexicalParts === null || entryRealParts === null) return "evidence_mismatch";
		if (!partsContain(rootParts, entryLexicalParts, platform)) return "evidence_mismatch";
		if (!partsContain(rootParts, entryRealParts, platform)) return "outside_realpath";
		if (index > 0) {
			if (!isDirectChild(prevLexical, entryLexical, platform)) return "evidence_mismatch";
			if (!isDirectChild(prevReal, entryReal, platform)) return "evidence_mismatch";
		}
		prevLexical = entryLexical;
		prevReal = entryReal;
	}
	return null;
}

/**
 * Lock coherence, fail-closed (P5). Each state is only meaningful with the
 * field values that justify it; a self-contradictory lock is treated as
 * untrustworthy and closed. `absent` and an eligible `stale` return null
 * (proceed); every other state (including any contradiction) returns a closed
 * reason rather than throwing.
 */
function evaluateLock(lock: SessionPathLockEvidence): SessionPathReason | null {
	switch (lock.state) {
		case "absent":
			return lock.holderPid === null && lock.pidDefinitelyAbsent ? null : "lock_unknown";
		case "live":
			return lock.sameHost && lock.holderPid !== null && !lock.pidDefinitelyAbsent ? "lock_live" : "lock_unknown";
		case "foreign":
			return !lock.sameHost ? "lock_foreign" : "lock_unknown";
		case "stale":
			return lock.sameHost && lock.holderPid !== null && lock.pidDefinitelyAbsent ? null : "lock_stale_ineligible";
		case "unknown":
			return "lock_unknown";
		default:
			return "lock_unknown";
	}
}

function plannedActionsForLock(lock: SessionPathLockEvidence): SessionPathPlannedAction[] {
	if (lock.state === "stale" && lock.holderPid !== null) {
		return [{ kind: "remove_stale_lock", holderPid: lock.holderPid }];
	}
	return [];
}

/**
 * Decide session path access from attested plain-data evidence. Pure: never
 * performs I/O and never executes a repair. The returned decision is a
 * deep-frozen copy.
 *
 * Classification precedence (P0): the lexical classification of the request
 * root/target is computed first and is authoritative for privileged intents.
 * `inspect_metadata` always resolves to metadata_only after lexical/evidence
 * binding. For `inspect_content`/`repair`/`repair_dry_run` the lexical target
 * must be strictly inside the root (external => target_external, root =>
 * target_is_root) before identity, and the realpath classification must
 * independently be inside; an injected realpath can never upgrade an external
 * lexical target. `repair_dry_run` shares repair's eligibility, status, reason,
 * and planned actions, but reports canRepair=false and zero scheduled writes.
 */
export function decideSessionPathAccess(rawInput: unknown): SessionPathDecision {
	const { platform, root, target, intent, identity, evidence, lock } = validateInput(rawInput);

	const rootCanonical = canonicalizeSessionPath(root, platform);
	const targetCanonical = canonicalizeSessionPath(target, platform);
	if (rootCanonical === null || targetCanonical === null) {
		return rejected(platform, intent, "lexical_invalid", evidence);
	}

	if (evidence.platform !== platform) {
		return blocked(platform, intent, "evidence_mismatch", evidence, "external");
	}
	const evidenceRootCanonical = canonicalizeSessionPath(evidence.trustedRootLexical, platform);
	const evidenceTargetCanonical = canonicalizeSessionPath(evidence.target.lexical, platform);
	const rootRealpathCanonical = canonicalizeSessionPath(evidence.trustedRootRealpath, platform);
	const targetRealpathCanonical = canonicalizeSessionPath(evidence.target.realpath, platform);
	if (
		!canonicalPathEqual(evidenceRootCanonical, rootCanonical, platform) ||
		!canonicalPathEqual(evidenceTargetCanonical, targetCanonical, platform) ||
		rootRealpathCanonical === null ||
		targetRealpathCanonical === null
	) {
		return blocked(platform, intent, "evidence_mismatch", evidence, "external");
	}

	const lexicalClassification = classifyTarget(rootCanonical, targetCanonical, platform);
	const isDryRun = intent === "repair_dry_run";
	const privilegedIntent: SessionPathIntent = isDryRun ? "repair" : intent;

	if (privilegedIntent === "inspect_metadata") {
		return metadataOnly(platform, intent, evidence, lexicalClassification);
	}

	// inspect_content, repair, repair_dry_run: lexical classification is primary (P0).
	if (lexicalClassification === "external") {
		return rejected(platform, intent, "target_external", evidence, "external");
	}
	if (lexicalClassification === "root") {
		return rejected(platform, intent, "target_is_root", evidence, "root");
	}

	// P0: independently require the realpath classification to be strictly inside;
	// an injected realpath can never upgrade an inside lexical target.
	const realClassification = classifyTarget(rootRealpathCanonical, targetRealpathCanonical, platform);
	if (realClassification !== "inside") {
		return blocked(platform, intent, "outside_realpath", evidence, "inside");
	}

	if (identity === undefined) {
		return blocked(platform, intent, "identity_required", evidence, "inside");
	}
	if (lock === undefined) {
		return blocked(platform, intent, "lock_required", evidence, "inside");
	}

	const chainReason = bindChain(
		evidence,
		rootCanonical,
		rootRealpathCanonical,
		targetCanonical,
		targetRealpathCanonical,
		platform,
	);
	if (chainReason !== null) {
		return blocked(platform, intent, chainReason, evidence, "inside");
	}
	if (!evidence.statBefore.regular) {
		return blocked(platform, intent, "nonregular", evidence, "inside");
	}
	if (evidence.statBefore.nlink !== 1) {
		return blocked(platform, intent, "nlink_not_one", evidence, "inside");
	}
	if (identity.owner !== evidence.statBefore.owner) {
		return blocked(platform, intent, "owner_mismatch", evidence, "inside");
	}
	if (evidence.opened.dev !== evidence.statBefore.dev || evidence.opened.ino !== evidence.statBefore.ino) {
		return blocked(platform, intent, "stat_race", evidence, "inside");
	}
	if (evidence.statAfter === null || !statEqual(evidence.statBefore, evidence.statAfter)) {
		return blocked(platform, intent, "stat_after_mismatch", evidence, "inside");
	}

	const lockBlock = evaluateLock(lock);
	if (lockBlock !== null) {
		return blocked(platform, intent, lockBlock, evidence, "inside");
	}

	if (privilegedIntent === "inspect_content") {
		return authorized(platform, intent, evidence, "inside", true, false, [], 0);
	}

	const plannedActions = plannedActionsForLock(lock);
	const scheduledWrites = isDryRun ? 0 : plannedActions.length;
	return authorized(platform, intent, evidence, "inside", false, !isDryRun, plannedActions, scheduledWrites);
}
