import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";

export interface YieldDispatcher<P> {
	/** Drop entries already delivered through another path. Called per-entry at flush time. */
	isStale?(entry: P): boolean;
	/** Produce one batched AgentMessage from non-stale entries. Return null to skip. */
	build(survivors: P[]): AgentMessage | null;
}

export interface YieldQueueOptions {
	isStreaming: () => boolean;
	injectStreaming?(msg: AgentMessage): void;
	injectIdle(messages: AgentMessage[]): Promise<void>;
	scheduleIdleFlush(run: () => Promise<void>): void;
}

type YieldFlushMode = "streaming" | "idle";

interface StoredDispatcher {
	isStale?: (entry: unknown) => boolean;
	build: (survivors: unknown[]) => AgentMessage | null;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class YieldQueue {
	readonly #options: YieldQueueOptions;
	readonly #dispatchers = new Map<string, StoredDispatcher>();
	readonly #entries = new Map<string, unknown[]>();
	#idleFlushPending = false;

	constructor(options: YieldQueueOptions) {
		this.#options = options;
	}

	register<P>(kind: string, dispatcher: YieldDispatcher<P>): () => void {
		const stored: StoredDispatcher = {
			...(dispatcher.isStale ? { isStale: entry => dispatcher.isStale?.(entry as P) ?? false } : {}),
			build: survivors => dispatcher.build(survivors as P[]),
		};
		this.#dispatchers.set(kind, stored);
		return () => {
			if (this.#dispatchers.get(kind) !== stored) return;
			this.#dispatchers.delete(kind);
			this.#entries.delete(kind);
		};
	}

	enqueue<P>(kind: string, entry: P): void {
		if (!this.#dispatchers.has(kind)) {
			logger.warn("Yield queue entry ignored for unregistered kind", { kind });
			return;
		}
		let entries = this.#entries.get(kind);
		if (!entries) {
			entries = [];
			this.#entries.set(kind, entries);
		}
		entries.push(entry);
		if (!this.#options.isStreaming()) {
			this.#scheduleIdleFlush();
		}
	}

	has(kind?: string): boolean {
		if (kind !== undefined) return (this.#entries.get(kind)?.length ?? 0) > 0;
		for (const entries of this.#entries.values()) {
			if (entries.length > 0) return true;
		}
		return false;
	}

	async flush(mode: YieldFlushMode): Promise<void> {
		if (mode === "idle") {
			this.#idleFlushPending = false;
		}
		const idleMessages: AgentMessage[] = [];
		for (const [kind, dispatcher] of this.#dispatchers) {
			const entries = this.#drain(kind);
			if (entries.length === 0) continue;
			const message = this.#build(kind, dispatcher, entries);
			if (!message) continue;
			if (mode === "streaming") {
				try {
					this.#options.injectStreaming?.(message);
				} catch (error) {
					logger.warn("Yield queue streaming dispatch failed", { kind, error: formatError(error) });
				}
			} else {
				idleMessages.push(message);
			}
		}
		if (mode === "idle" && idleMessages.length > 0) {
			try {
				await this.#options.injectIdle(idleMessages);
			} catch (error) {
				logger.warn("Yield queue idle dispatch failed", { error: formatError(error) });
			}
		}
	}

	/**
	 * Snapshot and remove all queued entries, returning one lazy thunk per kind.
	 * Each thunk applies the dispatcher's staleness filter and builds the batched
	 * message only when called — so the consumer (the agent loop) decides, at the
	 * moment it injects, whether the message is still worth delivering (a thunk may
	 * return null to skip). Background-job completions and late diagnostics reach
	 * the model between requests without the agent having to stop.
	 */
	drainLazy(): Array<() => AgentMessage | null> {
		const thunks: Array<() => AgentMessage | null> = [];
		for (const [kind, dispatcher] of this.#dispatchers) {
			const entries = this.#drain(kind);
			if (entries.length === 0) continue;
			thunks.push(() => this.#build(kind, dispatcher, entries));
		}
		return thunks;
	}

	clear(): void {
		this.#entries.clear();
		this.#idleFlushPending = false;
	}

	#scheduleIdleFlush(): void {
		if (this.#idleFlushPending) return;
		this.#idleFlushPending = true;
		try {
			this.#options.scheduleIdleFlush(async () => {
				this.#idleFlushPending = false;
				if (this.#options.isStreaming()) return;
				await this.flush("idle");
			});
		} catch (error) {
			this.#idleFlushPending = false;
			logger.warn("Yield queue idle flush scheduling failed", { error: formatError(error) });
		}
	}

	#drain(kind: string): unknown[] {
		const entries = this.#entries.get(kind);
		if (!entries || entries.length === 0) return [];
		this.#entries.delete(kind);
		return entries;
	}

	#build(kind: string, dispatcher: StoredDispatcher, entries: unknown[]): AgentMessage | null {
		const survivors: unknown[] = [];
		for (const entry of entries) {
			if (dispatcher.isStale) {
				let stale: boolean;
				try {
					stale = dispatcher.isStale(entry);
				} catch (error) {
					logger.warn("Yield queue stale check failed", { kind, error: formatError(error) });
					continue;
				}
				if (stale) continue;
			}
			survivors.push(entry);
		}
		if (survivors.length === 0) return null;
		try {
			return dispatcher.build(survivors);
		} catch (error) {
			logger.warn("Yield queue build failed", { kind, error: formatError(error) });
			return null;
		}
	}
}
