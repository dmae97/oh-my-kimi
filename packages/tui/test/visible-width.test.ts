/**
 * `visibleWidth` measures terminal column width via `Bun.stringWidth` (a JSC
 * builtin) instead of the native scanner, to keep the render loop off the
 * N-API number-boxing path that traps under Bun 1.3.x GC pressure.
 *
 * Correctness contract: the result MUST equal the native engine's width for the
 * same input, because `truncateToWidth` / `sliceWithWidth` / `wrapTextWithAnsi`
 * cut text using that native model — any divergence makes padding / cursor math
 * (`width - visibleWidth(...)`) drift. This guards the two corrections layered
 * on top of `Bun.stringWidth` (tabs, OSC 66 scaling) and catches silent
 * `Bun.stringWidth` width-table drift across Bun upgrades.
 */
import { describe, expect, it } from "bun:test";
import { visibleWidth as nativeVisibleWidth } from "@oh-my-pi/pi-natives";
import { DEFAULT_TAB_WIDTH, visibleWidth } from "@oh-my-pi/pi-tui/utils";

const ESC = "\x1b";
const ST = "\x1b\\";
const BEL = "\x07";
const TAB = DEFAULT_TAB_WIDTH;

describe("visibleWidth — parity with the native width engine", () => {
	const corpus: [string, string][] = [
		["empty", ""],
		["ascii", "Pending run: passed"],
		["styled", `${ESC}[31mred${ESC}[0m text`],
		["styled-truecolor", `${ESC}[38;2;1;2;3mx${ESC}[0m`],
		["nested-sgr", `${ESC}[1m${ESC}[31mbold${ESC}[0m${ESC}[0m`],
		["osc8-st", `${ESC}]8;;https://x.com${ST}link${ESC}]8;;${ST}`],
		["osc8-bel", `${ESC}]8;;u${BEL}t${ESC}]8;;${BEL}`],
		["cjk", "日本語のテキスト"],
		["cjk-mixed", "abc中文def"],
		["hangul-syllables", "안녕하세요"],
		["styled-cjk", `${ESC}[1m漢字${ESC}[0m`],
		["emoji", "👍 done"],
		["emoji-zwj", "👨‍👩‍👧‍👦"],
		["emoji-flag", "🇯🇵"],
		["styled-zwj", `${ESC}[31m👨‍👩‍👧‍👦${ESC}[0m`],
		["variation-selector", "▶️"],
		["combining", "e\u0301"],
		["ambiguous", "§±×→①②③"],
		["box-drawing", "─│┌┐└┘"],
		["fullwidth", "１２３"],
		["halfwidth-kana", "ｱｲｳ"],
		["rtl-arabic", "مرحبا"],
		["thai", "สวัสดี"],
		["tabs", "name\tvalue\tstatus"],
		["leading-tabs", "\t\tindented"],
		["osc66-scale", `${ESC}]66;s=2;big${ST}`],
		["osc66-explicit-w", `${ESC}]66;w=5;Hi${BEL}`],
		["osc66-scale-and-w", `${ESC}]66;s=3:w=4;X${ST}`],
		["osc66-cjk", `${ESC}]66;s=2;日本${ST}`],
		["osc66-inline", `pre ${ESC}]66;s=2;AB${ST} post`],
		["osc66-multi", `${ESC}]66;s=2;A${ST} ${ESC}]66;s=3;B${ST}`],
		["osc66-with-tabs", `\t${ESC}]66;s=2;X${ST}\t`],
	];
	for (const [name, input] of corpus) {
		it(name, () => {
			expect(visibleWidth(input)).toBe(nativeVisibleWidth(input, TAB));
		});
	}

	it("strips ANSI (styled text measures as its plain content)", () => {
		expect(visibleWidth(`${ESC}[31mhello${ESC}[0m`)).toBe(5);
	});

	it("expands each tab to the configured tab width", () => {
		expect(visibleWidth("a\tb")).toBe(2 + TAB);
		expect(visibleWidth("\t\t")).toBe(2 * TAB);
	});

	it("scales OSC 66 text-sizing payloads by `s=`", () => {
		expect(visibleWidth(`${ESC}]66;s=2;big${ST}`)).toBe(6); // 2 * width("big")
		expect(visibleWidth(`${ESC}]66;w=5;Hi${BEL}`)).toBe(5); // explicit width, scale 1
		expect(visibleWidth(`${ESC}]66;s=3:w=4;X${ST}`)).toBe(12); // 3 * 4
	});
});
