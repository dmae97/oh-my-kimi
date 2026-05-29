/**
 * Streaming-safe filters for leaked chat-template tool-call and thinking markup.
 *
 * Hosted models sometimes leak raw template markup into visible `content` instead
 * of returning structured events. One `StreamMarkupHealing` instance owns one stream
 * and one grammar selected by options:
 *
 * - `kimi`: Kimi K2 `<|tool_calls_section_begin|>` sections.
 * - `dsml`: DeepSeek `<｜DSML｜tool_calls>` envelopes.
 * - `thinking`: plain `<think>` / `<thinking>` blocks used by MiniMax-style streams.
 *
 * The parser strips marker bytes, reconstructs embedded calls, emits thinking
 * deltas for thinking blocks, and holds partial tags across chunk boundaries.
 */

import { parseJsonWithRepair } from "./json-parse";

const KIMI_SECTION_BEGIN = "<|tool_calls_section_begin|>";
const KIMI_SECTION_END = "<|tool_calls_section_end|>";
const KIMI_CALL_BEGIN = "<|tool_call_begin|>";
const KIMI_CALL_END = "<|tool_call_end|>";
const KIMI_ARG_BEGIN = "<|tool_call_argument_begin|>";
const KIMI_TOKENS = [KIMI_SECTION_BEGIN, KIMI_SECTION_END, KIMI_CALL_BEGIN, KIMI_CALL_END, KIMI_ARG_BEGIN] as const;

/** Maximum buffered Kimi partial-token length before giving up holdback. */
const MAX_KIMI_PARTIAL_HOLD = 64;

/** Both fullwidth (U+FF5C) and ASCII pipes are observed in DeepSeek DSML leaks. */
const DSML_PIPE = "[｜|]";
const DSML_TOOL_CALLS_OPEN_RE = new RegExp(`<${DSML_PIPE}DSML${DSML_PIPE}tool_calls>`, "y");
const DSML_TOOL_CALLS_CLOSE_RE = new RegExp(`</${DSML_PIPE}DSML${DSML_PIPE}tool_calls>`, "y");
const DSML_INVOKE_OPEN_RE = new RegExp(`<${DSML_PIPE}DSML${DSML_PIPE}invoke\\s+name="([^"]*)"\\s*>`, "y");
const DSML_INVOKE_CLOSE_RE = new RegExp(`</${DSML_PIPE}DSML${DSML_PIPE}invoke>`, "y");
const DSML_PARAMETER_OPEN_RE = new RegExp(
	`<${DSML_PIPE}DSML${DSML_PIPE}parameter\\s+name="([^"]*)"(?:\\s+string="(true|false)")?\\s*>`,
	"y",
);
const DSML_PARAMETER_CLOSE_RE = new RegExp(`</${DSML_PIPE}DSML${DSML_PIPE}parameter>`, "y");

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";
const THINKING_OPEN = "<thinking>";
const THINKING_CLOSE = "</thinking>";

const PLAIN_THINKING_TAGS = [
	{ open: THINK_OPEN, close: THINK_CLOSE },
	{ open: THINKING_OPEN, close: THINKING_CLOSE },
] as const;

/** Cap held-back XML tag bytes so a stray `<` in prose cannot grow unboundedly. */
const MAX_XML_PARTIAL_HOLD = 256;

/** Maximum parameter bytes to accumulate before abandoning a pathological XML call. */
const MAX_XML_PARAM_VALUE_LENGTH = 1_000_000;

export interface HealedToolCall {
	readonly id: string;
	readonly name: string;
	readonly arguments: string;
}

export type StreamMarkupHealingPattern = "kimi" | "dsml" | "thinking";

export interface StreamMarkupHealingOptions {
	readonly pattern: StreamMarkupHealingPattern;
}

export type StreamMarkupHealingEvent =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "thinking"; readonly thinking: string }
	| { readonly type: "toolCall"; readonly call: HealedToolCall };

type XmlToolState =
	| { readonly kind: "idle" }
	| { readonly kind: "section" }
	| { readonly kind: "invoke"; readonly name: string; readonly args: Record<string, unknown> }
	| {
			readonly kind: "parameter";
			readonly invokeName: string;
			readonly args: Record<string, unknown>;
			readonly paramName: string;
			readonly isString: boolean;
			value: string;
	  };

type ThinkingTag = { readonly open: string; readonly close: string };

