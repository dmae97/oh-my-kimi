import { ABORT_WARNING } from "./constants";
import { HL_OP_CHARS, HL_OP_DELETE, HL_OP_INSERT_AFTER, HL_OP_INSERT_BEFORE, HL_OP_REPLACE } from "./hash";
import {
	cloneCursor,
	type HashlineToken,
	HashlineTokenizer,
	isDeleteOpWithPayload,
	type ParsedRange,
} from "./tokenizer";
import type { Anchor, HashlineCursor, HashlineEdit } from "./types";

function validateRangeOrder(range: ParsedRange, lineNum: number): void {
	if (range.end.line < range.start.line) {
		throw new Error(`line ${lineNum}: range ${range.start.line}-${range.end.line} ends before it starts.`);
	}
}

function expandRange(range: ParsedRange): Anchor[] {
	const anchors: Anchor[] = [];
	for (let line = range.start.line; line <= range.end.line; line++) {
		anchors.push({ line });
	}
	return anchors;
}

type PendingOp =
	| { kind: "insert"; cursor: HashlineCursor; lineNum: number }
	| { kind: "replace"; range: ParsedRange; lineNum: number };

interface Pending {
	op: PendingOp;
	payload: string[];
	pendingBlanks: number;
}

/**
 * Token-driven state machine that turns a stream of {@link HashlineToken}s
 * into the flat list of {@link HashlineEdit}s applied downstream by the
 * apply/diff layers.
 *
 * The executor owns:
 *   - the running edit index (kept monotonic across pending flushes),
 *   - the pending-payload buffer (lines accumulated for the most recently
 *     opened insert/replace op),
 *   - all parse-time diagnostics (range order, "delete with payload",
 *     orphan payload, unrecognized op),
 *   - the {@link terminated} flag set by `envelope-end`/`abort`.
 *
 * Tokens are dispatched in the order they arrive; the matching tokenizer
 * supplies the line numbers carried inside each token so diagnostics line
 * up with the source.
 */
export class HashlineExecutor {
	#edits: HashlineEdit[] = [];
	#warnings: string[] = [];
	#editIndex = 0;
	#pending: Pending | undefined;
	#terminated = false;

	/** True once an `envelope-end` or `abort` token has been observed. */
	get terminated(): boolean {
		return this.#terminated;
	}

	/**
	 * Consume one token. After `terminated` flips true subsequent feeds
	 * are silently ignored so callers can keep draining their tokenizer
	 * without explicit early-exit guards.
	 */
	feed(token: HashlineToken): void {
		if (this.#terminated) return;

		switch (token.kind) {
			case "envelope-begin":
				return;
			case "envelope-end":
				this.#terminated = true;
				return;
			case "abort":
				this.#warnings.push(ABORT_WARNING);
				this.#terminated = true;
				return;
			case "header":
				this.#flushPending(false);
				return;
			case "blank":
				if (this.#pending) this.#pending.pendingBlanks++;
				return;
			case "payload":
				this.#handlePayload(token.text, token.lineNum);
				return;
			case "op-delete":
				this.#flushPending(false);
				if (token.trailingPayload) {
					throw new Error(
						`line ${token.lineNum}: ${HL_OP_DELETE} deletes only. Payload is forbidden after ${HL_OP_DELETE}; use ${HL_OP_REPLACE} to replace.`,
					);
				}
				validateRangeOrder(token.range, token.lineNum);
				for (const anchor of expandRange(token.range)) {
					this.#edits.push({ kind: "delete", anchor, lineNum: token.lineNum, index: this.#editIndex++ });
				}
				return;
			case "op-insert":
				this.#flushPending(false);
				this.#pending = {
					op: { kind: "insert", cursor: token.cursor, lineNum: token.lineNum },
					payload: [token.inlineBody ?? ""],
					pendingBlanks: 0,
				};
				return;
			case "op-replace":
				this.#flushPending(false);
				validateRangeOrder(token.range, token.lineNum);
				this.#pending = {
					op: { kind: "replace", range: token.range, lineNum: token.lineNum },
					payload: [token.inlineBody ?? ""],
					pendingBlanks: 0,
				};
				return;
		}
	}

