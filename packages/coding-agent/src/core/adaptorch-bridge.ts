/**
 * Reasoning-router AdaptOrch advisory bridge (Goal 009 Lane B).
 *
 * A default-off, advisory-only primitive wired into AgentSession's v4 resolver.
 * AgentSession reads only the bridge's bounded cache and uses a caller-injected
 * advisory function for refresh; the current production transport is a no-op,
 * so it returns no hint. This module owns payload/result validation, TTL cache,
 * budget counter, circuit breaker, and timeout handling. It never calls an MCP
 * transport directly or receives execution authority.
 *
 * Grounded in the read-first plan at
 * .omk/goals/008-reasoning-router-advanced-accuracy-plan/laneC-privacy-adaptorch.md
 * (Part B, sections 4.1-4.11) and the real AdaptOrch MCP tool surface
 * documented in packages/adaptorch-wpl/src/adaptorch-client.ts. Key
 * constraints carried over from that plan:
 *
 *  - The router's turn-start path is synchronous and I/O-free today (plan
 *    4.4). This module never calls an MCP transport directly and exposes a
 *    synchronous, cache-read-only accessor (`getFreshHint`) plus a
 *    fire-and-forget refresh (`requestRefresh`) so the AgentSession integration
 *    never blocks or awaits advisory I/O on the turn-start path.
 *  - The real, documented AdaptOrch tool surface has no confidence or
 *    reasoning-level field (plan 4.3); this module's inbound result type
 *    (`AdaptorchAdvisoryResult`) therefore only carries a locally-relevant
 *    `taskClass` and a `confidenceBand` - both closed enums - never a raw
 *    numeric confidence or a `ThinkingLevel` value. AgentSession owns the
 *    bounded fusion from this advisory shape into the v4 resolver.
 *  - No product source is imported here. `AdaptorchTaskClass` /
 *    `AdaptorchLaneType` intentionally mirror the v4 task/lane unions by
 *    value, while AgentSession adapts them at the integration boundary.
 *  - Every outbound/inbound field is a closed enum, a boolean, or a bounded
 *    integer, derived from local features only. There is structurally no
 *    field shaped to carry prompt text, a prompt hash, a file/working-
 *    directory path, a model/provider identifier, a session/user identifier,
 *    a tool name, or hook output - the sanitize/validate helpers below also
 *    reject any candidate object exposing such a field by name, and reject
 *    any key outside the exact closed schema, so a hand-built or forged
 *    payload can never smuggle one through either type.
 *  - The router-bridge tool allowlist (`ADAPTORCH_READONLY_TOOL_ALLOWLIST`)
 *    only ever contains the two read/local AdaptOrch tools the plan
 *    identifies as in scope (the session-start capabilities probe and the
 *    per-consult topology-classification call, plan 4.2/4.6); the
 *    run-submission and run-cancellation tools (and any other mutating
 *    tool) can never appear in it, checked both by an exact-value test and
 *    by `looksMutatingToolName`'s verb-segment guard.
 *
 * Pure aside from `Date.now`/`setTimeout` (both injectable/wrapped so tests
 * never depend on real wall-clock time or a real MCP call).
 */

/** Closed set of task classes. Mirrors the v4 task-class union by value (see file header). */
export type AdaptorchTaskClass = "trivial" | "simple-edit" | "code-gen" | "debug" | "refactor" | "review" | "plan";

/** Closed set of subagent lane types. Mirrors the v4 lane union by value. */
export type AdaptorchLaneType = "planner" | "security" | "explorer" | "coder" | "reviewer" | "tester";

/** Local top1-vs-runner-up score-margin bucket (plan 4.5 ConsultPayloadV1.marginBucket). */
export type AdaptorchMarginBucket = "tie" | "low" | "medium" | "high";

/** Locally-derived confidence band for a returned hint. Never a raw network-supplied float (plan 4.3). */
export type AdaptorchConfidenceBand = "low" | "medium" | "high";

