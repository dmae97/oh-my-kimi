/**
 * Token-driven state machine that turns a stream of {@link Token}s into a
 * flat list of {@link Edit}s. Sits between the {@link Tokenizer} and the
 * applier.
 */
import { HL_PAYLOAD_REPLACE } from "./format";
import {
	BARE_BODY_AUTO_PIPED_WARNING,
	DELETE_BLOCK_TAKES_NO_BODY,
	DELETE_TAKES_NO_BODY,
	EMPTY_BLOCK,
	EMPTY_INSERT,
	EMPTY_REPLACE,
	MINUS_ROW_REJECTED,
} from "./messages";
import { type BlockTarget, cloneCursor, type ParsedRange, type Token, Tokenizer } from "./tokenizer";
import type { Anchor, Cursor, Edit } from "./types";

function validateRangeOrder(range: ParsedRange, lineNum: number): void {
	if (range.end.line < range.start.line) {
		throw new Error(`line ${lineNum}: range ${range.start.line}..${range.end.line} ends before it starts.`);
	}
}

function expandRange(range: ParsedRange): Anchor[] {
	const anchors: Anchor[] = [];
	for (let line = range.start.line; line <= range.end.line; line++) anchors.push({ line });
	return anchors;
}

function isSkippableCommentLine(line: string): boolean {
	return line.trimStart().startsWith("#");
}

function detectApplyPatchContamination(text: string, _hasPending: boolean): string | null {
	const trimmed = text.trimStart();
	if (trimmed.length === 0) return null;
	if (
		trimmed.startsWith("*** Update File:") ||
		trimmed.startsWith("*** Add File:") ||
		trimmed.startsWith("*** Delete File:") ||
		trimmed.startsWith("*** Move to:")
	) {
		const preview = trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed;
		return (
			`apply_patch sentinel ${JSON.stringify(preview)} is not valid in hashline. ` +
			"File sections start with `¶path#HASH` (no `Update File:` / `Add File:` keyword). " +
			"Use `replace N..M:`, `delete N..M`, or `insert before|after|head|tail:` ops."
		);
	}
	if (/^@@\s+[-+]?\d+,\d+\s+[-+]?\d+,\d+\s+@@/.test(trimmed)) {
		return (
			"unified-diff hunk header (`@@ -N,M +N,M @@`) is not valid in hashline. " +
			"Use `replace N..M:`, `delete N..M`, or `insert before|after|head|tail:` ops."
		);
	}
	if (trimmed.startsWith("@@")) {
		const preview = trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed;
		return (
			`\`@@\`-bracketed hunk header ${JSON.stringify(preview)} is not valid in hashline. ` +
			"Drop the `@@ ... @@` brackets and write a verb header such as `replace N..M:`."
		);
	}
	if (/^delete\s+[1-9]\d*(?:\s*(?:\.\.|-|…|\s)\s*[1-9]\d*)?\s*:/.test(trimmed)) {
		return "`delete N..M` has no colon and no body. Remove the colon and body rows.";
	}
	if (/^[1-9]\d*\s*$/.test(trimmed)) {
		return `hunk headers need a verb. Use \`replace ${trimmed}..${trimmed}:\` to replace, or \`delete ${trimmed}\` to delete.`;
	}
	const bareRange = /^([1-9]\d*)\s*[-. …]+\s*([1-9]\d*)\s*:?$/.exec(trimmed);
	if (bareRange !== null) {
		return (
			`bare range hunk header ${JSON.stringify(trimmed)} is not valid. ` +
			`Hunk headers need a verb: write \`replace ${bareRange[1]}..${bareRange[2]}:\` or \`delete ${bareRange[1]}..${bareRange[2]}\`.`
		);
	}
	return null;
}

interface PendingComment {
	lineNum: number;
	text: string;
}

type PayloadRow = { kind: "literal"; text: string; lineNum: number };

interface Pending {
	target: BlockTarget;
	lineNum: number;
	payloads: PayloadRow[];
}

export class Executor {
	#edits: Edit[] = [];
	#warnings: string[] = [];
	#editIndex = 0;
	#pending: Pending | undefined;
	#terminated = false;
	#skippableComments: PendingComment[] = [];

