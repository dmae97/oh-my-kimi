/**
 * Browser-safe, pure context-cache invalidation snapshot helper.
 *
 * Every public function is side-effect free and depends only on
 * platform-agnostic primitives. Returned snapshots are always
 * independently deep-frozen copies of the caller-supplied data, so
 * callers cannot mutate cached state through retained references.
 *
 * Snapshots are cache-key material for invalidation tracking, not an
 * authorization or authentication primitive.
 *
 * Schema: context-cache-invalidation-v1.
 */

export const CONTEXT_CACHE_INVALIDATION_SCHEMA_VERSION = "context-cache-invalidation-v1" as const;
export const CONTEXT_CACHE_INVALIDATION_SAFE_ID_MAX_LENGTH = 256;

/** Event counters tracked by an invalidation snapshot. */
export interface ContextCacheInvalidationCounters {
	readonly transcriptRepair: number;
	readonly toolResultDisposition: number;
	readonly evidenceReceipt: number;
	readonly userSteering: number;
	readonly settings: number;
}

/** Immutable schema-v1 invalidation snapshot. */
export interface ContextCacheInvalidationSnapshot {
	readonly schemaVersion: typeof CONTEXT_CACHE_INVALIDATION_SCHEMA_VERSION;
	readonly forkId: string;
	readonly globalEpoch: number;
	readonly counters: ContextCacheInvalidationCounters;
	readonly worktreeFingerprint: string;
	readonly activeModelId: string;
	readonly compactionModelId: string;
}

/** Constructor input for a fresh snapshot. Counters and epoch default to 0. */
export interface ContextCacheInvalidationSnapshotInit {
	readonly forkId: string;
	readonly worktreeFingerprint: string;
	readonly activeModelId: string;
	readonly compactionModelId: string;
	readonly globalEpoch?: number;
	readonly transcriptRepair?: number;
	readonly toolResultDisposition?: number;
	readonly evidenceReceipt?: number;
	readonly userSteering?: number;
	readonly settings?: number;
}

/**
 * Strict union covering all eight invalidation events. The five counter
 * events increment their counter; the three identity events set a value.
 */
export type ContextCacheInvalidationEvent =
	| { readonly type: "transcriptRepair" }
	| { readonly type: "toolResultDisposition" }
	| { readonly type: "evidenceReceipt" }
	| { readonly type: "userSteering" }
	| { readonly type: "settings" }
	| { readonly type: "worktreeFingerprint"; readonly value: string }
	| { readonly type: "activeModelId"; readonly value: string }
	| { readonly type: "compactionModelId"; readonly value: string };

export type ContextCacheInvalidationStatus = "applied" | "unchanged" | "overflow";

export interface ContextCacheInvalidationResult {
	readonly status: ContextCacheInvalidationStatus;
	readonly snapshot: ContextCacheInvalidationSnapshot;
}

export type ContextCacheMergeStatus = "equal" | "dominant" | "divergent";

export type ContextCacheMergeResult =
	| { readonly status: "equal"; readonly snapshot: ContextCacheInvalidationSnapshot }
	| { readonly status: "dominant"; readonly snapshot: ContextCacheInvalidationSnapshot }
	| {
			readonly status: "divergent";
			readonly left: ContextCacheInvalidationSnapshot;
			readonly right: ContextCacheInvalidationSnapshot;
	  };

type CounterKey = "transcriptRepair" | "toolResultDisposition" | "evidenceReceipt" | "userSteering" | "settings";

type IdentityKey = "worktreeFingerprint" | "activeModelId" | "compactionModelId";

const MAX_REPRESENTABLE = Number.MAX_SAFE_INTEGER;
const SAFE_ID_PATTERN = /^[\w.\-:+]+$/u;

/**
 * High-confidence credential markers, checked in addition to the
 * safe-character gate. A value already consists only of safe characters
 * before it is tested here. Each pattern is anchored to the whole string
 * to keep the false-positive rate low; identifiers and fingerprints in
 * this domain never legitimately take these shapes.
 */