/** floor(log2(trimmedPromptLen+1)) clamped to [0,7]. */
export type AdaptorchLenBucket = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Context-pressure band 0..3 - same bucketing as agent-session.ts's _computePressureBucket. */
export type AdaptorchPressureBucket = 0 | 1 | 2 | 3;

/**
 * Outbound advisory request (plan 4.5, field names adapted for this lane's
 * assignment: taskClass/runnerUp/marginBucket/lenBucket/hadFence/hadDiff/
 * pressureBucket/laneType). Every field is a closed enum, a boolean, or a
 * bounded integer built from local classifier features only. Structurally
 * excludes prompt text/hash, file paths, model/provider/session
 * identifiers, tool names, and hook output - there is no field shaped to
 * carry any of those.
 */
export interface AdaptorchConsultPayload {
	readonly schemaVersion: 1;
	readonly taskClass: AdaptorchTaskClass;
	readonly runnerUp: AdaptorchTaskClass;
	readonly marginBucket: AdaptorchMarginBucket;
	readonly lenBucket: AdaptorchLenBucket;
	readonly hadFence: boolean;
	readonly hadDiff: boolean;
	readonly pressureBucket: AdaptorchPressureBucket;
	readonly laneType?: AdaptorchLaneType;
}

/**
 * Inbound advisory result after local sanitation (plan 4.3, corrected
 * schema). `confidenceBand` is always synthesized/validated locally - the
 * real AdaptOrch tool contract carries no confidence or effort-level field,
 * so this type never trusts a raw numeric confidence from the advisory
 * function.
 */
export interface AdaptorchAdvisoryResult {
	readonly schemaVersion: 1;
	readonly taskClass: AdaptorchTaskClass;
	readonly confidenceBand: AdaptorchConfidenceBand;
}

const TASK_CLASSES: readonly AdaptorchTaskClass[] = [
	"trivial",
	"simple-edit",
	"code-gen",
	"debug",
	"refactor",
	"review",
	"plan",
];
const TASK_CLASS_SET: ReadonlySet<string> = new Set(TASK_CLASSES);

const LANE_TYPES: readonly AdaptorchLaneType[] = ["planner", "security", "explorer", "coder", "reviewer", "tester"];
const LANE_TYPE_SET: ReadonlySet<string> = new Set(LANE_TYPES);

const MARGIN_BUCKETS: readonly AdaptorchMarginBucket[] = ["tie", "low", "medium", "high"];
const MARGIN_BUCKET_SET: ReadonlySet<string> = new Set(MARGIN_BUCKETS);

const CONFIDENCE_BANDS: readonly AdaptorchConfidenceBand[] = ["low", "medium", "high"];
const CONFIDENCE_BAND_SET: ReadonlySet<string> = new Set(CONFIDENCE_BANDS);

const CONSULT_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
	"schemaVersion",
	"taskClass",
	"runnerUp",
	"marginBucket",
	"lenBucket",
	"hadFence",
	"hadDiff",
	"pressureBucket",
	"laneType",
]);

const ADVISORY_RESULT_KEYS: ReadonlySet<string> = new Set(["schemaVersion", "taskClass", "confidenceBand"]);

/**
 * Field-name markers that must never appear on a payload or result object,
 * checked case-insensitively as a substring of every own key. This is
 * defense-in-depth alongside the exact-key allowlist below: even a candidate
 * that otherwise has every required field still fails if it also carries a
 * field shaped like a stored prompt, hash, path, model/provider identifier,
 * session identifier, tool name, or hook output.
 */
const FORBIDDEN_KEY_SUBSTRINGS: readonly string[] = [
	"prompt",
	"hash",
	"path",
	"model",
	"session",
	"tool",
	"hook",
	"provider",
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True if any own key of `record` contains a forbidden field-name marker
 * (case-insensitive). Typed `object` rather than `Record<string, unknown>` so
 * callers (including tests) can pass any concrete object shape - named
 * interface, ad-hoc literal, or an already-`Record`-typed value - without a
 * missing-index-signature type error; only `Object.keys` is used internally,
 * which accepts any `object`.
 */
export function containsForbiddenField(record: object): boolean {
	for (const key of Object.keys(record)) {
		const lowerKey = key.toLowerCase();
		if (FORBIDDEN_KEY_SUBSTRINGS.some((needle) => lowerKey.includes(needle))) return true;
	}
	return false;
}

function hasOnlyAllowedKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(record).every((key) => allowed.has(key));
}

