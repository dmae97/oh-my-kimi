/**
 * Streaming edit preview strategies.
 *
 * Each edit mode owns a strategy that knows how to:
 * - collapse partial-JSON args to the subset safe to preview
 *   (`extractCompleteEdits`),
 * - compute unified diff previews for the in-flight args
 *   (`computeDiffPreview`), and
 * - render a text placeholder while no diff exists yet
 *   (`renderStreamingFallback`).
 *
 * The shared renderer / `ToolExecutionComponent` consult the strategy via
 * the injected `editMode` rather than probing argument shape.
 */

import {
	ABORT_MARKER,
	BEGIN_PATCH_MARKER,
	containsRecognizableHashlineOperations,
	END_PATCH_MARKER,
	type PatchSection as HashlineInputSection,
	Patch as HashlinePatch,
} from "@oh-my-pi/hashline";
import type { Theme } from "../modes/theme/theme";
import { type EditMode, resolveEditMode } from "../utils/edit-mode";
import { computeEditDiff, type DiffError, type DiffResult } from "./diff";
import { computeHashlineDiff, computeHashlineSectionDiff } from "./hashline/diff";
import { type ApplyPatchEntry, expandApplyPatchToEntries, expandApplyPatchToPreviewEntries } from "./modes/apply-patch";
import { computePatchDiff, type PatchEditEntry } from "./modes/patch";
import type { ReplaceEditEntry } from "./modes/replace";

export interface PerFileDiffPreview {
	path: string;
	diff?: string;
	firstChangedLine?: number;
	error?: string;
}

export interface StreamingDiffContext {
	cwd: string;
	signal: AbortSignal;
	fuzzyThreshold?: number;
	allowFuzzy?: boolean;
	hashlineAutoDropPureInsertDuplicates?: boolean;
	/**
	 * True while the tool's arguments are still streaming in. Strategies that
	 * accept free-form text input (apply_patch, hashline) trim the trailing
	 * partial line so per-character growth of an in-flight `+added` line does
	 * not flicker in the preview.
	 */
	isStreaming?: boolean;
}

export interface EditStreamingStrategy<Args = unknown> {
	/**
	 * Return the args restricted to edits that are "complete enough" to
	 * compute a diff against. Strategies drop the trailing incomplete entry
	 * when `partialJson` indicates its closing `}` hasn't arrived yet.
	 */
	extractCompleteEdits(args: Args, partialJson: string | undefined): Args;
	/**
	 * Compute diff(s) for the given partial args. Returns `null` when args
	 * do not yet carry enough structure to compute anything.
	 */
	computeDiffPreview(args: Args, ctx: StreamingDiffContext): Promise<PerFileDiffPreview[] | null>;
	/**
	 * Rendered inline while the diff hasn't been computed yet (or when the
	 * compute returned `null` because args are still too partial).
	 */
	renderStreamingFallback(args: Args, uiTheme: Theme): string;
}

// -----------------------------------------------------------------------------
// Partial-JSON handling
// -----------------------------------------------------------------------------

/**
 * Given an edits array parsed from partial JSON, drop the last entry when the
 * corresponding object in `partialJson` does not yet end with a closed `}`.
 *
 * This guards against `partial-json` silently coercing truncated tails like
 * `"write":nu` / `"write":nul` into `{ write: null }`, which would make the
 * last entry render a spurious null-write error until the value finishes
 * streaming.
 */