const CREDENTIAL_MARKERS: ReadonlyArray<RegExp> = [
	/^sk-[A-Za-z0-9_-]{8,}$/i, // OpenAI / generic "sk-" secret keys
	/^gh[pousr]_[A-Za-z0-9]{16,}$/i, // GitHub classic tokens (ghp_ gho_ ghu_ ghs_ ghr_)
	/^github_pat_[A-Za-z0-9_]{20,}$/i, // GitHub fine-grained PATs
	/^xox[pabrse]-[A-Za-z0-9-]{10,}$/i, // Slack tokens (xoxp xoxb xoxa xoxs xoxr xoxe)
	/^AKIA[0-9A-Z]{16}$/, // AWS access key id (20 chars, uppercase)
	/^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/, // JWT (three base64url segments)
	/^bearer$/i, // literal Bearer token marker
];

function looksLikeCredential(value: string): boolean {
	for (const marker of CREDENTIAL_MARKERS) {
		if (marker.test(value)) return true;
	}
	return false;
}

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
	"schemaVersion",
	"forkId",
	"globalEpoch",
	"counters",
	"worktreeFingerprint",
	"activeModelId",
	"compactionModelId",
]);

const COUNTER_KEYS: ReadonlySet<string> = new Set([
	"transcriptRepair",
	"toolResultDisposition",
	"evidenceReceipt",
	"userSteering",
	"settings",
]);

function fail(reason: string): never {
	throw new Error(`context-cache-invalidation: ${reason}`);
}

function assertSafeId(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string") fail(`${field} must be a string`);
	if (value.length === 0) fail(`${field} must not be empty`);
	if (value.length > CONTEXT_CACHE_INVALIDATION_SAFE_ID_MAX_LENGTH) {
		fail(`${field} exceeds ${CONTEXT_CACHE_INVALIDATION_SAFE_ID_MAX_LENGTH} characters`);
	}
	if (!SAFE_ID_PATTERN.test(value)) fail(`${field} contains unsafe characters`);
	if (looksLikeCredential(value)) fail(`${field} looks like a credential and was rejected`);
}

function assertNonNegativeSafeInt(value: unknown, field: string): asserts value is number {
	if (typeof value !== "number") fail(`${field} must be a number`);
	if (!Number.isFinite(value)) fail(`${field} must be finite`);
	if (!Number.isInteger(value)) fail(`${field} must be an integer`);
	if (value < 0) fail(`${field} must be nonnegative`);
	if (!Number.isSafeInteger(value)) fail(`${field} must be a safe integer`);
}

function assertExactKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, scope: string): void {
	const keys = Object.keys(record);
	if (keys.length !== allowed.size) fail(`${scope} has unexpected keys`);
	for (const key of keys) {
		if (!allowed.has(key)) fail(`${scope} has unknown key "${key}"`);
	}
}

/** Reject non-plain inputs: null, arrays, primitives, and class instances. */
function assertPlainObject(value: unknown, scope: string): asserts value is Record<string, unknown> {
	if (value === null || typeof value !== "object") fail(`${scope} must be a plain object`);
	if (Array.isArray(value)) fail(`${scope} must be a plain object`);
	const proto = Object.getPrototypeOf(value);
	if (proto !== null && proto !== Object.prototype) fail(`${scope} must be a plain object`);
}

/** Reject getter/setter accessors, whose reads are not stable. */
function assertNoAccessors(record: object, scope: string): void {
	for (const key of Object.getOwnPropertyNames(record)) {
		const desc = Object.getOwnPropertyDescriptor(record, key);
		if (desc !== undefined && (typeof desc.get === "function" || typeof desc.set === "function")) {
			fail(`${scope} must not define accessors`);
		}
	}
}

const INIT_REQUIRED_KEYS: ReadonlySet<string> = new Set([
	"forkId",
	"worktreeFingerprint",
	"activeModelId",
	"compactionModelId",
]);

const INIT_OPTIONAL_KEYS: ReadonlySet<string> = new Set([
	"globalEpoch",
	"transcriptRepair",
	"toolResultDisposition",
	"evidenceReceipt",
	"userSteering",
	"settings",
]);

