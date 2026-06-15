import {
	buildStringArgsResolver,
	decodeValue,
	mintToolCallId,
	partialSuffixOverlap,
	partialSuffixOverlapAny,
} from "./coercion";
import grammarPrompt from "./glm.md" with { type: "text" };
import { renderGlmInvocation, renderGlmToolCalls, renderGlmToolResults } from "./rendering";
import type { Grammar, InbandScanEvent, InbandScanner, InbandScannerOptions } from "./types";

const TOOL_OPEN = "<tool_call>";
const TOOL_CLOSE = "</tool_call>";
const ARG_KEY_OPEN = "<arg_key>";
const ARG_KEY_CLOSE = "</arg_key>";
const ARG_VALUE_OPEN = "<arg_value>";
const ARG_VALUE_CLOSE = "</arg_value>";
const RESPONSE_OPEN = "<tool_response>";
const RESPONSE_CLOSE = "</tool_response>";
const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

const OUTSIDE_TAGS = [
	TOOL_OPEN,
	ARG_KEY_OPEN,
	ARG_KEY_CLOSE,
	ARG_VALUE_OPEN,
	ARG_VALUE_CLOSE,
	RESPONSE_OPEN,
	RESPONSE_CLOSE,
	THINK_OPEN,
	THINK_CLOSE,
] as const;
const OUTSIDE_TAGS_NO_THINK = [
	TOOL_OPEN,
	ARG_KEY_OPEN,
	ARG_KEY_CLOSE,
	ARG_VALUE_OPEN,
	ARG_VALUE_CLOSE,
	RESPONSE_OPEN,
	RESPONSE_CLOSE,
] as const;
const BODY_TAGS = [ARG_KEY_OPEN, TOOL_CLOSE] as const;

type State = "outside" | "thinking" | "name" | "body" | "key" | "afterkey" | "value";

interface OpenCall {
	id: string;
	name: string;
	stringArgs: ReadonlySet<string>;
	arguments: Record<string, unknown>;
	key: string | null;
	valueRaw: string;
	rawBlock: string;
}

interface TagMatch {
	index: number;
	tag: string;
}

export class GLMInbandScanner implements InbandScanner {
	#buffer = "";
	#state: State = "outside";
	#call: OpenCall | null = null;
	#thinking = "";
	#parseThinking: boolean;
	#stringArgs: (toolName: string) => ReadonlySet<string>;