function clampInt(value: number, min: number, max: number): number {
	const truncated = Number.isFinite(value) ? Math.trunc(value) : min;
	if (truncated < min) return min;
	if (truncated > max) return max;
	return truncated;
}

function clampLenBucket(value: number): AdaptorchLenBucket {
	return clampInt(value, 0, 7) as AdaptorchLenBucket;
}

function clampPressureBucket(value: number): AdaptorchPressureBucket {
	return clampInt(value, 0, 3) as AdaptorchPressureBucket;
}

/** `value ?? fallback`, coerced to an integer and floored at `min` (used for config, not untrusted payloads). */
function boundedIntOrDefault(value: number | undefined, fallback: number, min: number): number {
	const raw = value ?? fallback;
	if (!Number.isFinite(raw)) return fallback;
	return Math.max(min, Math.trunc(raw));
}

/**
 * Sanitize/validate an outbound advisory request. Returns `null` (never
 * throws) when `candidate` is not a plain object, carries a forbidden-named
 * field, carries any key outside the exact closed schema, or has a
 * wrong-typed/unknown-enum field. `lenBucket`/`pressureBucket` are clamped
 * into their bounded ranges rather than rejected, so a caller-side rounding
 * or edge-case computation can never smuggle an out-of-range integer through.
 */
export function sanitizeConsultPayload(candidate: unknown): AdaptorchConsultPayload | null {
	if (!isPlainObject(candidate)) return null;
	if (containsForbiddenField(candidate)) return null;
	if (!hasOnlyAllowedKeys(candidate, CONSULT_PAYLOAD_KEYS)) return null;

	if (candidate.schemaVersion !== 1) return null;

	const taskClass = candidate.taskClass;
	if (typeof taskClass !== "string" || !TASK_CLASS_SET.has(taskClass)) return null;

	const runnerUp = candidate.runnerUp;
	if (typeof runnerUp !== "string" || !TASK_CLASS_SET.has(runnerUp)) return null;

	const marginBucket = candidate.marginBucket;
	if (typeof marginBucket !== "string" || !MARGIN_BUCKET_SET.has(marginBucket)) return null;

	const lenBucketRaw = candidate.lenBucket;
	if (typeof lenBucketRaw !== "number") return null;

	const pressureBucketRaw = candidate.pressureBucket;
	if (typeof pressureBucketRaw !== "number") return null;

	const hadFence = candidate.hadFence;
	if (typeof hadFence !== "boolean") return null;

	const hadDiff = candidate.hadDiff;
	if (typeof hadDiff !== "boolean") return null;

	const laneTypeRaw = candidate.laneType;
	let laneType: AdaptorchLaneType | undefined;
	if (laneTypeRaw !== undefined) {
		if (typeof laneTypeRaw !== "string" || !LANE_TYPE_SET.has(laneTypeRaw)) return null;
		laneType = laneTypeRaw as AdaptorchLaneType;
	}

	return {
		schemaVersion: 1,
		taskClass: taskClass as AdaptorchTaskClass,
		runnerUp: runnerUp as AdaptorchTaskClass,
		marginBucket: marginBucket as AdaptorchMarginBucket,
		lenBucket: clampLenBucket(lenBucketRaw),
		hadFence,
		hadDiff,
		pressureBucket: clampPressureBucket(pressureBucketRaw),
		...(laneType !== undefined ? { laneType } : {}),
	};
}

/**
 * Sanitize/validate an inbound advisory result (i.e. whatever the injected
 * advisory function returned). Returns `null` (never throws) on any shape,
 * forbidden-field, extra-key, or unknown-enum violation - the caller
 * (`AdaptorchBridge.consult`) treats `null` as "no hint" and falls back
 * silently, exactly like every other failure mode.
 */
