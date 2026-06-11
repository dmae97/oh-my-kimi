/**
 * AgentLifecycleManager - Owns the idle → parked → revived lifecycle of
 * adopted subagents.
 *
 * The task executor hands a finished agent over via {@link AgentLifecycleManager.adopt};
 * from then on the manager arms a TTL timer whenever the agent goes `idle`,
 * parks it on expiry (disposes the live session, keeps the AgentRef +
 * sessionFile), and revives it on demand through
 * {@link AgentLifecycleManager.ensureLive}. Only this manager flips
 * `parked` ↔ `idle`.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import { AgentRegistry, MAIN_AGENT_ID, type RegistryEvent } from "./agent-registry";

export type AgentReviver = () => Promise<AgentSession>;

export interface AdoptOptions {
	/** TTL before an idle agent is parked. <= 0 disables parking. */
	idleTtlMs: number;
	/** Recreates a live AgentSession from the ref's sessionFile. Absent => not resumable after park (e.g. isolated runs). */
	revive?: AgentReviver;
}

interface AdoptedAgent {
	idleTtlMs: number;
	revive?: AgentReviver;
	timer?: NodeJS.Timeout;
}

export class AgentLifecycleManager {
	static #global: AgentLifecycleManager | undefined;

	static global(): AgentLifecycleManager {
		if (!AgentLifecycleManager.#global) {
			AgentLifecycleManager.#global = new AgentLifecycleManager();
		}
		return AgentLifecycleManager.#global;
	}

	/** Reset the global manager. Test-only. */
	static resetGlobalForTests(): void {
		const current = AgentLifecycleManager.#global;
		if (current) {
			current.#unsubscribe?.();
			current.#unsubscribe = undefined;
			for (const adopted of current.#adopted.values()) {
				clearTimeout(adopted.timer);
			}
			current.#adopted.clear();
			current.#revivals.clear();
			current.#parking.clear();
		}
		AgentLifecycleManager.#global = undefined;
	}

	readonly #registry: AgentRegistry;
	readonly #adopted = new Map<string, AdoptedAgent>();
	/** Ids whose session is being disposed by {@link park} right now. */
	readonly #parking = new Set<string>();
	/** In-flight revives, so concurrent {@link ensureLive} calls coalesce. */
	readonly #revivals = new Map<string, Promise<AgentSession>>();
	#unsubscribe: (() => void) | undefined;

	constructor(registry: AgentRegistry = AgentRegistry.global()) {
		this.#registry = registry;
		this.#unsubscribe = registry.onChange(event => this.#onRegistryEvent(event));
	}

	/**
	 * Take ownership of a finished subagent. Caller has already set registry
	 * status to "idle". Arms the TTL timer (idleTtlMs <= 0 adopts without one).
	 */
	adopt(id: string, opts: AdoptOptions): void {
		if (id === MAIN_AGENT_ID) return;
		if (!this.#registry.get(id)) {
			logger.warn("AgentLifecycleManager.adopt: unknown agent id", { id });
			return;
		}
		const existing = this.#adopted.get(id);
		clearTimeout(existing?.timer);
		const adopted: AdoptedAgent = { idleTtlMs: opts.idleTtlMs, revive: opts.revive };
		this.#adopted.set(id, adopted);
		this.#armTimer(id, adopted);
	}

	/** True if the id is adopted (parked or live). */
	has(id: string): boolean {
		return this.#adopted.has(id);
	}

	/** True while {@link park} is disposing this agent's session (lets dispose hooks distinguish park from teardown). */
	isParking(id: string): boolean {
		return this.#parking.has(id);
	}

	/**
	 * Dispose the live session, detach it from the registry, and mark the
	 * agent `parked`. No-op unless the id is adopted and live.
	 */
	async park(id: string): Promise<void> {
		const adopted = this.#adopted.get(id);
		if (!adopted) return;
		const ref = this.#registry.get(id);
		if (!ref?.session) return;
		if (adopted.timer) {
			clearTimeout(adopted.timer);
			adopted.timer = undefined;
		}
		this.#parking.add(id);
		try {
			try {
				await ref.session.dispose();
			} catch (error) {
				logger.warn("AgentLifecycleManager.park: session dispose failed", { id, error: String(error) });
			}
			this.#registry.detachSession(id);
			this.#registry.setStatus(id, "parked");
		} finally {
			this.#parking.delete(id);
		}
	}

	/**
	 * Return the live session, reviving from the sessionFile if parked.
	 * Throws a plain Error if the id is unknown or parked without a reviver.
	 * Concurrent calls share one in-flight revive.
	 */
	async ensureLive(id: string): Promise<AgentSession> {
		const ref = this.#registry.get(id);
		if (!ref) {
			throw new Error(
				`Unknown agent "${id}" — it was never registered or has been released. If a transcript exists, read history://${id}.`,
			);
		}
		if (ref.session) return ref.session;
		const inflight = this.#revivals.get(id);
		if (inflight) return inflight;
		const adopted = this.#adopted.get(id);
		if (ref.status !== "parked" || !adopted?.revive) {
			throw new Error(
				`Agent "${id}" is ${ref.status} and cannot be revived${adopted?.revive ? "" : " (no reviver registered)"}. Its transcript remains readable at history://${id}.`,
			);
		}
		const revival = this.#revive(id, adopted.revive, ref.sessionFile);
		this.#revivals.set(id, revival);
		try {
			return await revival;
		} finally {
			this.#revivals.delete(id);
		}
	}

	/** Hard removal: dispose if live, unregister from registry, drop timers. */
	async release(id: string): Promise<void> {
		const adopted = this.#adopted.get(id);
		clearTimeout(adopted?.timer);
		this.#adopted.delete(id);
		const ref = this.#registry.get(id);
		if (ref?.session) {
			try {
				await ref.session.dispose();
			} catch (error) {
				logger.warn("AgentLifecycleManager.release: session dispose failed", { id, error: String(error) });
			}
		}
		this.#registry.unregister(id);
	}

	/** Teardown everything (process exit / main session dispose). */
	async dispose(): Promise<void> {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		const ids = [...this.#adopted.keys()];
		await Promise.all(ids.map(id => this.release(id)));
		this.#revivals.clear();
		this.#parking.clear();
	}

	async #revive(id: string, revive: AgentReviver, sessionFile: string | null): Promise<AgentSession> {
		const session = await revive();
		this.#registry.attachSession(id, session, sessionFile);
		// Emits status_changed → "idle", which re-arms the TTL timer below.
		this.#registry.setStatus(id, "idle");
		return session;
	}

	#armTimer(id: string, adopted: AdoptedAgent): void {
		if (adopted.idleTtlMs <= 0) return;
		clearTimeout(adopted.timer);
		const timer = setTimeout(() => {
			adopted.timer = undefined;
			void this.park(id);
		}, adopted.idleTtlMs);
		timer.unref?.();
		adopted.timer = timer;
	}

	#onRegistryEvent(event: RegistryEvent): void {
		const adopted = this.#adopted.get(event.ref.id);
		if (!adopted) return;
		if (event.type === "removed") {
			clearTimeout(adopted.timer);
			this.#adopted.delete(event.ref.id);
			return;
		}
		if (event.type !== "status_changed") return;
		if (event.ref.status === "running") {
			if (adopted.timer) {
				clearTimeout(adopted.timer);
				adopted.timer = undefined;
			}
		} else if (event.ref.status === "idle") {
			this.#armTimer(event.ref.id, adopted);
		}
	}
}
