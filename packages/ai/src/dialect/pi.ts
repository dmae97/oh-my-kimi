import type { Message, ToolCall } from "../types";
import type { ToolArgShape } from "./coercion";
import { buildArgShapes, coerceValue, isStringOnlySchema, mintToolCallId, partialSuffixOverlapAny } from "./coercion";
import dialectPrompt from "./pi.md" with { type: "text" };
import { renderChatMlTranscript, stringifyJson } from "./rendering";
import type {
	DialectDefinition,
	DialectRenderOptions,
	DialectToolResult,
	InbandScanEvent,
	InbandScanner,
	InbandScannerOptions,
} from "./types";

// Pi — a sigil-delimited, token-frugal owned dialect.
//
//   §read path=src/a.ts offset=50          ← scalar-only call (newline-terminated)
//   §edit path=src/a.ts«                    ← header + verbatim body fence
//   *** Begin Patch
//   ...
//   *** End Patch»
//
// Design goals vs the XML-ish `pi` dialect:
//   - one-token structural sigils (`§` call, `«»` body fence, `¤` thinking, `‡‡`
//     tool result — each a single o200k token that never occurs in source code)
//     instead of `<call:NAME>` / `</call:NAME>` (3 tokens + the repeated name);
//   - scalar arguments inline as `key=value` (the key appears once) rather than
//     `<key>value</key>` (key twice + four bracket tokens);
//   - the dominant string argument fills a verbatim body fence, dropping its key
//     entirely and needing no escaping for code/patches.
//
// Verbatim fences (body `«»`, result `‡‡`) escalate Markdown/raw-string style:
// when the content contains the closer, the renderer widens the fence (`««…»»`,
// `‡‡‡…‡‡‡`) so re-rendered history can never collide with payload content.

const CALL_SIGIL = "§";
const FENCE_OPEN = "«";
const FENCE_CLOSE = "»";
const THINK_SIGIL = "¤";
const RESULT_FENCE = "‡";
const OUTSIDE_TAGS = [CALL_SIGIL, THINK_SIGIL] as const;
const CALL_TAGS = [CALL_SIGIL] as const;
const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_-]/;
const EMPTY_STRING_ARGS: ReadonlySet<string> = new Set<string>();

type ScannerState = "outside" | "body" | "thinking";

type HeaderEnd =
	| { kind: "fence"; index: number }
	| { kind: "newline"; index: number }
	| { kind: "eof"; index: number }
	| { kind: "incomplete" };

export class PiNativeInbandScanner implements InbandScanner {
	#buffer = "";
	#state: ScannerState = "outside";
	#id = "";
	#name = "";
	#args: Record<string, unknown> = {};
	#bodyKey = "";
	#bodyValue = "";
	#bodyLeading = false;
	#closeMarker = "";
	#rawBlock = "";
	#thinking = "";
	readonly #argShapes: Map<string, ToolArgShape>;
	readonly #stringArgs: (toolName: string) => ReadonlySet<string>;
	readonly #knowsTools: boolean;
	readonly #parseThinking: boolean;