export function dropIncompleteLastEdit<T>(edits: readonly T[], partialJson: string | undefined, listKey: string): T[] {
	if (!Array.isArray(edits) || edits.length === 0) return [...(edits ?? [])];
	if (!partialJson) return [...edits];

	const keyMarker = `"${listKey}"`;
	const keyIdx = partialJson.indexOf(keyMarker);
	if (keyIdx === -1) return [...edits];

	// Find the `[` that opens the list value.
	let i = partialJson.indexOf("[", keyIdx + keyMarker.length);
	if (i === -1) return [...edits];
	i++;

	let depth = 0;
	let inString = false;
	let escaped = false;
	let lastClose = -1;
	for (; i < partialJson.length; i++) {
		const ch = partialJson[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			if (inString) escaped = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === "{" || ch === "[") {
			depth++;
		} else if (ch === "}" || ch === "]") {
			depth--;
			if (ch === "}" && depth === 0) {
				lastClose = i;
			}
			if (ch === "]" && depth === -1) {
				// End of list reached.
				break;
			}
		}
	}

	// If we're still inside the list and saw no closing `}` for the last entry,
	// or there is trailing non-whitespace after the last `}` before the list
	// ended (i.e. a new object has opened), drop the trailing entry.
	const tail = lastClose === -1 ? partialJson.slice(i) : partialJson.slice(lastClose + 1);
	const sawNewObjectAfterLastClose = /\{/.test(tail);
	const listIsStillOpen = depth >= 0;

	if (lastClose === -1 || (listIsStillOpen && sawNewObjectAfterLastClose)) {
		return edits.slice(0, -1);
	}
	return [...edits];
}

// -----------------------------------------------------------------------------
// Apply_patch remains multi-file because the Codex envelope carries paths per hunk.
// -----------------------------------------------------------------------------

function groupApplyPatchEntriesByPath(entries: readonly ApplyPatchEntry[]): Map<string, ApplyPatchEntry[]> {
	const groups = new Map<string, ApplyPatchEntry[]>();

	for (const entry of entries) {
		let bucket = groups.get(entry.path);
		if (!bucket) {
			bucket = [];
			groups.set(entry.path, bucket);
		}
		bucket.push(entry);
	}
	return groups;
}

// -----------------------------------------------------------------------------
// Strategies
// -----------------------------------------------------------------------------

interface ReplaceArgs {
	path?: string;
	edits?: ReplaceEditEntry[];
	__partialJson?: string;
}

const replaceStrategy: EditStreamingStrategy<ReplaceArgs> = {
	extractCompleteEdits(args, partialJson) {
		if (!args?.edits) return args;
		return { ...args, edits: dropIncompleteLastEdit(args.edits, partialJson, "edits") };
	},
	async computeDiffPreview(args, ctx) {
		if (!args.path) return null;
		const first = args.edits?.[0];
		if (!first || first.old_text === undefined || first.new_text === undefined) return null;
		ctx.signal.throwIfAborted();
		const result = await computeEditDiff(
			args.path,
			first.old_text,
			first.new_text,
			ctx.cwd,
			ctx.allowFuzzy ?? true,
			first.all,
			ctx.fuzzyThreshold,
		);
		ctx.signal.throwIfAborted();
		return [toPerFilePreview(args.path, result)];
	},
	renderStreamingFallback() {
		return "";
	},
};

interface PatchArgs {
	path?: string;
	edits?: PatchEditEntry[];
	__partialJson?: string;
}

const patchStrategy: EditStreamingStrategy<PatchArgs> = {
	extractCompleteEdits(args, partialJson) {
		if (!args?.edits) return args;
		return { ...args, edits: dropIncompleteLastEdit(args.edits, partialJson, "edits") };
	},
	async computeDiffPreview(args, ctx) {
		if (!args.path) return null;
		const first = args.edits?.[0];
		if (!first) return null;
		ctx.signal.throwIfAborted();
		const result = await computePatchDiff(
			{ path: args.path, op: first.op ?? "update", rename: first.rename, diff: first.diff },
			ctx.cwd,
			{ fuzzyThreshold: ctx.fuzzyThreshold, allowFuzzy: ctx.allowFuzzy },
		);
		ctx.signal.throwIfAborted();
		return [toPerFilePreview(args.path, result)];
	},
	renderStreamingFallback() {
		return "";
	},
};

interface HashlineArgs {
	input?: string;
	__partialJson?: string;
}

/**
 * While streaming a free-form text payload (apply_patch envelope, hashline
 * input), trim the trailing partial line so per-character growth of an
 * in-flight `+added` line does not cause the diff preview to flicker. The
 * full line will show on the next streaming tick once its `\n` arrives.
 * Returns `text` unchanged when not streaming or when no newline is present.
 */
function trimTrailingPartialLine(text: string, isStreaming: boolean | undefined): string {
	if (!isStreaming) return text;
	const idx = text.lastIndexOf("\n");
	if (idx === -1) return "";
	return text.slice(0, idx + 1);
}

/**
 * Build a per-file diff preview directly from a partial `apply_patch`
 * envelope by emitting its body lines in *input order*. This bypasses the
 * file-state re-diff (`computePatchDiff` → `Diff.structuredPatch`) whose
 * coalescing reorders the model's `-old +new -old +new` stream into
 * `-old -old +new +new` and visibly shifts existing `+added` lines
 * downward each time a new `-` arrives. The preview therefore grows
 * monotonically at the bottom while streaming and only becomes a real
 * unified diff once the args are complete.
 */
function buildApplyPatchNaturalOrderPreviews(input: string): PerFileDiffPreview[] | null {
	const lines = input.split("\n");
	const groups = new Map<string, string[]>();
	let currentPath: string | undefined;
	const ensure = (path: string): string[] => {
		let bucket = groups.get(path);
		if (!bucket) {
			bucket = [];
			groups.set(path, bucket);
		}
		return bucket;
	};
	for (const raw of lines) {
		const trimmedEnd = raw.trimEnd();
		if (trimmedEnd === BEGIN_PATCH_MARKER || trimmedEnd === END_PATCH_MARKER || trimmedEnd === ABORT_MARKER) {
			continue;
		}
		if (trimmedEnd.startsWith("*** Add File: ")) {
			currentPath = trimmedEnd.slice("*** Add File: ".length);
			ensure(currentPath);
			continue;
		}
		if (trimmedEnd.startsWith("*** Delete File: ")) {
			currentPath = trimmedEnd.slice("*** Delete File: ".length);
			ensure(currentPath);
			continue;
		}
		if (trimmedEnd.startsWith("*** Update File: ")) {
			currentPath = trimmedEnd.slice("*** Update File: ".length);
			ensure(currentPath);
			continue;
		}
		if (trimmedEnd.startsWith("*** Move to:") || trimmedEnd.startsWith("*** End of File")) {
			continue;
		}
		if (!currentPath) continue;
		// Diff body: keep `-/+/space`-prefixed lines and `@@` hunk headers in
		// input order. parseDiffLine accepts the no-line-number legacy form so
		// the renderer styles them as additions/removals/context naturally.
		if (raw.startsWith("+") || raw.startsWith("-") || raw.startsWith(" ") || raw.startsWith("@@")) {
			ensure(currentPath).push(raw);
		}
	}
	if (groups.size === 0) return null;
	const previews: PerFileDiffPreview[] = [];
	for (const [path, body] of groups) {
		if (body.length === 0) continue;
		previews.push({ path, diff: body.join("\n") });
	}
	return previews.length > 0 ? previews : null;
}

const hashlineStrategy: EditStreamingStrategy<HashlineArgs> = {
	extractCompleteEdits(args) {
		return args;
	},
	async computeDiffPreview(args, ctx) {
		if (typeof args.input !== "string" || args.input.length === 0) return null;
		const input = trimTrailingPartialLine(args.input, ctx.isStreaming);
		if (input.length === 0) return null;
		ctx.signal.throwIfAborted();

		let sections: readonly HashlineInputSection[];
		try {
			sections = HashlinePatch.parse(input, { cwd: ctx.cwd }).sections;
		} catch {
			// While streaming, the trailing op may still be mid-typed and fail
			// to parse; suppress until the next chunk arrives. Once args are
			// complete, surface the error so the model sees what went wrong.
			if (ctx.isStreaming) return null;
			const result = await computeHashlineDiff({ input }, ctx.cwd, {
				autoDropPureInsertDuplicates: ctx.hashlineAutoDropPureInsertDuplicates,
			});
			ctx.signal.throwIfAborted();
			return [toPerFilePreview("", result)];
		}
		if (sections.length === 0) return null;

		// While the trailing section is still being typed (no operations yet)
		// skip it so its empty/parse-error result doesn't replace previews of
		// already-completed sections with an opaque header.
		const lastIndex = sections.length - 1;
		const trailingIncomplete =
			sections.length > 1 && !containsRecognizableHashlineOperations(sections[lastIndex].diff);
		const sectionsToProcess = trailingIncomplete ? sections.slice(0, -1) : sections;
		const trailingProcessedIndex = sectionsToProcess.length - 1;

		const previews: PerFileDiffPreview[] = [];
		for (let i = 0; i < sectionsToProcess.length; i++) {
			ctx.signal.throwIfAborted();
			const section = sectionsToProcess[i];
			const result = await computeHashlineSectionDiff(section, ctx.cwd, {
				autoDropPureInsertDuplicates: ctx.hashlineAutoDropPureInsertDuplicates,
				streaming: ctx.isStreaming,
			});
			ctx.signal.throwIfAborted();
			// In a multi-section preview, ignore parse/apply errors from the
			// last section: it's still streaming and the partial op may not
			// parse yet. Earlier sections are stable and stay rendered.
			if (sectionsToProcess.length > 1 && i === trailingProcessedIndex && "error" in result) {
				continue;
			}
			previews.push(toPerFilePreview(section.path, result));
		}
		return previews.length > 0 ? previews : null;
	},
	renderStreamingFallback() {
		// Never leak raw hashline syntax (`64:`, `|payload`, `¶path#hash`)
		// to the user — the streaming preview already projects every
		// parseable op onto the real file via applyPartialTo, and an
		// unparseable trailing chunk renders as "no preview yet" rather
		// than a sigil dump.
		return "";
	},
};

interface ApplyPatchArgs {
	input?: string;
}

const applyPatchStrategy: EditStreamingStrategy<ApplyPatchArgs> = {
	extractCompleteEdits(args) {
		// Apply_patch payload is plain text, not an edits array. Nothing to trim.
		return args;
	},
	async computeDiffPreview(args, ctx) {
		if (typeof args.input !== "string" || args.input.length === 0) return null;
		const input = trimTrailingPartialLine(args.input, ctx.isStreaming);
		if (input.length === 0) return null;
		if (ctx.isStreaming) {
			// Render the envelope's diff body in input order so newly streamed
			// `+added` lines append at the bottom instead of being shuffled
			// upward as later `-removed` lines arrive and reorder the unified
			// diff that `Diff.structuredPatch` would otherwise produce.
			return buildApplyPatchNaturalOrderPreviews(input);
		}
		let entries: ApplyPatchEntry[];
		try {
			entries = expandApplyPatchToEntries({ input });
		} catch {
			try {
				entries = expandApplyPatchToPreviewEntries({ input });
			} catch (err) {
				return [{ path: "", error: err instanceof Error ? err.message : String(err) }];
			}
		}
		const groups = groupApplyPatchEntriesByPath(entries);
		if (groups.size === 0) return null;
		const previews: PerFileDiffPreview[] = [];
		for (const [path, fileEntries] of groups) {
			const first = fileEntries[0];
			if (!first) continue;
			ctx.signal.throwIfAborted();
			const result = await computePatchDiff(
				{ path, op: first.op ?? "update", rename: first.rename, diff: first.diff },
				ctx.cwd,
				{ fuzzyThreshold: ctx.fuzzyThreshold, allowFuzzy: ctx.allowFuzzy },
			);
			ctx.signal.throwIfAborted();
			previews.push(toPerFilePreview(path, result));
		}
		return previews.length > 0 ? previews : null;
	},
	renderStreamingFallback() {
		return "";
	},
};
export const EDIT_MODE_STRATEGIES: Record<EditMode, EditStreamingStrategy<unknown>> = {
	replace: replaceStrategy as EditStreamingStrategy<unknown>,
	patch: patchStrategy as EditStreamingStrategy<unknown>,
	hashline: hashlineStrategy as EditStreamingStrategy<unknown>,
	apply_patch: applyPatchStrategy as EditStreamingStrategy<unknown>,
};

export { resolveEditMode };

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function toPerFilePreview(path: string, result: DiffResult | DiffError): PerFileDiffPreview {
	if ("error" in result) {
		return { path, error: result.error };
	}
	return { path, diff: result.diff, firstChangedLine: result.firstChangedLine };
}
