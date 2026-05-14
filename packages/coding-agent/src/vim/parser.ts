import { VimInputError as VimError, type VimKeyToken } from "./types";

const SPECIAL_KEYS = new Map<string, string>([
	["esc", "Esc"],
	["escape", "Esc"],
	["cr", "CR"],
	["enter", "CR"],
	["return", "CR"],
	["bs", "BS"],
	["backspace", "BS"],
	["tab", "Tab"],
	["c-d", "C-d"],
	["c-u", "C-u"],
	["c-r", "C-r"],
	["c-w", "C-w"],
	["c-o", "C-o"],
]);

function normalizeSpecialKey(raw: string): string | undefined {
	return SPECIAL_KEYS.get(raw.trim().toLowerCase());
}

function toDisplayToken(value: string): string {
	switch (value) {
		case " ":
			return "<Space>";
		default:
			return value.length === 1 ? value : `<${value}>`;
	}
}

export function parseKeySequences(sequences: string[]): VimKeyToken[] {
	const tokens: VimKeyToken[] = [];

	for (let sequenceIndex = 0; sequenceIndex < sequences.length; sequenceIndex += 1) {
		const sequence = sequences[sequenceIndex] ?? "";
		for (let offset = 0; offset < sequence.length; offset += 1) {
			const char = sequence[offset] ?? "";
			// Handle literal escape byte (\x1b / \u001b)
			if (char === "\x1b") {
				tokens.push({
					value: "Esc",
					display: "<Esc>",
					sequenceIndex,
					offset,
				});
				continue;
			}
			// Handle literal carriage return
			if (char === "\r") {
				tokens.push({
					value: "CR",
					display: "<CR>",
					sequenceIndex,
					offset,
				});
				continue;
			}
			// Handle escaped sequences: \r → CR, \e → Esc, \n → newline, \t → Tab
			if (char === "\\" && offset + 1 < sequence.length) {
				const next = sequence[offset + 1];
				if (next === "r") {
					tokens.push({ value: "CR", display: "\\r", sequenceIndex, offset });
					offset += 1;
					continue;
				}
				if (next === "e") {
					tokens.push({ value: "Esc", display: "\\e", sequenceIndex, offset });
					offset += 1;
					continue;
				}
				if (next === "n") {
					tokens.push({ value: "\n", display: "\\n", sequenceIndex, offset });
					offset += 1;
					continue;
				}
				if (next === "t") {
					tokens.push({ value: "Tab", display: "\\t", sequenceIndex, offset });
					offset += 1;
					continue;
				}
			}
			if (char !== "<") {
				tokens.push({
					value: char,
					display: toDisplayToken(char),
					sequenceIndex,
					offset,
				});
				continue;
			}

			const close = sequence.indexOf(">", offset + 1);
			if (close === -1) {
				throw new VimError(`Unterminated special key in sequence ${sequenceIndex + 1}`, {
					value: char,
					display: char,
					sequenceIndex,
					offset,
				});
			}

			const rawSpecial = sequence.slice(offset + 1, close);
			const special = normalizeSpecialKey(rawSpecial);
			if (!special) {
				throw new VimError(`Unknown special key <${rawSpecial}> in sequence ${sequenceIndex + 1}`, {
					value: rawSpecial,
					display: `<${rawSpecial}>`,
					sequenceIndex,
					offset,
				});
			}

			tokens.push({
				value: special,
				display: `<${rawSpecial}>`,
				sequenceIndex,
				offset,
			});
			offset = close;
		}
	}

	return tokens;
}

export function replayTokens(values: readonly string[]): VimKeyToken[] {
	return values.map((value, index) => ({
		value,
		display: toDisplayToken(value),
		sequenceIndex: 0,
		offset: index,
	}));
}
