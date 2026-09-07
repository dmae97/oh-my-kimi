/**
 * Stagnation tracker (TB21 §8.4): deterministic anti-loop policy.
 *
 * The same failure fingerprint with no new observation, repeated past the
 * threshold, means "try something materially different" — not another retry.
 * Fingerprints bind error kind + involved files + artifact hash so a changed
 * workspace reopens the question instead of inheriting a stale verdict.
 */

export interface StagnationObservation {
	/** Stable fingerprint: error class + related file hashes + action class. */
	readonly fingerprint: string;
	/** Hash of the new observation this attempt produced, if any. */
	readonly observationHash?: string;
}

export interface StagnationResult {
	readonly stagnated: boolean;
	readonly repeats: number;
	/** Present only on stagnation: retry is banned, divert exactly once. */
	readonly recommendation?: "divert";
}

export class StagnationTracker {
	private lastFingerprint: string | undefined;
	private lastObservationHash: string | undefined;
	private repeats = 0;
	private readonly threshold: number;

	constructor(threshold = 3) {
		this.threshold = threshold;
	}

	/** Record one attempt outcome. Pure state machine; no I/O. */
	check(observation: StagnationObservation): StagnationResult {
		const progressed =
			observation.fingerprint !== this.lastFingerprint ||
			(observation.observationHash !== undefined && observation.observationHash !== this.lastObservationHash);
		if (progressed) {
			this.lastFingerprint = observation.fingerprint;
			this.lastObservationHash = observation.observationHash;
			this.repeats = 1;
			return { stagnated: false, repeats: 1 };
		}
		this.repeats += 1;
		if (this.repeats >= this.threshold) {
			return { stagnated: true, repeats: this.repeats, recommendation: "divert" };
		}
		return { stagnated: false, repeats: this.repeats };
	}

	reset(): void {
		this.lastFingerprint = undefined;
		this.lastObservationHash = undefined;
		this.repeats = 0;
	}
}