export function sanitizeAdvisoryResult(candidate: unknown): AdaptorchAdvisoryResult | null {
	if (!isPlainObject(candidate)) return null;
	if (containsForbiddenField(candidate)) return null;
	if (!hasOnlyAllowedKeys(candidate, ADVISORY_RESULT_KEYS)) return null;

	if (candidate.schemaVersion !== 1) return null;

	const taskClass = candidate.taskClass;
	if (typeof taskClass !== "string" || !TASK_CLASS_SET.has(taskClass)) return null;

	const confidenceBand = candidate.confidenceBand;
	if (typeof confidenceBand !== "string" || !CONFIDENCE_BAND_SET.has(confidenceBand)) return null;

	return {
		schemaVersion: 1,
		taskClass: taskClass as AdaptorchTaskClass,
		confidenceBand: confidenceBand as AdaptorchConfidenceBand,
	};
}

/**
 * Read-only/local AdaptOrch MCP tool names this bridge may ever reference,
 * grounded in the real 10-tool surface documented in
 * packages/adaptorch-wpl/src/adaptorch-client.ts (cross-checked there
 * against the AdaptOrch server's own docs) and narrowed to the two tools the
 * read-first plan puts in scope for a reasoning-effort hint (plan 4.2): the
 * session-start capabilities probe and the per-consult topology
 * classification call. This module does not call any MCP tool directly
 * today - the advisory function is fully caller-injected - so this
 * allowlist is not wired to a transport here; it exists so a future
 * transport, and this module's own tests, can assert by construction that
 * `adaptorch_run` (submit) and `adaptorch_cancel_run` (cancel), or any other
 * mutating tool, can never be reachable from router/bridge code.
 */
export const ADAPTORCH_READONLY_TOOL_ALLOWLIST = ["adaptorch_capabilities", "adaptorch_route_topology"] as const;

export type AdaptorchReadonlyToolName = (typeof ADAPTORCH_READONLY_TOOL_ALLOWLIST)[number];

/** Underscore-segment verbs that mark an AdaptOrch-shaped tool name as mutating (write/execute/lifecycle). */
const MUTATING_TOOL_VERB_SEGMENTS: ReadonlySet<string> = new Set([
	"run",
	"submit",
	"cancel",
	"dispatch",
	"delete",
	"execute",
	"mutate",
	"write",
	"create",
	"update",
	"remove",
]);

/**
 * True if any underscore-delimited segment of an AdaptOrch-shaped tool name
 * is a known mutating verb. Segment-based rather than a raw substring/regex
 * match so "adaptorch_route_topology" is never falsely flagged (no segment
 * is a mutating verb), while "adaptorch_run" and "adaptorch_cancel_run" are
 * always caught regardless of future prefix/suffix changes.
 */
export function looksMutatingToolName(name: string): boolean {
	return name
		.toLowerCase()
		.split("_")
		.some((segment) => MUTATING_TOOL_VERB_SEGMENTS.has(segment));
}

/**
 * Type guard: true only for the two allowlisted read/local AdaptOrch tool
 * names. Also independently rejects any name `looksMutatingToolName` flags,
 * so a future accidental addition of a mutating name to the allowlist array
 * still cannot make this function report it as allowed.
 */
export function isAdaptorchToolAllowed(name: string): name is AdaptorchReadonlyToolName {
	if (looksMutatingToolName(name)) return false;
	return (ADAPTORCH_READONLY_TOOL_ALLOWLIST as readonly string[]).includes(name);
}

/**
 * Timeout wrapper interface around any injected async advisory call. Races
 * the call against a timer; a slow or hung call rejects at `timeoutMs`
 * instead of leaving the caller waiting indefinitely. Always clears the
 * timer once the call settles (or once the timeout itself fires), and
 * always resolves/rejects exactly once - a synchronous throw from `run` is
 * treated the same as an asynchronous rejection.
 */
export type AdvisoryTimeoutWrapper = <T>(run: () => Promise<T>, timeoutMs: number) => Promise<T>;

