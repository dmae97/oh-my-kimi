import { describe, expect, it } from "bun:test";
import { CURSOR_MARKER } from "@oh-my-pi/pi-tui";
import { Input } from "@oh-my-pi/pi-tui/components/input";
import { setKittyProtocolActive } from "@oh-my-pi/pi-tui/keys";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";
import { getIndentation } from "@oh-my-pi/pi-utils";

function renderedWidth(input: Input, width: number): number {
	const [line] = input.render(width);
	// TUI strips this marker before its width verification; tests should mimic that.
	return visibleWidth(line.replaceAll(CURSOR_MARKER, ""));
}

describe("Input component", () => {
	const wordLeft = "\x1bb"; // ESC-b (alt+b)
	const wordRight = "\x1bf"; // ESC-f (alt+f)

	function setupAtEnd(text: string): Input {
		const input = new Input();
		input.focused = true;
		input.setValue(text);
		input.handleInput("\x05"); // Ctrl+E (end)
		return input;
	}

	it("moves by CJK and punctuation blocks (backward)", () => {
		const text = "天气不错，去散步吧！";

		{
			const input = setupAtEnd(text);
			input.handleInput(wordLeft);
			input.handleInput("|");
			expect(input.getValue()).toBe("天气不错，去散步吧|！");
		}

		{
			const input = setupAtEnd(text);
			input.handleInput(wordLeft);
			input.handleInput(wordLeft);
			input.handleInput("|");
			expect(input.getValue()).toBe("天气不错，|去散步吧！");
		}

		{
			const input = setupAtEnd(text);
			input.handleInput(wordLeft);
			input.handleInput(wordLeft);
			input.handleInput(wordLeft);
			input.handleInput("|");
			expect(input.getValue()).toBe("天气不错|，去散步吧！");
		}

		{
			const input = setupAtEnd(text);
			input.handleInput(wordLeft);
			input.handleInput(wordLeft);
			input.handleInput(wordLeft);
			input.handleInput(wordLeft);
			input.handleInput("|");
			expect(input.getValue()).toBe("|天气不错，去散步吧！");
		}
	});

	it("moves by CJK and punctuation blocks (forward)", () => {
		const text = "天气不错，去散步吧！";
		const input = new Input();
		input.focused = true;
		input.setValue(text);
		input.handleInput("\x01"); // Ctrl+A (start)

		input.handleInput(wordRight);
		input.handleInput("|");
		expect(input.getValue()).toBe("天气不错|，去散步吧！");
	});

	it("treats NBSP as whitespace for word navigation", () => {
		const nbsp = "\u00A0";
		const text = `Hola${nbsp}mundo`;
		const input = setupAtEnd(text);
		input.handleInput(wordLeft);
		input.handleInput("|");
		expect(input.getValue()).toBe(`Hola${nbsp}|mundo`);
	});

	it("keeps common joiners inside words", () => {
		{
			const text = "co-operate l’été";
			const input = setupAtEnd(text);
			input.handleInput(wordLeft);
			input.handleInput("|");
			expect(input.getValue()).toBe("co-operate |l’été");
		}

		{
			const text = "co-operate l’été";
			const input = setupAtEnd(text);
			input.handleInput(wordLeft);
			input.handleInput(wordLeft);
			input.handleInput("|");
			expect(input.getValue()).toBe("|co-operate l’été");
		}
	});

	it("recognizes Unicode punctuation as delimiter blocks", () => {
		{
			const text = "¿Cómo estás? ¡Muy bien!";
			const input = setupAtEnd(text);
			input.handleInput(wordLeft);
			input.handleInput("|");
			expect(input.getValue()).toBe("¿Cómo estás? ¡Muy bien|!");
		}

		{
			const text = "¿Cómo estás? ¡Muy bien!";
			const input = setupAtEnd(text);
			input.handleInput(wordLeft);
			input.handleInput(wordLeft);
			input.handleInput("|");
			expect(input.getValue()).toBe("¿Cómo estás? ¡Muy |bien!");
		}
	});

	it("does not delete twice when Kitty sends backspace press and release", () => {
		setKittyProtocolActive(true);
		const input = setupAtEnd("ab");

		input.handleInput("\x1b[127u");
		expect(input.getValue()).toBe("a");

		input.handleInput("\x1b[127;1:3u");
		expect(input.getValue()).toBe("a");

		setKittyProtocolActive(false);
	});

	it("inserts NumLock keypad digits from Kitty CSI-u input", () => {
		setKittyProtocolActive(true);
		const input = setupAtEnd("a");

		input.handleInput("\x1b[57407;129u");
		expect(input.getValue()).toBe("a8");

		setKittyProtocolActive(false);
	});

	it("inserts keypad operators from Kitty CSI-u input", () => {
		setKittyProtocolActive(true);
		const input = setupAtEnd("a");

		input.handleInput("\x1b[57410u");
		expect(input.getValue()).toBe("a/");

		setKittyProtocolActive(false);
	});

	it("normalizes tabs in buffered bracketed paste using configured indentation", () => {
		const input = setupAtEnd("");

		input.handleInput("\x1b[200~a\t");
		expect(input.getValue()).toBe("");

		input.handleInput("b\r\n");
		expect(input.getValue()).toBe("");

		input.handleInput("c\x1b[201~");
		expect(input.getValue()).toBe(`a${" ".repeat(getIndentation())}bc`);
	});

	it("never renders a line wider than the terminal width (wide chars)", () => {
		const input = new Input();
		input.focused = true;
		// Long wide-script text: string length != terminal cell width.
		input.setValue("天气不错，去散步吧！".repeat(50));
		input.handleInput("\x05"); // Ctrl+E (end)
		const width = 40;
		expect(renderedWidth(input, width)).toBeLessThanOrEqual(width);
	});
});
