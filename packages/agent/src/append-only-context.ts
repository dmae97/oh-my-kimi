/**
 * Append-only context mode — stabilizes the byte prefix sent to the LLM
 * across turns so provider prefix caches (DeepSeek, Anthropic, etc.)
 * hit at the maximum possible rate.
 *
 * Two mechanisms:
 *
 * 1. **StablePrefix** — system prompt + tool specs are computed once
 *    and frozen. Subsequent turns reuse the exact same byte sequence
 *    unless `invalidate()` is called (e.g. after MCP reconnect).
 *
 * 2. **AppendOnlyLog** — messages only grow; prior turns are never
 *    re-serialized. Combined with a stable prefix, only the user's new
 *    message delta is a cache miss each turn.
 */

import type { Context, Message, Tool } from "@oh-my-pi/pi-ai";
import type { AgentContext, AgentTool } from "./types";

// ---------------------------------------------------------------------------
// StablePrefix (formerly ImmutablePrefix)
// ---------------------------------------------------------------------------

/** Frozen system prompt + tool spec snapshot. */
export interface StablePrefixSnapshot {
	systemPrompt: string[];
	tools: Tool[];
	fingerprint: string;
}

/**
 * A frozen prefix (system prompt + tools) that produces stable byte
 * sequences across `build()` calls.
 *
 * The first `build()` snapshots the live state. Subsequent calls reuse
 * the cached copy until `invalidate()` is called or the live state's
 * fingerprint changes.
 */
export class StablePrefix {
	#snapshot: StablePrefixSnapshot | null = null;
	#version = 0;

	get fingerprint(): string {
		return this.#snapshot?.fingerprint ?? "<unbuilt>";
	}
	get version(): number {
		return this.#version;
	}
	get built(): boolean {
		return this.#snapshot !== null;
	}

	/**
	 * Build or rebuild from live context.
	 * Returns `true` if the prefix actually changed (cache miss imminent).
	 */
	build(context: AgentContext): boolean {
		const snapshot = takeSnapshot(context);
		if (this.#snapshot && this.#snapshot.fingerprint === snapshot.fingerprint) {
			return false;
		}
		this.#snapshot = snapshot;
		this.#version++;
		return true;
	}

	/** Force rebuild on the next `build()` call. */
	invalidate(): void {
		this.#snapshot = null;
	}

	/**
	 * Returns the cached prefix.
	 * @throws if `build()` was never called.
	 */
	toContext(): { systemPrompt: string[]; tools: Tool[] } {
		const s = this.#snapshot;
		if (!s) throw new Error("StablePrefix.toContext() called before build()");
		return { systemPrompt: s.systemPrompt, tools: s.tools };
	}
}

// ---------------------------------------------------------------------------
// AppendOnlyLog
// ---------------------------------------------------------------------------

/**
 * Append-only message log at the `Message[]` (provider-level) layer.
 *
 * The only mutation path is `replaceTail()`, reserved for compaction.
 * Every other operation is append-only.
 */
export class AppendOnlyLog {
	#entries: Message[] = [];

	get length(): number {
		return this.#entries.length;
	}

	append(message: any): void {
		this.#entries.push(message);
	}

	extend(messages: any[]): void {
		for (const m of messages) this.#entries.push(m);
	}

	/** Replace the last entry — only legal for compaction. */
	replaceTail(replacement: any): void {
		const idx = this.#entries.length - 1;
		if (idx >= 0) this.#entries[idx] = replacement;
	}

	/** Returns a shallow copy of all entries. */
	toMessages(): Message[] {
		return this.#entries.slice();
	}

	/** Direct readonly access for in-place inspection. */
	entries(): readonly Message[] {
		return this.#entries;
	}

	clear(): void {
		this.#entries = [];
	}
}

// ---------------------------------------------------------------------------
// AppendOnlyContextManager
// ---------------------------------------------------------------------------

/**
 * Manages a stable prefix + append-only log for the agent loop.
 *
 * Call `build(context)` each turn to get a `Context` with stable
 * `systemPrompt` and `tools` and append-only messages. Call
 * `syncMessages(normalizedMessages)` after `convertToLlm` each
 * turn to keep the log in sync.
 *
 * Example:
 * ```
 * const mgr = new AppendOnlyContextManager();
 * const ctx = mgr.build(context);  // first call snapshots prefix
 * mgr.syncMessages(normalized);    // grow the log
 * ctx = mgr.build(context);        // subsequent calls use cache
 * ```
 */