export const withAdvisoryTimeout: AdvisoryTimeoutWrapper = <T>(
	run: () => Promise<T>,
	timeoutMs: number,
): Promise<T> => {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error("adaptorch-bridge: advisory call timed out"));
		}, timeoutMs);

		let pending: Promise<T>;
		try {
			pending = run();
		} catch (err) {
			clearTimeout(timer);
			reject(err instanceof Error ? err : new Error(String(err)));
			return;
		}

		pending.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err: unknown) => {
				clearTimeout(timer);
				reject(err instanceof Error ? err : new Error(String(err)));
			},
		);
	});
};

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MIN_TTL_MS = 30 * 1000;
const MAX_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_TURNS_PER_ENTRY = 10;
const DEFAULT_CACHE_SIZE = 16;
const DEFAULT_MAX_CONSULTS_PER_SESSION = 5;
const DEFAULT_MIN_INTERVAL_MS = 60 * 1000;
const DEFAULT_TIMEOUT_MS = 1500;
const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 30 * 1000;
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Exact TTL/cache/budget/circuit-breaker defaults from the read-first plan,
 * section 4.8. Exported so a security/review lane can confirm the shipped
 * numbers without reading this module's internals.
 */
export const ADAPTORCH_BRIDGE_DEFAULTS = {
	ttlMs: DEFAULT_TTL_MS,
	minTtlMs: MIN_TTL_MS,
	maxTtlMs: MAX_TTL_MS,
	maxTurnsPerEntry: DEFAULT_MAX_TURNS_PER_ENTRY,
	cacheSize: DEFAULT_CACHE_SIZE,
	maxConsultsPerSession: DEFAULT_MAX_CONSULTS_PER_SESSION,
	minIntervalMs: DEFAULT_MIN_INTERVAL_MS,
	timeoutMs: DEFAULT_TIMEOUT_MS,
	minTimeoutMs: MIN_TIMEOUT_MS,
	maxTimeoutMs: MAX_TIMEOUT_MS,
	failureThreshold: DEFAULT_FAILURE_THRESHOLD,
	cooldownMs: DEFAULT_COOLDOWN_MS,
} as const;

/**
 * Bridge configuration. `advisoryFn` is the ONLY seam to any external
 * system - this module never imports or calls an MCP client/transport
 * itself, so it is impossible for a unit test (or a misconfigured caller)
 * to reach a real MCP server through this module by accident.
 */
export interface AdaptorchBridgeConfig {
	/**
	 * Caller-injected advisory call. Its return value is untrusted: `consult`
	 * always runs it through `sanitizeAdvisoryResult` before using or caching
	 * it, and a rejected/thrown/timed-out/schema-invalid response is treated
	 * as an ordinary failure (counts toward the circuit breaker), never as a
	 * value to fuse.
	 */
	readonly advisoryFn: (payload: AdaptorchConsultPayload) => Promise<unknown>;
	/** Injectable clock; defaults to `Date.now`. Tests supply a fake to avoid real wall-clock waits. */
	readonly now?: () => number;
	/** Cache TTL in ms; clamped to [30s, 5min] (plan 4.8). Default 5 minutes. */
	readonly ttlMs?: number;
	/** A cache entry also expires after this many `getFreshHint` calls ("turns"). Default 10. */
	readonly maxTurnsPerEntry?: number;
	/** Max distinct cached payload keys (LRU eviction beyond this). Default 16. */
	readonly cacheSize?: number;
	/** Max advisory attempts for this bridge instance's lifetime ("session"). Default 5. */
	readonly maxConsultsPerSession?: number;
	/** Minimum ms between advisory attempts. Default 60000 (60s). */
	readonly minIntervalMs?: number;
	/** Per-attempt timeout in ms; clamped to [1ms, 30s]. Default 1500 (1.5s). */
	readonly timeoutMs?: number;
	/** Consecutive failures before the circuit opens. Default 3. */
	readonly failureThreshold?: number;
	/** Circuit-open duration in ms once opened. Default 600000 (10min). */
	readonly cooldownMs?: number;
}

