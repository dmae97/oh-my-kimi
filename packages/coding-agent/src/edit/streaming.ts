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
import type { Theme } from "../modes/theme/theme";
import { type EditMode, resolveEditMode } from "../utils/edit-mode";
import { computeEditDiff, type DiffError, type DiffResult } from "./diff";
import { expandApplyPatchToEntries, expandApplyPatchToPreviewEntries } from "./modes/apply-patch";
import { type ChunkToolEdit, computeChunkDiff, parseChunkEditPath } from "./modes/chunk";
import { computeHashlineDiff, type HashlineToolEdit } from "./modes/hashline";
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
		const first = args.edits?.[0];
		if (!first) return null;
		const path = first.path ?? args.path;
		if (!path || first.old_text === undefined || first.new_text === undefined) return null;
		ctx.signal.throwIfAborted();
		const result = await computeEditDiff(
			path,
			first.old_text,
			first.new_text,
			ctx.cwd,
			ctx.allowFuzzy ?? true,
			first.all,
			ctx.fuzzyThreshold,
		);
		ctx.signal.throwIfAborted();
		return [toPerFilePreview(path, result)];
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
		const first = args.edits?.[0];
		const path = first?.path ?? args.path;
		if (!path) return null;
		ctx.signal.throwIfAborted();
		const result = await computePatchDiff(
			{ path, op: first?.op ?? "update", rename: first?.rename, diff: first?.diff },
			ctx.cwd,
			{ fuzzyThreshold: ctx.fuzzyThreshold, allowFuzzy: ctx.allowFuzzy },
		);
		ctx.signal.throwIfAborted();
		return [toPerFilePreview(path, result)];
	},
	renderStreamingFallback() {
		return "";
	},
};

interface HashlineArgs {
	path?: string;
	edits?: HashlineToolEdit[];
	__partialJson?: string;
}

const hashlineStrategy: EditStreamingStrategy<HashlineArgs> = {
	extractCompleteEdits(args, partialJson) {
		if (!args?.edits) return args;
		return { ...args, edits: dropIncompleteLastEdit(args.edits, partialJson, "edits") };
	},
	async computeDiffPreview(args, ctx) {
		const first = args.edits?.[0] as (HashlineToolEdit & { path?: string }) | undefined;
		const path = first?.path ?? args.path;
		if (!path) return null;
		const fileEdits = (args.edits ?? [])
			.map(e => {
				if (!e || typeof e !== "object") return undefined;
				const entryPath = (e as { path?: string }).path ?? args.path;
				if (!entryPath || entryPath !== path) return undefined;
				return { ...(e as HashlineToolEdit), path } as HashlineToolEdit & { path: string };
			})
			.filter((e): e is HashlineToolEdit & { path: string } => e !== undefined);
		ctx.signal.throwIfAborted();
		const result = await computeHashlineDiff({ path, edits: fileEdits }, ctx.cwd);
		ctx.signal.throwIfAborted();
		return [toPerFilePreview(path, result)];
	},
	renderStreamingFallback() {
		return "";
	},
};

interface ChunkArgs {
	path?: string;
	edits?: ChunkToolEdit[];
	__partialJson?: string;
}