/**
 * State machine that consumes streamed visible text and emits cleaned text,
 * thinking deltas, and reconstructed tool calls.
 *
 * Feed only one stream channel (usually `delta.content` / `message.content`).
 * Mixing reasoning and visible text into the same instance can corrupt the
 * held-back partial tag buffer.
 */
export class StreamMarkupHealing {
	readonly #pattern: StreamMarkupHealingPattern;
	#buffer = "";
	#offset = 0;

	#kimiInSection = false;
	#kimiInCall = false;
	#kimiInArgs = false;
	#kimiPendingId = "";
	#kimiPendingArgs = "";

	#xmlState: XmlToolState = { kind: "idle" };
	#thinkingCloseTag = "";
	#sectionTerminated = false;
	readonly #completed: HealedToolCall[] = [];

	constructor(options: StreamMarkupHealingOptions) {
		this.#pattern = options.pattern;
	}

	get pattern(): StreamMarkupHealingPattern {
		return this.#pattern;
	}

	/**
	 * Feed a chunk and return visible text only. Reconstructed tool calls are
	 * stored for {@link drainCompleted}; thinking blocks are intentionally not
	 * returned by this compatibility helper. Use {@link feedEvents} when the
	 * caller needs ordered text/thinking/tool-call events.
	 */
	feed(text: string): string {
		let clean = "";
		for (const event of this.feedEvents(text)) {
			if (event.type === "text") {
				clean += event.text;
			} else if (event.type === "toolCall") {
				this.#completed.push(event.call);
			}
		}
		return clean;
	}

	/** Feed a chunk and return cleaned text/thinking/tool-call events in stream order. */
	feedEvents(text: string): StreamMarkupHealingEvent[] {
		if (text.length === 0) return [];
		this.#compact();
		this.#buffer += text;
		switch (this.#pattern) {
			case "kimi":
				return this.#consumeKimiEvents();
			case "dsml":
				return this.#consumeDsmlEvents();
			case "thinking":
				return this.#consumePlainThinkingEvents();
		}
	}

	/**
	 * Like {@link feed}, but discards completed calls. Used when the upstream
	 * chunk also carries structured `tool_calls`, keeping that structured payload
	 * as the single source of truth.
	 */
	consumeWithoutCalls(text: string): string {
		let clean = "";
		for (const event of this.feedEvents(text)) {
			if (event.type === "text") clean += event.text;
		}
		return clean;
	}

	/** Drain accumulated tool calls from calls to {@link feed}. */
	drainCompleted(): HealedToolCall[] {
		if (this.#completed.length === 0) return [];
		return this.#completed.splice(0, this.#completed.length);
	}

	/**
	 * Flush held-back stream-end fragments as ordered events. Partial tool-call
	 * sections/envelopes are dropped; unterminated thinking blocks are emitted as
	 * thinking, matching the previous MiniMax parser behavior.
	 */
	flushEvents(): StreamMarkupHealingEvent[] {
		const tail = this.#remaining();
		this.#buffer = "";
		this.#offset = 0;

		switch (this.#pattern) {
			case "kimi": {
				const inTemplate = this.#kimiInCall || this.#kimiInSection;
				this.#resetKimi();
				return inTemplate || tail.length === 0 ? [] : [{ type: "text", text: tail }];
			}
			case "dsml": {
				const state = this.#xmlState;
				this.#xmlState = { kind: "idle" };
				return state.kind !== "idle" || tail.length === 0 ? [] : [{ type: "text", text: tail }];
			}
			case "thinking": {
				const closeTag = this.#thinkingCloseTag;
				this.#thinkingCloseTag = "";
				if (tail.length === 0) return [];
				return closeTag ? [{ type: "thinking", thinking: tail }] : [{ type: "text", text: tail }];
			}
		}
	}

	/** Flush held-back text only. Reconstructed calls are retained for {@link drainCompleted}. */
	flushPending(): string {
		let clean = "";
		for (const event of this.flushEvents()) {
			if (event.type === "text") {
				clean += event.text;
			} else if (event.type === "toolCall") {
				this.#completed.push(event.call);
			}
		}
		return clean;
	}

	/** True once any configured tool-call section/envelope has fully closed. */
	get sectionClosed(): boolean {
		return this.#sectionTerminated;
	}

	#remaining(): string {
		return this.#offset === 0 ? this.#buffer : this.#buffer.slice(this.#offset);
	}

