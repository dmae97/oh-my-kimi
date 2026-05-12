import { logger } from "@oh-my-pi/pi-utils";

const DELIVERY_RETRY_BASE_MS = 500;
const DELIVERY_RETRY_MAX_MS = 30_000;
const DELIVERY_RETRY_JITTER_MS = 200;
const DEFAULT_RETENTION_MS = 5 * 60 * 1000;
const DEFAULT_MAX_RUNNING_JOBS = 15;

export interface AsyncJob {
	id: string;
	type: "bash" | "task";
	status: "running" | "completed" | "failed" | "cancelled";
	startTime: number;
	label: string;
	abortController: AbortController;
	promise: Promise<void>;
	resultText?: string;
	errorText?: string;
}

export interface AsyncJobManagerOptions {
	onJobComplete: (jobId: string, text: string, job?: AsyncJob) => void | Promise<void>;
	maxRunningJobs?: number;
	retentionMs?: number;
}

interface AsyncJobDelivery {
	jobId: string;
	text: string;
	attempt: number;
	nextAttemptAt: number;
	lastError?: string;
}

export interface AsyncJobDeliveryState {
	queued: number;
	delivering: boolean;
	nextRetryAt?: number;
	pendingJobIds: string[];
}

export interface AsyncJobRegisterOptions {
	id?: string;
	onProgress?: (text: string, details?: Record<string, unknown>) => void | Promise<void>;
}

export class AsyncJobManager {
	static #instance: AsyncJobManager | undefined;

	/** Process-global instance shared by internal URL protocol handlers and tools. */
	static instance(): AsyncJobManager | undefined {
		return AsyncJobManager.#instance;
	}

	/** Install or clear the process-global instance. */
	static setInstance(value: AsyncJobManager | undefined): void {
		AsyncJobManager.#instance = value;
	}

	/** Reset the process-global instance. Test-only. */
	static resetForTests(): void {
		AsyncJobManager.#instance = undefined;
	}

	readonly #jobs = new Map<string, AsyncJob>();
	readonly #deliveries: AsyncJobDelivery[] = [];
	readonly #suppressedDeliveries = new Set<string>();
	readonly #watchedJobs = new Set<string>();
	readonly #evictionTimers = new Map<string, NodeJS.Timeout>();
	readonly #onJobComplete: AsyncJobManagerOptions["onJobComplete"];
	readonly #maxRunningJobs: number;
	readonly #retentionMs: number;
	#deliveryLoop: Promise<void> | undefined;
	#disposed = false;

	constructor(options: AsyncJobManagerOptions) {
		this.#onJobComplete = options.onJobComplete;
		this.#maxRunningJobs = Math.max(1, Math.floor(options.maxRunningJobs ?? DEFAULT_MAX_RUNNING_JOBS));
		this.#retentionMs = Math.max(0, Math.floor(options.retentionMs ?? DEFAULT_RETENTION_MS));
	}

