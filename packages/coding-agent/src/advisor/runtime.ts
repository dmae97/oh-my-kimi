import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { estimateTokens } from "@oh-my-pi/pi-agent-core/compaction";
import { logger } from "@oh-my-pi/pi-utils";
import { formatSessionHistoryMarkdown } from "../session/session-history-format";

/** Minimal slice of `Agent` the runtime drives — satisfied by pi-agent-core `Agent`. */
export interface AdvisorAgent {
	prompt(input: string): Promise<void>;
	abort(reason?: unknown): void;
	reset(): void;
	readonly state: { messages: AgentMessage[] };
}

export interface AdvisorRuntimeHost {
	/** Live primary transcript (use `agent.state.messages`). */
	snapshotMessages(): AgentMessage[];
	/** Surface one advice note to the primary (enqueues into the session YieldQueue). */
	enqueueAdvice(note: string, severity?: "nit" | "concern" | "blocker"): void;
	/**
	 * Pre-prompt context maintenance for the advisor's own append-only context.
	 * Promotes the advisor model to a larger sibling when its context nears the
	 * window (mirroring the primary's promote-first policy) and resolves `true`
	 * when the advisor should re-prime — reset and replay the current
	 * primary-bounded transcript — because promotion did not free enough room.
	 * Optional: hosts that omit it get no maintenance (context only shrinks when
	 * the primary's next compaction triggers {@link AdvisorRuntime.reset}).
	 */
	maintainContext?(incomingTokens: number): Promise<boolean>;
}

interface PendingDelta {
	text: string;
	turns: number;
}

interface CatchupWaiter {
	threshold: number;
	resolve: () => void;
	finish: () => void;
	timer?: NodeJS.Timeout;
}

export class AdvisorRuntime {
	#lastCount = 0;
	#pending: PendingDelta[] = [];
	#busy = false;
	#backlog = 0;
	#consecutiveFailures = 0;
	#latestMessages?: AgentMessage[];
	#waiters: CatchupWaiter[] = [];
	/** Bumped by every external {@link reset}/{@link dispose}. A drain iteration
	 *  captures it before its awaits; a mismatch on resume means a reset aborted
	 *  the in-flight advisor prompt, so the stale batch is dropped instead of
	 *  being retried/requeued into the post-reset conversation. */
	#epoch = 0;
	disposed = false;

	constructor(
		private readonly agent: AdvisorAgent,
		private readonly host: AdvisorRuntimeHost,
		private readonly retryDelayMs = 1000,
	) {}

	get backlog(): number {
		return this.#backlog;
	}

	onTurnEnd(messages?: AgentMessage[]): void {
		if (this.disposed) return;
		const all = messages ?? this.host.snapshotMessages();
		this.#latestMessages = all;
		const render = this.#renderDelta(all);
		if (render) {
			this.#pending.push({ text: render, turns: 1 });
			this.#backlog++;
			this.#notifyWaiters();
			void this.#drain();
		}
	}

	waitForCatchup(maxMs: number, threshold: number, signal?: AbortSignal): Promise<void> {
		if (this.disposed || signal?.aborted || this.#backlog < threshold) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		let waiter!: CatchupWaiter;
		const finish = (): void => {
			const idx = this.#waiters.indexOf(waiter);
			if (idx >= 0) this.#waiters.splice(idx, 1);
			clearTimeout(waiter.timer);
			signal?.removeEventListener("abort", finish);
			resolve();
		};
		waiter = { threshold, resolve, finish, timer: setTimeout(finish, maxMs) };
		this.#waiters.push(waiter);
		signal?.addEventListener("abort", finish, { once: true });
		if (signal?.aborted) {
			finish();
		}
		return promise;
	}

	dispose(): void {
		this.disposed = true;
		this.#epoch++;
		this.#pending = [];
		this.#backlog = 0;
		this.#consecutiveFailures = 0;
		this.#wakeAllWaiters();
		try {
			this.agent.abort("advisor disposed");
		} catch {}
	}

	#resetAdvisorContext(clearBacklog: boolean, wakeWaiters: boolean): void {
		this.#lastCount = 0;
		this.#pending = [];
		this.#consecutiveFailures = 0;
		if (clearBacklog) {
			this.#backlog = 0;
		}
		if (wakeWaiters) {
			this.#wakeAllWaiters();
		}
		try {
			this.agent.reset();
		} catch {}
		try {
			this.agent.abort("advisor reset");
		} catch {}
	}