	/**
	 * Flush any open pending op (including its trailing blank lines, which
	 * are payload-significant) and return the accumulated edits and
	 * warnings. The executor is single-use; reset() is required for reuse.
	 */
	end(): { edits: HashlineEdit[]; warnings: string[] } {
		this.#flushPending(true);
		return { edits: this.#edits, warnings: this.#warnings };
	}

	/** Reset to a fresh state so the same instance can drive another parse. */
	reset(): void {
		this.#edits = [];
		this.#warnings = [];
		this.#editIndex = 0;
		this.#pending = undefined;
		this.#terminated = false;
	}

	#handlePayload(text: string, lineNum: number): void {
		if (this.#pending) {
			this.#flushPendingBlanks();
			this.#pending.payload.push(text);
			return;
		}

		// Whitespace-only payload outside any pending op is a visual
		// separator (matches the legacy outer-loop isBlankLine skip);
		// only fully-empty lines arrive as `blank` tokens.
		if (text.trim().length === 0) return;
		// Orphan payload outside any pending op: pick the most specific
		// diagnostic so the model sees the actionable hint.
		if (isDeleteOpWithPayload(text)) {
			throw new Error(
				`line ${lineNum}: ${HL_OP_DELETE} deletes only. Payload is forbidden after ${HL_OP_DELETE}; use ${HL_OP_REPLACE} to replace.`,
			);
		}

		const firstChar = text[0];
		const startsWithOp = firstChar !== undefined && HL_OP_CHARS.includes(firstChar);
		if (startsWithOp || firstChar === "-" || firstChar === "@" || firstChar === "«" || firstChar === "»") {
			throw new Error(
				`line ${lineNum}: unrecognized op. Use LINE${HL_OP_INSERT_BEFORE} (insert before), LINE${HL_OP_INSERT_AFTER} (insert after), LINE${HL_OP_REPLACE} / A-B${HL_OP_REPLACE} (replace), or LINE${HL_OP_DELETE} / A-B${HL_OP_DELETE} (delete). ` +
					`Got ${JSON.stringify(text)}.`,
			);
		}

		throw new Error(
			`line ${lineNum}: payload line has no preceding ${HL_OP_INSERT_BEFORE}, ${HL_OP_INSERT_AFTER}, ${HL_OP_REPLACE}, or ${HL_OP_DELETE} operation. ` +
				`Got ${JSON.stringify(text)}.`,
		);
	}

	#flushPendingBlanks(): void {
		if (!this.#pending) return;
		for (let count = 0; count < this.#pending.pendingBlanks; count++) this.#pending.payload.push("");
		this.#pending.pendingBlanks = 0;
	}

	#flushPending(includeTrailingBlanks: boolean): void {
		const pending = this.#pending;
		if (!pending) return;
		if (includeTrailingBlanks) this.#flushPendingBlanks();

		const { op, payload } = pending;
		const linesToInsert = payload;

		if (op.kind === "insert") {
			for (const text of linesToInsert) {
				this.#edits.push({
					kind: "insert",
					cursor: cloneCursor(op.cursor),
					text,
					lineNum: op.lineNum,
					index: this.#editIndex++,
				});
			}
		} else {
			for (const text of linesToInsert) {
				this.#edits.push({
					kind: "insert",
					cursor: { kind: "before_anchor", anchor: { ...op.range.start } },
					text,
					lineNum: op.lineNum,
					index: this.#editIndex++,
				});
			}
			for (const anchor of expandRange(op.range)) {
				this.#edits.push({ kind: "delete", anchor, lineNum: op.lineNum, index: this.#editIndex++ });
			}
		}

		this.#pending = undefined;
	}
}

/**
 * Drive a full hashline diff through the tokenizer + executor pipeline and
 * return the resulting edits plus any parse-time warnings. This is the
 * convenience entry point most callers want; reach for {@link
 * HashlineTokenizer}/{@link HashlineExecutor} directly only when you need
 * streaming feeds, cross-section state, or custom token handling.
 */
export function parseHashline(diff: string): { edits: HashlineEdit[]; warnings: string[] } {
	const tokenizer = new HashlineTokenizer();
	const executor = new HashlineExecutor();
	const drain = (tokens: HashlineToken[]): void => {
		for (const token of tokens) {
			if (executor.terminated) return;
			executor.feed(token);
		}
	};
	drain(tokenizer.feed(diff));
	drain(tokenizer.end());
	return executor.end();
}
