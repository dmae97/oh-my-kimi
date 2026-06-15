import { mintToolCallId, partialSuffixOverlapAny } from "./coercion";
import grammarPrompt from "./gemma.md" with { type: "text" };
import { renderGemmaInvocation, renderGemmaToolCalls, renderGemmaToolResults } from "./rendering";
import type { Grammar, InbandScanEvent, InbandScanner } from "./types";

const CALL_OPEN = "<|tool_call>";
const CALL_CLOSE = "<tool_call|>";
const STRING = '<|"|>';
const OPEN_TAGS = [CALL_OPEN] as const;
const CALL_HEAD = /^call:\s*([A-Za-z_]\w*)\s*\{/;

type State = "outside" | "tool";

interface ParsedCall {
	name: string;
	arguments: Record<string, unknown>;
}

/**
 * Scanner for the Gemma 4 token-delimited tool-calling convention (see
 * `docs/toolconv/gemma.md`). Each call is one `<|tool_call>call:NAME{…}<tool_call|>`
 * block whose argument list is `key:value` pairs; string values are wrapped in
 * the `<|"|>` token rather than ASCII quotes, so splitting must skip those spans.
 */
export class GemmaInbandScanner implements InbandScanner {
	#buffer = "";
	#state: State = "outside";

	feed(text: string): InbandScanEvent[] {
		if (text.length === 0) return [];
		this.#buffer += text;
		return this.#consume(false);
	}

	flush(): InbandScanEvent[] {
		return this.#consume(true);
	}

	#consume(final: boolean): InbandScanEvent[] {
		const events: InbandScanEvent[] = [];
		while (this.#buffer.length > 0) {
			if (this.#state === "outside") {
				this.#consumeOutside(final, events);
				if (this.#state === "outside") break;
				continue;
			}
			this.#consumeTool(final, events);
			if (this.#state === "tool") break;
		}
		return events;
	}

	#consumeOutside(final: boolean, events: InbandScanEvent[]): void {
		const open = this.#buffer.indexOf(CALL_OPEN);
		if (open === -1) {
			const hold = final ? 0 : partialSuffixOverlapAny(this.#buffer, OPEN_TAGS);
			const emit = this.#buffer.slice(0, this.#buffer.length - hold);
			if (emit.length > 0) events.push({ type: "text", text: emit });
			this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
			return;
		}
		if (open > 0) events.push({ type: "text", text: this.#buffer.slice(0, open) });
		this.#buffer = this.#buffer.slice(open + CALL_OPEN.length);
		this.#state = "tool";
	}

	#consumeTool(final: boolean, events: InbandScanEvent[]): void {
		const close = findCallClose(this.#buffer);
		if (close === -1) {
			if (final) {
				this.#buffer = "";
				this.#state = "outside";
			}
			return;
		}
		const body = this.#buffer.slice(0, close);
		const parsed = parseGemmaCall(body);
		if (parsed) {
			const id = mintToolCallId();
			events.push({ type: "toolStart", id, name: parsed.name });
			events.push({
				type: "toolEnd",
				id,
				name: parsed.name,
				arguments: parsed.arguments,
				rawBlock: `${CALL_OPEN}${body}${CALL_CLOSE}`,
			});
		}
		this.#buffer = this.#buffer.slice(close + CALL_CLOSE.length);
		this.#state = "outside";
	}
}

function parseGemmaCall(body: string): ParsedCall | undefined {
	const trimmed = body.trim();
	const head = CALL_HEAD.exec(trimmed);
	if (!head) return undefined;
	const braceStart = head[0].length - 1;
	const end = matchDelim(trimmed, braceStart, "{", "}");
	const argsText = end === -1 ? trimmed.slice(braceStart + 1) : trimmed.slice(braceStart + 1, end);
	return { name: head[1]!, arguments: parseGemmaArgs(argsText) };
}

function parseGemmaArgs(text: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const segment of splitTopLevel(text, ",")) {
		const trimmed = segment.trim();
		if (trimmed.length === 0) continue;
		const colon = topLevelIndexOf(trimmed, ":");
		if (colon === -1) continue;
		const key = trimmed.slice(0, colon).trim();
		if (!/^[A-Za-z_]\w*$/.test(key)) continue;
		out[key] = parseGemmaValue(trimmed.slice(colon + 1).trim());
	}
	return out;
}

function parseGemmaValue(raw: string): unknown {
	const t = raw.trim();
	if (t.startsWith(STRING)) {
		const close = t.indexOf(STRING, STRING.length);
		return close === -1 ? t.slice(STRING.length) : t.slice(STRING.length, close);
	}
	if (t.startsWith("[")) {
		const end = matchDelim(t, 0, "[", "]");
		const inner = end === -1 ? t.slice(1) : t.slice(1, end);
		return splitTopLevel(inner, ",")
			.map(part => part.trim())
			.filter(part => part.length > 0)
			.map(parseGemmaValue);
	}
	if (t.startsWith("{")) {
		const end = matchDelim(t, 0, "{", "}");
		return parseGemmaArgs(end === -1 ? t.slice(1) : t.slice(1, end));
	}
	if (t === "true") return true;
	if (t === "false") return false;
	if (t === "null" || t === "none" || t === "None") return null;
	if (/^[+-]?(\d|\.)/.test(t)) {
		const num = Number(t);
		if (!Number.isNaN(num)) return num;
	}
	return t;
}

/** Index just past the `<|"|>`-delimited string starting at `i`. */
function skipGemmaString(text: string, i: number): number {
	const close = text.indexOf(STRING, i + STRING.length);
	return close === -1 ? text.length : close + STRING.length;
}

function findCallClose(text: string): number {
	let i = 0;
	const n = text.length;
	while (i < n) {
		if (text.startsWith(STRING, i)) {
			i = skipGemmaString(text, i);
			continue;
		}
		if (text.startsWith(CALL_CLOSE, i)) return i;
		i++;
	}
	return -1;
}

/** Index of the `close` delimiter matching `open` at `openIndex`, skipping strings. */
function matchDelim(text: string, openIndex: number, open: string, close: string): number {
	let depth = 0;
	let i = openIndex;
	const n = text.length;
	while (i < n) {
		if (text.startsWith(STRING, i)) {
			i = skipGemmaString(text, i);
			continue;
		}
		const ch = text[i]!;
		if (ch === open) depth++;
		else if (ch === close && --depth === 0) return i;
		i++;
	}
	return -1;
}

/** Split on `sep` at bracket depth 0, skipping `<|"|>` string spans. */
function splitTopLevel(text: string, sep: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	let i = 0;
	const n = text.length;
	while (i < n) {
		if (text.startsWith(STRING, i)) {
			i = skipGemmaString(text, i);
			continue;
		}
		const ch = text[i]!;
		if (ch === "{" || ch === "[" || ch === "(") depth++;
		else if (ch === "}" || ch === "]" || ch === ")") depth--;
		else if (depth === 0 && ch === sep) {
			parts.push(text.slice(start, i));
			start = i + 1;
		}
		i++;
	}
	parts.push(text.slice(start));
	return parts;
}

/** First index of `ch` at bracket depth 0, skipping `<|"|>` string spans. */
function topLevelIndexOf(text: string, ch: string): number {
	let depth = 0;
	let i = 0;
	const n = text.length;
	while (i < n) {
		if (text.startsWith(STRING, i)) {
			i = skipGemmaString(text, i);
			continue;
		}
		const c = text[i]!;
		if (c === "{" || c === "[" || c === "(") depth++;
		else if (c === "}" || c === "]" || c === ")") depth--;
		else if (depth === 0 && c === ch) return i;
		i++;
	}
	return -1;
}

const grammar: Grammar = {
	syntax: "gemma",
	prompt: grammarPrompt,
	createScanner: () => new GemmaInbandScanner(),
	renderToolCall: renderGemmaInvocation,
	renderAssistantToolCalls: renderGemmaToolCalls,
	renderToolResults: renderGemmaToolResults,
};

export default grammar;
