/**
 * Tool output pruning utilities for compaction.
 */

import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { AgentMessage, AgentToolCall } from "../types";
import { estimateTokens } from "./compaction";
import type { SessionEntry, SessionMessageEntry } from "./entries";
import {
	collectToolCallsById,
	isProtectedToolResult,
	isSkillReadToolResult,
	type ProtectedToolMatcher,
} from "./tool-protection";
import { splitReadSelector } from "./utils";

export interface PruneConfig {
	/** Keep the most recent tool output tokens intact. */
	protectTokens: number;
	/** Only prune if total savings meets this threshold. */
	minimumSavings: number;
	/** Tool-result protection matchers. String entries protect every result from that tool; predicates may inspect the paired tool call. */
	protectedTools: ProtectedToolMatcher[];
	/**
	 * Optional supersede key function (see {@link SupersedePruneConfig.supersedeKey}).
	 * When provided, superseded tool results are pruned first — even inside the
	 * `protectTokens` window — before age-based victims. Absent, behavior is
	 * unchanged.
	 */
	supersedeKey?: SupersedeKeyFn;
}

export const DEFAULT_PRUNE_CONFIG: PruneConfig = {
	protectTokens: 40_000,
	minimumSavings: 20_000,
	protectedTools: ["skill", isSkillReadToolResult],
};

export interface PruneResult {
	prunedCount: number;
	tokensSaved: number;
}

/** Exact placeholder written over a superseded tool result. */
export const SUPERSEDED_NOTICE = "[Superseded by a newer read of this file]";

/**
 * Maps a tool call to a supersede key. Results sharing a key form a group in
 * which every result except the newest is a supersede candidate. A key `K`
 * additionally supersedes keys with prefix `K + "\u0000"` (selector-free read
 * supersedes selector-carrying reads of the same base path). Return
 * `undefined` to exempt a call from supersede grouping.
 */
export type SupersedeKeyFn = (toolName: string, args: Record<string, unknown>) => string | undefined;

export interface SupersedePruneConfig {
	/** Supersede key function; results sharing a key supersede older ones. */
	supersedeKey: SupersedeKeyFn;
	/** Prune a candidate now when all messages after it total at most this many estimated tokens. Default 8 000. */
	suffixTokenLimit?: number;
	/** Prune all candidates when the last message is at least this old (prompt cache is cold anyway). Default 30 min. */
	idleFlushMs?: number;
	/** Clock override for tests. */
	now?: number;
	/** Tool-result protection matchers (same contract as {@link PruneConfig.protectedTools}). */
	protectedTools: ProtectedToolMatcher[];
}

const DEFAULT_SUFFIX_TOKEN_LIMIT = 8_000;
const DEFAULT_IDLE_FLUSH_MS = 30 * 60_000;

function createPrunedNotice(tokens: number): string {
	return `[Output truncated - ${tokens} tokens]`;
}

function getToolResultMessage(entry: SessionEntry): ToolResultMessage | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message as AgentMessage;
	if (message.role !== "toolResult") return undefined;
	return message as ToolResultMessage;
}

function estimatePrunedSavings(tokens: number, notice: string): number {
	const noticeTokens = Math.ceil(notice.length / 4);
	return Math.max(0, tokens - noticeTokens);
}

interface SupersedeCandidate {
	entry: SessionMessageEntry;
	message: ToolResultMessage;
	/** Index of the entry within the `entries` array. */
	index: number;
	tokens: number;
}

/**
 * Collect superseded tool results: for every unpruned, unprotected tool result
 * whose paired call resolves a supersede key, a LATER result with the same key
 * — or with a key that is the `"\u0000"`-prefix parent of this one — marks it
 * superseded. Returned in message order.
 */
function collectSupersededResults(
	entries: readonly SessionEntry[],
	toolCallsById: ReadonlyMap<string, AgentToolCall>,
	supersedeKey: SupersedeKeyFn,
	protectedTools: readonly ProtectedToolMatcher[],
): SupersedeCandidate[] {
	const candidates: SupersedeCandidate[] = [];
	const seenKeys = new Set<string>();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getToolResultMessage(entry);
		if (!message || message.prunedAt !== undefined) continue;
		const toolCall = toolCallsById.get(message.toolCallId);
		if (!toolCall) continue;
		if (isProtectedToolResult(message, toolCall, protectedTools)) continue;
		const key = supersedeKey(toolCall.name, toolCall.arguments as Record<string, unknown>);
		if (key === undefined) continue;
		const separator = key.indexOf("\u0000");
		const superseded = seenKeys.has(key) || (separator >= 0 && seenKeys.has(key.slice(0, separator)));
		seenKeys.add(key);
		if (!superseded) continue;
		candidates.push({
			entry: entry as SessionMessageEntry,
			message,
			index: i,
			tokens: estimateTokens(message as AgentMessage),
		});
	}
	return candidates.reverse();
}

/**
 * Prune superseded tool results (e.g. stale `read` outputs replaced by a newer
 * read of the same file). Cheap, incremental, and prompt-cache-aware: a
 * candidate is pruned now only when the suffix after it is small (tail case —
 * the read→edit→read loop) or when the context has been idle long enough that
 * the provider cache is cold anyway (then ALL candidates flush).
 */
