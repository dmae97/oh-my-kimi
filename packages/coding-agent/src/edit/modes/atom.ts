/**
 * Atom edit mode — single-point hashline-anchored edits.
 *
 * Each op references exactly **one** anchor (`LINEHASH`). Range endpoints,
 * vim-style motions, and column addressing are intentionally absent: to
 * replace many lines, the model issues many ops. Reuses hashline's anchor
 * staleness scheme (`computeLineHash`) verbatim.
 *
 * Op shapes (one per entry):
 *   { path, set: "5th",          lines: "..." | ["..."] }       // replace one line
 *   { path, set: ["5th", "9xy"], lines: [...] }                 // replace lines strictly between two anchors
 *                                                                  // (both anchors kept; use for block-body replacement)
 *   { path, pre:  "5th" | "",    lines: "..." | ["..."] }       // insert lines above anchor; "" = BOF (prepend)
 *   { path, post: "5th" | "",    lines: "..." | ["..."] }       // insert lines below anchor; "" = EOF (append)
 *   { path, del:  "5th" }                                        // delete one line
 *   { path, sub:  "5th", find: "...", lines: "..." }             // replace a unique substring on the anchored line; tail preserved
 *
 * Anchors mark *survivors*. With single-anchor `set`, the named line is the
 * target (consumed). With two-anchor `set: [open, close]`, both anchors are
 * **kept** and only the lines strictly between them are replaced. There are no
 * inclusive ranges and no two-endpoint spans whose endpoint is itself rewritten
 * — this eliminates the most common boundary-confusion failure mode (off-by-one
 * on the closing brace).
 *
 * For deleting or moving files, the agent should use bash.
 */

import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import type { WritethroughCallback, WritethroughDeferredHandle } from "../../lsp";
import type { ToolSession } from "../../tools";
import { assertEditableFileContent } from "../../tools/auto-generated-guard";
import { invalidateFsScanAfterWrite } from "../../tools/fs-cache-invalidation";
import { outputMeta } from "../../tools/output-meta";
import { enforcePlanModeWrite, resolvePlanPath } from "../../tools/plan-mode-guard";
import { generateDiffString } from "../diff";
import { computeLineHash } from "../line-hash";
import { detectLineEnding, normalizeToLF, restoreLineEndings, stripBom } from "../normalize";
import type { EditToolDetails, LspBatchRequest } from "../renderer";
import {
	type Anchor,
	buildCompactHashlineDiffPreview,
	HashlineMismatchError,
	type HashMismatch,
	hashlineParseText,
	parseTag,
} from "./hashline";

// ═══════════════════════════════════════════════════════════════════════════
// Schema
// ═══════════════════════════════════════════════════════════════════════════

const linesSchema = Type.Union([Type.Array(Type.String()), Type.String()], {
	description: "replacement lines",
});

/**
 * Flat entry shape: every op key is optional, and the runtime validator
 * (`resolveAtomToolEdit`) enforces that exactly one op key is present per entry.
 * We use a flat schema instead of a discriminated union to keep the tool
 * definition compact (the schema is re-sent on every turn).
 */
export const atomEditSchema = Type.Object(
	{
		path: Type.Optional(Type.String({ description: "file path override", examples: ["src/foo.ts"] })),
		// Exactly one of the following op keys is required per entry:
		set: Type.Optional(
			Type.Union([
				Type.String({ description: "line anchor to replace", examples: ["1ab"] }),
				Type.Array(Type.String(), {
					description: "two surviving anchors (open, close)",
					examples: [["1ab", "9bb"]],
				}),
			]),
		),
		pre: Type.Optional(
			Type.String({ description: "line anchor to insert before or empty for BOF", examples: ["1ab", ""] }),
		),
		post: Type.Optional(
			Type.String({ description: "line anchor to insert after or empty for EOF", examples: ["1ab", ""] }),
		),
		del: Type.Optional(Type.String({ description: "line anchor to delete", examples: ["1ab"] })),
		sub: Type.Optional(
			Type.String({ description: "line anchor on which to replace a unique substring", examples: ["1ab"] }),
		),
		// Payload (used by set/pre/post/sub):
		lines: Type.Optional(
			Type.Union([Type.Array(Type.String()), Type.String()], {
				description: "replacement payload",
			}),
		),
		find: Type.Optional(
			Type.String({
				description:
					"unique substring on the anchored line (sub only); use the shortest fragment — 1–4 chars usually suffices",
				examples: ["||", "true", "i--"],
			}),
		),
	},
	{ additionalProperties: false },
);