	/**
	 * Re-prime the advisor after a history rewrite (compaction, session
	 * switch/resume, branch). Clears the advisor's own (non-persisted) context
	 * and rewinds the cursor to 0 so the NEXT turn replays the full current —
	 * post-compaction — transcript, giving the advisor fresh context instead of
	 * leaving it blind to everything before the rewrite.
	 */
	reset(): void {
		this.#epoch++;
		this.#resetAdvisorContext(true, true);
	}

	/**
	 * Seed the cursor to the current transcript length when the advisor is enabled
	 * mid-session. Prevents the next turn from replaying the entire history to the
	 * advisor (which would be expensive and likely stale).
	 */
	seedTo(count: number): void {
		this.#lastCount = count;
		this.#pending = [];
		this.#backlog = 0;
		this.#consecutiveFailures = 0;
		this.#wakeAllWaiters();
	}

	#renderDelta(messages?: AgentMessage[]): string | null {
		const all = messages ?? this.#latestMessages ?? this.host.snapshotMessages();
		if (all.length < this.#lastCount) {
			this.#lastCount = all.length;
			return null;
		}
		const delta = all
			.slice(this.#lastCount)
			.filter(m => !(m.role === "custom" && (m as { customType?: string }).customType === "advisor"));
		this.#lastCount = all.length;
		if (delta.length === 0) return null;
		const md = formatSessionHistoryMarkdown(delta, {
			includeThinking: true,
			includeToolIntent: true,
			watchedRoles: true,
		});
		if (!md.trim()) return null;
		return `### Session update\n\n${md}`;
	}

	#notifyWaiters(): void {
		for (let i = this.#waiters.length - 1; i >= 0; i--) {
			const w = this.#waiters[i];
			if (this.#backlog < w.threshold) {
				w.finish();
			}
		}
	}

	#wakeAllWaiters(): void {
		for (const w of [...this.#waiters]) {
			w.finish();
		}
	}

	async #drain(): Promise<void> {
		if (this.#busy) return;
		this.#busy = true;
		try {
			while (!this.disposed && this.#pending.length) {
				const popped = this.#pending.splice(0);
				const epoch = this.#epoch;
				// Each delta already opens with a `### Session update` heading, so
				// join with a blank line rather than a `---` rule.
				const candidateBatch = popped.map(b => b.text).join("\n\n");
				const turnsCovered = popped.reduce((sum, b) => sum + b.turns, 0);
				const incomingTokens = estimateTokens({
					role: "user",
					content: candidateBatch,
					timestamp: Date.now(),
				});

				let shouldReprime = false;
				if (this.host.maintainContext) {
					try {
						shouldReprime = await this.host.maintainContext(incomingTokens);
					} catch (err) {
						logger.debug("advisor context maintenance failed", { err: String(err) });
					}
				}
				// A reset/dispose during context maintenance invalidates this batch.
				if (this.#epoch !== epoch) continue;

				let batch: string | null;
				let finalTurns: number;
				if (shouldReprime) {
					// Promotion could not fit the advisor's context — re-prime.
					const newTurns = this.#pending.reduce((sum, b) => sum + b.turns, 0);
					this.#resetAdvisorContext(false, false);
					batch = this.#renderDelta(this.#latestMessages);
					finalTurns = turnsCovered + newTurns;
				} else {
					batch = candidateBatch;
					finalTurns = turnsCovered;
				}

				if (this.disposed || batch === null) {
					this.#backlog = Math.max(0, this.#backlog - finalTurns);
					this.#notifyWaiters();
					continue;
				}

				let success = false;
				try {
					await this.agent.prompt(batch);
					success = true;
					this.#consecutiveFailures = 0;
				} catch (err) {
					// reset()/dispose() aborts the in-flight prompt; the rejection is the
					// reset itself, not a transient advisor failure. Drop the stale batch
					// (reset already cleared #pending and rewound the cursor) instead of
					// requeuing it into the post-reset conversation.
					if (this.#epoch !== epoch) continue;
					logger.debug("advisor turn failed", { err: String(err) });
					this.#consecutiveFailures++;
					if (this.#consecutiveFailures >= 3) {
						logger.warn("advisor failed consecutively 3 times; dropping backlog to prevent stall");
						this.#consecutiveFailures = 0;
						success = true;
					} else {
						this.#pending.unshift({ text: batch, turns: finalTurns });
						await Bun.sleep(this.retryDelayMs);
					}
				}

				if (success && this.#epoch === epoch) {
					this.#backlog = Math.max(0, this.#backlog - finalTurns);
					this.#notifyWaiters();
				}
			}
		} finally {
			this.#busy = false;
		}
	}
}
