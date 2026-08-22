import { randomUUID } from "node:crypto";
import type { WorkloadClass } from "./workload-classifier.ts";

/**
 * Shared workload permit pool (OMK v0.97.x roadmap §10, M3/PR5).
 *
 * Bounds concurrent heavy/cpu subprocesses independently of tool concurrency
 * (§10.1: 4 concurrent reads != 4 concurrent `npm test` processes). One pool
 * instance is shared by a session and, later, its child subagents (§14.1) —
 * a child creating its own pool would oversubscribe the host.
 *
 * §10.3 rules implemented here: strict FIFO (§10.4), abort- and
 * timeout-aware waiting, exactly-once release with double-release recorded
 * as a diagnostic no-op, immediate rejection of requests wider than
 * capacity, and a hard queue cap whose overflow surfaces as a structured
 * error code (§15.4 `queue_overflow`). Waiter timers stay ref'd — a permit
 * wait is actively awaited work — and are cleared on settle.
 */

export interface WorkloadPermitRequest {
	readonly requestId: string;
	readonly promptRunId: string;
	readonly workloadClass: WorkloadClass;
	readonly weight: 1 | 2;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

export interface WorkloadPermit {
	readonly permitId: string;
	readonly requestId: string;
	readonly acquiredAt: string;
	release(): void;
}

export interface WorkloadPermitPoolSnapshot {
	readonly capacity: number;
	readonly activeWeight: number;
	readonly queuedCount: number;
}

export type WorkloadPermitErrorCode = "queue_overflow" | "timeout" | "aborted" | "over_capacity_weight";

export class WorkloadPermitError extends Error {
	readonly code: WorkloadPermitErrorCode;
	readonly requestId: string;

	constructor(code: WorkloadPermitErrorCode, requestId: string) {
		super(`workload permit ${code} (request ${requestId})`);
		this.name = "WorkloadPermitError";
		this.code = code;
		this.requestId = requestId;
	}
}

interface Waiter {
	readonly request: WorkloadPermitRequest;
	readonly resolve: (permit: WorkloadPermit) => void;
	readonly reject: (error: WorkloadPermitError) => void;
	timer: ReturnType<typeof setTimeout> | null;
	abortListener: (() => void) | null;
}

export const DEFAULT_PERMIT_QUEUE_CAP = 32;

export type WorkloadPermitPoolOptions = {
	/** Concurrent weight budget; §7.2 heavy caps feed this. Default 2. */
	capacity?: number;
	/** §10.3 queue length hard cap. Default 32. */
	maxQueue?: number;
	/** Injectable clock for deterministic tests. */
	now?: () => Date;
};

export class WorkloadPermitPool {
	private capacity: number;
	private readonly maxQueue: number;
	private readonly now: () => Date;
	private activeWeight = 0;
	private readonly queue: Waiter[] = [];
	private readonly releasedPermitIds = new Set<string>();
	private readonly activePermitIds = new Set<string>();
	private doubleReleases = 0;

	constructor(options?: WorkloadPermitPoolOptions) {
		this.capacity = sanitizeCapacity(options?.capacity, 2);
		this.maxQueue = sanitizeCapacity(options?.maxQueue, DEFAULT_PERMIT_QUEUE_CAP);
		this.now = options?.now ?? (() => new Date());
	}

	/**
	 * Update capacity from a new admission decision. In-flight permits are
	 * never revoked; a reduction only delays future grants until active
	 * weight drains below the new capacity.
	 */
	setCapacity(capacity: number): void {
		this.capacity = sanitizeCapacity(capacity, this.capacity);
		this.grantWhilePossible();
	}

	/** Acquire a permit. Strict FIFO; rejects with {@link WorkloadPermitError}. */
	acquire(request: WorkloadPermitRequest): Promise<WorkloadPermit> {
		if (request.weight > this.capacity) {
			return Promise.reject(new WorkloadPermitError("over_capacity_weight", request.requestId));
		}
		if (request.signal?.aborted) {
			return Promise.reject(new WorkloadPermitError("aborted", request.requestId));
		}
		if (this.queue.length === 0 && this.activeWeight + request.weight <= this.capacity) {
			return Promise.resolve(this.grant(request));
		}
		if (this.queue.length >= this.maxQueue) {
			return Promise.reject(new WorkloadPermitError("queue_overflow", request.requestId));
		}
		return new Promise<WorkloadPermit>((resolve, reject) => {
			const waiter: Waiter = { request, resolve, reject, timer: null, abortListener: null };
			if (typeof request.timeoutMs === "number" && Number.isFinite(request.timeoutMs) && request.timeoutMs > 0) {
				waiter.timer = setTimeout(() => {
					this.evict(waiter, "timeout");
				}, request.timeoutMs);
			}
			if (request.signal) {
				const signal = request.signal;
				waiter.abortListener = () => {
					this.evict(waiter, "aborted");
				};
				signal.addEventListener("abort", waiter.abortListener, { once: true });
			}
			this.queue.push(waiter);
		});
	}

	snapshot(): WorkloadPermitPoolSnapshot {
		return { capacity: this.capacity, activeWeight: this.activeWeight, queuedCount: this.queue.length };
	}

	/** Diagnostic count of double releases (§10.3 no-op + diagnostic). */
	get doubleReleaseCount(): number {
		return this.doubleReleases;
	}

	private grant(request: WorkloadPermitRequest): WorkloadPermit {
		this.activeWeight += request.weight;
		const permitId = `permit-${randomUUID()}`;
		this.activePermitIds.add(permitId);
		const release = (): void => {
			// §10.3 exactly-once: a late or repeated settlement must not return
			// weight it no longer owns.
			if (this.releasedPermitIds.has(permitId) || !this.activePermitIds.has(permitId)) {
				this.doubleReleases += 1;
				return;
			}
			this.activePermitIds.delete(permitId);
			this.releasedPermitIds.add(permitId);
			this.activeWeight = Math.max(0, this.activeWeight - request.weight);
			this.grantWhilePossible();
		};
		return { permitId, requestId: request.requestId, acquiredAt: this.now().toISOString(), release };
	}

	/** Grant queued waiters strictly in FIFO order while the head fits (§10.4). */
	private grantWhilePossible(): void {
		while (this.queue.length > 0) {
			const head = this.queue[0];
			if (head.request.weight > this.capacity) {
				// Capacity shrank below the head's weight: reject rather than
				// starving everyone behind it forever.
				this.queue.shift();
				this.settleCleanup(head);
				head.reject(new WorkloadPermitError("over_capacity_weight", head.request.requestId));
				continue;
			}
			if (this.activeWeight + head.request.weight > this.capacity) {
				return;
			}
			this.queue.shift();
			this.settleCleanup(head);
			head.resolve(this.grant(head.request));
		}
	}

	private evict(waiter: Waiter, code: WorkloadPermitErrorCode): void {
		const index = this.queue.indexOf(waiter);
		if (index === -1) {
			return; // Already granted or already evicted.
		}
		this.queue.splice(index, 1);
		this.settleCleanup(waiter);
		waiter.reject(new WorkloadPermitError(code, waiter.request.requestId));
	}

	private settleCleanup(waiter: Waiter): void {
		if (waiter.timer !== null) {
			clearTimeout(waiter.timer);
			waiter.timer = null;
		}
		if (waiter.abortListener !== null) {
			waiter.request.signal?.removeEventListener("abort", waiter.abortListener);
			waiter.abortListener = null;
		}
	}
}

function sanitizeCapacity(value: number | undefined, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
		return fallback;
	}
	return Math.floor(value);
}