	register(
		type: "bash" | "task",
		label: string,
		run: (ctx: {
			jobId: string;
			signal: AbortSignal;
			reportProgress: (text: string, details?: Record<string, unknown>) => Promise<void>;
		}) => Promise<string>,
		options?: AsyncJobRegisterOptions,
	): string {
		if (this.#disposed) {
			throw new Error("Async job manager is disposed");
		}
		const runningCount = this.getRunningJobs().length;
		if (runningCount >= this.#maxRunningJobs) {
			throw new Error(
				`Background job limit reached (${this.#maxRunningJobs}). Wait for running jobs to finish or cancel one.`,
			);
		}

		const id = this.#resolveJobId(options?.id);
		this.#suppressedDeliveries.delete(id);
		const abortController = new AbortController();
		const startTime = Date.now();

		const job: AsyncJob = {
			id,
			type,
			status: "running",
			startTime,
			label,
			abortController,
			promise: Promise.resolve(),
		};

		const reportProgress = async (text: string, details?: Record<string, unknown>): Promise<void> => {
			if (!options?.onProgress) return;
			try {
				await options.onProgress(text, details);
			} catch (error) {
				logger.warn("Async job progress callback failed", {
					jobId: id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		};
		job.promise = (async () => {
			try {
				const text = await run({ jobId: id, signal: abortController.signal, reportProgress });
				if (job.status === "cancelled") {
					job.resultText = text;
					this.#scheduleEviction(id);
					return;
				}
				job.status = "completed";
				job.resultText = text;
				this.#enqueueDelivery(id, text);
				this.#scheduleEviction(id);
			} catch (error) {
				if (job.status === "cancelled") {
					job.errorText = error instanceof Error ? error.message : String(error);
					this.#scheduleEviction(id);
					return;
				}
				const errorText = error instanceof Error ? error.message : String(error);
				job.status = "failed";
				job.errorText = errorText;
				this.#enqueueDelivery(id, errorText);
				this.#scheduleEviction(id);
			}
		})();

		this.#jobs.set(id, job);
		return id;
	}

	cancel(id: string): boolean {
		const job = this.#jobs.get(id);
		if (!job) return false;
		if (job.status !== "running") return false;
		job.status = "cancelled";
		job.abortController.abort();
		this.#scheduleEviction(id);
		return true;
	}

	getJob(id: string): AsyncJob | undefined {
		return this.#jobs.get(id);
	}

	getRunningJobs(): AsyncJob[] {
		return Array.from(this.#jobs.values()).filter(job => job.status === "running");
	}

	getRecentJobs(limit = 10): AsyncJob[] {
		return Array.from(this.#jobs.values())
			.filter(job => job.status !== "running")
			.sort((a, b) => b.startTime - a.startTime)
			.slice(0, limit);
	}

	getAllJobs(): AsyncJob[] {
		return Array.from(this.#jobs.values());
	}

	getDeliveryState(): AsyncJobDeliveryState {
		const nextRetryAt = this.#deliveries.reduce<number | undefined>((next, delivery) => {
			if (next === undefined) return delivery.nextAttemptAt;
			return Math.min(next, delivery.nextAttemptAt);
		}, undefined);

		return {
			queued: this.#deliveries.length,
			delivering: this.#deliveryLoop !== undefined,
			nextRetryAt,
			pendingJobIds: this.#deliveries.map(delivery => delivery.jobId),
		};
	}

	hasPendingDeliveries(): boolean {
		return this.#deliveries.length > 0;
	}

	watchJobs(jobIds: string[]): number {
		const uniqueJobIds = Array.from(new Set(jobIds.map(id => id.trim()).filter(id => id.length > 0)));
		for (const jobId of uniqueJobIds) {
			this.#watchedJobs.add(jobId);
		}
		return uniqueJobIds.length;
	}

	unwatchJobs(jobIds: string[]): number {
		const uniqueJobIds = Array.from(new Set(jobIds.map(id => id.trim()).filter(id => id.length > 0)));
		let removed = 0;
		for (const jobId of uniqueJobIds) {
			if (this.#watchedJobs.delete(jobId)) {
				removed += 1;
			}
		}
		return removed;
	}

	acknowledgeDeliveries(jobIds: string[]): number {
		const uniqueJobIds = Array.from(new Set(jobIds.map(id => id.trim()).filter(id => id.length > 0)));
		if (uniqueJobIds.length === 0) return 0;

		for (const jobId of uniqueJobIds) {
			this.#suppressedDeliveries.add(jobId);
		}

		const before = this.#deliveries.length;
		this.#deliveries.splice(
			0,
			this.#deliveries.length,
			...this.#deliveries.filter(delivery => !this.isDeliverySuppressed(delivery.jobId)),
		);
		return before - this.#deliveries.length;
	}

	cancelAll(): void {
		for (const job of this.getRunningJobs()) {
			job.status = "cancelled";
			job.abortController.abort();
			this.#scheduleEviction(job.id);
		}
	}

	async waitForAll(): Promise<void> {
		await Promise.all(Array.from(this.#jobs.values()).map(job => job.promise));
	}

	async drainDeliveries(options?: { timeoutMs?: number }): Promise<boolean> {
		const timeoutMs = options?.timeoutMs;
		const hasDeadline = timeoutMs !== undefined;
		const deadline = hasDeadline ? Date.now() + Math.max(timeoutMs, 0) : Number.POSITIVE_INFINITY;

		while (this.hasPendingDeliveries()) {
			this.#ensureDeliveryLoop();
			const loop = this.#deliveryLoop;
			if (!loop) {
				continue;
			}

			if (!hasDeadline) {
				await loop;
				continue;
			}

			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) {
				return false;
			}

			await Promise.race([loop, Bun.sleep(remainingMs)]);
			if (Date.now() >= deadline && this.hasPendingDeliveries()) {
				return false;
			}
		}

		return true;
	}

	async dispose(options?: { timeoutMs?: number }): Promise<boolean> {
		this.#disposed = true;
		this.#clearEvictionTimers();
		this.cancelAll();
		await this.waitForAll();
		const drained = await this.drainDeliveries({ timeoutMs: options?.timeoutMs ?? 3_000 });
		this.#clearEvictionTimers();
		this.#jobs.clear();
		this.#deliveries.length = 0;
		this.#suppressedDeliveries.clear();
		this.#watchedJobs.clear();
		return drained;
	}

	#resolveJobId(preferredId?: string): string {
		preferredId = preferredId?.trim();
		if (!preferredId) {
			let candidate = 1;
			while (true) {
				const id = `bg_${candidate}`;
				if (!this.#jobs.has(id)) {
					return id;
				}
				candidate += 1;
			}
		}

		const base = preferredId.trim();
		if (!this.#jobs.has(base)) return base;

		let suffix = 2;
		let candidate = `${base}-${suffix}`;
		while (this.#jobs.has(candidate)) {
			suffix += 1;
			candidate = `${base}-${suffix}`;
		}
		return candidate;
	}

	#scheduleEviction(jobId: string): void {
		if (this.#retentionMs <= 0) {
			this.#jobs.delete(jobId);
			this.#suppressedDeliveries.delete(jobId);
			this.#watchedJobs.delete(jobId);
			return;
		}
		const existing = this.#evictionTimers.get(jobId);
		if (existing) {
			clearTimeout(existing);
		}
		const timer = setTimeout(() => {
			this.#evictionTimers.delete(jobId);
			this.#jobs.delete(jobId);
			this.#suppressedDeliveries.delete(jobId);
			this.#watchedJobs.delete(jobId);
		}, this.#retentionMs);
		timer.unref();
		this.#evictionTimers.set(jobId, timer);
	}

	#clearEvictionTimers(): void {
		for (const timer of this.#evictionTimers.values()) {
			clearTimeout(timer);
		}
		this.#evictionTimers.clear();
	}

	isDeliverySuppressed(jobId: string): boolean {
		return this.#suppressedDeliveries.has(jobId) || this.#watchedJobs.has(jobId);
	}

	#enqueueDelivery(jobId: string, text: string): void {
		// Skip delivery if already acknowledged
		if (this.isDeliverySuppressed(jobId)) {
			return;
		}
		this.#deliveries.push({
			jobId,
			text,
			attempt: 0,
			nextAttemptAt: Date.now(),
		});
		this.#ensureDeliveryLoop();
	}

