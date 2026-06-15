import { parseJsonWithRepair } from "../utils/json-parse";
import { asRecord, normalizeKimiFunctionName, partialSuffixOverlapAny } from "./coercion";
import grammarPrompt from "./kimi.md" with { type: "text" };
import { renderKimiInvocation, renderKimiToolCalls, renderKimiToolResults } from "./rendering";
import type { Grammar, InbandScanEvent, InbandScanner } from "./types";

export const KIMI_SECTION_BEGIN = "<|tool_calls_section_begin|>";
export const KIMI_SECTION_END = "<|tool_calls_section_end|>";
export const KIMI_CALL_BEGIN = "<|tool_call_begin|>";
export const KIMI_CALL_END = "<|tool_call_end|>";
export const KIMI_ARG_BEGIN = "<|tool_call_argument_begin|>";

const TOKENS = [KIMI_SECTION_BEGIN, KIMI_SECTION_END, KIMI_CALL_BEGIN, KIMI_CALL_END, KIMI_ARG_BEGIN] as const;

type State = "outside" | "section" | "header" | "args";

export class KimiInbandScanner implements InbandScanner {
	#buffer = "";
	#state: State = "outside";
	#id = "";
	#name = "";
	#rawBlock = "";

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

			if (this.#state === "section") {
				if (!this.#consumeSection(final)) break;
				continue;
			}

			if (this.#state === "header") {
				if (!this.#consumeHeader(final, events)) break;
				continue;
			}

			if (!this.#consumeArgs(final, events)) break;
		}
		return events;
	}

	#consumeOutside(final: boolean, events: InbandScanEvent[]): boolean {
		const tokenStart = this.#nextTokenIndex();
		if (tokenStart === -1) {
			const hold = final ? 0 : partialSuffixOverlapAny(this.#buffer, TOKENS);
			const emitEnd = this.#buffer.length - hold;
			if (emitEnd > 0) events.push({ type: "text", text: this.#buffer.slice(0, emitEnd) });
			this.#buffer = this.#buffer.slice(emitEnd);
			return false;
		}

		if (tokenStart > 0) events.push({ type: "text", text: this.#buffer.slice(0, tokenStart) });
		this.#buffer = this.#buffer.slice(tokenStart);
		const token = this.#tokenAtStart();
		if (!token) return false;
		this.#buffer = this.#buffer.slice(token.length);
		if (token === KIMI_SECTION_BEGIN) this.#state = "section";
		else events.push({ type: "text", text: token });
		return true;
	}

	#consumeSection(final: boolean): boolean {
		this.#skipWhitespace();
		if (this.#buffer.length === 0) return false;

		const token = this.#tokenAtStart();
		if (token === KIMI_SECTION_END) {
			this.#buffer = this.#buffer.slice(KIMI_SECTION_END.length);
			this.#state = "outside";
			return true;
		}
		if (token === KIMI_CALL_BEGIN) {
			this.#buffer = this.#buffer.slice(KIMI_CALL_BEGIN.length);
			this.#state = "header";
			return true;
		}
		if (token) {
			this.#buffer = this.#buffer.slice(token.length);
			return true;
		}

		if (!final && partialSuffixOverlapAny(this.#buffer, TOKENS) === this.#buffer.length) return false;
		this.#buffer = this.#buffer.slice(1);
		return true;
	}

	#consumeHeader(final: boolean, events: InbandScanEvent[]): boolean {
		const sep = this.#buffer.indexOf(KIMI_ARG_BEGIN);
		if (sep === -1) {
			if (final) this.#dropBufferedCall();
			return false;
		}

		const rawHeader = this.#buffer.slice(0, sep);
		this.#id = rawHeader.trim();
		this.#name = normalizeKimiFunctionName(this.#id);
		this.#rawBlock = `${KIMI_CALL_BEGIN}${rawHeader}${KIMI_ARG_BEGIN}`;
		events.push({ type: "toolStart", id: this.#id, name: this.#name });
		this.#buffer = this.#buffer.slice(sep + KIMI_ARG_BEGIN.length);
		this.#state = "args";
		return true;
	}

	#consumeArgs(final: boolean, events: InbandScanEvent[]): boolean {
		const end = this.#buffer.indexOf(KIMI_CALL_END);
		if (end === -1) {
			if (final) this.#dropBufferedCall();
			return false;
		}

		const rawArgsBlock = this.#buffer.slice(0, end);
		const rawArgs = rawArgsBlock.trim();
		events.push({
			type: "toolEnd",
			id: this.#id,
			name: this.#name,
			arguments: this.#parseArgs(rawArgs),
			rawBlock: `${this.#rawBlock}${rawArgsBlock}${KIMI_CALL_END}`,
		});
		this.#buffer = this.#buffer.slice(end + KIMI_CALL_END.length);
		this.#resetCall();
		this.#state = "section";
		return true;
	}

	#parseArgs(rawArgs: string): Record<string, unknown> {
		if (rawArgs.length === 0) return {};
		try {
			return asRecord(parseJsonWithRepair<unknown>(rawArgs));
		} catch {
			return {};
		}
	}

	#nextTokenIndex(): number {
		let best = -1;
		for (const token of TOKENS) {
			const index = this.#buffer.indexOf(token);
			if (index !== -1 && (best === -1 || index < best)) best = index;
		}
		return best;
	}

	#tokenAtStart(): string | undefined {
		for (const token of TOKENS) {
			if (this.#buffer.startsWith(token)) return token;
		}
		return undefined;
	}

	#skipWhitespace(): void {
		let i = 0;
		while (i < this.#buffer.length && isWhitespace(this.#buffer.charCodeAt(i))) i++;
		if (i > 0) this.#buffer = this.#buffer.slice(i);
	}

	#dropBufferedCall(): void {
		this.#buffer = "";
		this.#resetCall();
		this.#state = "outside";
	}

	#resetCall(): void {
		this.#id = "";
		this.#name = "";
		this.#rawBlock = "";
	}
}

function isWhitespace(cp: number): boolean {
	return cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d || cp === 0x0b || cp === 0x0c;
}

const grammar: Grammar = {
	syntax: "kimi",
	prompt: grammarPrompt,
	createScanner: () => new KimiInbandScanner(),
	renderToolCall: renderKimiInvocation,
	renderAssistantToolCalls: renderKimiToolCalls,
	renderToolResults: renderKimiToolResults,
};

export default grammar;
