import { randomUUID } from "node:crypto";
import type { ResourceAdmissionDecision } from "./resource-admission.ts";

/**
 * Run resource lease (OMK v0.97.x roadmap §8, M2/PR3).
 *
 * A lease scopes one admission decision to one top-level prompt run and owns
 * the temporary tool-concurrency cap for that run. Generation tokens make
 * cap restore race-free (§8.1): only the current generation may restore, so
 * a retry or nested continuation that settles late can never overwrite the
 * cap another run applied, and the baseline is captured exactly once per
 * idle→active transition.
 *
 * Invariants (§8.3, verified by tests):
 * - Generation is a monotonic integer.
 * - A stale (superseded or already-released) release never changes the cap.
 * - Release in `finally` restores the pre-governor baseline exactly once.
 * - The applied cap never exceeds the configured baseline (§7.3).
 * - State is runtime-local only: nothing persists, so crash recovery and
 *   session switch start clean by construction.
 */
export interface RunResourceLease {
	readonly leaseId: string;
	readonly promptRunId: string;
	readonly generation: number;
	readonly decision: ResourceAdmissionDecision;
	readonly acquiredAt: string;
}

/** Mutable cap seam owned by the session (`Agent.maxToolConcurrency`; `undefined` = unlimited). */
export interface ToolCapAuthority {
	getCap(): number | undefined;
	setCap(cap: number | undefined): void;
}

export type ResourceLeaseReleaseResult = "restored" | "stale" | "duplicate";

export type RunResourceLeaseControllerOptions = {
	/** Injectable clock for deterministic tests. */
	now?: () => Date;
};

export class RunResourceLeaseController {
	private readonly authority: ToolCapAuthority;
	private readonly now: () => Date;
	private generation = 0;
	private active: RunResourceLease | null = null;
	private baselineCap: number | undefined;
	private lastReleasedGeneration = 0;
	private staleReleases = 0;

	constructor(authority: ToolCapAuthority, options?: RunResourceLeaseControllerOptions) {
		this.authority = authority;
		this.now = options?.now ?? (() => new Date());
	}

	/**
	 * Acquire a lease for one top-level run and apply its effective tool cap.
	 * The baseline is captured only on the idle→active transition, so an
	 * overlapping acquire can never mistake another lease's throttled cap for
	 * the user-configured baseline (§8.1 nested-continuation race).
	 */
	acquire(input: { readonly promptRunId: string; readonly decision: ResourceAdmissionDecision }): RunResourceLease {
		this.generation += 1;
		if (this.active === null) {
			this.baselineCap = this.authority.getCap();
		}
		const lease: RunResourceLease = {
			leaseId: `lease-${randomUUID()}`,
			promptRunId: input.promptRunId,
			generation: this.generation,
			decision: input.decision,
			acquiredAt: this.now().toISOString(),
		};
		this.active = lease;
		this.authority.setCap(effectiveLeaseCap(this.baselineCap, input.decision.maxToolConcurrency));
		return lease;
	}

	isCurrent(lease: RunResourceLease): boolean {
		return this.active !== null && this.active.generation === lease.generation;
	}

	/**
	 * Release a lease. Only the current generation restores the baseline;
	 * duplicate and superseded releases are diagnosable no-ops (§8.3).
	 */
	release(lease: RunResourceLease): ResourceLeaseReleaseResult {
		if (lease.generation === this.lastReleasedGeneration) {
			this.staleReleases += 1;
			return "duplicate";
		}
		if (!this.isCurrent(lease)) {
			this.staleReleases += 1;
			return "stale";
		}
		this.lastReleasedGeneration = lease.generation;
		this.active = null;
		this.authority.setCap(this.baselineCap);
		return "restored";
	}

	get activeLease(): RunResourceLease | null {
		return this.active;
	}

	/** Count of stale/duplicate releases observed (diagnostic only). */
	get staleReleaseCount(): number {
		return this.staleReleases;
	}
}

/**
 * §7.3 effective cap: `min(configured baseline, admission cap)` where a
 * missing/zero baseline means "unlimited" and is limited to the admission
 * cap. Defense in depth: this holds even if a caller's decision did not
 * already fold the configured caps in.
 */
export function effectiveLeaseCap(baselineCap: number | undefined, admissionCap: number): number {
	const admitted = Math.max(1, Math.floor(admissionCap));
	if (baselineCap === undefined || !Number.isFinite(baselineCap) || baselineCap <= 0) {
		return admitted;
	}
	return Math.max(1, Math.min(Math.floor(baselineCap), admitted));
}