	#discardPendingSkippableComments(): void {
		this.#skippableComments = [];
	}

	#consumePendingSkippableComments(): void {
		if (this.#skippableComments.length === 0) return;
		for (const comment of this.#skippableComments) this.#handleRaw(comment.text, comment.lineNum);
		this.#skippableComments = [];
	}

	feed(token: Token): void {
		if (this.#terminated) return;
		switch (token.kind) {
			case "envelope-begin":
				this.#consumePendingSkippableComments();
				return;
			case "envelope-end":
				this.#consumePendingSkippableComments();
				this.#terminated = true;
				return;
			case "abort":
				this.#terminated = true;
				return;
			case "header":
				this.#consumePendingSkippableComments();
				this.#flushPending();
				return;
			case "blank":
				this.#consumePendingSkippableComments();
				return;
			case "payload-literal":
				this.#consumePendingSkippableComments();
				this.#handleLiteralPayload(token.text, token.lineNum);
				return;
			case "raw":
				if (this.#pending === undefined && isSkippableCommentLine(token.text)) {
					this.#skippableComments.push({ text: token.text, lineNum: token.lineNum });
					return;
				}
				this.#consumePendingSkippableComments();
				this.#handleRaw(token.text, token.lineNum);
				return;
			case "op-block":
				this.#discardPendingSkippableComments();
				if (token.target.kind === "replace" || token.target.kind === "delete") {
					validateRangeOrder(token.target.range, token.lineNum);
				}
				this.#flushPending();
				this.#pending = { target: token.target, lineNum: token.lineNum, payloads: [] };
				return;
		}
	}

	end(): { edits: Edit[]; warnings: string[] } {
		this.#consumePendingSkippableComments();
		this.#flushPending();
		this.#validateNoOverlappingDeletes();
		return { edits: this.#edits, warnings: this.#warnings };
	}

	endStreaming(): { edits: Edit[]; warnings: string[] } {
		this.#consumePendingSkippableComments();
		if (this.#pending && this.#pending.payloads.length > 0) this.#flushPending();
		else if (this.#pending?.target.kind === "delete" || this.#pending?.target.kind === "delete_block")
			this.#flushPending();
		else this.#pending = undefined;
		this.#validateNoOverlappingDeletes();
		return { edits: this.#edits, warnings: this.#warnings };
	}

	reset(): void {
		this.#edits = [];
		this.#warnings = [];
		this.#editIndex = 0;
		this.#pending = undefined;
		this.#skippableComments = [];
		this.#terminated = false;
	}

	#validateNoOverlappingDeletes(): void {
		const sourceLinesByAnchor = new Map<number, number[]>();
		for (const edit of this.#edits) {
			if (edit.kind !== "delete") continue;
			let sourceLines = sourceLinesByAnchor.get(edit.anchor.line);
			if (sourceLines === undefined) {
				sourceLines = [];
				sourceLinesByAnchor.set(edit.anchor.line, sourceLines);
			}
			if (!sourceLines.includes(edit.lineNum)) sourceLines.push(edit.lineNum);
		}
		for (const [anchorLine, sourceLines] of sourceLinesByAnchor) {
			if (sourceLines.length < 2) continue;
			const [firstBlock, secondBlock] = [...sourceLines].sort((a, b) => a - b);
			throw new Error(
				`line ${secondBlock}: anchor line ${anchorLine} is already targeted by another hunk on line ${firstBlock}. ` +
					"Issue ONE hunk per range; payload is only the final desired content, never a before/after pair.",
			);
		}
	}

	#handleLiteralPayload(text: string, lineNum: number): void {
		const pending = this.#pending;
		if (!pending) {
			throw new Error(
				`line ${lineNum}: payload line has no preceding hunk header. ` +
					`Got ${JSON.stringify(`${HL_PAYLOAD_REPLACE}${text}`)}.`,
			);
		}
		if (pending.target.kind === "delete") throw new Error(`line ${lineNum}: ${DELETE_TAKES_NO_BODY}`);
		if (pending.target.kind === "delete_block") throw new Error(`line ${lineNum}: ${DELETE_BLOCK_TAKES_NO_BODY}`);
		pending.payloads.push({ kind: "literal", text, lineNum });
	}

	#handleRaw(text: string, lineNum: number): void {
		const contamination = detectApplyPatchContamination(text, this.#pending !== undefined);
		if (contamination !== null) throw new Error(`line ${lineNum}: ${contamination}`);
		if (this.#pending) {
			if (text.trim().length === 0) return;
			if (this.#pending.target.kind === "delete") throw new Error(`line ${lineNum}: ${DELETE_TAKES_NO_BODY}`);
			if (this.#pending.target.kind === "delete_block")
				throw new Error(`line ${lineNum}: ${DELETE_BLOCK_TAKES_NO_BODY}`);
			if (text.trimStart().charCodeAt(0) === 45 /* - */) throw new Error(`line ${lineNum}: ${MINUS_ROW_REJECTED}`);
			if (!this.#warnings.includes(BARE_BODY_AUTO_PIPED_WARNING)) this.#warnings.push(BARE_BODY_AUTO_PIPED_WARNING);
			this.#pending.payloads.push({ kind: "literal", text, lineNum });
			return;
		}
		if (text.trim().length === 0) return;
		throw new Error(
			`line ${lineNum}: payload line has no preceding hunk header. ` +
				`Use \`replace N..M:\`, \`delete N..M\`, or \`insert before|after|head|tail:\` above the body. Got ${JSON.stringify(text)}.`,
		);
	}

	#pushInsert(cursor: Cursor, text: string, lineNum: number, mode?: "replacement"): void {
		this.#edits.push({
			kind: "insert",
			cursor: cloneCursor(cursor),
			text,
			lineNum,
			index: this.#editIndex++,
			...(mode === undefined ? {} : { mode }),
		});
	}

	#pushDelete(anchor: Anchor, lineNum: number): void {
		this.#edits.push({ kind: "delete", anchor: { ...anchor }, lineNum, index: this.#editIndex++ });
	}

	#pushBlock(anchor: Anchor, payloads: readonly PayloadRow[], lineNum: number): void {
		this.#edits.push({
			kind: "block",
			anchor: { ...anchor },
			payloads: payloads.map(payload => payload.text),
			lineNum,
			index: this.#editIndex++,
		});
	}

	#emitPayloadRows(cursor: Cursor, payloads: readonly PayloadRow[], lineNum: number, mode?: "replacement"): void {
		for (const payload of payloads) this.#pushInsert(cursor, payload.text, lineNum, mode);
	}

	#flushPending(): void {
		const pending = this.#pending;
		if (!pending) return;
		const { target, lineNum, payloads } = pending;
		this.#pending = undefined;
		if (target.kind === "delete") {
			for (const anchor of expandRange(target.range)) this.#pushDelete(anchor, lineNum);
			return;
		}
		if (target.kind === "delete_block") {
			// A block edit with no payloads resolves to a pure block deletion.
			this.#pushBlock(target.anchor, [], lineNum);
			return;
		}
		if (target.kind === "block") {
			if (payloads.length === 0) throw new Error(`line ${lineNum}: ${EMPTY_BLOCK}`);
			this.#pushBlock(target.anchor, payloads, lineNum);
			return;
		}
		if (payloads.length === 0) {
			if (target.kind === "replace") throw new Error(`line ${lineNum}: ${EMPTY_REPLACE}`);
			throw new Error(`line ${lineNum}: ${EMPTY_INSERT}`);
		}
		if (target.kind === "replace") {
			const cursor: Cursor = { kind: "before_anchor", anchor: { ...target.range.start } };
			this.#emitPayloadRows(cursor, payloads, lineNum, "replacement");
			for (const anchor of expandRange(target.range)) this.#pushDelete(anchor, lineNum);
			return;
		}
		if (target.kind === "insert_before") {
			this.#emitPayloadRows({ kind: "before_anchor", anchor: { ...target.anchor } }, payloads, lineNum);
			return;
		}
		if (target.kind === "insert_after") {
			this.#emitPayloadRows({ kind: "after_anchor", anchor: { ...target.anchor } }, payloads, lineNum);
			return;
		}
		const cursor: Cursor = target.kind === "bof" ? { kind: "bof" } : { kind: "eof" };
		this.#emitPayloadRows(cursor, payloads, lineNum);
	}
}

function drain(executor: Executor, tokenizer: Tokenizer): { edits: Edit[]; warnings: string[] } {
	for (const token of tokenizer.end()) executor.feed(token);
	return executor.end();
}

export function parsePatch(diff: string): { edits: Edit[]; warnings: string[] } {
	const tokenizer = new Tokenizer();
	const executor = new Executor();
	for (const token of tokenizer.feed(diff)) executor.feed(token);
	return drain(executor, tokenizer);
}

export function parsePatchStreaming(diff: string): { edits: Edit[]; warnings: string[] } {
	const tokenizer = new Tokenizer();
	const executor = new Executor();
	for (const token of tokenizer.feed(diff)) executor.feed(token);
	for (const token of tokenizer.end()) executor.feed(token);
	return executor.endStreaming();
}
