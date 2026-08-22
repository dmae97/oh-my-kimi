import { createHash } from "node:crypto";

/**
 * Workload shard plan and state contracts (OMK v0.97.x roadmap §13, M5/PR8).
 *
 * Pure layer: plan validation, the §13.4 state machine, deterministic
 * journal replay (reduce), and the §13.5 resume projection. No I/O here —
 * the journal store persists lines and the M5 executor consumes the
 * projections. §13.6: shard completion is an evidence source, never a task
 * verdict; nothing in this module declares a task passed.
 */

export const WORKLOAD_SHARD_PLAN_VERSION = 1 as const;

export interface WorkloadShardPlan {
	readonly schemaVersion: typeof WORKLOAD_SHARD_PLAN_VERSION;
	readonly planId: string;
	readonly promptRunId: string;
	readonly commandDigest: string;
	readonly strategy: string;
	readonly createdAt: string;
	readonly maxConcurrency: number;
	readonly shards: readonly WorkloadShardSpec[];
}

export interface WorkloadShardSpec {
	readonly shardId: string;
	readonly dependencyIds: readonly string[];
	readonly commandDescriptor: {
		readonly executable: string;
		readonly argvDigest: string;
		readonly redactedArgv: readonly string[];
	};
	readonly expectedEvidence: readonly string[];
}

export type WorkloadShardState = "pending" | "running" | "passed" | "failed" | "aborted" | "interrupted";

export interface WorkloadShardRecord {
	readonly schemaVersion: 1;
	readonly planId: string;
	readonly shardId: string;
	readonly attempt: number;
	readonly state: WorkloadShardState;
	readonly startedAt?: string;
	readonly finishedAt?: string;
	readonly evidenceRefs: readonly string[];
	readonly reasonCode?: string;
}

/** §13.4 legal transitions. `pending` re-arms come from failed/aborted/interrupted only. */
const LEGAL_TRANSITIONS: Readonly<Record<WorkloadShardState, readonly WorkloadShardState[]>> = {
	pending: ["running"],
	running: ["passed", "failed", "aborted", "interrupted"],
	failed: ["pending"],
	aborted: ["pending"],
	interrupted: ["pending"],
	passed: [],
};

export function canTransitionShardState(from: WorkloadShardState, to: WorkloadShardState): boolean {
	return LEGAL_TRANSITIONS[from].includes(to);
}

/** §22.1: journals carry only the digest and a redacted descriptor, never raw argv. */
export function buildShardCommandDescriptor(argv: readonly string[]): WorkloadShardSpec["commandDescriptor"] {
	const executable = basename(argv[0] ?? "");
	const redactedArgv = argv.map((token, index) => {
		if (index === 0) {
			return executable;
		}
		if (/^-{1,2}[A-Za-z0-9][A-Za-z0-9=/:.,_-]*$/.test(token)) {
			return token; // flags (with inline values) stay readable
		}
		if (/^[A-Za-z0-9_.:-]{1,32}$/.test(token) && !token.includes("..")) {
			return token; // short bare words (subcommands, shard specs)
		}
		return "<redacted>"; // paths, globs, and anything possibly sensitive
	});
	return {
		executable,
		argvDigest: createHash("sha256").update(JSON.stringify(argv), "utf8").digest("hex"),
		redactedArgv,
	};
}

/** Structural plan validation: ids unique, dependencies resolvable and acyclic. */
export function validateWorkloadShardPlan(plan: WorkloadShardPlan): readonly string[] {
	const errors: string[] = [];
	if (plan.schemaVersion !== WORKLOAD_SHARD_PLAN_VERSION) {
		errors.push(`plan.schemaVersion: expected ${WORKLOAD_SHARD_PLAN_VERSION}`);
	}
	if (!Number.isSafeInteger(plan.maxConcurrency) || plan.maxConcurrency < 1) {
		errors.push("plan.maxConcurrency: must be a positive integer");
	}
	if (plan.shards.length === 0) {
		errors.push("plan.shards: must not be empty");
	}
	const ids = new Set<string>();
	for (const shard of plan.shards) {
		if (ids.has(shard.shardId)) {
			errors.push(`plan.shards: duplicate shardId ${shard.shardId}`);
		}
		ids.add(shard.shardId);
	}
	for (const shard of plan.shards) {
		for (const dependency of shard.dependencyIds) {
			if (!ids.has(dependency)) {
				errors.push(`plan.shards: ${shard.shardId} depends on unknown ${dependency}`);
			}
		}
	}
	if (errors.length === 0 && hasDependencyCycle(plan.shards)) {
		errors.push("plan.shards: dependency cycle detected");
	}
	return errors;
}