	constructor(options: InbandScannerOptions = {}) {
		this.#argShapes = buildArgShapes(options.tools);
		this.#knowsTools = this.#argShapes.size > 0;
		this.#stringArgs =
			options.stringArgs ?? (toolName => this.#argShapes.get(toolName)?.stringArgs ?? EMPTY_STRING_ARGS);
		this.#parseThinking = options.parseThinking !== false;
	}

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
				if (!this.#consumeOutside(events, final)) break;
				continue;
			}
			if (this.#state === "thinking") {
				if (!this.#consumeThinking(events, final)) break;
				continue;
			}
			if (!this.#consumeBody(events, final)) break;
		}
		if (final && this.#state === "thinking") this.#endThinking(events);
		return events;
	}

	#consumeOutside(events: InbandScanEvent[], final: boolean): boolean {
		const call = this.#buffer.indexOf(CALL_SIGIL);
		const think = this.#parseThinking ? this.#buffer.indexOf(THINK_SIGIL) : -1;
		let start = call;
		let isThink = false;
		if (think !== -1 && (start === -1 || think < start)) {
			start = think;
			isThink = true;
		}
		if (start === -1) {
			const tags = this.#parseThinking ? OUTSIDE_TAGS : CALL_TAGS;
			const hold = final ? 0 : partialSuffixOverlapAny(this.#buffer, tags);
			const emit = this.#buffer.slice(0, this.#buffer.length - hold);
			if (emit.length > 0) events.push({ type: "text", text: emit });
			this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
			return false;
		}

		if (start > 0) {
			events.push({ type: "text", text: this.#buffer.slice(0, start) });
			this.#buffer = this.#buffer.slice(start);
		}

		if (isThink) {
			this.#buffer = this.#buffer.slice(THINK_SIGIL.length);
			this.#thinking = "";
			events.push({ type: "thinkingStart" });
			this.#state = "thinking";
			return true;
		}

		return this.#beginCall(events, final);
	}

	// Buffer starts with `§`. Resolve the tool name, then the header terminator.
	// Returns false to wait for more input (call still streaming in).
	#beginCall(events: InbandScanEvent[], final: boolean): boolean {
		const nameStart = CALL_SIGIL.length;
		if (nameStart >= this.#buffer.length && !final) return false; // just `§` so far
		let nameEnd = nameStart;
		if (!isNameStart(this.#buffer[nameEnd])) return this.#rejectSigil(events);
		nameEnd++;
		while (nameEnd < this.#buffer.length && isNameChar(this.#buffer[nameEnd])) nameEnd++;
		if (nameEnd >= this.#buffer.length && !final) return false; // name may continue

		const name = this.#buffer.slice(CALL_SIGIL.length, nameEnd);
		// Guard against `§` in prose: only claim a known tool when schemas exist.
		if (this.#knowsTools && !this.#argShapes.has(name)) return this.#rejectSigil(events);

		const header = findHeaderEnd(this.#buffer, nameEnd);
		if (header.kind === "fence") {
			let runEnd = header.index;
			while (runEnd < this.#buffer.length && this.#buffer[runEnd] === FENCE_OPEN) runEnd++;
			if (runEnd >= this.#buffer.length && !final) return false; // fence run may grow
			return this.#startCall(events, name, nameEnd, header.index, "fence", runEnd - header.index);
		}
		if (header.kind === "newline") {
			return this.#startCall(events, name, nameEnd, header.index, "newline", 0);
		}
		// "eof"/"incomplete": the header may still be streaming in — only a scalar
		// call with no trailing newline at true end-of-stream finalizes here.
		if (!final) return false;
		return this.#startCall(events, name, nameEnd, this.#buffer.length, "eof", 0);
	}

	// `§` not followed by a known tool name is prose — surface it as literal text.
	#rejectSigil(events: InbandScanEvent[]): boolean {
		events.push({ type: "text", text: CALL_SIGIL });
		this.#buffer = this.#buffer.slice(CALL_SIGIL.length);
		return true;
	}

	#startCall(
		events: InbandScanEvent[],
		name: string,
		argsStart: number,
		headerEnd: number,
		kind: "fence" | "newline" | "eof",
		fenceLen: number,
	): boolean {
		const shape = this.#argShapes.get(name);
		this.#id = mintToolCallId();
		this.#name = name;
		this.#args = parseHeaderArgs(this.#buffer.slice(argsStart, headerEnd), shape?.properties ?? {});
		events.push({ type: "toolStart", id: this.#id, name: this.#name });

		if (kind === "fence") {
			const fenceEnd = headerEnd + fenceLen;
			this.#rawBlock = this.#buffer.slice(0, fenceEnd);
			this.#closeMarker = FENCE_CLOSE.repeat(fenceLen);
			this.#bodyKey = this.#inlineTargetKey() ?? "input";
			this.#bodyValue = "";
			this.#bodyLeading = true;
			this.#buffer = this.#buffer.slice(fenceEnd);
			this.#state = "body";
			return true;
		}

		this.#rawBlock = this.#buffer.slice(0, headerEnd);
		events.push({
			type: "toolEnd",
			id: this.#id,
			name: this.#name,
			arguments: this.#args,
			rawBlock: this.#rawBlock,
		});
		let next = headerEnd;
		if (kind === "newline") {
			if (this.#buffer[next] === "\r") next++;
			if (this.#buffer[next] === "\n") next++;
		}
		this.#buffer = this.#buffer.slice(next);
		this.#reset();
		return true;
	}

	#consumeBody(events: InbandScanEvent[], final: boolean): boolean {
		this.#stripBodyLeading(final);
		const close = this.#buffer.indexOf(this.#closeMarker);
		if (close === -1) {
			if (final) {
				this.#reset();
				this.#buffer = "";
				return false;
			}
			const overlap = partialSuffixOverlapAny(this.#buffer, [this.#closeMarker]);
			let hold = Math.max(this.#closeMarker.length, overlap);
			if (overlap > 0) {
				const beforeOverlap = this.#buffer.length - overlap - 1;
				if (this.#buffer[beforeOverlap] === "\n") {
					hold = Math.max(hold, overlap + 1);
					if (this.#buffer[beforeOverlap - 1] === "\r") hold = Math.max(hold, overlap + 2);
				}
			}
			const emitLength = this.#buffer.length - hold;
			if (emitLength > 0) {
				const delta = this.#buffer.slice(0, emitLength);
				this.#rawBlock += delta;
				this.#emitBodyDelta(delta, events);
				this.#buffer = this.#buffer.slice(emitLength);
			}
			return false;
		}

		const rawDelta = this.#buffer.slice(0, close);
		this.#rawBlock += rawDelta + this.#closeMarker;
		let delta = rawDelta;
		if (delta.endsWith("\r\n")) delta = delta.slice(0, -2);
		else if (delta.endsWith("\n")) delta = delta.slice(0, -1);
		this.#emitBodyDelta(delta, events);
		this.#args[this.#bodyKey] = this.#bodyValue;
		events.push({
			type: "toolEnd",
			id: this.#id,
			name: this.#name,
			arguments: this.#args,
			rawBlock: this.#rawBlock,
		});
		this.#buffer = this.#buffer.slice(close + this.#closeMarker.length);
		this.#reset();
		return true;
	}

	#stripBodyLeading(final: boolean): void {
		if (!this.#bodyLeading) return;
		if (this.#buffer.length === 0) return;
		if (this.#buffer[0] === "\r") {
			if (this.#buffer.length === 1 && !final) return;
			if (this.#buffer[1] === "\n") {
				this.#rawBlock += this.#buffer.slice(0, 2);
				this.#buffer = this.#buffer.slice(2);
			}
			this.#bodyLeading = false;
			return;
		}
		if (this.#buffer[0] === "\n") {
			this.#rawBlock += this.#buffer[0];
			this.#buffer = this.#buffer.slice(1);
		}
		this.#bodyLeading = false;
	}

	#emitBodyDelta(delta: string, events: InbandScanEvent[]): void {
		if (delta.length === 0) return;
		this.#bodyValue += delta;
		events.push({ type: "toolArgDelta", id: this.#id, name: this.#name, key: this.#bodyKey, delta });
	}

	#consumeThinking(events: InbandScanEvent[], final: boolean): boolean {
		const close = this.#buffer.indexOf(THINK_SIGIL);
		if (close === -1) {
			const hold = final ? 0 : partialSuffixOverlapAny(this.#buffer, [THINK_SIGIL]);
			this.#emitThinking(this.#buffer.slice(0, this.#buffer.length - hold), events);
			this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
			if (final) {
				this.#endThinking(events);
				this.#state = "outside";
			}
			return false;
		}
		this.#emitThinking(this.#buffer.slice(0, close), events);
		this.#buffer = this.#buffer.slice(close + THINK_SIGIL.length);
		this.#endThinking(events);
		this.#state = "outside";
		return true;
	}

	#emitThinking(delta: string, events: InbandScanEvent[]): void {
		if (delta.length === 0) return;
		this.#thinking += delta;
		events.push({ type: "thinkingDelta", delta });
	}

	#endThinking(events: InbandScanEvent[]): void {
		events.push({ type: "thinkingEnd", thinking: this.#thinking });
		this.#thinking = "";
		this.#state = "outside";
	}

	#inlineTargetKey(): string | undefined {
		const shape = this.#argShapes.get(this.#name);
		if (shape) {
			for (const key of shape.parameterOrder) {
				if (Object.hasOwn(this.#args, key)) continue;
				return isStringOnlySchema(shape.properties[key]) ? key : undefined;
			}
			return undefined;
		}
		for (const key of this.#stringArgs(this.#name)) {
			if (!Object.hasOwn(this.#args, key)) return key;
		}
		return "input";
	}

	#reset(): void {
		this.#state = "outside";
		this.#id = "";
		this.#name = "";
		this.#args = {};
		this.#bodyKey = "";
		this.#bodyValue = "";
		this.#bodyLeading = false;
		this.#closeMarker = "";
		this.#rawBlock = "";
	}
}

function parseHeaderArgs(text: string, properties: Record<string, unknown>): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	let index = skipWhitespace(text, 0);
	while (index < text.length) {
		if (!isNameStart(text[index])) {
			index++;
			continue;
		}
		const nameStart = index;
		index++;
		while (index < text.length && isNameChar(text[index])) index++;
		const key = text.slice(nameStart, index);
		index = skipWhitespace(text, index);
		if (text[index] !== "=") {
			args[key] = true;
			continue;
		}
		index = skipWhitespace(text, index + 1);
		const parsed = readInlineValue(text, index, properties[key]);
		args[key] = parsed.value;
		index = skipWhitespace(text, parsed.next);
	}
	return args;
}

type InlineValue = { value: unknown; next: number };

function readInlineValue(text: string, start: number, schema: unknown): InlineValue {
	const ch = text[start];
	if (ch === '"') {
		let index = start + 1;
		while (index < text.length) {
			const c = text[index];
			if (c === "\\") {
				index += 2;
				continue;
			}
			if (c === '"') {
				index++;
				break;
			}
			index++;
		}
		const raw = text.slice(start, index);
		try {
			return { value: JSON.parse(raw) as unknown, next: index };
		} catch {
			return { value: raw.slice(1, raw.endsWith('"') ? -1 : undefined), next: index };
		}
	}
	if (ch === "[" || ch === "{") {
		const end = matchBracket(text, start);
		const raw = text.slice(start, end);
		try {
			return { value: JSON.parse(raw) as unknown, next: end };
		} catch {
			return { value: raw, next: end };
		}
	}
	let index = start;
	while (index < text.length && !isWhitespace(text[index])) index++;
	return { value: coerceValue(text.slice(start, index), schema), next: index };
}

function matchBracket(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	for (let index = start; index < text.length; index++) {
		const ch = text[index];
		if (inString) {
			if (ch === "\\") {
				index++;
				continue;
			}
			if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "[" || ch === "{") depth++;
		else if (ch === "]" || ch === "}") {
			depth--;
			if (depth === 0) return index + 1;
		}
	}
	return text.length;
}

// Locate where a call header ends: the first top-level body fence, the first
// literal newline (scalar-only call), end-of-input, or "incomplete" when a
// quoted/bracketed value is still mid-stream.
function findHeaderEnd(text: string, start: number): HeaderEnd {
	let inString = false;
	let depth = 0;
	for (let index = start; index < text.length; index++) {
		const ch = text[index];
		if (inString) {
			if (ch === "\\") {
				index++;
				continue;
			}
			if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "[" || ch === "{") {
			depth++;
			continue;
		}
		if (ch === "]" || ch === "}") {
			if (depth > 0) depth--;
			continue;
		}
		if (depth > 0) continue;
		if (ch === FENCE_OPEN) return { kind: "fence", index };
		if (ch === "\n" || ch === "\r") return { kind: "newline", index };
	}
	if (inString || depth > 0) return { kind: "incomplete" };
	return { kind: "eof", index: text.length };
}

function skipWhitespace(text: string, index: number): number {
	while (index < text.length && isWhitespace(text[index])) index++;
	return index;
}

function isWhitespace(ch: string | undefined): boolean {
	return ch === " " || ch === "\n" || ch === "\r" || ch === "\t" || ch === "\f";
}

function isNameStart(ch: string | undefined): boolean {
	return ch !== undefined && NAME_START.test(ch);
}

function isNameChar(ch: string | undefined): boolean {
	return ch !== undefined && NAME_CHAR.test(ch);
}

function renderToolCall(call: ToolCall, options: DialectRenderOptions = {}): string {
	return renderInvocation(call, buildArgShapes(options.tools).get(call.name));
}

function renderAssistantToolCalls(calls: readonly ToolCall[], options: DialectRenderOptions = {}): string {
	const shapes = buildArgShapes(options.tools);
	return calls.map(call => renderInvocation(call, shapes.get(call.name))).join("\n");
}

function renderInvocation(call: ToolCall, shape: ToolArgShape | undefined): string {
	const properties = shape?.properties ?? {};
	const bodyKey = selectBodyKey(call.arguments, shape);
	let header = `${CALL_SIGIL}${call.name}`;
	for (const key in call.arguments) {
		if (key === bodyKey) continue;
		header += ` ${key}=${renderInlineValue(call.arguments[key], properties[key])}`;
	}
	if (bodyKey === undefined) return header;
	const body = String(call.arguments[bodyKey]);
	const fence = 1 + maxRun(body, FENCE_CLOSE);
	return `${header}${FENCE_OPEN.repeat(fence)}\n${body}\n${FENCE_CLOSE.repeat(fence)}`;
}

// The body holds a single dominant string argument: the first string-only
// parameter whose value contains a newline. Single-line strings stay inline
// (quoted when needed) so the verbatim fence is reserved for genuine blocks.
function selectBodyKey(args: Record<string, unknown>, shape: ToolArgShape | undefined): string | undefined {
	// Round-trip requires renderer and scanner to agree on the omitted body key.
	// The scanner assigns the body to the first string-only parameter missing from
	// the header, so a body is only safe when no earlier parameter is also absent
	// (no schema → keep everything inline).
	if (!shape) return undefined;
	for (const key of shape.parameterOrder) {
		if (!Object.hasOwn(args, key)) return undefined;
		const value = args[key];
		if (typeof value === "string" && value.includes("\n") && isStringOnlySchema(shape.properties[key])) return key;
	}
	return undefined;
}

function renderInlineValue(value: unknown, schema: unknown): string {
	if (typeof value === "string") {
		return needsQuote(value) ? JSON.stringify(value) : value;
	}
	if (isStringOnlySchema(schema) && value === null) return '""';
	return stringifyJson(value);
}

function needsQuote(value: string): boolean {
	if (value.length === 0) return true;
	const first = value[0];
	if (first === '"' || first === "[" || first === "{") return true;
	return /[\s«»]/.test(value);
}

function maxRun(text: string, ch: string): number {
	let best = 0;
	let run = 0;
	for (let index = 0; index < text.length; index++) {
		if (text[index] === ch) {
			run++;
			if (run > best) best = run;
		} else {
			run = 0;
		}
	}
	return best;
}

function renderToolResults(results: readonly DialectToolResult[], _options?: DialectRenderOptions): string {
	return results
		.map(result => {
			const fence = RESULT_FENCE.repeat(Math.max(2, 1 + maxRun(result.text, RESULT_FENCE)));
			return `${fence}\n${result.text}\n${fence}`;
		})
		.join("\n");
}

function renderThinking(text: string): string {
	if (!text) return "";
	return `${THINK_SIGIL}\n${text}\n${THINK_SIGIL}`;
}

function renderTranscript(messages: readonly Message[], options: DialectRenderOptions = {}): string {
	return renderChatMlTranscript(messages, options, {
		toolResultRole: "tool",
		renderThinking,
		renderCalls: renderAssistantToolCalls,
		renderResultsBody: renderToolResults,
	});
}

const definition: DialectDefinition = {
	dialect: "pi",
	prompt: dialectPrompt,
	createScanner: options => new PiNativeInbandScanner(options),
	renderToolCall,
	renderAssistantToolCalls,
	renderToolResults,
	renderThinking,
	renderTranscript,
};

export default definition;
