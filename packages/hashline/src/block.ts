/**
 * Expand deferred `replace block N:` edits into concrete inserts + deletes.
 *
 * The hashline parser cannot expand a block edit on its own — the line span is
 * unknown until file text + path (→ language) are available. This transform
 * runs at every apply/preview boundary that has text: it calls the injected
 * {@link BlockResolver} to resolve each block's `[start, end]` span, then emits
 * the exact same `before_anchor` replacement inserts + range deletes that
 * `replace start..end:` produces in the parser. After it runs, no `block` edits
 * remain, so {@link applyEdits} (and recovery) only ever see resolved edits.
 */
import { BLOCK_RESOLVER_UNAVAILABLE, blockUnresolvedMessage } from "./messages";
import type { BlockResolver, Cursor, Edit } from "./types";

export interface ResolveBlockEditsOptions {
	/**
	 * How to handle a block edit that cannot be resolved (missing resolver or a
	 * `null` span). `"throw"` (default) raises a `blockUnresolvedMessage` error —
	 * used by the authoritative apply + final preview paths. `"drop"` silently
	 * skips the edit — used by the streaming preview, where a half-written file
	 * or transient parse error must not throw.
	 */
	onUnresolved?: "throw" | "drop";
}

/** True when at least one edit is an unresolved `replace block N:` edit. */
export function hasBlockEdit(edits: readonly Edit[]): boolean {
	return edits.some(edit => edit.kind === "block");
}

/**
 * Resolve every `replace block N:` edit in `edits` against `text` (parsed as
 * the language inferred from `path`). Non-block edits pass through untouched.
 * Returns a fresh edit list with no `block` variants. The fast path returns the
 * input unchanged when there is nothing to resolve.
 *
 * Synthesized inserts/deletes carry sequential `index` values for readability
 * only — {@link applyEdits} re-derives every edit's index from array order, so
 * the passthrough edits keeping their original indices is harmless.
 */
export function resolveBlockEdits(
	edits: readonly Edit[],
	text: string,
	path: string,
	resolver: BlockResolver | undefined,
	options: ResolveBlockEditsOptions = {},
): readonly Edit[] {
	if (!hasBlockEdit(edits)) return edits;
	const onUnresolved = options.onUnresolved ?? "throw";
	const resolved: Edit[] = [];
	let synthIndex = 0;
	for (const edit of edits) {
		if (edit.kind !== "block") {
			resolved.push(edit);
			continue;
		}
		const span = resolver ? resolver({ path, text, line: edit.anchor.line }) : null;
		if (span === null) {
			if (onUnresolved === "drop") continue;
			throw new Error(
				`line ${edit.lineNum}: ${resolver ? blockUnresolvedMessage(edit.anchor.line) : BLOCK_RESOLVER_UNAVAILABLE}`,
			);
		}
		// Mirror the parser's `replace start..end:` expansion exactly: one
		// `before_anchor` replacement insert per payload row at `span.start`,
		// then one delete per line across `[span.start, span.end]`. An empty
		// `payloads` (from `delete block N`) emits no inserts — a pure deletion.
		for (const payload of edit.payloads) {
			const cursor: Cursor = { kind: "before_anchor", anchor: { line: span.start } };
			resolved.push({
				kind: "insert",
				cursor,
				text: payload,
				lineNum: edit.lineNum,
				index: synthIndex++,
				mode: "replacement",
			});
		}
		for (let line = span.start; line <= span.end; line++) {
			resolved.push({ kind: "delete", anchor: { line }, lineNum: edit.lineNum, index: synthIndex++ });
		}
	}
	return resolved;
}