export const atomEditParamsSchema = Type.Object(
	{
		path: Type.Optional(Type.String({ description: "default file path for edits" })),
		edits: Type.Array(atomEditSchema, { description: "edit ops" }),
	},
	{ additionalProperties: false },
);

export type AtomToolEdit = Static<typeof atomEditSchema>;
export type AtomParams = Static<typeof atomEditParamsSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Internal resolved op shapes
// ═══════════════════════════════════════════════════════════════════════════

export type AtomEdit =
	| { op: "set"; pos: Anchor; lines: string[] }
	| { op: "pre"; pos: Anchor; lines: string[] }
	| { op: "post"; pos: Anchor; lines: string[] }
	| { op: "del"; pos: Anchor }
	| { op: "sub"; pos: Anchor; find: string; to: string }
	| { op: "between"; after: Anchor; before: Anchor; lines: string[] }
	| { op: "append_file"; lines: string[] }
	| { op: "prepend_file"; lines: string[] };

// ═══════════════════════════════════════════════════════════════════════════
// Param guards
// ═══════════════════════════════════════════════════════════════════════════

const ATOM_OP_KEYS = ["set", "pre", "post", "del", "sub"] as const;

// ═══════════════════════════════════════════════════════════════════════════
// Resolution
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse an anchor reference like `"5th"`.
 *
 * Tolerant: on a malformed reference we still try to extract a 1-indexed line
 * number from the leading digits so the validator can surface the *correct*
 * `LINEHASH\tcontent` for the user. The bogus hash is preserved in the returned
 * anchor so the validator emits a content-rich mismatch error.
 *
 * If we cannot recover even a line number, throw a usage-style error with the
 * raw reference quoted.
 */
function parseAnchor(raw: string, opName: string): Anchor {
	if (typeof raw !== "string" || raw.length === 0) {
		throw new Error(`${opName} requires an anchor of the form "LINE+ID" (e.g. "5th").`);
	}
	try {
		return parseTag(raw);
	} catch {
		const lineMatch = /^\s*[>+-]*\s*(\d+)/.exec(raw);
		if (lineMatch) {
			const line = Number.parseInt(lineMatch[1], 10);
			if (line >= 1) {
				// Sentinel hash that will never match a real line, forcing the validator
				// to report a mismatch with the actual hash + line content.
				return { line, hash: "??" };
			}
		}
		throw new Error(
			`${opName} requires an anchor of the form "LINE+ID" (e.g. "5th"). Received ${JSON.stringify(raw)}; could not extract a line number.`,
		);
	}
}

function subLinesToString(lines: unknown): string {
	if (typeof lines === "string") return lines;
	if (Array.isArray(lines)) return lines.join("\n");
	throw new Error("sub requires a string or array `lines` value (the replacement text).");
}

function classifyAtomEdit(edit: AtomToolEdit): string {
	for (const k of ATOM_OP_KEYS) {
		if (k in edit) return k;
	}
	return "unknown";
}

