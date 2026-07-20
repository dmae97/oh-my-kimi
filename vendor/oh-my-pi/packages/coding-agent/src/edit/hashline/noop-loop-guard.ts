/**
 * Per-session guard against subagents looping on byte-identical no-op edits.
 *
 * A hashline patch can apply cleanly yet produce no change when the body rows
 * are already byte-identical to the targeted lines. {@link executeHashlineSingle}
 * surfaces a soft hint ("re-read the file before issuing another edit"), but in
 * the wild some models ignore the hint and keep re-issuing the same bytes
 * (issue #2081 captured 182 such repeats in 205 calls before the user aborted).
 *
 * This module tracks consecutive byte-identical no-op edits per canonical file
 * path within a single session. Once the same payload no-ops {@link NOOP_HARD_LIMIT}
 * times in a row the caller is expected to escalate from a soft text result to
 * a thrown {@link ToolError} so the agent loop sees a tool *failure* — empirically
 * far more effective at breaking the cycle than the soft hint alone.
 *
 * A successful (non-noop) commit for a path resets that path's counter; a
 * different payload on the same path also resets it because the body hash
 * changed, which is a sign of model progress and deserves another soft hint.
 */

interface NoopLoopEntry {
	/** Hash of the most recent input that no-op'd on this canonical path. */
	hash: string;
	/** Consecutive no-op count for the same `hash` on this path. */
	count: number;
}

/** Cross-session-safe state slot held on the `ToolSession`. */
export interface NoopLoopGuard {
	entries: Map<string, NoopLoopEntry>;
}

/**
 * After this many consecutive byte-identical no-op edits on the same path,
 * {@link recordNoopEdit} returns `escalate: true`. Picked deliberately small
 * so the soft hint still fires once or twice before we escalate — the model
 * deserves a chance to recover, but a tight bound is what actually breaks
 * loops in practice.
 */
export const NOOP_HARD_LIMIT = 3;

interface NoopLoopGuardOwner {
	noopLoopGuard?: NoopLoopGuard;
}

/** Lazily create the per-session guard, mirroring `getFileSnapshotStore`. */
export function getNoopLoopGuard(session: NoopLoopGuardOwner): NoopLoopGuard {
	if (!session.noopLoopGuard) session.noopLoopGuard = { entries: new Map() };
	return session.noopLoopGuard;
}

/** Result of recording one no-op against the guard. */
export interface NoopRecordResult {
	/** Consecutive identical no-op count, including the current one. */
	count: number;
	/** True once `count >= NOOP_HARD_LIMIT` and the caller MUST escalate. */
	escalate: boolean;
}

/**
 * Record a no-op edit for `canonicalPath` keyed by `inputHash` (a stable hash
 * of the raw patch input bytes). Returns the running consecutive-no-op count
 * and whether the caller should escalate from a soft text result to a thrown
 * error.
 *
 * `inputHash` is intentionally derived from the raw model-authored bytes
 * rather than from file content: when the model emits a different payload
 * (even whitespace-only) that's progress and earns a fresh soft hint, but
 * re-issuing the same bytes after being warned is what we want to break.
 */
export function recordNoopEdit(
	session: NoopLoopGuardOwner,
	canonicalPath: string,
	inputHash: string,
): NoopRecordResult {
	const guard = getNoopLoopGuard(session);
	const prev = guard.entries.get(canonicalPath);
	const count = prev && prev.hash === inputHash ? prev.count + 1 : 1;
	guard.entries.set(canonicalPath, { hash: inputHash, count });
	return { count, escalate: count >= NOOP_HARD_LIMIT };
}

/**
 * Clear the no-op counter for `canonicalPath`. Call after a non-noop commit
 * for the same path so a future no-op starts fresh from the soft hint.
 */
export function resetNoopEdit(session: NoopLoopGuardOwner, canonicalPath: string): void {
	const guard = session.noopLoopGuard;
	if (!guard) return;
	guard.entries.delete(canonicalPath);
}

/**
 * Stable hash of the raw patch input. Bun's `Bun.hash` is xxHash64 — fast,
 * non-cryptographic, more than adequate for "is this the same payload?".
 */
export function hashPatchInput(input: string): string {
	return Bun.hash(input).toString(16);
}