	constructor(options: InbandScannerOptions = {}) {
		this.#parseThinking = options.parseThinking !== false;
		this.#stringArgs = options.stringArgs ?? buildStringArgsResolver(options.tools);
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
				if (!this.#consumeOutside(final, events)) break;
				continue;
			}

			if (this.#state === "thinking") {
				this.#consumeThinking(final, events);
				if (this.#state === "thinking") break;
				continue;
			}

			if (this.#state === "name") {
				if (!this.#consumeName(final, events)) break;
				continue;
			}

			if (this.#state === "body") {
				if (!this.#consumeBody(final, events)) break;
				continue;
			}

			if (this.#state === "key") {
				if (!this.#consumeKey(final)) break;
				continue;
			}

			if (this.#state === "afterkey") {
				if (!this.#consumeAfterKey(final)) break;
				continue;
			}

			if (!this.#consumeValue(final, events)) break;
		}
		return events;
	}

	#consumeOutside(final: boolean, events: InbandScanEvent[]): boolean {
		const tags = this.#parseThinking ? OUTSIDE_TAGS : OUTSIDE_TAGS_NO_THINK;
		const match = findFirstTag(this.#buffer, tags);
		if (!match) {
			const hold = final ? 0 : partialSuffixOverlapAny(this.#buffer, tags);
			const emit = this.#buffer.slice(0, this.#buffer.length - hold);
			if (emit.length > 0) events.push({ type: "text", text: emit });
			this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
			return false;
		}

		if (match.index > 0) events.push({ type: "text", text: this.#buffer.slice(0, match.index) });
		this.#buffer = this.#buffer.slice(match.index + match.tag.length);

		if (match.tag === TOOL_OPEN) {
			this.#state = "name";
			return true;
		}
		if (match.tag === THINK_OPEN && this.#parseThinking) {
			this.#thinking = "";
			events.push({ type: "thinkingStart" });
			this.#state = "thinking";
			return true;
		}
		if (match.tag === RESPONSE_OPEN) {
			this.#buffer = "";
			return false;
		}
		return true;
	}

	#consumeThinking(final: boolean, events: InbandScanEvent[]): void {
		const close = this.#buffer.indexOf(THINK_CLOSE);
		if (close === -1) {
			const hold = final ? 0 : partialSuffixOverlap(this.#buffer, THINK_CLOSE);
			const emit = this.#buffer.slice(0, this.#buffer.length - hold);
			this.#emitThinking(emit, events);
			this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
			if (final) this.#endThinking(events);
			return;
		}
		this.#emitThinking(this.#buffer.slice(0, close), events);
		this.#buffer = this.#buffer.slice(close + THINK_CLOSE.length);
		this.#endThinking(events);
		this.#state = "outside";
	}

	#consumeName(final: boolean, events: InbandScanEvent[]): boolean {
		const newline = this.#buffer.indexOf("\n");
		const key = this.#buffer.indexOf(ARG_KEY_OPEN);
		const close = this.#buffer.indexOf(TOOL_CLOSE);
		const delimiter = minFound(newline, key, close);
		if (delimiter === -1) {
			if (!final) return false;
			this.#beginCall(this.#buffer, events);
			this.#buffer = "";
			this.#endCall(events);
			return false;
		}

		const rawName = this.#buffer.slice(0, delimiter);
		this.#beginCall(rawName, events);
		if (delimiter === newline) {
			this.#appendCallRaw("\n");
			this.#buffer = this.#buffer.slice(delimiter + 1);
			this.#state = "body";
			return true;
		}
		if (delimiter === key) {
			this.#appendCallRaw(ARG_KEY_OPEN);
			this.#buffer = this.#buffer.slice(delimiter + ARG_KEY_OPEN.length);
			this.#state = "key";
			return true;
		}
		this.#appendCallRaw(TOOL_CLOSE);
		this.#buffer = this.#buffer.slice(delimiter + TOOL_CLOSE.length);
		this.#endCall(events);
		return true;
	}

	#consumeBody(final: boolean, events: InbandScanEvent[]): boolean {
		this.#appendCallRaw(this.#skipWhitespace());
		if (this.#buffer.length === 0) return false;
		if (this.#buffer.startsWith(ARG_KEY_OPEN)) {
			this.#appendCallRaw(ARG_KEY_OPEN);
			this.#buffer = this.#buffer.slice(ARG_KEY_OPEN.length);
			this.#state = "key";
			return true;
		}
		if (this.#buffer.startsWith(TOOL_CLOSE)) {
			this.#appendCallRaw(TOOL_CLOSE);
			this.#buffer = this.#buffer.slice(TOOL_CLOSE.length);
			this.#endCall(events);
			return true;
		}
		if (!final && partialSuffixOverlapAny(this.#buffer, BODY_TAGS) === this.#buffer.length) return false;
		this.#appendCallRaw(this.#buffer[0] ?? "");
		this.#buffer = this.#buffer.slice(1);
		return true;
	}

	#consumeKey(final: boolean): boolean {
		const close = this.#buffer.indexOf(ARG_KEY_CLOSE);
		if (close === -1) {
			if (final) this.#dropCall();
			return false;
		}
		if (this.#call) {
			this.#call.key = this.#buffer.slice(0, close).trim();
			this.#appendCallRaw(this.#buffer.slice(0, close + ARG_KEY_CLOSE.length));
		}
		this.#buffer = this.#buffer.slice(close + ARG_KEY_CLOSE.length);
		this.#state = "afterkey";
		return true;
	}

	#consumeAfterKey(final: boolean): boolean {
		this.#appendCallRaw(this.#skipWhitespace());
		if (this.#buffer.length === 0) return false;
		if (this.#buffer.startsWith(ARG_VALUE_OPEN)) {
			this.#appendCallRaw(ARG_VALUE_OPEN);
			this.#buffer = this.#buffer.slice(ARG_VALUE_OPEN.length);
			if (this.#call) this.#call.valueRaw = "";
			this.#state = "value";
			return true;
		}
		if (!final && ARG_VALUE_OPEN.startsWith(this.#buffer)) return false;
		this.#appendCallRaw(this.#buffer[0] ?? "");
		this.#buffer = this.#buffer.slice(1);
		return true;
	}

	#consumeValue(final: boolean, events: InbandScanEvent[]): boolean {
		const close = this.#buffer.indexOf(ARG_VALUE_CLOSE);
		if (close === -1) {
			const hold = final ? 0 : partialSuffixOverlap(this.#buffer, ARG_VALUE_CLOSE);
			const emit = this.#buffer.slice(0, this.#buffer.length - hold);
			this.#streamValue(emit, events);
			this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
			if (final) this.#dropCall();
			return false;
		}
		this.#streamValue(this.#buffer.slice(0, close), events);
		this.#appendCallRaw(ARG_VALUE_CLOSE);
		this.#buffer = this.#buffer.slice(close + ARG_VALUE_CLOSE.length);
		this.#endValue();
		this.#state = "body";
		return true;
	}

	#beginCall(rawName: string, events: InbandScanEvent[]): void {
		const name = rawName.trim();
		if (name.length === 0) {
			this.#dropCall();
			return;
		}
		const id = mintToolCallId();
		this.#call = {
			id,
			name,
			stringArgs: this.#stringArgs(name),
			arguments: {},
			key: null,
			valueRaw: "",
			rawBlock: `${TOOL_OPEN}${rawName}`,
		};
		events.push({ type: "toolStart", id, name });
	}

	#streamValue(chunk: string, events: InbandScanEvent[]): void {
		const call = this.#call;
		if (!call || call.key === null || chunk.length === 0) return;
		call.valueRaw += chunk;
		call.rawBlock += chunk;
		events.push({ type: "toolArgDelta", id: call.id, name: call.name, key: call.key, delta: chunk });
	}

	#endValue(): void {
		const call = this.#call;
		if (!call || call.key === null) return;
		call.arguments[call.key] = call.stringArgs.has(call.key) ? call.valueRaw : decodeValue(call.valueRaw);
		call.key = null;
		call.valueRaw = "";
	}

	#endCall(events: InbandScanEvent[]): void {
		const call = this.#call;
		if (!call) {
			this.#state = "outside";
			return;
		}
		events.push({
			type: "toolEnd",
			id: call.id,
			name: call.name,
			arguments: call.arguments,
			rawBlock: call.rawBlock,
		});
		this.#call = null;
		this.#state = "outside";
	}

	#dropCall(): void {
		this.#call = null;
		this.#state = "outside";
	}

	#appendCallRaw(text: string): void {
		if (this.#call && text.length > 0) this.#call.rawBlock += text;
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

	#skipWhitespace(): string {
		let i = 0;
		while (i < this.#buffer.length && " \n\t\r".includes(this.#buffer[i]!)) i++;
		const skipped = this.#buffer.slice(0, i);
		if (i > 0) this.#buffer = this.#buffer.slice(i);
		return skipped;
	}
}

function findFirstTag(text: string, tags: readonly string[]): TagMatch | null {
	let best: TagMatch | null = null;
	for (const tag of tags) {
		const index = text.indexOf(tag);
		if (index === -1) continue;
		if (!best || index < best.index) best = { index, tag };
	}
	return best;
}

function minFound(...values: readonly number[]): number {
	let best = -1;
	for (const value of values) {
		if (value === -1) continue;
		if (best === -1 || value < best) best = value;
	}
	return best;
}

const grammar: Grammar = {
	syntax: "glm",
	prompt: grammarPrompt,
	createScanner: options => new GLMInbandScanner(options),
	renderToolCall: renderGlmInvocation,
	renderAssistantToolCalls: renderGlmToolCalls,
	renderToolResults: renderGlmToolResults,
};

export default grammar;
