import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
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
}

export class AdvisorRuntime {
	#lastCount = 0;
	#pending: string[] = [];
	#busy = false;
	#disposed = false;

	constructor(
		private readonly agent: AdvisorAgent,
		private readonly host: AdvisorRuntimeHost,
	) {}

	onTurnEnd(): void {
		if (this.#disposed) return;
		const render = this.#renderDelta();
		if (render) {
			this.#pending.push(render);
			void this.#drain();
		}
	}

	dispose(): void {
		this.#disposed = true;
		this.#pending = [];
		try {
			this.agent.abort("advisor disposed");
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
		this.#lastCount = 0;
		this.#pending = [];
		try {
			this.agent.reset();
		} catch {}
		try {
			this.agent.abort("advisor reset");
		} catch {}
	}

	/**
	 * Seed the cursor to the current transcript length when the advisor is enabled
	 * mid-session. Prevents the next turn from replaying the entire history to the
	 * advisor (which would be expensive and likely stale).
	 */
	seedTo(count: number): void {
		this.#lastCount = count;
		this.#pending = [];
	}

	#renderDelta(): string | null {
		const all = this.host.snapshotMessages();
		if (all.length < this.#lastCount) {
			this.#lastCount = all.length;
			return null;
		}
		const delta = all
			.slice(this.#lastCount)
			.filter(m => !(m.role === "custom" && (m as { customType?: string }).customType === "advisor"));
		this.#lastCount = all.length;
		if (delta.length === 0) return null;
		const md = formatSessionHistoryMarkdown(delta, { includeThinking: true });
		return md.trim() ? md : null;
	}

	async #drain(): Promise<void> {
		if (this.#busy) return;
		this.#busy = true;
		try {
			while (!this.#disposed && this.#pending.length) {
				const batch = this.#pending.splice(0).join("\n\n---\n\n");
				try {
					await this.agent.prompt(batch);
				} catch (err) {
					logger.debug("advisor turn failed", { err: String(err) });
				}
			}
		} finally {
			this.#busy = false;
		}
	}
}