const INIT_ALLOWED_KEYS: ReadonlySet<string> = new Set([...INIT_REQUIRED_KEYS, ...INIT_OPTIONAL_KEYS]);

/**
 * Strictly validate a snapshot constructor input: a plain data object with
 * exactly the required identity/fork keys plus optional counters/epoch, and
 * no accessor properties. Rejects null, arrays, class instances, unknown
 * keys, and getters/setters with a stable error.
 */
function assertInitShape(input: unknown): asserts input is ContextCacheInvalidationSnapshotInit {
	assertPlainObject(input, "init");
	assertNoAccessors(input, "init");
	for (const key of Object.keys(input)) {
		if (!INIT_ALLOWED_KEYS.has(key)) fail(`init has unknown key "${key}"`);
	}
	for (const required of INIT_REQUIRED_KEYS) {
		if (!Object.hasOwn(input, required)) {
			fail(`init is missing required key "${required}"`);
		}
	}
}

const COUNTER_EVENT_TYPES: ReadonlySet<string> = new Set([
	"transcriptRepair",
	"toolResultDisposition",
	"evidenceReceipt",
	"userSteering",
	"settings",
]);

const IDENTITY_EVENT_TYPES: ReadonlySet<string> = new Set([
	"worktreeFingerprint",
	"activeModelId",
	"compactionModelId",
]);

const COUNTER_EVENT_KEYS: ReadonlySet<string> = new Set(["type"]);
const IDENTITY_EVENT_KEYS: ReadonlySet<string> = new Set(["type", "value"]);

/**
 * Strictly validate a runtime invalidation event before dispatch. The event
 * must be a plain data object carrying exactly the keys its discriminant
 * allows (counter events: `{ type }`; identity events: `{ type, value }`),
 * a known `type` string, and (for identity events) a safe value. Forged or
 * malformed events always throw here and can never fall through to an
 * undefined result.
 */
function validateEvent(input: unknown): asserts input is ContextCacheInvalidationEvent {
	assertPlainObject(input, "event");
	assertNoAccessors(input, "event");
	const type = input.type;
	if (type === undefined) fail("event is missing type");
	if (typeof type !== "string") fail("event type must be a string");
	if (COUNTER_EVENT_TYPES.has(type)) {
		assertExactKeys(input, COUNTER_EVENT_KEYS, "event");
		return;
	}
	if (IDENTITY_EVENT_TYPES.has(type)) {
		assertExactKeys(input, IDENTITY_EVENT_KEYS, "event");
		assertSafeId(input.value, type);
		return;
	}
	fail(`event type "${type}" is unknown`);
}

/**
 * Strictly validate that {@link input} is a structurally correct snapshot.
 * Rejects extra keys, missing keys, malformed counters, unsafe integers,
 * and control/credential-unsafe identifier strings. Does not require the
 * object to be frozen.
 */
export function validateContextCacheInvalidationSnapshot(
	input: unknown,
): asserts input is ContextCacheInvalidationSnapshot {
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		fail("snapshot must be a plain object");
	}
	const obj = input as Record<string, unknown>;
	assertExactKeys(obj, TOP_LEVEL_KEYS, "snapshot");
	if (obj.schemaVersion !== CONTEXT_CACHE_INVALIDATION_SCHEMA_VERSION) {
		fail(`schemaVersion must be ${CONTEXT_CACHE_INVALIDATION_SCHEMA_VERSION}`);
	}
	assertSafeId(obj.forkId, "forkId");
	assertNonNegativeSafeInt(obj.globalEpoch, "globalEpoch");
	if (obj.counters === null || typeof obj.counters !== "object" || Array.isArray(obj.counters)) {
		fail("counters must be a plain object");
	}
	const counters = obj.counters as Record<string, unknown>;
	assertExactKeys(counters, COUNTER_KEYS, "counters");
	assertNonNegativeSafeInt(counters.transcriptRepair, "counters.transcriptRepair");
	assertNonNegativeSafeInt(counters.toolResultDisposition, "counters.toolResultDisposition");
	assertNonNegativeSafeInt(counters.evidenceReceipt, "counters.evidenceReceipt");
	assertNonNegativeSafeInt(counters.userSteering, "counters.userSteering");
	assertNonNegativeSafeInt(counters.settings, "counters.settings");
	assertSafeId(obj.worktreeFingerprint, "worktreeFingerprint");
	assertSafeId(obj.activeModelId, "activeModelId");
	assertSafeId(obj.compactionModelId, "compactionModelId");
}