	#compact(): void {
		if (this.#offset === 0) return;
		this.#buffer = this.#buffer.slice(this.#offset);
		this.#offset = 0;
	}

	#consumeKimiEvents(): StreamMarkupHealingEvent[] {
		const events: StreamMarkupHealingEvent[] = [];
		let clean = "";
		const flushClean = (): void => {
			if (clean.length === 0) return;
			events.push({ type: "text", text: clean });
			clean = "";
		};

		while (this.#offset < this.#buffer.length) {
			if (this.#startsWithPartialToken(KIMI_TOKENS, MAX_KIMI_PARTIAL_HOLD)) break;

			if (this.#matchesToken(KIMI_SECTION_BEGIN)) {
				this.#kimiInSection = true;
				this.#offset += KIMI_SECTION_BEGIN.length;
				continue;
			}
			if (this.#matchesToken(KIMI_SECTION_END)) {
				this.#kimiInSection = false;
				this.#sectionTerminated = true;
				this.#offset += KIMI_SECTION_END.length;
				continue;
			}
			if (this.#matchesToken(KIMI_CALL_BEGIN)) {
				if (!this.#kimiInSection) {
					clean += KIMI_CALL_BEGIN;
					this.#offset += KIMI_CALL_BEGIN.length;
					continue;
				}
				this.#kimiInCall = true;
				this.#kimiInArgs = false;
				this.#kimiPendingId = "";
				this.#kimiPendingArgs = "";
				this.#offset += KIMI_CALL_BEGIN.length;
				continue;
			}
			if (this.#matchesToken(KIMI_ARG_BEGIN)) {
				if (!this.#kimiInSection) {
					clean += KIMI_ARG_BEGIN;
					this.#offset += KIMI_ARG_BEGIN.length;
					continue;
				}
				this.#kimiInArgs = true;
				this.#offset += KIMI_ARG_BEGIN.length;
				continue;
			}
			if (this.#matchesToken(KIMI_CALL_END)) {
				if (!this.#kimiInSection || !this.#kimiInCall) {
					clean += KIMI_CALL_END;
					this.#offset += KIMI_CALL_END.length;
					continue;
				}
				const call = this.#finalizeKimiCall();
				flushClean();
				events.push({ type: "toolCall", call });
				this.#offset += KIMI_CALL_END.length;
				continue;
			}

			const ch = this.#buffer[this.#offset]!;
			this.#offset += 1;

			if (this.#kimiInCall) {
				if (this.#kimiInArgs) {
					this.#kimiPendingArgs += ch;
				} else {
					this.#kimiPendingId += ch;
				}
				continue;
			}

			if (!this.#kimiInSection) clean += ch;
		}

		flushClean();
		return events;
	}

	#consumeDsmlEvents(): StreamMarkupHealingEvent[] {
		return this.#consumeXmlToolEvents({
			getState: () => this.#xmlState,
			setState: state => {
				this.#xmlState = state;
			},
			sectionOpen: DSML_TOOL_CALLS_OPEN_RE,
			sectionClose: DSML_TOOL_CALLS_CLOSE_RE,
			invokeOpen: DSML_INVOKE_OPEN_RE,
			invokeClose: DSML_INVOKE_CLOSE_RE,
			parameterOpen: DSML_PARAMETER_OPEN_RE,
			parameterClose: DSML_PARAMETER_CLOSE_RE,
			coerceStringByDefault: true,
		});
	}

	#consumePlainThinkingEvents(): StreamMarkupHealingEvent[] {
		const events: StreamMarkupHealingEvent[] = [];
		let clean = "";
		let thinking = "";
		const flushClean = (): void => {
			if (clean.length === 0) return;
			events.push({ type: "text", text: clean });
			clean = "";
		};
		const flushThinking = (): void => {
			if (thinking.length === 0) return;
			events.push({ type: "thinking", thinking });
			thinking = "";
		};

		while (this.#offset < this.#buffer.length) {
			if (this.#thinkingCloseTag) {
				if (this.#matchesToken(this.#thinkingCloseTag)) {
					flushThinking();
					this.#offset += this.#thinkingCloseTag.length;
					this.#thinkingCloseTag = "";
					continue;
				}
				if (this.#startsWithPartialToken([this.#thinkingCloseTag], MAX_XML_PARTIAL_HOLD)) break;
				const ch = this.#buffer[this.#offset]!;
				this.#offset += 1;
				thinking += ch;
				continue;
			}

			const thinkingTag = this.#tryMatchThinkingOpen(PLAIN_THINKING_TAGS);
			if (thinkingTag) {
				flushClean();
				this.#thinkingCloseTag = thinkingTag.close;
				continue;
			}
			if (this.#startsWithPartialThinkingOpen(PLAIN_THINKING_TAGS)) break;

			const ch = this.#buffer[this.#offset]!;
			this.#offset += 1;
			clean += ch;
		}

		flushClean();
		flushThinking();
		return events;
	}

	#consumeXmlToolEvents(config: {
		readonly getState: () => XmlToolState;
		readonly setState: (state: XmlToolState) => void;
		readonly sectionOpen: RegExp;
		readonly sectionClose: RegExp;
		readonly invokeOpen: RegExp;
		readonly invokeClose: RegExp;
		readonly parameterOpen: RegExp;
		readonly parameterClose: RegExp;
		readonly coerceStringByDefault: boolean;
	}): StreamMarkupHealingEvent[] {
		const events: StreamMarkupHealingEvent[] = [];
		let clean = "";
		const flushClean = (): void => {
			if (clean.length === 0) return;
			events.push({ type: "text", text: clean });
			clean = "";
		};

		while (this.#offset < this.#buffer.length) {
			const state = config.getState();

			if (state.kind === "idle") {
				if (this.#tryMatch(config.sectionOpen)) {
					config.setState({ kind: "section" });
					continue;
				}
			} else if (state.kind === "section") {
				if (this.#tryMatch(config.sectionClose)) {
					config.setState({ kind: "idle" });
					this.#sectionTerminated = true;
					continue;
				}
				const invokeMatch = this.#tryMatchCapture(config.invokeOpen);
				if (invokeMatch) {
					config.setState({ kind: "invoke", name: invokeMatch[1] ?? "", args: {} });
					continue;
				}
			} else if (state.kind === "invoke") {
				if (this.#tryMatch(config.invokeClose)) {
					const call = finalizeXmlToolCall(state.name, state.args);
					flushClean();
					events.push({ type: "toolCall", call });
					config.setState({ kind: "section" });
					continue;
				}
				const paramMatch = this.#tryMatchCapture(config.parameterOpen);
				if (paramMatch) {
					const stringAttr = paramMatch[2];
					config.setState({
						kind: "parameter",
						invokeName: state.name,
						args: state.args,
						paramName: paramMatch[1] ?? "",
						isString: config.coerceStringByDefault ? stringAttr !== "false" : false,
						value: "",
					});
					continue;
				}
			} else if (this.#tryMatch(config.parameterClose)) {
				state.args[state.paramName] = coerceXmlParamValue(state.value, state.isString);
				config.setState({ kind: "invoke", name: state.invokeName, args: state.args });
				continue;
			}

			if (this.#startsWithPartialXmlTag()) break;

			const ch = this.#buffer[this.#offset]!;
			this.#offset += 1;
			if (state.kind === "idle") {
				clean += ch;
				continue;
			}
			if (state.kind === "parameter") {
				if (state.value.length >= MAX_XML_PARAM_VALUE_LENGTH) {
					config.setState({ kind: "idle" });
					continue;
				}
				state.value += ch;
			}
		}

		flushClean();
		return events;
	}

	#tryMatch(pattern: RegExp): boolean {
		pattern.lastIndex = this.#offset;
		const match = pattern.exec(this.#buffer);
		if (!match) return false;
		this.#offset += match[0].length;
		return true;
	}

	#tryMatchCapture(pattern: RegExp): RegExpExecArray | undefined {
		pattern.lastIndex = this.#offset;
		const match = pattern.exec(this.#buffer);
		if (!match) return undefined;
		this.#offset += match[0].length;
		return match;
	}

	#tryMatchThinkingOpen(tags: readonly ThinkingTag[]): ThinkingTag | undefined {
		for (const tag of tags) {
			if (!this.#matchesToken(tag.open)) continue;
			this.#offset += tag.open.length;
			return tag;
		}
		return undefined;
	}

	#matchesToken(token: string): boolean {
		return this.#buffer.startsWith(token, this.#offset);
	}

	#startsWithPartialThinkingOpen(tags: readonly ThinkingTag[]): boolean {
		for (const tag of tags) {
			if (this.#startsWithPartialToken([tag.open], MAX_XML_PARTIAL_HOLD)) return true;
		}
		return false;
	}

	#startsWithPartialToken(tokens: readonly string[], maxHold: number): boolean {
		const remainingLength = this.#buffer.length - this.#offset;
		if (remainingLength === 0 || remainingLength > maxHold) return false;
		for (const token of tokens) {
			if (token.length <= remainingLength) continue;
			if (this.#bufferIsPrefixOf(token, remainingLength)) return true;
		}
		return false;
	}

	#startsWithPartialXmlTag(): boolean {
		if (this.#buffer[this.#offset] !== "<") return false;
		const tailLength = this.#buffer.length - this.#offset;
		if (tailLength > MAX_XML_PARTIAL_HOLD) return false;
		for (let i = this.#offset + 1; i < this.#buffer.length; i++) {
			if (this.#buffer[i] === ">") return false;
		}
		return true;
	}

	#bufferIsPrefixOf(token: string, remainingLength: number): boolean {
		for (let i = 0; i < remainingLength; i++) {
			if (this.#buffer[this.#offset + i] !== token[i]) return false;
		}
		return true;
	}

	#finalizeKimiCall(): HealedToolCall {
		const rawId = this.#kimiPendingId.trim();
		const rawArgs = this.#kimiPendingArgs.trim();
		const name = normalizeKimiFunctionName(rawId);

		let argsJson = rawArgs;
		if (rawArgs.length > 0) {
			try {
				argsJson = JSON.stringify(parseJsonWithRepair<unknown>(rawArgs));
			} catch {
				// Leave raw; downstream parseStreamingJson absorbs the failure.
			}
		} else {
			argsJson = "{}";
		}

		this.#kimiInCall = false;
		this.#kimiInArgs = false;
		this.#kimiPendingId = "";
		this.#kimiPendingArgs = "";
		return { id: generateHealedToolCallId(), name, arguments: argsJson };
	}

	#resetKimi(): void {
		this.#kimiInSection = false;
		this.#kimiInCall = false;
		this.#kimiInArgs = false;
		this.#kimiPendingId = "";
		this.#kimiPendingArgs = "";
	}
}