/** Read-only, non-sensitive introspection snapshot - never exposes payload/result content. */
export interface AdaptorchBridgeStats {
	readonly consultCount: number;
	readonly failureStreak: number;
	readonly circuitOpen: boolean;
	readonly circuitOpenUntilMs: number;
	readonly cacheEntryCount: number;
}

export interface AdaptorchBridge {
	/**
	 * Synchronous, cache-read-only. Never blocks, never throws, and never
	 * calls the advisory function - a cache miss or an expired/invalid entry
	 * silently returns `null` ("no hint"), matching the turn-start path's
	 * synchronous, I/O-free contract (plan 4.4).
	 */
	getFreshHint(payload: AdaptorchConsultPayload): AdaptorchAdvisoryResult | null;
	/**
	 * Fire-and-forget refresh for a LATER call to `getFreshHint`, never the
	 * current one. Never throws synchronously and never rejects into the
	 * caller - any failure is swallowed internally by `consult`.
	 */
	requestRefresh(payload: AdaptorchConsultPayload): void;
	/**
	 * The awaitable core operation `requestRefresh` fires without awaiting.
	 * Gated by the circuit breaker, budget counter, and minimum interval (in
	 * that order) before ever invoking `advisoryFn`; always resolves (never
	 * rejects) to either a sanitized hint or `null`.
	 */
	consult(payload: AdaptorchConsultPayload): Promise<AdaptorchAdvisoryResult | null>;
	/** Read-only introspection for tests/diagnostics; contains no payload or result content. */
	getStats(): AdaptorchBridgeStats;
}

interface CacheEntry {
	readonly result: AdaptorchAdvisoryResult;
	readonly insertedAtMs: number;
	readonly insertedAtTurn: number;
}

/** Deterministic cache key built field-by-field from a sanitized payload - never from raw prompt text. */
function cacheKeyFor(payload: AdaptorchConsultPayload): string {
	return JSON.stringify({
		taskClass: payload.taskClass,
		runnerUp: payload.runnerUp,
		marginBucket: payload.marginBucket,
		lenBucket: payload.lenBucket,
		hadFence: payload.hadFence,
		hadDiff: payload.hadDiff,
		pressureBucket: payload.pressureBucket,
		laneType: payload.laneType ?? null,
	});
}

class AdaptorchBridgeImpl implements AdaptorchBridge {
	private readonly advisoryFn: (payload: AdaptorchConsultPayload) => Promise<unknown>;
	private readonly now: () => number;
	private readonly ttlMs: number;
	private readonly maxTurnsPerEntry: number;
	private readonly cacheSize: number;
	private readonly maxConsultsPerSession: number;
	private readonly minIntervalMs: number;
	private readonly timeoutMs: number;
	private readonly failureThreshold: number;
	private readonly cooldownMs: number;

	private readonly cache = new Map<string, CacheEntry>();
	private turnCounter = 0;
	private consultCount = 0;
	private failureStreak = 0;
	private lastAttemptAtMs: number | null = null;
	private circuitOpenUntilMs = 0;

