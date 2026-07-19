export interface CompactionHysteresisConfig {
	readonly rearmRatio: number;
	readonly triggerRatio: number;
	readonly emergencyRatio: number;
}

export interface CompactionHysteresisState {
	readonly armed: boolean;
}

export type CompactionAttemptOutcome = "none" | "commit" | "abort" | "stale" | "defer";
export type CompactionHysteresisAction = "compact" | "wait";
export type CompactionHysteresisReason =
	| "emergency_threshold_reached"
	| "trigger_threshold_reached"
	| "below_trigger_threshold"
	| "commit_disarmed"
	| "disarmed_until_rearm"
	| "rearmed_at_low_watermark";

export interface CompactionHysteresisInput {
	readonly config: CompactionHysteresisConfig;
	readonly state: CompactionHysteresisState;
	readonly ratio: number;
	readonly outcome?: CompactionAttemptOutcome;
}

export interface CompactionHysteresisResult {
	readonly action: CompactionHysteresisAction;
	readonly reason: CompactionHysteresisReason;
	readonly nextState: CompactionHysteresisState;
}

function assertRatio(value: unknown, field: string): asserts value is number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
		throw new TypeError(`${field} must be a finite ratio in [0, 1]`);
	}
}

export function createCompactionHysteresisConfig(config: CompactionHysteresisConfig): CompactionHysteresisConfig {
	if (typeof config !== "object" || config === null || Array.isArray(config)) {
		throw new TypeError("compaction hysteresis config must be an object");
	}
	const allowedKeys = ["rearmRatio", "triggerRatio", "emergencyRatio"];
	if (Object.keys(config).some((key) => !allowedKeys.includes(key))) {
		throw new TypeError("compaction hysteresis config contains unsupported keys");
	}
	assertRatio(config.rearmRatio, "rearmRatio");
	assertRatio(config.triggerRatio, "triggerRatio");
	assertRatio(config.emergencyRatio, "emergencyRatio");
	if (!(config.rearmRatio < config.triggerRatio && config.triggerRatio <= config.emergencyRatio)) {
		throw new TypeError("config must satisfy 0 <= rearmRatio < triggerRatio <= emergencyRatio <= 1");
	}
	return Object.freeze({ ...config });
}

export function createCompactionHysteresisState(input?: Partial<CompactionHysteresisState>): CompactionHysteresisState {
	if (input !== undefined) {
		if (typeof input !== "object" || input === null || Array.isArray(input)) {
			throw new TypeError("compaction hysteresis state must be an object");
		}
		if (Object.keys(input).some((key) => key !== "armed")) {
			throw new TypeError("compaction hysteresis state contains unsupported keys");
		}
		if (input.armed !== undefined && typeof input.armed !== "boolean") {
			throw new TypeError("compaction hysteresis state armed must be a boolean");
		}
		return Object.freeze({ armed: input.armed ?? true });
	}
	return Object.freeze({ armed: true });
}

function result(
	action: CompactionHysteresisAction,
	reason: CompactionHysteresisReason,
	armed: boolean,
): CompactionHysteresisResult {
	return Object.freeze({ action, reason, nextState: Object.freeze({ armed }) });
}

/** Pure transition; only a successful commit disarms normal-threshold compaction. */
export function stepCompactionHysteresis(input: CompactionHysteresisInput): CompactionHysteresisResult {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new TypeError("compaction hysteresis input must be an object");
	}
	const allowedInputKeys = ["config", "state", "ratio", "outcome"];
	if (Object.keys(input).some((key) => !allowedInputKeys.includes(key))) {
		throw new TypeError("compaction hysteresis input contains unsupported keys");
	}
	const config = createCompactionHysteresisConfig(input.config);
	const stateObj = input.state;
	if (typeof stateObj !== "object" || stateObj === null || Array.isArray(stateObj)) {
		throw new TypeError("compaction hysteresis state must be an object");
	}
	if (Object.keys(stateObj).some((key) => key !== "armed")) {
		throw new TypeError("compaction hysteresis state contains unsupported keys");
	}
	if (typeof stateObj.armed !== "boolean") {
		throw new TypeError("compaction hysteresis state must contain an armed boolean");
	}
	assertRatio(input.ratio, "ratio");
	const outcome = input.outcome ?? "none";
	if (!new Set<CompactionAttemptOutcome>(["none", "commit", "abort", "stale", "defer"]).has(outcome)) {
		throw new TypeError("outcome must be none, commit, abort, stale, or defer");
	}

	const committed = outcome === "commit";
	let armed = committed ? false : stateObj.armed;
	const rearmed = !committed && !armed && input.ratio <= config.rearmRatio;
	if (rearmed) armed = true;

	if (input.ratio >= config.emergencyRatio) {
		return result("compact", "emergency_threshold_reached", armed);
	}
	if (armed && input.ratio >= config.triggerRatio) {
		return result("compact", "trigger_threshold_reached", armed);
	}
	if (committed) return result("wait", "commit_disarmed", false);
	if (rearmed) return result("wait", "rearmed_at_low_watermark", true);
	if (!armed) return result("wait", "disarmed_until_rearm", false);
	return result("wait", "below_trigger_threshold", true);
}
