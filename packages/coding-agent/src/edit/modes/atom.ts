/**
 *
 * Flat locator + verb edit mode backed by hashline anchors. Each entry carries
 * one shared `loc` selector plus one or more verbs (`pre`, `set`, `post`).
 * The runtime resolves those verbs into internal anchor-scoped edits and still
 * reuses hashline's staleness scheme (`computeLineHash`) verbatim.
 *
 * External shapes (one entry):
 *   { path, loc: "5th",      set:  ["..."] }
 *   { path, loc: "5th",      pre:  ["..."] }
 *   { path, loc: "5th",      post: ["..."] }
 *   { path, loc: "5th",      pre: [...], set: [...], post: [...] }
 *   { path, loc: "$",        pre:  [...] }                            // prepend to file
 *   { path, loc: "$",        post: [...] }                            // append to file
 *   { path, loc: "$",        sed:  "s/foo/bar/" }                    // sed on every line
 *
 * `set: []` on a single-anchor locator deletes that line. `set:[""]` preserves
 * a blank line. Line ranges are not supported.
 * in the same entry.
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
import { computeLineHash, HASHLINE_BIGRAM_RE_SRC, HASHLINE_CONTENT_SEPARATOR } from "../line-hash";
import { detectLineEnding, normalizeToLF, restoreLineEndings, stripBom } from "../normalize";
import type { EditToolDetails, LspBatchRequest } from "../renderer";
import {
	ANCHOR_REBASE_WINDOW,
	type Anchor,
	buildCompactHashlineDiffPreview,
	formatFullAnchorRequirement,
	HashlineMismatchError,
	type HashMismatch,
	hashlineParseText,
	parseTag,
	tryRebaseAnchor,
} from "./hashline";

// ═══════════════════════════════════════════════════════════════════════════
// Schema
// ═══════════════════════════════════════════════════════════════════════════
const textSchema = Type.Array(Type.String());

/**
 * Flat entry shape with shared locator fields and verb-specific payloads.
 * The runtime validator (`resolveAtomToolEdit`) enforces legal locator/verb
 * combinations. Keeping the schema flat reduces tool-definition size and gives
 * weaker models fewer branching shapes to sample from.
 */