	constructor(config: AdaptorchBridgeConfig) {
		this.advisoryFn = config.advisoryFn;
		this.now = config.now ?? Date.now;
		this.ttlMs = clampInt(config.ttlMs ?? DEFAULT_TTL_MS, MIN_TTL_MS, MAX_TTL_MS);
		this.maxTurnsPerEntry = boundedIntOrDefault(config.maxTurnsPerEntry, DEFAULT_MAX_TURNS_PER_ENTRY, 1);
		this.cacheSize = boundedIntOrDefault(config.cacheSize, DEFAULT_CACHE_SIZE, 1);
		this.maxConsultsPerSession = boundedIntOrDefault(
			config.maxConsultsPerSession,
			DEFAULT_MAX_CONSULTS_PER_SESSION,
			0,
		);
		this.minIntervalMs = boundedIntOrDefault(config.minIntervalMs, DEFAULT_MIN_INTERVAL_MS, 0);
		this.timeoutMs = clampInt(config.timeoutMs ?? DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
		this.failureThreshold = boundedIntOrDefault(config.failureThreshold, DEFAULT_FAILURE_THRESHOLD, 1);
		this.cooldownMs = boundedIntOrDefault(config.cooldownMs, DEFAULT_COOLDOWN_MS, 0);
	}

	getFreshHint(payload: AdaptorchConsultPayload): AdaptorchAdvisoryResult | null {
		this.turnCounter += 1;
		const sanitizedPayload = sanitizeConsultPayload(payload);
		if (sanitizedPayload === null) return null;

		const key = cacheKeyFor(sanitizedPayload);
		const entry = this.cache.get(key);
		if (entry === undefined) return null;
		if (!this.isEntryFresh(entry)) {
			this.cache.delete(key);
			return null;
		}
		return entry.result;
	}

	requestRefresh(payload: AdaptorchConsultPayload): void {
		void this.consult(payload).catch(() => {
			// consult() already swallows every failure and always resolves; this
			// catch only guards a future refactor from letting one escape, so a
			// fire-and-forget refresh can never surface an unhandled rejection.
		});
	}

	async consult(payload: AdaptorchConsultPayload): Promise<AdaptorchAdvisoryResult | null> {
		const sanitizedPayload = sanitizeConsultPayload(payload);
		if (sanitizedPayload === null) return null;

		const nowMs = this.now();
		if (nowMs < this.circuitOpenUntilMs) return null;
		if (this.consultCount >= this.maxConsultsPerSession) return null;
		if (this.lastAttemptAtMs !== null && nowMs - this.lastAttemptAtMs < this.minIntervalMs) return null;

		this.consultCount += 1;
		this.lastAttemptAtMs = nowMs;

		let raw: unknown;
		try {
			raw = await withAdvisoryTimeout(() => this.advisoryFn(sanitizedPayload), this.timeoutMs);
		} catch {
			this.recordFailure();
			return null;
		}

		const result = sanitizeAdvisoryResult(raw);
		if (result === null) {
			this.recordFailure();
			return null;
		}

		this.failureStreak = 0;
		this.cacheResult(sanitizedPayload, result);
		return result;
	}

	getStats(): AdaptorchBridgeStats {
		const nowMs = this.now();
		return {
			consultCount: this.consultCount,
			failureStreak: this.failureStreak,
			circuitOpen: nowMs < this.circuitOpenUntilMs,
			circuitOpenUntilMs: this.circuitOpenUntilMs,
			cacheEntryCount: this.cache.size,
		};
	}

	private recordFailure(): void {
		this.failureStreak += 1;
		if (this.failureStreak >= this.failureThreshold) {
			this.circuitOpenUntilMs = this.now() + this.cooldownMs;
		}
	}

	private isEntryFresh(entry: CacheEntry): boolean {
		const ageMs = this.now() - entry.insertedAtMs;
		const ageTurns = this.turnCounter - entry.insertedAtTurn;
		return ageMs < this.ttlMs && ageTurns < this.maxTurnsPerEntry;
	}

	/** Eviction favors entries last refreshed by a successful consult (write-time LRU, not read-time). */
	private cacheResult(payload: AdaptorchConsultPayload, result: AdaptorchAdvisoryResult): void {
		const key = cacheKeyFor(payload);
		if (this.cache.has(key)) this.cache.delete(key);
		this.cache.set(key, { result, insertedAtMs: this.now(), insertedAtTurn: this.turnCounter });
		while (this.cache.size > this.cacheSize) {
			const oldestKey = this.cache.keys().next().value;
			if (oldestKey === undefined) break;
			this.cache.delete(oldestKey);
		}
	}
}

/** Construct a default-off AdaptOrch advisory bridge. See `AdaptorchBridgeConfig` for tunables. */
export function createAdaptorchBridge(config: AdaptorchBridgeConfig): AdaptorchBridge {
	return new AdaptorchBridgeImpl(config);
}