function hasDependencyCycle(shards: readonly WorkloadShardSpec[]): boolean {
	const visiting = new Set<string>();
	const done = new Set<string>();
	const byId = new Map(shards.map((shard) => [shard.shardId, shard]));
	const visit = (id: string): boolean => {
		if (done.has(id)) return false;
		if (visiting.has(id)) return true;
		visiting.add(id);
		for (const dependency of byId.get(id)?.dependencyIds ?? []) {
			if (visit(dependency)) return true;
		}
		visiting.delete(id);
		done.add(id);
		return false;
	};
	return shards.some((shard) => visit(shard.shardId));
}

export interface WorkloadShardProjection {
	readonly shardId: string;
	readonly state: WorkloadShardState;
	readonly attempt: number;
	readonly evidenceRefs: readonly string[];
	readonly reasonCode?: string;
}

export class WorkloadShardTransitionError extends Error {
	readonly shardId: string;
	constructor(shardId: string, message: string) {
		super(`shard ${shardId}: ${message}`);
		this.name = "WorkloadShardTransitionError";
		this.shardId = shardId;
	}
}

/**
 * Deterministic replay of transition records into per-shard projections
 * (§23.2 property 10). Fail closed (§21): unknown shards, illegal §13.4
 * transitions, or non-monotonic attempts throw instead of guessing.
 */
export function reduceShardRecords(
	plan: WorkloadShardPlan,
	records: readonly WorkloadShardRecord[],
): ReadonlyMap<string, WorkloadShardProjection> {
	const projections = new Map<string, WorkloadShardProjection>();
	for (const shard of plan.shards) {
		projections.set(shard.shardId, { shardId: shard.shardId, state: "pending", attempt: 0, evidenceRefs: [] });
	}
	for (const record of records) {
		const current = projections.get(record.shardId);
		if (current === undefined) {
			throw new WorkloadShardTransitionError(record.shardId, "transition for shard not in plan");
		}
		if (record.planId !== plan.planId) {
			throw new WorkloadShardTransitionError(record.shardId, `record planId ${record.planId} != ${plan.planId}`);
		}
		if (!canTransitionShardState(current.state, record.state)) {
			throw new WorkloadShardTransitionError(
				record.shardId,
				`illegal transition ${current.state} -> ${record.state}`,
			);
		}
		const expectedAttempt = record.state === "running" ? current.attempt + 1 : current.attempt;
		if (record.attempt !== expectedAttempt) {
			throw new WorkloadShardTransitionError(
				record.shardId,
				`attempt ${record.attempt} != expected ${expectedAttempt} for ${record.state}`,
			);
		}
		projections.set(record.shardId, {
			shardId: record.shardId,
			state: record.state,
			attempt: expectedAttempt,
			evidenceRefs: record.evidenceRefs.length > 0 ? record.evidenceRefs : current.evidenceRefs,
			reasonCode: record.reasonCode ?? (record.state === "pending" ? undefined : current.reasonCode),
		});
	}
	return projections;
}

export interface WorkloadShardResumePlan {
	/** §13.5 step 3 / §23.2 property 9: passed shards are never re-run. */
	readonly skip: readonly string[];
	/** Pending shards whose dependencies all passed (§13.5 step 5). */
	readonly ready: readonly string[];
	/** Pending shards still blocked on dependencies. */
	readonly blocked: readonly string[];
	/** Failed shards awaiting the caller's retry policy (§13.5 step 4). */
	readonly retryable: readonly string[];
	/** Aborted shards that need an explicit resume decision (§13.4). */
	readonly resumable: readonly string[];
	/** Shards projected interrupted: `running` with no terminal record (§13.5 step 2). */
	readonly interrupted: readonly string[];
}

/** §13.5 resume projection. Pure; ordering follows plan order for determinism. */
export function planShardResume(
	plan: WorkloadShardPlan,
	projections: ReadonlyMap<string, WorkloadShardProjection>,
): WorkloadShardResumePlan {
	const skip: string[] = [];
	const ready: string[] = [];
	const blocked: string[] = [];
	const retryable: string[] = [];
	const resumable: string[] = [];
	const interrupted: string[] = [];
	const stateOf = (id: string): WorkloadShardState => projections.get(id)?.state ?? "pending";
	for (const shard of plan.shards) {
		switch (stateOf(shard.shardId)) {
			case "passed":
				skip.push(shard.shardId);
				break;
			case "failed":
				retryable.push(shard.shardId);
				break;
			case "aborted":
				resumable.push(shard.shardId);
				break;
			// A crash can leave `running` with no terminal record; recovery
			// projects it as interrupted work needing a fresh attempt.
			case "running":
			case "interrupted":
				interrupted.push(shard.shardId);
				break;
			case "pending":
				if (shard.dependencyIds.every((dependency) => stateOf(dependency) === "passed")) {
					ready.push(shard.shardId);
				} else {
					blocked.push(shard.shardId);
				}
				break;
			default:
				break;
		}
	}
	return { skip, ready, blocked, retryable, resumable, interrupted };
}

function basename(token: string): string {
	const slash = token.lastIndexOf("/");
	return slash === -1 ? token : token.slice(slash + 1);
}