/** Non-throwing variant of {@link validateContextCacheInvalidationSnapshot}. */
export function isContextCacheInvalidationSnapshot(input: unknown): input is ContextCacheInvalidationSnapshot {
	try {
		validateContextCacheInvalidationSnapshot(input);
		return true;
	} catch {
		return false;
	}
}

interface SnapshotBuilder {
	schemaVersion: typeof CONTEXT_CACHE_INVALIDATION_SCHEMA_VERSION;
	forkId: string;
	globalEpoch: number;
	counters: ContextCacheInvalidationCounters;
	worktreeFingerprint: string;
	activeModelId: string;
	compactionModelId: string;
}

function freezeSnapshot(builder: SnapshotBuilder): ContextCacheInvalidationSnapshot {
	Object.freeze(builder.counters);
	return Object.freeze(builder) as ContextCacheInvalidationSnapshot;
}

function copyCounters(counters: ContextCacheInvalidationCounters): Record<CounterKey, number> {
	return {
		transcriptRepair: counters.transcriptRepair,
		toolResultDisposition: counters.toolResultDisposition,
		evidenceReceipt: counters.evidenceReceipt,
		userSteering: counters.userSteering,
		settings: counters.settings,
	};
}

function cloneAndFreeze(snapshot: ContextCacheInvalidationSnapshot): ContextCacheInvalidationSnapshot {
	return freezeSnapshot({
		schemaVersion: snapshot.schemaVersion,
		forkId: snapshot.forkId,
		globalEpoch: snapshot.globalEpoch,
		counters: copyCounters(snapshot.counters),
		worktreeFingerprint: snapshot.worktreeFingerprint,
		activeModelId: snapshot.activeModelId,
		compactionModelId: snapshot.compactionModelId,
	});
}

function resolveOptionalCounter(value: number | undefined, field: string): number {
	if (value === undefined) return 0;
	assertNonNegativeSafeInt(value, field);
	return value;
}

/** Build a validated, deep-frozen initial snapshot. */
export function createContextCacheInvalidationSnapshot(
	init: ContextCacheInvalidationSnapshotInit,
): ContextCacheInvalidationSnapshot {
	assertInitShape(init);
	assertSafeId(init.forkId, "forkId");
	assertSafeId(init.worktreeFingerprint, "worktreeFingerprint");
	assertSafeId(init.activeModelId, "activeModelId");
	assertSafeId(init.compactionModelId, "compactionModelId");
	const globalEpoch = init.globalEpoch ?? 0;
	assertNonNegativeSafeInt(globalEpoch, "globalEpoch");
	return freezeSnapshot({
		schemaVersion: CONTEXT_CACHE_INVALIDATION_SCHEMA_VERSION,
		forkId: init.forkId,
		globalEpoch,
		counters: {
			transcriptRepair: resolveOptionalCounter(init.transcriptRepair, "transcriptRepair"),
			toolResultDisposition: resolveOptionalCounter(init.toolResultDisposition, "toolResultDisposition"),
			evidenceReceipt: resolveOptionalCounter(init.evidenceReceipt, "evidenceReceipt"),
			userSteering: resolveOptionalCounter(init.userSteering, "userSteering"),
			settings: resolveOptionalCounter(init.settings, "settings"),
		},
		worktreeFingerprint: init.worktreeFingerprint,
		activeModelId: init.activeModelId,
		compactionModelId: init.compactionModelId,
	});
}