const chunkStrategy: EditStreamingStrategy<ChunkArgs> = {
	extractCompleteEdits(args, partialJson) {
		if (!args?.edits) return args;
		let edits = dropIncompleteLastEdit(args.edits, partialJson, "edits");
		// Extra guard: if partial JSON still contains `":nu` / `":nul` (partial
		// `null` literals), `partial-json` may have already surfaced the last
		// entry with `write === null`. When that entry's `}` hasn't closed
		// yet, it has already been dropped above. But if dropping was not
		// triggered (e.g. list still open and no new `{` after), also drop the
		// trailing null-write entry so the preview does not flicker with an
		// error for an incomplete string/null literal.
		if (partialJson && edits.length > 0) {
			const last = edits[edits.length - 1] as Partial<ChunkToolEdit> | undefined;
			const endsInPartialNull = /:\s*nu?l?\s*$/.test(partialJson.trimEnd());
			if (last && endsInPartialNull && last.write === null) {
				edits = edits.slice(0, -1);
			}
		}
		return { ...args, edits };
	},
	async computeDiffPreview(args, ctx) {
		const edits = args.edits ?? [];
		if (edits.length === 0) return null;
		// Group edits by file path
		const groups = new Map<string, ChunkToolEdit[]>();
		const fileOrder: string[] = [];
		for (const edit of edits) {
			if (!edit) continue;
			const editPath = edit.path ?? args.path;
			if (!editPath) continue;
			const { filePath } = parseChunkEditPath(editPath);
			if (!filePath) continue;
			let bucket = groups.get(filePath);
			if (!bucket) {
				bucket = [];
				groups.set(filePath, bucket);
				fileOrder.push(filePath);
			}
			bucket.push({ ...edit, path: editPath });
		}
		if (fileOrder.length === 0) return null;

		const MAX_FILES = 5;
		const selected = fileOrder.slice(0, MAX_FILES);
		const previews: PerFileDiffPreview[] = [];
		for (const filePath of selected) {
			ctx.signal.throwIfAborted();
			const fileEdits = groups.get(filePath) ?? [];
			const result = await computeChunkDiff({ path: filePath, edits: fileEdits }, ctx.cwd, { signal: ctx.signal });
			previews.push(toPerFilePreview(filePath, result));
		}
		return previews;
	},
	renderStreamingFallback() {
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
		let entries: PatchEditEntry[];
		try {
			entries = expandApplyPatchToEntries({ input: args.input });
		} catch {
			try {
				entries = expandApplyPatchToPreviewEntries({ input: args.input });
			} catch (err) {
				return [{ path: "", error: err instanceof Error ? err.message : String(err) }];
			}
		}
		const first = entries[0];
		if (!first?.path) return null;
		ctx.signal.throwIfAborted();
		const result = await computePatchDiff(
			{ path: first.path, op: first.op ?? "update", rename: first.rename, diff: first.diff },
			ctx.cwd,
			{ fuzzyThreshold: ctx.fuzzyThreshold, allowFuzzy: ctx.allowFuzzy },
		);
		ctx.signal.throwIfAborted();
		return [toPerFilePreview(first.path, result)];
	},
	renderStreamingFallback() {
		return "";
	},
};

// Vim streaming preview is handled by the existing vimToolRenderer inside
// edit/renderer.ts. The strategy here is a no-op so the registry is total.
const vimStrategy: EditStreamingStrategy<unknown> = {
	extractCompleteEdits(args) {
		return args;
	},
	async computeDiffPreview() {
		return null;
	},
	renderStreamingFallback() {
		return "";
	},
};

interface AtomArgs {
	path?: string;
	edits?: unknown[];
}

const atomStrategy: EditStreamingStrategy<AtomArgs> = {
	extractCompleteEdits(args, partialJson) {
		if (!args.edits) return args;
		return { ...args, edits: dropIncompleteLastEdit(args.edits, partialJson, "edits") };
	},
	async computeDiffPreview() {
		// Atom edits are line-anchored and validated against live file hashes; a
		// streaming preview without that validation could mislead. Skip for now.
		return null;
	},
	renderStreamingFallback() {
		return "";
	},
};

export const EDIT_MODE_STRATEGIES: Record<EditMode, EditStreamingStrategy<unknown>> = {
	replace: replaceStrategy as EditStreamingStrategy<unknown>,
	patch: patchStrategy as EditStreamingStrategy<unknown>,
	hashline: hashlineStrategy as EditStreamingStrategy<unknown>,
	chunk: chunkStrategy as EditStreamingStrategy<unknown>,
	apply_patch: applyPatchStrategy as EditStreamingStrategy<unknown>,
	vim: vimStrategy,
	atom: atomStrategy as EditStreamingStrategy<unknown>,
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
