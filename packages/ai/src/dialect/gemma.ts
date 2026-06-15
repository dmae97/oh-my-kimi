import type { Message, ToolCall } from "../types";
import { mintToolCallId, partialSuffixOverlapAny } from "./coercion";
import dialectPrompt from "./gemma.md" with { type: "text" };
import { assistantTranscriptParts, collectToolResultRun, messageContentText } from "./rendering";
import type {
	DialectDefinition,
	DialectRenderOptions,
	DialectToolResult,
	InbandScanEvent,
	InbandScanner,
} from "./types";

const CALL_OPEN = "<|tool_call>";
const CALL_CLOSE = "<tool_call|>";
const STRING = '<|"|>';
const RESPONSE_OPEN = "<|tool_response>";
const RESPONSE_CLOSE = "<tool_response|>";
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

function renderToolCall(call: ToolCall, _options: DialectRenderOptions = {}): string {
	const args = Object.entries(call.arguments)
		.map(([key, value]) => `${key}:${gemmaValue(value)}`)
		.join(",");
	return `${CALL_OPEN}call:${call.name}{${args}}${CALL_CLOSE}`;
}

function renderAssistantToolCalls(calls: readonly ToolCall[], options: DialectRenderOptions = {}): string {
	return calls.map(call => renderToolCall(call, options)).join("");
}

function renderToolResults(results: readonly DialectToolResult[], _options: DialectRenderOptions = {}): string {
	return results
		.map(
			result =>
				`${RESPONSE_OPEN}response:${result.name}{output:${gemmaValue(parseMaybeJson(result.text))}}${RESPONSE_CLOSE}`,
		)
		.join("");
}

function renderThinking(text: string): string {
	return text;
}

function renderTranscript(messages: readonly Message[], options: DialectRenderOptions = {}): string {
	if (messages.length === 0) return "";
	let out = "<bos>";
	for (let i = 0; i < messages.length; ) {
		const message = messages[i]!;
		if (message.role === "assistant") {
			const parts = assistantTranscriptParts(message);
			let body = `${parts.thinking}${parts.text}${renderAssistantToolCalls(parts.toolCalls, options)}`;
			let next = i + 1;
			if (next < messages.length && messages[next]!.role === "toolResult") {
				const run = collectToolResultRun(messages, next);
				body += renderToolResults(run.results);
				next = run.next;
			}
			out += gemmaTurn("model", body);
			i = next;
			continue;
		}
		if (message.role === "toolResult") {
			const run = collectToolResultRun(messages, i);
			out += gemmaTurn("model", renderToolResults(run.results));
			i = run.next;
			continue;
		}
		const role = message.role === "developer" ? "system" : message.role;
		out += gemmaTurn(role, messageContentText(message.content));
		i++;
	}
	return out;
}

function gemmaValue(value: unknown): string {
	if (value === null || value === undefined) return "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return String(value);
	if (typeof value === "string") return `${STRING}${value}${STRING}`;
	if (Array.isArray(value)) return `[${value.map(gemmaValue).join(",")}]`;
	if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>);
		return `{${entries.map(([key, val]) => `${key}:${gemmaValue(val)}`).join(",")}}`;
	}
	return `${STRING}${String(value)}${STRING}`;
}

function parseMaybeJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return text;
	}
}

function gemmaTurn(role: "model" | "system" | "user", body: string): string {
	return `<|turn>${role}\n${body}<turn|>`;
}

const definition: DialectDefinition = {
	dialect: "gemma",
	prompt: dialectPrompt,
	createScanner: () => new GemmaInbandScanner(),
	renderToolCall,
	renderAssistantToolCalls,
	renderToolResults,
	renderThinking,
	renderTranscript,
};

export default definition;