export function pruneSupersededToolResults(entries: SessionEntry[], config: SupersedePruneConfig): PruneResult {
	const toolCallsById = collectToolCallsById(entries);
	const candidates = collectSupersededResults(entries, toolCallsById, config.supersedeKey, config.protectedTools);
	if (candidates.length === 0) return { prunedCount: 0, tokensSaved: 0 };

	const now = config.now ?? Date.now();
	let lastMessageTimestamp: number | undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const timestamp = (entry.message as AgentMessage).timestamp;
		if (typeof timestamp === "number") lastMessageTimestamp = timestamp;
		break;
	}
	const idle =
		lastMessageTimestamp !== undefined && now - lastMessageTimestamp >= (config.idleFlushMs ?? DEFAULT_IDLE_FLUSH_MS);

	let toPrune: SupersedeCandidate[];
	if (idle) {
		toPrune = candidates;
	} else {
		const suffixTokenLimit = config.suffixTokenLimit ?? DEFAULT_SUFFIX_TOKEN_LIMIT;
		// suffixTokens[i] = estimated tokens of all messages strictly after entry i.
		const suffixTokens = new Array<number>(entries.length);
		let accumulated = 0;
		for (let i = entries.length - 1; i >= 0; i--) {
			suffixTokens[i] = accumulated;
			const entry = entries[i];
			if (entry.type === "message") accumulated += estimateTokens(entry.message as AgentMessage);
		}
		toPrune = candidates.filter(candidate => suffixTokens[candidate.index] <= suffixTokenLimit);
	}
	if (toPrune.length === 0) return { prunedCount: 0, tokensSaved: 0 };

	const prunedAt = Date.now();
	let tokensSaved = 0;
	for (const candidate of toPrune) {
		candidate.message.content = [{ type: "text", text: SUPERSEDED_NOTICE }];
		candidate.message.prunedAt = prunedAt;
		tokensSaved += estimatePrunedSavings(candidate.tokens, SUPERSEDED_NOTICE);
	}
	return { prunedCount: toPrune.length, tokensSaved };
}

export function pruneToolOutputs(entries: SessionEntry[], config: PruneConfig = DEFAULT_PRUNE_CONFIG): PruneResult {
	let accumulatedTokens = 0;
	let tokensSaved = 0;
	let prunedCount = 0;

	const candidates: Array<{ entry: SessionMessageEntry; tokens: number; superseded: boolean }> = [];
	const toolCallsById = collectToolCallsById(entries);
	const supersededMessages = config.supersedeKey
		? new Set(
				collectSupersededResults(entries, toolCallsById, config.supersedeKey, config.protectedTools).map(
					candidate => candidate.message,
				),
			)
		: undefined;

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getToolResultMessage(entry);
		if (!message) continue;

		const tokens = estimateTokens(message as AgentMessage);
		const isProtected = isProtectedToolResult(message, toolCallsById.get(message.toolCallId), config.protectedTools);

		if (message.prunedAt !== undefined) {
			accumulatedTokens += tokens;
			continue;
		}

		// Superseded results are pruned first: they bypass the protect window
		// (a stale copy of re-read content is dead weight at any age).
		const superseded = supersededMessages?.has(message) ?? false;
		if (!superseded && (accumulatedTokens < config.protectTokens || isProtected)) {
			accumulatedTokens += tokens;
			continue;
		}

		candidates.push({ entry: entry as SessionMessageEntry, tokens, superseded });
		accumulatedTokens += tokens;
	}

	for (const candidate of candidates) {
		tokensSaved += estimatePrunedSavings(
			candidate.tokens,
			candidate.superseded ? SUPERSEDED_NOTICE : createPrunedNotice(candidate.tokens),
		);
	}

	if (tokensSaved < config.minimumSavings || candidates.length === 0) {
		return { prunedCount: 0, tokensSaved: 0 };
	}

	const prunedAt = Date.now();
	for (const candidate of candidates) {
		const message = candidate.entry.message as ToolResultMessage;
		message.content = [
			{ type: "text", text: candidate.superseded ? SUPERSEDED_NOTICE : createPrunedNotice(candidate.tokens) },
		];
		message.prunedAt = prunedAt;
		prunedCount++;
	}

	return { prunedCount, tokensSaved };
}

/**
 * Supersede key for the `read` tool: the file path with the trailing line/raw
 * selector stripped (the read tool's own splitter grammar via
 * {@link splitReadSelector}, e.g. `src/foo.ts:50-200`, `:2-4:raw`).
 * Internal/URL-scheme paths (`skill://…`, `https://…`) are exempt.
 * Selector-free reads key on the bare path; selector-carrying reads key on
 * `path + "\u0000" + selector`, so two reads collide only when the newer is
 * selector-free or the selectors are identical (the pass's prefix rule lets a
 * bare-path read supersede selector-carrying reads of the same file).
 */
export function readToolSupersedeKey(toolName: string, args: Record<string, unknown>): string | undefined {
	if (toolName !== "read") return undefined;
	const path = args.path;
	if (typeof path !== "string" || path.length === 0) return undefined;
	if (path.includes("://")) return undefined;
	const { path: base, sel } = splitReadSelector(path);
	return sel === undefined ? base : `${base}\u0000${sel}`;
}