export class AppendOnlyContextManager {
	readonly prefix = new StablePrefix();
	readonly log = new AppendOnlyLog();
	/** How many normalized messages were synced into the log as of the last sync. */
	#lastSyncCount = 0;
	/** Rolling digest of synced message content — detects in-place rewrites. */
	#syncedDigest = 0;

	build(context: AgentContext): Context {
		this.prefix.build(context);
		const { systemPrompt, tools } = this.prefix.toContext();
		return { systemPrompt, messages: this.log.toMessages(), tools };
	}

	/**
	 * Sync normalized (provider-level) messages into the append-only log.
	 *
	 * Detects both compaction (shorter array) and in-place rewrites
	 * (same length, changed content via a rolling digest).
	 */
	syncMessages(normalizedMessages: any[]): void {
		// Detect in-place rewrites of already-synced messages.
		if (
			this.#lastSyncCount > 0 &&
			this.#lastSyncCount <= normalizedMessages.length &&
			this.#computeDigest(normalizedMessages.slice(0, this.#lastSyncCount)) !== this.#syncedDigest
		) {
			this.log.clear();
			this.#lastSyncCount = 0;
		}

		// Compaction — array shrunk.
		if (normalizedMessages.length < this.#lastSyncCount) {
			this.log.clear();
			this.#lastSyncCount = 0;
		}

		const newMsgs = normalizedMessages.slice(this.#lastSyncCount);
		for (const msg of newMsgs) {
			this.log.append(msg);
		}

		this.#lastSyncCount = normalizedMessages.length;
		this.#syncedDigest = this.#computeDigest(normalizedMessages);
	}

	/** Reset prefix + log for a model/provider switch while mode stays active. */
	invalidateForModelChange(): void {
		this.prefix.invalidate();
		this.log.clear();
		this.#lastSyncCount = 0;
		this.#syncedDigest = 0;
	}

	/** Reset the sync cursor AND clear the log. */
	resetSyncCursor(): void {
		this.log.clear();
		this.#lastSyncCount = 0;
		this.#syncedDigest = 0;
	}

	appendMessage(message: any): void {
		this.log.append(message);
	}

	replaceTailMessage(message: any): void {
		this.log.replaceTail(message);
	}

	invalidate(): void {
		this.prefix.invalidate();
	}

	reset(context: AgentContext): void {
		this.prefix.invalidate();
		this.log.clear();
		this.#lastSyncCount = 0;
		this.#syncedDigest = 0;
		this.prefix.build(context);
	}

	/** Fast rolling digest of message content. */
	#computeDigest(messages: any[]): number {
		let hash = 0;
		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];
			if (msg && typeof msg === "object") {
				const payload =
					String(msg.role) + (typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? ""));
				for (let j = 0; j < payload.length; j++) {
					hash = ((hash << 5) - hash + payload.charCodeAt(j)) | 0;
				}
			}
		}
		return hash >>> 0;
	}
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

/**
 * Produce a stable serialization of tools that matches what
 * `normalizeTools(tools, false)` outputs (no intent injection).
 *
 * The spread `{ ...agentTool }` preserves all own enumerable properties
 * that survive JSON.stringify — functions are dropped, but strings,
 * booleans, objects are included.
 */
function normalizeTool(t: AgentTool): Tool {
	const description = t.description ?? "";
	return { ...t, parameters: t.parameters, description };
}

function takeSnapshot(context: AgentContext): StablePrefixSnapshot {
	const systemPrompt = [...context.systemPrompt];
	const tools = (context.tools ?? []).map(normalizeTool);
	return {
		systemPrompt,
		tools,
		fingerprint: computeFingerprint(systemPrompt, tools),
	};
}

function computeFingerprint(systemPrompt: string[], tools: Tool[]): string {
	const payload = JSON.stringify({
		s: systemPrompt,
		t: tools.map(t => ({
			n: t.name,
			d: t.description,
			p: t.parameters,
			s: t.strict,
			cf: t.customFormat,
			cw: t.customWireName,
		})),
	});
	let hash = 0;
	for (let i = 0; i < payload.length; i++) {
		hash = ((hash << 5) - hash + payload.charCodeAt(i)) | 0;
	}
	return (hash >>> 0).toString(36);
}
