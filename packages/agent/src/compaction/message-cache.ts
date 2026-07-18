/**
 * Per-message memoization for the two hot history walks: token estimation
 * ({@link estimateTokens}) and LLM conversion (the coding-agent's `convertToLlm`).
 *
 * Long sessions re-walk a settled `AgentMessage[]` every turn, re-tokenizing and
 * re-converting historical objects that only the newest suffix can change. These
 * caches key on message *identity* so a settled message is counted/converted once
 * and reused until an owner rewrites it.
 *
 * Correctness rests on two invariants:
 *
 * 1. **Settle gate.** A streaming assistant is mutated under one identity while
 *    its `usage`/`stopReason` are provisional (the seed carries zeroed usage and
 *    a placeholder `stopReason`). Caching it would freeze a mid-stream count, so
 *    estimation only caches assistants that are settled — real `usage`
 *    (`totalTokens > 0`) with a terminal `stopReason` that is not `"aborted"` /
 *    `"error"`. Unsettled assistants never read or insert. Non-assistant roles
 *    are immutable once appended and cache by identity.
 * 2. **Owner invalidation.** `pruneToolOutputs` / `pruneSupersededToolResults`,
 *    `applyShakeRegion`, and `stripImagesFromMessage` rewrite message content in
 *    place under a stable identity. Each MUST call {@link invalidateMessageCache}
 *    on the mutated message before the next convert/estimate pass so both caches
 *    drop the stale entry. The convert cache lives in another package, so it
 *    subscribes via {@link registerMessageCacheInvalidator}.
 */
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AgentMessage } from "../types";

/** External cache invalidators (e.g. the coding-agent `convertToLlm` memo). */
const externalInvalidators = new Set<(message: AgentMessage) => void>();

/**
 * Register a cache tied to message identity so owner mutations in this package
 * (prune/shake) can invalidate it across the package boundary. Returns an
 * unregister function. The coding-agent `convertToLlm` memo registers here.
 */
export function registerMessageCacheInvalidator(invalidate: (message: AgentMessage) => void): () => void {
	externalInvalidators.add(invalidate);
	return () => {
		externalInvalidators.delete(invalidate);
	};
}

// Dual option-split estimate caches: the compaction floor passes
// `excludeEncryptedReasoning` (dropping opaque provider reasoning), so a message
// has two distinct estimates that must not collide in one map.
//
// These are WeakMaps, not symbol-tagged properties, deliberately: callers spread
// messages to derive throwaway variants for counting — `estimateBranchSummaryTokens`
// does `estimateTokens({ ...message, content: truncated })`. A symbol-keyed cache
// value rides along an object spread, so the truncated clone would inherit (and
// return) the full-content estimate. Keying strictly on identity keeps the cache
// off spread copies, which get their own fresh count.
const estimateCacheDefault = new WeakMap<AgentMessage, number>();
const estimateCacheFloored = new WeakMap<AgentMessage, number>();

/**
 * True when this message's estimate is safe to cache by identity. Non-assistants
 * are immutable once appended; assistants are cached only once settled (see the
 * settle-gate invariant above).
 */
export function isEstimateCacheable(message: AgentMessage): boolean {
	if (message.role !== "assistant") return true;
	const assistant = message as AssistantMessage;
	return (
		assistant.stopReason !== "aborted" &&
		assistant.stopReason !== "error" &&
		assistant.usage != null &&
		assistant.usage.totalTokens > 0
	);
}

/** Read a cached estimate for the given option split, or `undefined` on miss. */
export function readEstimateCache(message: AgentMessage, excludeEncryptedReasoning: boolean): number | undefined {
	return (excludeEncryptedReasoning ? estimateCacheFloored : estimateCacheDefault).get(message);
}

/** Store an estimate for the given option split. */
export function writeEstimateCache(message: AgentMessage, excludeEncryptedReasoning: boolean, value: number): void {
	(excludeEncryptedReasoning ? estimateCacheFloored : estimateCacheDefault).set(message, value);
}

/**
 * Drop every cached derivation of `message` after an in-place rewrite. Owners of
 * mutation (prune, shake, strip-images) call this at the mutation seam so the
 * next convert/estimate pass recomputes from the new content.
 */
export function invalidateMessageCache(message: AgentMessage): void {
	estimateCacheDefault.delete(message);
	estimateCacheFloored.delete(message);
	for (const invalidate of externalInvalidators) invalidate(message);
}