function applyCounterEvent(current: ContextCacheInvalidationSnapshot, key: CounterKey): ContextCacheInvalidationResult {
	const value = current.counters[key];
	if (value >= MAX_REPRESENTABLE || current.globalEpoch >= MAX_REPRESENTABLE) {
		return Object.freeze({ status: "overflow", snapshot: cloneAndFreeze(current) } as const);
	}
	const nextCounters = copyCounters(current.counters);
	nextCounters[key] = value + 1;
	return Object.freeze({
		status: "applied",
		snapshot: freezeSnapshot({
			schemaVersion: current.schemaVersion,
			forkId: current.forkId,
			globalEpoch: current.globalEpoch + 1,
			counters: nextCounters,
			worktreeFingerprint: current.worktreeFingerprint,
			activeModelId: current.activeModelId,
			compactionModelId: current.compactionModelId,
		}),
	} as const);
}

function applyIdentityEvent(
	current: ContextCacheInvalidationSnapshot,
	key: IdentityKey,
	value: string,
): ContextCacheInvalidationResult {
	assertSafeId(value, key);
	if (current[key] === value) {
		return Object.freeze({ status: "unchanged", snapshot: cloneAndFreeze(current) } as const);
	}
	if (current.globalEpoch >= MAX_REPRESENTABLE) {
		return Object.freeze({ status: "overflow", snapshot: cloneAndFreeze(current) } as const);
	}
	return Object.freeze({
		status: "applied",
		snapshot: freezeSnapshot({
			schemaVersion: current.schemaVersion,
			forkId: current.forkId,
			globalEpoch: current.globalEpoch + 1,
			counters: copyCounters(current.counters),
			worktreeFingerprint: key === "worktreeFingerprint" ? value : current.worktreeFingerprint,
			activeModelId: key === "activeModelId" ? value : current.activeModelId,
			compactionModelId: key === "compactionModelId" ? value : current.compactionModelId,
		}),
	} as const);
}

/**
 * Apply a single invalidation event. Increments the global epoch and the
 * relevant counter, or sets an identity. A same-value identity set is a
 * no-op and returns {@link ContextCacheInvalidationStatus.unchanged} without
 * an epoch bump. Any counter or epoch overflow returns
 * {@link ContextCacheInvalidationStatus.overflow} with the snapshot unchanged
 * and never wraps.
 */
export function applyContextCacheInvalidation(
	current: ContextCacheInvalidationSnapshot,
	event: ContextCacheInvalidationEvent,
): ContextCacheInvalidationResult {
	validateContextCacheInvalidationSnapshot(current);
	validateEvent(event);
	switch (event.type) {
		case "transcriptRepair":
		case "toolResultDisposition":
		case "evidenceReceipt":
		case "userSteering":
		case "settings":
			return applyCounterEvent(current, event.type);
		case "worktreeFingerprint":
		case "activeModelId":
		case "compactionModelId":
			return applyIdentityEvent(current, event.type, event.value);
		default: {
			// Exhaustiveness guard: a new event variant without a matching
			// case becomes a compile error on the assignment below.
			const _exhaustive: never = event;
			fail(`unhandled event type ${_exhaustive}`);
		}
	}
}

/**
 * Fork a snapshot: keep all event counters and identity values, change the
 * fork id, and reset the global epoch to 0. The caller supplies the new fork
 * id. Rejects an id equal to the current fork id.
 */
export function forkContextCacheSnapshot(
	current: ContextCacheInvalidationSnapshot,
	nextForkId: string,
): ContextCacheInvalidationSnapshot {
	validateContextCacheInvalidationSnapshot(current);
	assertSafeId(nextForkId, "forkId");
	if (nextForkId === current.forkId) {
		fail("forkId must differ from current fork");
	}
	return freezeSnapshot({
		schemaVersion: current.schemaVersion,
		forkId: nextForkId,
		globalEpoch: 0,
		counters: copyCounters(current.counters),
		worktreeFingerprint: current.worktreeFingerprint,
		activeModelId: current.activeModelId,
		compactionModelId: current.compactionModelId,
	});
}