	#ensureDeliveryLoop(): void {
		if (this.#deliveryLoop) {
			return;
		}

		this.#deliveryLoop = this.#runDeliveryLoop()
			.catch(error => {
				logger.error("Async job delivery loop crashed", { error: String(error) });
			})
			.finally(() => {
				this.#deliveryLoop = undefined;
				if (this.#deliveries.length > 0) {
					this.#ensureDeliveryLoop();
				}
			});
	}

	async #runDeliveryLoop(): Promise<void> {
		while (this.#deliveries.length > 0) {
			const delivery = this.#deliveries[0];
			if (this.isDeliverySuppressed(delivery.jobId)) {
				this.#deliveries.shift();
				continue;
			}
			const waitMs = delivery.nextAttemptAt - Date.now();
			if (waitMs > 0) {
				await Bun.sleep(waitMs);
			}
			if (this.#deliveries[0] !== delivery) {
				continue;
			}
			// Check again after sleep
			if (this.isDeliverySuppressed(delivery.jobId)) {
				this.#deliveries.shift();
				continue;
			}

			try {
				await this.#onJobComplete(delivery.jobId, delivery.text, this.#jobs.get(delivery.jobId));
				this.#deliveries.shift();
			} catch (error) {
				delivery.attempt += 1;
				delivery.lastError = error instanceof Error ? error.message : String(error);
				delivery.nextAttemptAt = Date.now() + this.#getRetryDelay(delivery.attempt);
				this.#deliveries.shift();
				if (!this.isDeliverySuppressed(delivery.jobId)) {
					this.#deliveries.push(delivery);
				}
				logger.warn("Async job completion delivery failed", {
					jobId: delivery.jobId,
					attempt: delivery.attempt,
					nextRetryAt: delivery.nextAttemptAt,
					error: delivery.lastError,
				});
			}
		}
	}

	#getRetryDelay(attempt: number): number {
		const exp = Math.min(Math.max(attempt - 1, 0), 8);
		const backoffMs = DELIVERY_RETRY_BASE_MS * 2 ** exp;
		const jitterMs = Math.floor(Math.random() * DELIVERY_RETRY_JITTER_MS);
		return Math.min(DELIVERY_RETRY_MAX_MS, backoffMs + jitterMs);
	}
}