function resolveAtomToolEdit(edit: AtomToolEdit, editIndex = 0): AtomEdit {
	const opKeysPresent = ATOM_OP_KEYS.filter(k => k in edit);
	if (opKeysPresent.length === 0) {
		throw new Error(
			`Edit ${editIndex}: missing op key. Each entry must include exactly one of: ${ATOM_OP_KEYS.join(", ")}.`,
		);
	}
	if (opKeysPresent.length > 1) {
		throw new Error(
			`Edit ${editIndex}: multiple op keys (${opKeysPresent.join(", ")}). Each entry is exactly one op — split into ${opKeysPresent.length} separate entries.`,
		);
	}
	if ("set" in edit && edit.set !== undefined) {
		if (typeof edit.set === "string") {
			return { op: "set", pos: parseAnchor(edit.set, "set"), lines: hashlineParseText(edit.lines) };
		}
		if (Array.isArray(edit.set)) {
			if (edit.set.length === 2) {
				const [openRaw, closeRaw] = edit.set;
				if (typeof openRaw !== "string" || typeof closeRaw !== "string") {
					throw new Error(
						`Edit ${editIndex}: \`set\` 2-tuple requires both elements to be anchor strings, e.g. ["1ab", "9bb"].`,
					);
				}
				return {
					op: "between",
					after: parseAnchor(openRaw, "set[0] (open anchor)"),
					before: parseAnchor(closeRaw, "set[1] (close anchor)"),
					lines: hashlineParseText(edit.lines),
				};
			} else if (edit.set.length === 1) {
				return { op: "set", pos: parseAnchor(edit.set[0], "set"), lines: hashlineParseText(edit.lines) };
			}
		}

		throw new Error(`Edit ${editIndex}: \`set\` must be a string ("1ab") or a 2-tuple (["1ab", "9bb"]).`);
	}
	if ("pre" in edit && typeof edit.pre === "string") {
		if (edit.pre === "") {
			return { op: "prepend_file", lines: hashlineParseText(edit.lines) };
		}
		return { op: "pre", pos: parseAnchor(edit.pre, "pre"), lines: hashlineParseText(edit.lines) };
	}
	if ("post" in edit && typeof edit.post === "string") {
		if (edit.post === "") {
			return { op: "append_file", lines: hashlineParseText(edit.lines) };
		}
		return { op: "post", pos: parseAnchor(edit.post, "post"), lines: hashlineParseText(edit.lines) };
	}
	if ("del" in edit && typeof edit.del === "string") {
		return { op: "del", pos: parseAnchor(edit.del, "del") };
	}
	if ("sub" in edit && typeof edit.sub === "string") {
		if (typeof edit.find !== "string" || edit.find.length === 0) {
			throw new Error("sub requires a non-empty `find` string (the unique substring on the anchored line).");
		}
		const to = subLinesToString(edit.lines);
		return { op: "sub", pos: parseAnchor(edit.sub, "sub"), find: edit.find, to };
	}
	throw new Error(`Unknown atom edit shape: ${JSON.stringify(edit)}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Validation
// ═══════════════════════════════════════════════════════════════════════════

function* getAtomAnchors(edit: AtomEdit): Iterable<Anchor> {
	switch (edit.op) {
		case "set":
		case "pre":
		case "post":
		case "del":
		case "sub":
			yield edit.pos;
			return;
		case "between":
			yield edit.after;
			yield edit.before;
			return;
		default:
			return;
	}
}

function validateAtomAnchors(edits: AtomEdit[], fileLines: string[]): HashMismatch[] {
	const mismatches: HashMismatch[] = [];
	for (const edit of edits) {
		for (const anchor of getAtomAnchors(edit)) {
			if (anchor.line < 1 || anchor.line > fileLines.length) {
				throw new Error(`Line ${anchor.line} does not exist (file has ${fileLines.length} lines)`);
			}
			const actualHash = computeLineHash(anchor.line, fileLines[anchor.line - 1]);
			if (actualHash !== anchor.hash) {
				mismatches.push({ line: anchor.line, expected: anchor.hash, actual: actualHash });
			}
		}
	}
	return mismatches;
}

function validateNoConflictingAnchorOps(edits: AtomEdit[]): void {
	// For each anchor line, at most one mutating op (set/del/sub).
	// `pre`/`post` (insert ops) may coexist with them — they don't mutate the anchor line.
	const mutatingPerLine = new Map<number, string>();
	for (const edit of edits) {
		if (edit.op === "set" || edit.op === "del" || edit.op === "sub") {
			const existing = mutatingPerLine.get(edit.pos.line);
			if (existing) {
				throw new Error(
					`Conflicting ops on anchor line ${edit.pos.line}: \`${existing}\` and \`${edit.op}\`. ` +
						`At most one of set/del/sub is allowed per anchor.`,
				);
			}
			mutatingPerLine.set(edit.pos.line, edit.op);
		}
	}

	// `between` replaces lines strictly between two surviving anchors. Validate
	// the bounds, ensure betweens don't overlap each other, and ensure no other
	// op targets a line in the interior (the boundary lines themselves are fine).
	const betweenIntervals: { after: number; before: number }[] = [];
	for (const edit of edits) {
		if (edit.op !== "between") continue;
		if (edit.after.line >= edit.before.line) {
			throw new Error(
				`between requires after.line < before.line, got after=${edit.after.line} before=${edit.before.line}.`,
			);
		}
		for (const prev of betweenIntervals) {
			const overlaps = !(edit.before.line <= prev.after || edit.after.line >= prev.before);
			if (overlaps) {
				throw new Error(
					`Overlapping \`between\` ops: ${prev.after}→${prev.before} and ${edit.after.line}→${edit.before.line}. ` +
						`Each line may belong to at most one between region.`,
				);
			}
		}
		betweenIntervals.push({ after: edit.after.line, before: edit.before.line });
	}

	for (const edit of edits) {
		if (edit.op === "between") continue;
		let targetLine: number | undefined;
		switch (edit.op) {
			case "set":
			case "del":
			case "sub":
			case "pre":
			case "post":
				targetLine = edit.pos.line;
				break;
			default:
				targetLine = undefined;
		}
		if (targetLine === undefined) continue;
		for (const interval of betweenIntervals) {
			if (targetLine > interval.after && targetLine < interval.before) {
				throw new Error(
					`Edit on line ${targetLine} (\`${edit.op}\`) falls inside a \`between\` region (${interval.after}→${interval.before}). ` +
						`Move the op outside the region or fold its content into the between's \`lines\`.`,
				);
			}
		}
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Apply
// ═══════════════════════════════════════════════════════════════════════════

function applySubToLine(edit: { op: "sub"; pos: Anchor; find: string; to: string }, current: string): string {
	const first = current.indexOf(edit.find);
	if (first === -1) {
		throw new Error(
			`sub: substring \`${edit.find}\` not found on line ${edit.pos.line}. ` +
				`Current line content: ${JSON.stringify(current)}`,
		);
	}
	const second = current.indexOf(edit.find, first + 1);
	if (second !== -1) {
		throw new Error(
			`sub: substring \`${edit.find}\` occurs more than once on line ${edit.pos.line}; ` +
				`use a longer substring that uniquely identifies the target. ` +
				`Current line content: ${JSON.stringify(current)}`,
		);
	}
	// `sub`: replace only the matched span; tail preserved.
	return current.slice(0, first) + edit.to + current.slice(first + edit.find.length);
}

function maybeAutocorrectEscapedTabIndentation(edits: AtomEdit[], warnings: string[]): void {
	const enabled = Bun.env.PI_HASHLINE_AUTOCORRECT_ESCAPED_TABS !== "0";
	if (!enabled) return;
	for (const edit of edits) {
		if (edit.op !== "set" && edit.op !== "pre" && edit.op !== "post") continue;
		if (edit.lines.length === 0) continue;
		const hasEscapedTabs = edit.lines.some(line => line.includes("\\t"));
		if (!hasEscapedTabs) continue;
		const hasRealTabs = edit.lines.some(line => line.includes("\t"));
		if (hasRealTabs) continue;
		let correctedCount = 0;
		const corrected = edit.lines.map(line =>
			line.replace(/^((?:\\t)+)/, escaped => {
				correctedCount += escaped.length / 2;
				return "\t".repeat(escaped.length / 2);
			}),
		);
		if (correctedCount === 0) continue;
		edit.lines = corrected;
		warnings.push(
			`Auto-corrected escaped tab indentation in edit: converted leading \\t sequence(s) to real tab characters`,
		);
	}
}

export function applyAtomEdits(
	text: string,
	edits: AtomEdit[],
): {
	lines: string;
	firstChangedLine: number | undefined;
	warnings?: string[];
} {
	if (edits.length === 0) {
		return { lines: text, firstChangedLine: undefined };
	}

	const fileLines = text.split("\n");
	const warnings: string[] = [];
	let firstChangedLine: number | undefined;

	const mismatches = validateAtomAnchors(edits, fileLines);
	if (mismatches.length > 0) {
		throw new HashlineMismatchError(mismatches, fileLines);
	}
	validateNoConflictingAnchorOps(edits);
	maybeAutocorrectEscapedTabIndentation(edits, warnings);

	const trackFirstChanged = (line: number) => {
		if (firstChangedLine === undefined || line < firstChangedLine) {
			firstChangedLine = line;
		}
	};

	// Partition: anchor-scoped vs between vs file-scoped. Preserve original order via the
	// captured idx so multiple pre/post on the same target are emitted in the order
	// the model produced them.
	type Indexed<T> = { edit: T; idx: number };
	type AnchorEdit = Exclude<AtomEdit, { op: "append_file" } | { op: "prepend_file" } | { op: "between" }>;
	const anchorEdits: Indexed<AnchorEdit>[] = [];
	const betweenEdits: Indexed<Extract<AtomEdit, { op: "between" }>>[] = [];
	const appendEdits: Indexed<Extract<AtomEdit, { op: "append_file" }>>[] = [];
	const prependEdits: Indexed<Extract<AtomEdit, { op: "prepend_file" }>>[] = [];
	edits.forEach((edit, idx) => {
		if (edit.op === "append_file") appendEdits.push({ edit, idx });
		else if (edit.op === "prepend_file") prependEdits.push({ edit, idx });
		else if (edit.op === "between") betweenEdits.push({ edit, idx });
		else anchorEdits.push({ edit, idx });
	});

	// Group anchor edits by line so all ops on the same line are applied as a
	// single splice. This makes the per-anchor outcome independent of index
	// shifts caused by sibling ops (e.g. `post` paired with `del` on the same
	// anchor, or repeated `pre`/`post` inserts that previously reversed).
	const byLine = new Map<number, Indexed<AnchorEdit>[]>();
	for (const entry of anchorEdits) {
		const line = entry.edit.pos.line;
		let bucket = byLine.get(line);
		if (!bucket) {
			bucket = [];
			byLine.set(line, bucket);
		}
		bucket.push(entry);
	}

	// Build a unified bottom-up event list. Sort key = highest 1-indexed line
	// each event splices over: anchor group = its line; between = before.line - 1
	// (the topmost line that's actually replaced; the closing-anchor line is
	// preserved). Tie-breakers don't matter — conflicting overlaps are rejected
	// in `validateNoConflictingAnchorOps`.
	type Event =
		| { kind: "anchor"; sortKey: number; line: number; bucket: Indexed<AnchorEdit>[] }
		| { kind: "between"; sortKey: number; entry: Indexed<Extract<AtomEdit, { op: "between" }>> };
	const events: Event[] = [];
	for (const [line, bucket] of byLine) {
		events.push({ kind: "anchor", sortKey: line, line, bucket });
	}
	for (const entry of betweenEdits) {
		events.push({ kind: "between", sortKey: entry.edit.before.line - 1, entry });
	}
	events.sort((a, b) => b.sortKey - a.sortKey);

	for (const event of events) {
		if (event.kind === "between") {
			const { edit } = event.entry;
			const spliceStart = edit.after.line; // 0-indexed: line after.line+1
			const spliceCount = edit.before.line - edit.after.line - 1;
			const replacement = edit.lines;
			const noOp = spliceCount === 0 && replacement.length === 0;
			if (noOp) continue;
			fileLines.splice(spliceStart, spliceCount, ...replacement);
			if (spliceCount > 0 || replacement.length > 0) {
				trackFirstChanged(edit.after.line + 1);
			}
			continue;
		}

		const { line, bucket } = event;
		bucket.sort((a, b) => a.idx - b.idx);

		const idx = line - 1;
		let currentLine = fileLines[idx];
		let replacement: string[] = [currentLine];
		let replacementSet = false;
		let anchorMutated = false;
		let anchorDeleted = false;
		const beforeLines: string[] = [];
		const afterLines: string[] = [];

		for (const { edit } of bucket) {
			switch (edit.op) {
				case "pre":
					beforeLines.push(...edit.lines);
					break;
				case "post":
					afterLines.push(...edit.lines);
					break;
				case "del":
					replacement = [];
					replacementSet = true;
					anchorDeleted = true;
					break;
				case "set":
					replacement = edit.lines.length === 0 ? [""] : [...edit.lines];
					replacementSet = true;
					anchorMutated = true;
					break;
				case "sub": {
					currentLine = applySubToLine(edit, currentLine);
					replacement = currentLine.includes("\n") ? currentLine.split("\n") : [currentLine];
					replacementSet = true;
					anchorMutated = true;
					break;
				}
			}
		}

		const noOp = !replacementSet && beforeLines.length === 0 && afterLines.length === 0;
		if (noOp) continue;

		const combined = [...beforeLines, ...replacement, ...afterLines];
		fileLines.splice(idx, 1, ...combined);

		if (beforeLines.length > 0 || anchorMutated || anchorDeleted) {
			trackFirstChanged(line);
		} else if (afterLines.length > 0) {
			trackFirstChanged(line + 1);
		}
	}

	// Apply prepend_file ops in original order so the first one ends up at the
	// very top of the file.
	prependEdits.sort((a, b) => a.idx - b.idx);
	for (const { edit } of prependEdits) {
		if (edit.lines.length === 0) continue;
		if (fileLines.length === 1 && fileLines[0] === "") {
			fileLines.splice(0, 1, ...edit.lines);
		} else {
			// Insert in reverse cumulative order so later splices push earlier
			// content further down, preserving the original op order.
			fileLines.splice(0, 0, ...edit.lines);
		}
		trackFirstChanged(1);
	}

	// Apply append_file ops in original order. When the file ends with a
	// trailing newline (last split element is the empty sentinel), insert
	// before that sentinel so the trailing newline is preserved.
	appendEdits.sort((a, b) => a.idx - b.idx);
	for (const { edit } of appendEdits) {
		if (edit.lines.length === 0) continue;
		if (fileLines.length === 1 && fileLines[0] === "") {
			fileLines.splice(0, 1, ...edit.lines);
			trackFirstChanged(1);
			continue;
		}
		const hasTrailingNewline = fileLines.length > 0 && fileLines[fileLines.length - 1] === "";
		const insertIdx = hasTrailingNewline ? fileLines.length - 1 : fileLines.length;
		fileLines.splice(insertIdx, 0, ...edit.lines);
		trackFirstChanged(insertIdx + 1);
	}

	return {
		lines: fileLines.join("\n"),
		firstChangedLine,
		...(warnings.length > 0 ? { warnings } : {}),
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Executor
// ═══════════════════════════════════════════════════════════════════════════

export interface ExecuteAtomSingleOptions {
	session: ToolSession;
	path: string;
	edits: AtomToolEdit[];
	signal?: AbortSignal;
	batchRequest?: LspBatchRequest;
	writethrough: WritethroughCallback;
	beginDeferredDiagnosticsForPath: (path: string) => WritethroughDeferredHandle;
}

export async function executeAtomSingle(
	options: ExecuteAtomSingleOptions,
): Promise<AgentToolResult<EditToolDetails, typeof atomEditParamsSchema>> {
	const { session, path, edits, signal, batchRequest, writethrough, beginDeferredDiagnosticsForPath } = options;

	const contentEdits = edits.map((edit, i) => resolveAtomToolEdit(edit, i));

	enforcePlanModeWrite(session, path, { op: "update" });

	if (path.endsWith(".ipynb") && contentEdits.length > 0) {
		throw new Error("Cannot edit Jupyter notebooks with the Edit tool. Use the NotebookEdit tool instead.");
	}

	const absolutePath = resolvePlanPath(session, path);

	const sourceFile = Bun.file(absolutePath);
	const sourceExists = await sourceFile.exists();

	if (!sourceExists) {
		const lines: string[] = [];
		for (const edit of contentEdits) {
			if (edit.op === "append_file") {
				lines.push(...edit.lines);
			} else if (edit.op === "prepend_file") {
				lines.unshift(...edit.lines);
			} else {
				throw new Error(`File not found: ${path}`);
			}
		}

		await Bun.write(absolutePath, lines.join("\n"));
		invalidateFsScanAfterWrite(absolutePath);
		return {
			content: [{ type: "text", text: `Created ${path}` }],
			details: {
				diff: "",
				op: "create",
				meta: outputMeta().get(),
			},
		};
	}

	const rawContent = await sourceFile.text();
	assertEditableFileContent(rawContent, path);

	const { bom, text } = stripBom(rawContent);
	const originalEnding = detectLineEnding(text);
	const originalNormalized = normalizeToLF(text);

	const result = applyAtomEdits(originalNormalized, contentEdits);
	if (originalNormalized === result.lines) {
		throw new Error(`No changes made to ${path}. The edits produced identical content.`);
	}

	const finalContent = bom + restoreLineEndings(result.lines, originalEnding);
	const diagnostics = await writethrough(
		absolutePath,
		finalContent,
		signal,
		Bun.file(absolutePath),
		batchRequest,
		dst => (dst === absolutePath ? beginDeferredDiagnosticsForPath(absolutePath) : undefined),
	);
	invalidateFsScanAfterWrite(absolutePath);

	const diffResult = generateDiffString(originalNormalized, result.lines);
	const meta = outputMeta()
		.diagnostics(diagnostics?.summary ?? "", diagnostics?.messages ?? [])
		.get();

	const resultText = `Updated ${path}`;
	const preview = buildCompactHashlineDiffPreview(diffResult.diff);
	const summaryLine = `Changes: +${preview.addedLines} -${preview.removedLines}${
		preview.preview ? "" : " (no textual diff preview)"
	}`;
	const warningsBlock = result.warnings?.length ? `\n\nWarnings:\n${result.warnings.join("\n")}` : "";
	const previewBlock = preview.preview ? `\n\nDiff preview:\n${preview.preview}` : "";

	return {
		content: [
			{
				type: "text",
				text: `${resultText}\n${summaryLine}${previewBlock}${warningsBlock}`,
			},
		],
		details: {
			diff: diffResult.diff,
			firstChangedLine: result.firstChangedLine ?? diffResult.firstChangedLine,
			diagnostics,
			op: "update",
			meta,
		},
	};
}

// Helpers exposed for tests / external dispatch.
export { classifyAtomEdit, parseAnchor, resolveAtomToolEdit };