function snapshotsEqual(a: ContextCacheInvalidationSnapshot, b: ContextCacheInvalidationSnapshot): boolean {
	return (
		a.globalEpoch === b.globalEpoch &&
		a.counters.transcriptRepair === b.counters.transcriptRepair &&
		a.counters.toolResultDisposition === b.counters.toolResultDisposition &&
		a.counters.evidenceReceipt === b.counters.evidenceReceipt &&
		a.counters.userSteering === b.counters.userSteering &&
		a.counters.settings === b.counters.settings &&
		a.worktreeFingerprint === b.worktreeFingerprint &&
		a.activeModelId === b.activeModelId &&
		a.compactionModelId === b.compactionModelId
	);
}

function dominates(x: ContextCacheInvalidationSnapshot, y: ContextCacheInvalidationSnapshot): boolean {
	return (
		x.globalEpoch >= y.globalEpoch &&
		x.counters.transcriptRepair >= y.counters.transcriptRepair &&
		x.counters.toolResultDisposition >= y.counters.toolResultDisposition &&
		x.counters.evidenceReceipt >= y.counters.evidenceReceipt &&
		x.counters.userSteering >= y.counters.userSteering &&
		x.counters.settings >= y.counters.settings &&
		x.worktreeFingerprint === y.worktreeFingerprint &&
		x.activeModelId === y.activeModelId &&
		x.compactionModelId === y.compactionModelId
	);
}

/**
 * Fail-closed merge of two snapshots.
 *
 * - Different fork ids, or two snapshots that are not on a shared linear
 *   history, yield {@link ContextCacheMergeStatus.divergent}. Disjoint
 *   changes are never max-merged.
 * - Structurally equal snapshots yield {@link ContextCacheMergeStatus.equal}.
 * - When one snapshot componentwise-dominates the other (epoch and every
 *   counter greater-or-equal, and all identity values equal), the dominant
 *   snapshot is chosen via {@link ContextCacheMergeStatus.dominant}.
 */
export function mergeContextCacheSnapshots(
	a: ContextCacheInvalidationSnapshot,
	b: ContextCacheInvalidationSnapshot,
): ContextCacheMergeResult {
	validateContextCacheInvalidationSnapshot(a);
	validateContextCacheInvalidationSnapshot(b);
	if (a.forkId !== b.forkId) {
		return Object.freeze({ status: "divergent", left: cloneAndFreeze(a), right: cloneAndFreeze(b) } as const);
	}
	if (snapshotsEqual(a, b)) {
		return Object.freeze({ status: "equal", snapshot: cloneAndFreeze(a) } as const);
	}
	const aDominates = dominates(a, b);
	const bDominates = dominates(b, a);
	if (aDominates && !bDominates) {
		return Object.freeze({ status: "dominant", snapshot: cloneAndFreeze(a) } as const);
	}
	if (bDominates && !aDominates) {
		return Object.freeze({ status: "dominant", snapshot: cloneAndFreeze(b) } as const);
	}
	return Object.freeze({ status: "divergent", left: cloneAndFreeze(a), right: cloneAndFreeze(b) } as const);
}

/**
 * Canonical, fixed-order JSON serialization of a snapshot, suitable as
 * future cache-key material. The field order is fixed and every distinct
 * field participates, so any distinct field change alters the result.
 * Returns a deterministic string with no hash claim.
 */
export function serializeContextCacheSnapshot(snapshot: ContextCacheInvalidationSnapshot): string {
	validateContextCacheInvalidationSnapshot(snapshot);
	return JSON.stringify({
		schemaVersion: snapshot.schemaVersion,
		forkId: snapshot.forkId,
		globalEpoch: snapshot.globalEpoch,
		counters: {
			transcriptRepair: snapshot.counters.transcriptRepair,
			toolResultDisposition: snapshot.counters.toolResultDisposition,
			evidenceReceipt: snapshot.counters.evidenceReceipt,
			userSteering: snapshot.counters.userSteering,
			settings: snapshot.counters.settings,
		},
		worktreeFingerprint: snapshot.worktreeFingerprint,
		activeModelId: snapshot.activeModelId,
		compactionModelId: snapshot.compactionModelId,
	});
}
