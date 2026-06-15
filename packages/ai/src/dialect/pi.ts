import type { Message, ToolCall } from "../types";
import type { ToolArgShape } from "./coercion";
import {
	buildArgShapes,
	coerceValue,
	collectSchemaTypes,
	getArrayItemSchema,
	getObjectProperties,
	isArraySchema,
	isObjectSchema,
	isStringOnlySchema,
	mintToolCallId,
	partialSuffixOverlapAny,
} from "./coercion";
import dialectPrompt from "./pi.md" with { type: "text" };
import { renderChatMlTranscript, renderToolResponseResults, stringifyJson } from "./rendering";
import type {
	DialectDefinition,
	DialectRenderOptions,
	DialectToolResult,
	InbandScanEvent,
	InbandScanner,
	InbandScannerOptions,
} from "./types";

const CALL_PREFIX = "<call:";
const THINK_OPEN = "<thinking>";
const THINK_CLOSE = "</thinking>";
const CALL_TAGS = [CALL_PREFIX] as const;
const OUTSIDE_TAGS = [CALL_PREFIX, THINK_OPEN] as const;
const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_-]/;
const EMPTY_STRING_ARGS: ReadonlySet<string> = new Set<string>();

type ScannerState = "outside" | "body" | "thinking";
type BodyMode = "undecided" | "inline" | "members";

type RawAttribute = { name: string; value: string | true };

type OpenTag = {
	name: string;
	rawAttrs: RawAttribute[];
	selfClosing: boolean;
	end: number;
};

type MembersResult = {
	ok: boolean;
	value: Record<string, unknown>;
	next: number;
};

type ValueResult = {
	ok: boolean;
	value: unknown;
	next: number;
};

export class PiNativeInbandScanner implements InbandScanner {
	#buffer = "";
	#state: ScannerState = "outside";
	#bodyMode: BodyMode = "undecided";
	#id = "";
	#name = "";
	#args: Record<string, unknown> = {};
	#inlineKey = "";
	#inlineValue = "";
	#inlineLeading = false;
	#rawBlock = "";
	readonly #argShapes: Map<string, ToolArgShape>;
	readonly #stringArgs: (toolName: string) => ReadonlySet<string>;
	#thinking = "";
	readonly #parseThinking: boolean;