function normalizeKimiFunctionName(rawId: string): string {
	const stripped = rawId.startsWith("functions.") ? rawId.slice("functions.".length) : rawId;
	const colon = stripped.indexOf(":");
	return colon >= 0 ? stripped.slice(0, colon) : stripped;
}

function finalizeXmlToolCall(name: string, args: Record<string, unknown>): HealedToolCall {
	return {
		id: generateHealedToolCallId(),
		name: name.trim(),
		arguments: JSON.stringify(args),
	};
}

function coerceXmlParamValue(raw: string, isString: boolean): unknown {
	if (isString) return raw;
	const trimmed = raw.trim();
	if (trimmed.length === 0) return raw;
	try {
		return parseJsonWithRepair<unknown>(trimmed);
	} catch {
		return raw;
	}
}

function generateHealedToolCallId(): string {
	return `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

/** Cheap model/provider gate for Kimi-K2 chat-template token leaks. */
export function modelMayLeakKimiToolCalls(provider: string, modelId: string): boolean {
	if (provider === "kimi-code" || provider === "moonshot") return true;
	return /kimi[-/_.]?k2/i.test(modelId);
}

/** Cheap model/provider gate for DeepSeek DSML envelope leaks. */
export function modelMayLeakDsmlToolCalls(provider: string, modelId: string): boolean {
	if (!/deepseek/i.test(modelId)) return false;
	return (
		provider === "ollama" ||
		provider === "ollama-cloud" ||
		provider === "nvidia" ||
		provider === "deepseek" ||
		provider === "fireworks" ||
		provider === "nanogpt" ||
		provider === "opencode-go" ||
		provider === "openrouter"
	);
}

export function getStreamMarkupHealingPattern(
	provider: string,
	modelId: string,
	options?: { readonly parseThinkingTags?: boolean },
): StreamMarkupHealingPattern | undefined {
	if (options?.parseThinkingTags) return "thinking";
	if (modelMayLeakKimiToolCalls(provider, modelId)) return "kimi";
	if (modelMayLeakDsmlToolCalls(provider, modelId)) return "dsml";
	return undefined;
}