export const atomEditSchema = Type.Object(
	{
		loc: Type.String({
			description: 'edit location: "1ab", "$", or path override like "a.ts:1ab"',
			examples: ["1ab", "$", "src/foo.ts:1ab"],
		}),
		set: Type.Optional(textSchema),
		pre: Type.Optional(textSchema),
		post: Type.Optional(textSchema),
		sed: Type.Optional(
			Type.String({
				description: "sed-style substitution applied to the anchored line",
				examples: ["s/foo/bar/", "s|api|API|g", "s/<pat>/<rep>/F"],
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
	| { op: "append_file"; lines: string[] }
	| { op: "prepend_file"; lines: string[] }
	| { op: "sed"; pos: Anchor; spec: SedSpec; expression: string }
	| { op: "sed_file"; spec: SedSpec; expression: string };

export interface SedSpec {
	pattern: string;
	replacement: string;
	global: boolean;
	ignoreCase: boolean;
	literal: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Param guards
// ═══════════════════════════════════════════════════════════════════════════

const ATOM_VERB_KEYS = ["set", "pre", "post", "sed"] as const;
type AtomOptionalKey = "loc" | (typeof ATOM_VERB_KEYS)[number];
const ATOM_OPTIONAL_KEYS = ["loc", ...ATOM_VERB_KEYS] as const satisfies readonly AtomOptionalKey[];

// Matches just the LINE+BIGRAM prefix of an anchor reference. Used to detect
// optional `|content` suffixes (e.g. `82zu|  for (...)`) so the suffix can be
// captured as a content hint for anchor disambiguation.
const ANCHOR_PREFIX_RE = new RegExp(`^\\s*[>+-]*\\s*\\d+${HASHLINE_BIGRAM_RE_SRC}`);

// Splits `path:loc` references where the right side starts with a valid anchor
// (single `\d+<bigram>` or `<anchor>-<anchor>` range, optionally followed by a
// content suffix using `|` or `:`). The non-greedy `(.+?)` picks the leftmost
// colon whose RHS is a real anchor, so colons inside the loc's content suffix
// (TS type annotations, etc.) don't break the split. Drive-letter prefixes like
// `C:\path\a.ts:160sr` still resolve correctly because the first colon's RHS
// fails the anchor pattern.
const ANCHOR_TAG_RE_SRC = `\\s*[>+-]*\\s*\\d+${HASHLINE_BIGRAM_RE_SRC}`;
const PATH_LOC_SPLIT_RE = new RegExp(`^(.+?):(${ANCHOR_TAG_RE_SRC}(?:-${ANCHOR_TAG_RE_SRC})?(?:[|:].*)?)$`);

function stripNullAtomFields(edit: AtomToolEdit): AtomToolEdit {
	let next: Record<string, unknown> | undefined;
	const fields = edit as Record<string, unknown>;
	for (const key of ATOM_OPTIONAL_KEYS) {
		if (fields[key] !== null) continue;
		next ??= { ...fields };
		delete next[key];
	}
	return (next ?? fields) as AtomToolEdit;
}

type ParsedAtomLoc = { kind: "anchor"; pos: Anchor } | { kind: "file" };

// ═══════════════════════════════════════════════════════════════════════════
// Resolution
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse an anchor reference like `"5th"`.
 *
 * Tolerant: on a malformed reference we still try to extract a 1-indexed line
 * number from the leading digits so the validator can surface the *correct*
 * `LINEHASH|content` for the user. The bogus hash is preserved in the returned
 * anchor so the validator emits a content-rich mismatch error.
 *
 * If we cannot recover even a line number, throw a usage-style error with the
 * raw reference quoted.
 */
function parseAnchor(raw: string, opName: string): Anchor {
	if (typeof raw !== "string" || raw.length === 0) {
		throw new Error(`${opName} requires ${formatFullAnchorRequirement()}.`);
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
			`${opName} requires ${formatFullAnchorRequirement(raw)} Could not find a line number in the anchor.`,
		);
	}
}

function tryParseAtomTag(raw: string): Anchor | undefined {
	try {
		return parseTag(raw);
	} catch {
		return undefined;
	}
}

function resolveAtomEntryPath(
	edit: AtomToolEdit,
	topLevelPath: string | undefined,
	editIndex: number,
): AtomToolEdit & { path: string } {
	const entry = stripNullAtomFields(edit);
	let loc = entry.loc;
	let pathOverride: string | undefined;
	if (typeof loc === "string") {
		const split = loc.match(PATH_LOC_SPLIT_RE);
		if (split) {
			pathOverride = split[1];
			loc = split[2]!;
		}
	}
	const path = pathOverride || topLevelPath;
	if (!path) {
		throw new Error(
			`Edit ${editIndex}: missing path. Provide a top-level path or prefix loc with a file path (for example "a.ts:160sr").`,
		);
	}
	return { ...entry, path, ...(loc !== entry.loc ? { loc } : {}) };
}

export function resolveAtomEntryPaths(
	edits: readonly AtomToolEdit[],
	topLevelPath: string | undefined,
): (AtomToolEdit & { path: string })[] {
	return edits.map((edit, i) => resolveAtomEntryPath(edit, topLevelPath, i));
}

function parseLoc(raw: string, editIndex: number): ParsedAtomLoc {
	if (raw === "$") return { kind: "file" };
	// Detect range syntax explicitly: "<anchor>-<anchor>". A bare `-` inside the
	// loc (e.g. line content like `i--`) should not trigger the range error.
	const dash = raw.indexOf("-");
	if (dash > 0) {
		const left = raw.slice(0, dash);
		const right = raw.slice(dash + 1);
		if (tryParseAtomTag(left) !== undefined && tryParseAtomTag(right) !== undefined) {
			throw new Error(
				`Edit ${editIndex}: atom loc does not support line ranges. Use a single anchor like "160sr" or "$".`,
			);
		}
	}
	const pos = parseAnchor(raw, "loc");
	// Capture an optional content suffix after the anchor: `82zu|  for (...)`.
	// The suffix acts as a hint for anchor disambiguation when the model's hash
	// is wrong but the content reveals the intended line.
	const hint = extractAnchorContentHint(raw);
	if (hint !== undefined) {
		pos.contentHint = hint;
	}
	return { kind: "anchor", pos };
}

function extractAnchorContentHint(raw: string): string | undefined {
	const match = raw.match(ANCHOR_PREFIX_RE);
	if (!match) return undefined;
	const rest = raw.slice(match[0].length);
	// Accept either the canonical `|` (HASHLINE_CONTENT_SEPARATOR) or the legacy
	// `:` separator. Models trained on older docs still emit `82zu:  for (...)`.
	const sep = rest[0];
	if (sep !== HASHLINE_CONTENT_SEPARATOR && sep !== ":") return undefined;
	const hint = rest.slice(1);
	if (hint.trim().length === 0) return undefined;
	return hint;
}

function parseSedExpression(raw: string, editIndex: number): SedSpec {
	if (typeof raw !== "string" || raw.length < 3) {
		throw new Error(
			`Edit ${editIndex}: sed expression must start with "s" followed by a delimiter, e.g. "s/foo/bar/".`,
		);
	}
	// Tolerate a missing leading `s`: models occasionally emit `/foo/bar/` directly.
	// As long as the first character is a valid delimiter, treat the expression as
	// if `s` was prepended.
	let bodyStart = 0;
	if (raw[0] === "s") {
		bodyStart = 1;
	}
	const delim = raw[bodyStart]!;
	if (/[\sA-Za-z0-9\\]/.test(delim)) {
		throw new Error(
			`Edit ${editIndex}: sed delimiter must be a non-alphanumeric, non-whitespace, non-backslash character (got ${JSON.stringify(delim)}).`,
		);
	}
	const parts: [string, string] = ["", ""];
	let bucket: 0 | 1 = 0;
	let i = bodyStart + 1;
	while (i < raw.length) {
		const c = raw[i]!;
		if (c === "\\" && raw[i + 1] === delim) {
			parts[bucket] += delim;
			i += 2;
			continue;
		}
		if (c === delim) {
			if (bucket === 0) {
				bucket = 1;
				i += 1;
				continue;
			}
			i += 1;
			break;
		}
		parts[bucket] += c;
		i += 1;
	}
	if (bucket !== 1) {
		throw new Error(
			`Edit ${editIndex}: malformed sed expression ${JSON.stringify(raw)}. Expected three ${JSON.stringify(delim)} separators.`,
		);
	}
	const flagsStr = raw.slice(i);
	let global = false;
	let ignoreCase = false;
	let literal = false;
	for (const f of flagsStr) {
		if (f === "g") global = true;
		else if (f === "i") ignoreCase = true;
		else if (f === "F") literal = true;
		else {
			throw new Error(
				`Edit ${editIndex}: unknown sed flag ${JSON.stringify(f)}. Supported flags: g (all), i (case-insensitive), F (literal).`,
			);
		}
	}
	if (parts[0] === "") {
		throw new Error(`Edit ${editIndex}: sed expression has empty pattern.`);
	}
	return { pattern: parts[0], replacement: parts[1], global, ignoreCase, literal };
}

function applyLiteralSed(currentLine: string, spec: SedSpec): { result: string; matched: boolean } {
	const idx = currentLine.indexOf(spec.pattern);
	if (idx === -1) return { result: currentLine, matched: false };
	if (spec.global) {
		return { result: currentLine.split(spec.pattern).join(spec.replacement), matched: true };
	}
	return {
		result: currentLine.slice(0, idx) + spec.replacement + currentLine.slice(idx + spec.pattern.length),
		matched: true,
	};
}

function applySedToLine(
	currentLine: string,
	spec: SedSpec,
): { result: string; matched: boolean; error?: string; literalFallback?: boolean } {
	if (spec.literal) {
		return applyLiteralSed(currentLine, spec);
	}
	let flags = "";
	if (spec.global) flags += "g";
	if (spec.ignoreCase) flags += "i";
	let re: RegExp | undefined;
	let compileError: string | undefined;
	try {
		re = new RegExp(spec.pattern, flags);
	} catch (e) {
		compileError = (e as Error).message;
	}
	if (re?.test(currentLine)) {
		re.lastIndex = 0;
		return { result: currentLine.replace(re, spec.replacement), matched: true };
	}
	// Fall back to literal substring match. Models frequently send sed patterns
	// containing unescaped regex metacharacters (parentheses, `?`, `.`) that they
	// intend as literal code. Trying a literal match before reporting failure
	// recovers the obvious intent without changing semantics for patterns that
	// already match as regex.
	const literal = applyLiteralSed(currentLine, spec);
	if (literal.matched) {
		return { ...literal, literalFallback: true };
	}
	if (compileError !== undefined) {
		return { result: currentLine, matched: false, error: compileError };
	}
	return { result: currentLine, matched: false };
}

function classifyAtomEdit(edit: AtomToolEdit): string {
	const entry = stripNullAtomFields(edit);
	const verbs = ATOM_VERB_KEYS.filter(k => entry[k] !== undefined);
	return verbs.length > 0 ? verbs.join("+") : "unknown";
}

function resolveAtomToolEdit(edit: AtomToolEdit, editIndex = 0): AtomEdit[] {
	const entry = stripNullAtomFields(edit);
	const verbKeysPresent = ATOM_VERB_KEYS.filter(k => entry[k] !== undefined);
	if (verbKeysPresent.length === 0) {
		throw new Error(
			`Edit ${editIndex}: missing verb. Each entry must include at least one of: ${ATOM_VERB_KEYS.join(", ")}.`,
		);
	}
	if (typeof entry.loc !== "string") {
		throw new Error(`Edit ${editIndex}: missing loc. Use a selector like "160sr" or "$".`);
	}

	const loc = parseLoc(entry.loc, editIndex);
	const resolved: AtomEdit[] = [];

	if (loc.kind === "file") {
		if (entry.set !== undefined) {
			throw new Error(`Edit ${editIndex}: loc "$" supports pre, post, and sed (not set).`);
		}
		if (entry.pre !== undefined) {
			resolved.push({ op: "prepend_file", lines: hashlineParseText(entry.pre) });
		}
		if (entry.post !== undefined) {
			resolved.push({ op: "append_file", lines: hashlineParseText(entry.post) });
		}
		if (entry.sed !== undefined) {
			const spec = parseSedExpression(entry.sed, editIndex);
			resolved.push({ op: "sed_file", spec, expression: entry.sed });
		}
		return resolved;
	}

	if (entry.pre !== undefined) {
		resolved.push({ op: "pre", pos: loc.pos, lines: hashlineParseText(entry.pre) });
	}
	if (entry.set !== undefined) {
		if (Array.isArray(entry.set) && entry.set.length === 0) {
			// Models often default `set: []` alongside other verbs (notably `sed`).
			// Treating that combination as an explicit `del` produces a confusing
			// `Conflicting ops` error. When another mutating verb is present, drop
			// the empty `set` instead of treating it as a deletion.
			if (entry.sed === undefined) {
				resolved.push({ op: "del", pos: loc.pos });
			}
		} else {
			resolved.push({ op: "set", pos: loc.pos, lines: hashlineParseText(entry.set) });
		}
	}
	if (entry.post !== undefined) {
		resolved.push({ op: "post", pos: loc.pos, lines: hashlineParseText(entry.post) });
	}
	if (entry.sed !== undefined) {
		const setIsExplicitReplacement = Array.isArray(entry.set) && entry.set.length > 0;
		// Models often duplicate intent by sending both an explicit `set` and a
		// matching `sed`. The explicit replacement wins; the redundant `sed` would
		// otherwise trigger a confusing `Conflicting ops` rejection.
		if (!setIsExplicitReplacement) {
			const spec = parseSedExpression(entry.sed, editIndex);
			resolved.push({ op: "sed", pos: loc.pos, spec, expression: entry.sed });
		}
	}
	return resolved;
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
		case "sed":
			yield edit.pos;
			return;
		default:
			return;
	}
}

/**
 * Search for a line near `anchor.line` whose trimmed content equals the
 * anchor's content hint. Returns the closest match (preferring lines below the
 * requested anchor on ties) or `null` when no line matches. Strict equality on
 * trimmed content keeps this conservative \u2014 we only retarget when there is no
 * ambiguity about the model's intent.
 */
function findLineByContentHint(anchor: Anchor, fileLines: string[]): number | null {
	const hint = anchor.contentHint?.trim();
	if (!hint) return null;
	const lo = Math.max(1, anchor.line - ANCHOR_REBASE_WINDOW);
	const hi = Math.min(fileLines.length, anchor.line + ANCHOR_REBASE_WINDOW);
	let best: { line: number; distance: number } | null = null;
	for (let line = lo; line <= hi; line++) {
		if (fileLines[line - 1].trim() !== hint) continue;
		const distance = Math.abs(line - anchor.line);
		if (best === null || distance < best.distance) {
			best = { line, distance };
		}
	}
	return best?.line ?? null;
}

function validateAtomAnchors(edits: AtomEdit[], fileLines: string[], warnings: string[]): HashMismatch[] {
	const mismatches: HashMismatch[] = [];
	for (const edit of edits) {
		for (const anchor of getAtomAnchors(edit)) {
			if (anchor.line < 1 || anchor.line > fileLines.length) {
				throw new Error(`Line ${anchor.line} does not exist (file has ${fileLines.length} lines)`);
			}
			const actualHash = computeLineHash(anchor.line, fileLines[anchor.line - 1]);
			if (actualHash === anchor.hash) continue;
			// When the model supplied a content hint after the anchor (e.g.
			// `82zu|  for (...)`), prefer rebasing to the line that actually matches
			// that content. This avoids false positives from hash-only rebasing where
			// a coincidentally matching hash on a nearby line silently retargets the
			// edit to the wrong line.
			const hinted = findLineByContentHint(anchor, fileLines);
			if (hinted !== null) {
				const original = `${anchor.line}${anchor.hash}`;
				const hintedHash = computeLineHash(hinted, fileLines[hinted - 1]);
				anchor.line = hinted;
				anchor.hash = hintedHash;
				warnings.push(
					`Auto-rebased anchor ${original} → ${hinted}${hintedHash} (matched the content hint provided after the anchor).`,
				);
				continue;
			}
			const rebased = tryRebaseAnchor(anchor, fileLines);
			if (rebased !== null) {
				const original = `${anchor.line}${anchor.hash}`;
				anchor.line = rebased;
				warnings.push(
					`Auto-rebased anchor ${original} → ${rebased}${anchor.hash} (line shifted within ±${ANCHOR_REBASE_WINDOW}; hash matched).`,
				);
				continue;
			}
			mismatches.push({ line: anchor.line, expected: anchor.hash, actual: actualHash });
		}
	}
	return mismatches;
}

function validateNoConflictingAnchorOps(edits: AtomEdit[]): void {
	// For each anchor line, at most one mutating op (set/del).
	// `pre`/`post` (insert ops) may coexist with them — they don't mutate the anchor line.
	const mutatingPerLine = new Map<number, string>();
	for (const edit of edits) {
		if (edit.op !== "set" && edit.op !== "del" && edit.op !== "sed") continue;
		const existing = mutatingPerLine.get(edit.pos.line);
		if (existing) {
			throw new Error(
				`Conflicting ops on anchor line ${edit.pos.line}: \`${existing}\` and \`${edit.op}\`. ` +
					`At most one of set/del/sed is allowed per anchor.`,
			);
		}
		mutatingPerLine.set(edit.pos.line, edit.op);
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Apply
// ═══════════════════════════════════════════════════════════════════════════

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

export interface AtomNoopEdit {
	editIndex: number;
	loc: string;
	reason: string;
	current: string;
}

export function applyAtomEdits(
	text: string,
	edits: AtomEdit[],
): {
	lines: string;
	firstChangedLine: number | undefined;
	warnings?: string[];
	noopEdits?: AtomNoopEdit[];
} {
	if (edits.length === 0) {
		return { lines: text, firstChangedLine: undefined };
	}

	const fileLines = text.split("\n");
	const warnings: string[] = [];
	let firstChangedLine: number | undefined;
	const noopEdits: AtomNoopEdit[] = [];

	const mismatches = validateAtomAnchors(edits, fileLines, warnings);
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

	// Partition: anchor-scoped vs file-scoped. Preserve original order via the
	// captured idx so multiple pre/post on the same target are emitted in the order
	// the model produced them.
	type Indexed<T> = { edit: T; idx: number };
	type AnchorEdit = Exclude<AtomEdit, { op: "append_file" } | { op: "prepend_file" } | { op: "sed_file" }>;
	const anchorEdits: Indexed<AnchorEdit>[] = [];
	const appendEdits: Indexed<Extract<AtomEdit, { op: "append_file" }>>[] = [];
	const sedFileEdits: Indexed<Extract<AtomEdit, { op: "sed_file" }>>[] = [];
	const prependEdits: Indexed<Extract<AtomEdit, { op: "prepend_file" }>>[] = [];
	edits.forEach((edit, idx) => {
		if (edit.op === "append_file") appendEdits.push({ edit, idx });
		else if (edit.op === "prepend_file") prependEdits.push({ edit, idx });
		else if (edit.op === "sed_file") sedFileEdits.push({ edit, idx });
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

	const anchorLines = [...byLine.keys()].sort((a, b) => b - a);
	for (const line of anchorLines) {
		const bucket = byLine.get(line);
		if (!bucket) continue;
		bucket.sort((a, b) => a.idx - b.idx);

		const idx = line - 1;
		const currentLine = fileLines[idx];
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
				case "sed": {
					const { result, matched, error, literalFallback } = applySedToLine(currentLine, edit.spec);
					if (error) {
						throw new Error(`Edit sed expression ${JSON.stringify(edit.expression)} failed to compile: ${error}`);
					}
					if (!matched) {
						throw new Error(
							`Edit sed expression ${JSON.stringify(edit.expression)} did not match line ${edit.pos.line}: ${JSON.stringify(currentLine)}`,
						);
					}
					if (literalFallback) {
						warnings.push(
							`sed expression ${JSON.stringify(edit.expression)} did not match as a regex on line ${edit.pos.line}; applied literal substring substitution instead. Use the \`F\` flag (e.g. \`s/.../.../F\`) for literal patterns or escape regex metacharacters.`,
						);
					}
					replacement = [result];
					replacementSet = true;
					anchorMutated = true;
					break;
				}
			}
		}

		const noOp = !replacementSet && beforeLines.length === 0 && afterLines.length === 0;
		if (noOp) continue;

		const originalLine = fileLines[idx];
		const replacementProducesNoChange =
			beforeLines.length === 0 &&
			afterLines.length === 0 &&
			replacement.length === 1 &&
			replacement[0] === originalLine;
		if (replacementProducesNoChange) {
			const firstEdit = bucket[0]?.edit;
			const loc = firstEdit ? `${firstEdit.pos.line}${firstEdit.pos.hash}` : `${line}`;
			const reason = "replacement is identical to the current line content";
			noopEdits.push({
				editIndex: bucket[0]?.idx ?? 0,
				loc,
				reason,
				current: originalLine,
			});
			continue;
		}

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

	// Apply sed_file ops last so they observe the post-anchor / post-prepend /
	// post-append state of the file. Each op runs across every content line and
	let warnedLiteralFallback = false;
	sedFileEdits.sort((a, b) => a.idx - b.idx);
	for (const { edit } of sedFileEdits) {
		const hasTrailingNewline = fileLines.length > 1 && fileLines[fileLines.length - 1] === "";
		const upper = hasTrailingNewline ? fileLines.length - 1 : fileLines.length;
		let anyMatched = false;
		let lastCompileError: string | undefined;
		for (let i = 0; i < upper; i++) {
			const line = fileLines[i] ?? "";
			const r = applySedToLine(line, edit.spec);
			if (r.error) lastCompileError = r.error;
			if (!r.matched) continue;
			anyMatched = true;
			if (r.literalFallback && !warnedLiteralFallback) {
				warnings.push(
					`sed expression ${JSON.stringify(edit.expression)} did not match as a regex; applied literal substring substitution. Use the \`F\` flag (e.g. \`s/.../.../F\`) for literal patterns or escape regex metacharacters.`,
				);
				warnedLiteralFallback = true;
			}
			if (r.result !== line) {
				fileLines[i] = r.result;
				trackFirstChanged(i + 1);
			}
		}
		if (!anyMatched) {
			if (lastCompileError !== undefined) {
				throw new Error(
					`Edit sed expression ${JSON.stringify(edit.expression)} failed to compile: ${lastCompileError}`,
				);
			}
			throw new Error(
				`Edit sed expression ${JSON.stringify(edit.expression)} did not match any line in the file.`,
			);
		}
	}

	return {
		lines: fileLines.join("\n"),
		firstChangedLine,
		...(warnings.length > 0 ? { warnings } : {}),
		...(noopEdits.length > 0 ? { noopEdits } : {}),
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

	const contentEdits = edits.flatMap((edit, i) => resolveAtomToolEdit(edit, i));

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
		let diagnostic = `Edits to ${path} resulted in no changes being made.`;
		if (result.noopEdits && result.noopEdits.length > 0) {
			const details = result.noopEdits
				.map(e => {
					const preview =
						e.current.length > 0
							? `\n  current: ${JSON.stringify(e.current.length > 200 ? `${e.current.slice(0, 200)}…` : e.current)}`
							: "";
					return `Edit ${e.editIndex} (${e.loc}): ${e.reason}.${preview}`;
				})
				.join("\n");
			diagnostic += `\n${details}`;
		}
		throw new Error(diagnostic);
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