	constructor(options: InbandScannerOptions = {}) {
		this.#argShapes = buildArgShapes(options.tools);
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

			if (this.#bodyMode === "undecided") {
				const mode = this.#classifyBody(final);
				if (!mode) break;
				this.#bodyMode = mode;
				if (mode === "inline") {
					this.#inlineKey = this.#inlineTargetKey() ?? "input";
					this.#inlineValue = "";
					this.#inlineLeading = true;
				}
			}

			if (this.#bodyMode === "inline") {
				if (!this.#consumeInline(events, final)) break;
				continue;
			}

			if (!this.#consumeMembers(events, final)) break;
		}
		if (final && this.#state === "thinking") this.#endThinking(events);
		return events;
	}

	#consumeOutside(events: InbandScanEvent[], final: boolean): boolean {
		const call = this.#buffer.indexOf(CALL_PREFIX);
		const think = this.#parseThinking ? this.#buffer.indexOf(THINK_OPEN) : -1;
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
			this.#buffer = this.#buffer.slice(THINK_OPEN.length);
			this.#thinking = "";
			events.push({ type: "thinkingStart" });
			this.#state = "thinking";
			return true;
		}

		const tagEnd = findTagEnd(this.#buffer, 0);
		if (tagEnd === -1) {
			if (final) this.#buffer = "";
			return false;
		}

		const tag = parseCallOpenTag(this.#buffer);
		if (!tag) {
			events.push({ type: "text", text: this.#buffer[0] ?? "" });
			this.#buffer = this.#buffer.slice(1);
			return true;
		}

		this.#beginCall(tag, events);
		this.#buffer = this.#buffer.slice(tag.end);
		if (tag.selfClosing) {
			events.push({
				type: "toolEnd",
				id: this.#id,
				name: this.#name,
				arguments: this.#args,
				rawBlock: this.#rawBlock,
			});
			this.#reset();
			return true;
		}

		this.#state = "body";
		this.#bodyMode = "undecided";
		return true;
	}

	#consumeThinking(events: InbandScanEvent[], final: boolean): boolean {
		const close = this.#buffer.indexOf(THINK_CLOSE);
		if (close === -1) {
			const hold = final ? 0 : partialSuffixOverlapAny(this.#buffer, [THINK_CLOSE]);
			this.#emitThinking(this.#buffer.slice(0, this.#buffer.length - hold), events);
			this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
			if (final) {
				this.#endThinking(events);
				this.#state = "outside";
			}
			return false;
		}
		this.#emitThinking(this.#buffer.slice(0, close), events);
		this.#buffer = this.#buffer.slice(close + THINK_CLOSE.length);
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

	#beginCall(tag: OpenTag, events: InbandScanEvent[]): void {
		this.#id = mintToolCallId();
		this.#name = tag.name;
		this.#args = coerceAttributes(tag.rawAttrs, this.#shape()?.properties ?? {});
		this.#inlineKey = "";
		this.#inlineValue = "";
		this.#inlineLeading = false;
		this.#rawBlock = this.#buffer.slice(0, tag.end);
		events.push({ type: "toolStart", id: this.#id, name: this.#name });
	}

	#classifyBody(final: boolean): BodyMode | undefined {
		const closeTag = this.#closeTag();
		const first = skipWhitespace(this.#buffer, 0);
		const close = this.#buffer.indexOf(closeTag);
		const inlineKey = this.#inlineTargetKey();

		if (close !== -1 && first >= close) return inlineKey ? "inline" : "members";
		if (first >= this.#buffer.length) return undefined;

		const fromFirst = this.#buffer.slice(first);
		if (!final && closeTag.startsWith(fromFirst)) return undefined;

		if (this.#buffer[first] !== "<") return inlineKey ? "inline" : "members";
		if (this.#buffer.startsWith(closeTag, first)) return inlineKey ? "inline" : "members";
		if (this.#buffer.startsWith("</", first)) return "members";

		const elementName = readElementNamePrefix(this.#buffer, first);
		if (elementName === undefined) return final ? (inlineKey ? "inline" : "members") : undefined;
		if (elementName.length === 0) return inlineKey ? "inline" : "members";

		const shape = this.#shape();
		if (!shape) return "members";
		return Object.hasOwn(shape.properties, elementName) ? "members" : inlineKey ? "inline" : "members";
	}

	#consumeInline(events: InbandScanEvent[], final: boolean): boolean {
		this.#stripInlineLeadingDelimiter(final);
		const closeTag = this.#closeTag();
		const close = this.#buffer.indexOf(closeTag);
		if (close === -1) {
			if (final) {
				this.#reset();
				this.#buffer = "";
				return false;
			}
			const overlap = partialSuffixOverlapAny(this.#buffer, [closeTag]);
			let hold = Math.max(1, overlap);
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
				this.#emitInlineDelta(delta, events);
				this.#buffer = this.#buffer.slice(emitLength);
			}
			return false;
		}

		const rawDelta = this.#buffer.slice(0, close);
		this.#rawBlock += rawDelta + closeTag;
		let delta = rawDelta;
		if (delta.endsWith("\r\n")) delta = delta.slice(0, -2);
		else if (delta.endsWith("\n")) delta = delta.slice(0, -1);
		this.#emitInlineDelta(delta, events);
		this.#args[this.#inlineKey] = this.#inlineValue;
		events.push({ type: "toolEnd", id: this.#id, name: this.#name, arguments: this.#args, rawBlock: this.#rawBlock });
		this.#buffer = this.#buffer.slice(close + closeTag.length);
		this.#reset();
		return true;
	}

	#consumeMembers(events: InbandScanEvent[], final: boolean): boolean {
		const closeTag = this.#closeTag();
		let searchFrom = 0;
		while (true) {
			const close = this.#buffer.indexOf(closeTag, searchFrom);
			if (close === -1) {
				if (final) {
					this.#reset();
					this.#buffer = "";
				}
				return false;
			}

			const body = this.#buffer.slice(0, close);
			const parsed = parseMembers(body, 0, undefined, this.#shape()?.properties ?? {});
			if (!parsed.ok || skipWhitespace(body, parsed.next) !== body.length) {
				searchFrom = close + closeTag.length;
				continue;
			}

			const bodyArgs = parsed.value;
			const args = { ...this.#args, ...bodyArgs };
			this.#rawBlock += body + closeTag;
			this.#emitCompletedStringDeltas(bodyArgs, events);
			events.push({ type: "toolEnd", id: this.#id, name: this.#name, arguments: args, rawBlock: this.#rawBlock });
			this.#buffer = this.#buffer.slice(close + closeTag.length);
			this.#reset();
			return true;
		}
	}

	#emitCompletedStringDeltas(args: Record<string, unknown>, events: InbandScanEvent[]): void {
		for (const key in args) {
			const value = args[key];
			if (typeof value === "string" && value.length > 0) {
				events.push({ type: "toolArgDelta", id: this.#id, name: this.#name, key, delta: value });
			}
		}
	}

	#stripInlineLeadingDelimiter(final: boolean): void {
		if (!this.#inlineLeading) return;
		if (this.#buffer.length === 0) return;
		if (this.#buffer[0] === "\r") {
			if (this.#buffer.length === 1 && !final) return;
			if (this.#buffer[1] === "\n") {
				this.#rawBlock += this.#buffer.slice(0, 2);
				this.#buffer = this.#buffer.slice(2);
			}
			this.#inlineLeading = false;
			return;
		}
		if (this.#buffer[0] === "\n") {
			this.#rawBlock += this.#buffer[0];
			this.#buffer = this.#buffer.slice(1);
		}
		this.#inlineLeading = false;
	}

	#emitInlineDelta(delta: string, events: InbandScanEvent[]): void {
		if (delta.length === 0) return;
		this.#inlineValue += delta;
		events.push({ type: "toolArgDelta", id: this.#id, name: this.#name, key: this.#inlineKey, delta });
	}

	#inlineTargetKey(): string | undefined {
		const shape = this.#shape();
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

	#shape(): ToolArgShape | undefined {
		return this.#argShapes.get(this.#name);
	}

	#closeTag(): string {
		return `</call:${this.#name}>`;
	}

	#reset(): void {
		this.#state = "outside";
		this.#bodyMode = "undecided";
		this.#id = "";
		this.#name = "";
		this.#args = {};
		this.#inlineKey = "";
		this.#inlineValue = "";
		this.#inlineLeading = false;
		this.#rawBlock = "";
	}
}

function parseMembers(
	text: string,
	position: number,
	endTag: string | undefined,
	properties: Record<string, unknown>,
): MembersResult {
	const value: Record<string, unknown> = {};
	let index = position;
	while (index < text.length) {
		index = skipWhitespace(text, index);
		if (endTag && text.startsWith(endTag, index)) return { ok: true, value, next: index + endTag.length };
		if (index >= text.length) break;
		if (text[index] !== "<" || text.startsWith("</", index) || text.startsWith(CALL_PREFIX, index)) {
			return { ok: false, value, next: index };
		}

		const tag = parseElementOpenTag(text, index);
		if (!tag) return { ok: false, value, next: index };
		const propertySchema = properties[tag.name];
		const schemaArray = isArraySchema(propertySchema);
		const itemSchema = schemaArray ? getArrayItemSchema(propertySchema) : propertySchema;
		const parsed = parseElementValue(text, tag, itemSchema);
		if (!parsed.ok) return { ok: false, value, next: index };
		addMember(value, tag.name, parsed.value, schemaArray);
		index = parsed.next;
	}

	return endTag ? { ok: false, value, next: index } : { ok: true, value, next: index };
}

function parseElementValue(text: string, tag: OpenTag, schema: unknown): ValueResult {
	const attrProperties = getObjectProperties(schema);
	const attrs = coerceAttributes(tag.rawAttrs, attrProperties);
	if (tag.selfClosing) {
		if (isObjectSchema(schema) || tag.rawAttrs.length > 0) return { ok: true, value: attrs, next: tag.end };
		return { ok: true, value: coerceValue("", schema), next: tag.end };
	}

	const bodyStart = tag.end;
	const closeTag = `</${tag.name}>`;
	if (shouldParseObjectBody(text, bodyStart, closeTag, schema, tag.rawAttrs.length > 0)) {
		const parsed = parseMembers(text, bodyStart, closeTag, attrProperties);
		if (!parsed.ok) return { ok: false, value: undefined, next: bodyStart };
		return { ok: true, value: { ...attrs, ...parsed.value }, next: parsed.next };
	}

	const close = text.indexOf(closeTag, bodyStart);
	if (close === -1) return { ok: false, value: undefined, next: bodyStart };
	const raw = stripBlockDelimiters(text.slice(bodyStart, close));
	return { ok: true, value: coerceValue(raw, schema), next: close + closeTag.length };
}

function shouldParseObjectBody(
	text: string,
	bodyStart: number,
	closeTag: string,
	schema: unknown,
	hasAttrs: boolean,
): boolean {
	if (isObjectSchema(schema)) return true;
	if (isTypedScalarSchema(schema)) return false;
	if (hasAttrs) return true;
	const first = skipWhitespace(text, bodyStart);
	if (text.startsWith(closeTag, first)) return false;
	return text[first] === "<" && !text.startsWith("</", first) && !text.startsWith(CALL_PREFIX, first);
}

function isTypedScalarSchema(schema: unknown): boolean {
	const types = collectSchemaTypes(schema);
	if (types.size === 0) return false;
	return !types.has("object") && !types.has("array");
}

function addMember(target: Record<string, unknown>, key: string, value: unknown, schemaArray: boolean): void {
	if (schemaArray) {
		const existing = target[key];
		if (Array.isArray(existing)) existing.push(value);
		else target[key] = [value];
		return;
	}

	if (!Object.hasOwn(target, key)) {
		target[key] = value;
		return;
	}

	const existing = target[key];
	if (Array.isArray(existing)) existing.push(value);
	else target[key] = [existing, value];
}

function coerceAttributes(
	rawAttrs: readonly RawAttribute[],
	properties: Record<string, unknown>,
): Record<string, unknown> {
	const attrs: Record<string, unknown> = {};
	for (const attr of rawAttrs) {
		attrs[attr.name] = attr.value === true ? true : coerceValue(attr.value, properties[attr.name]);
	}
	return attrs;
}

function parseCallOpenTag(text: string): OpenTag | undefined {
	if (!text.startsWith(CALL_PREFIX)) return undefined;
	const tagEnd = findTagEnd(text, 0);
	if (tagEnd === -1) return undefined;
	return parseOpenTagContent(text, CALL_PREFIX.length, tagEnd);
}

function parseElementOpenTag(text: string, start: number): OpenTag | undefined {
	if (text[start] !== "<" || text.startsWith("</", start) || text.startsWith(CALL_PREFIX, start)) return undefined;
	const tagEnd = findTagEnd(text, start);
	if (tagEnd === -1) return undefined;
	return parseOpenTagContent(text, start + 1, tagEnd);
}

function parseOpenTagContent(text: string, contentStart: number, tagEnd: number): OpenTag | undefined {
	let contentEnd = tagEnd;
	let cursor = skipWhitespace(text, contentStart);
	const nameStart = cursor;
	if (!isNameStart(text[cursor])) return undefined;
	cursor++;
	while (cursor < contentEnd && isNameChar(text[cursor])) cursor++;
	const name = text.slice(nameStart, cursor);

	let selfClosing = false;
	let last = contentEnd - 1;
	while (last >= cursor && isWhitespace(text[last])) last--;
	if (text[last] === "/") {
		selfClosing = true;
		contentEnd = last;
	}

	return {
		name,
		rawAttrs: parseRawAttributes(text.slice(cursor, contentEnd)),
		selfClosing,
		end: tagEnd + 1,
	};
}

function parseRawAttributes(text: string): RawAttribute[] {
	const attrs: RawAttribute[] = [];
	let index = 0;
	while (index < text.length) {
		index = skipWhitespace(text, index);
		if (index >= text.length) break;
		if (!isNameStart(text[index])) {
			index++;
			continue;
		}

		const nameStart = index;
		index++;
		while (index < text.length && isNameChar(text[index])) index++;
		const name = text.slice(nameStart, index);
		index = skipWhitespace(text, index);
		if (text[index] !== "=") {
			attrs.push({ name, value: true });
			continue;
		}

		index++;
		index = skipWhitespace(text, index);
		if (index >= text.length) {
			attrs.push({ name, value: "" });
			break;
		}

		const quote = text[index];
		if (quote === '"' || quote === "'") {
			const valueStart = ++index;
			while (index < text.length && text[index] !== quote) index++;
			attrs.push({ name, value: text.slice(valueStart, index) });
			if (index < text.length) index++;
			continue;
		}

		const valueStart = index;
		while (index < text.length && !isWhitespace(text[index])) index++;
		attrs.push({ name, value: text.slice(valueStart, index) });
	}
	return attrs;
}

function readElementNamePrefix(text: string, ltIndex: number): string | undefined {
	let index = ltIndex + 1;
	if (index >= text.length) return undefined;
	if (!isNameStart(text[index])) return "";
	const start = index;
	index++;
	while (index < text.length && isNameChar(text[index])) index++;
	if (index >= text.length) return undefined;
	const next = text[index];
	return isWhitespace(next) || next === "/" || next === ">" ? text.slice(start, index) : "";
}

function findTagEnd(text: string, start: number): number {
	let quote = "";
	for (let index = start; index < text.length; index++) {
		const ch = text[index];
		if (quote) {
			if (ch === quote) quote = "";
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === ">") return index;
	}
	return -1;
}

function stripBlockDelimiters(raw: string): string {
	let start = 0;
	let end = raw.length;
	if (raw.startsWith("\r\n")) start = 2;
	else if (raw.startsWith("\n")) start = 1;
	if (end > start) {
		if (raw.endsWith("\r\n")) end -= 2;
		else if (raw.endsWith("\n")) end -= 1;
	}
	return raw.slice(start, end);
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

function renderInvocation(call: ToolCall, shape: ToolArgShape | undefined): string {
	let body = `<call:${call.name}>`;
	for (const key in call.arguments) {
		body += `\n${renderElement(key, call.arguments[key], shape?.properties[key])}`;
	}
	return `${body}\n</call:${call.name}>`;
}

function renderAssistantToolCalls(calls: readonly ToolCall[], options: DialectRenderOptions = {}): string {
	const shapes = buildArgShapes(options.tools);
	return calls.map(call => renderInvocation(call, shapes.get(call.name))).join("\n");
}

function renderToolResults(results: readonly DialectToolResult[], _options?: DialectRenderOptions): string {
	return renderToolResponseResults(results);
}

function renderThinking(text: string): string {
	if (!text) return "";
	return `<thinking>\n${text}\n</thinking>`;
}

function renderTranscript(messages: readonly Message[], options: DialectRenderOptions = {}): string {
	return renderChatMlTranscript(messages, options, {
		toolResultRole: "tool",
		renderThinking,
		renderCalls: renderAssistantToolCalls,
		renderResultsBody: renderToolResults,
	});
}

function renderElement(key: string, value: unknown, schema: unknown): string {
	if (Array.isArray(value)) {
		const itemSchema = getArrayItemSchema(schema);
		return value.map(item => renderElement(key, item, itemSchema)).join("\n");
	}
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const properties = getObjectProperties(schema);
		let body = `<${key}>`;
		for (const childKey in record) {
			body += `\n${renderElement(childKey, record[childKey], properties[childKey])}`;
		}
		return `${body}\n</${key}>`;
	}
	return `<${key}>${renderScalar(value, schema)}</${key}>`;
}

function renderScalar(value: unknown, schema: unknown): string {
	if (typeof value === "string") return value;
	if (isStringOnlySchema(schema) && value === null) return "";
	return stringifyJson(value);
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
