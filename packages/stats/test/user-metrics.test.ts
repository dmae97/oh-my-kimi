import { describe, expect, it } from "bun:test";
import { computeUserMessageMetrics } from "../src/user-metrics";

describe("computeUserMessageMetrics", () => {
	it("returns zeros for empty / whitespace-only text", () => {
		expect(computeUserMessageMetrics("")).toEqual({
			chars: 0,
			words: 0,
			yellingSentences: 0,
			profanity: 0,
			dramaRuns: 0,
		});
		expect(computeUserMessageMetrics("   \n\t ")).toEqual({
			chars: 0,
			words: 0,
			yellingSentences: 0,
			profanity: 0,
			dramaRuns: 0,
		});
	});

	it("counts a sentence as yelling when >50% of its letters are uppercase", () => {
		// 16 letters, all uppercase → yelling.
		const m = computeUserMessageMetrics("STOP DOING THAT NOW");
		expect(m.yellingSentences).toBe(1);
	});

	it("treats mostly-lowercase sentences as not yelling even with embedded CAPS", () => {
		// `STOP` and `THAT` are uppercase but the surrounding lowercase keeps the
		// per-sentence ratio well under 50%.
		const m = computeUserMessageMetrics("Hi there, please STOP doing THAT immediately, it is really annoying.");
		expect(m.yellingSentences).toBe(0);
	});

	it("ignores very short uppercase fragments below the letter floor", () => {
		// "OK" and "WIP" have fewer than the minimum-letters threshold, so neither
		// sentence should register as yelling.
		expect(computeUserMessageMetrics("OK").yellingSentences).toBe(0);
		expect(computeUserMessageMetrics("WIP.").yellingSentences).toBe(0);
	});

	it("counts multiple yelling sentences separated by terminators", () => {
		const m = computeUserMessageMetrics("WHY IS THIS BROKEN? FIX IT NOW!! please.");
		// "WHY IS THIS BROKEN" and " FIX IT NOW" are both >50% uppercase; the
		// trailing " please" sentence is lowercase.
		expect(m.yellingSentences).toBe(2);
	});

	it("does not flag camelCase / acronyms inside otherwise-lowercase prose", () => {
		const m = computeUserMessageMetrics("call getHTMLParser then exit");
		expect(m.yellingSentences).toBe(0);
	});

	it("matches profanity case-insensitively at word boundaries only", () => {
		const m = computeUserMessageMetrics("oh FUCK this is bullshit, damn it");
		expect(m.profanity).toBe(3);
		// `class` shares letters with `ass` but must not match — word boundary required.
		expect(computeUserMessageMetrics("import classes from module").profanity).toBe(0);
	});

	it("counts each run of 3+ ! or ? as one drama run", () => {
		const m = computeUserMessageMetrics("why!!! seriously??? omg!?!?!?");
		// "!!!" = 1, "???" = 1, "!?!?!?" = 1 (mixed ≥3 cluster) → 3
		expect(m.dramaRuns).toBe(3);
		// Two characters alone do not count as drama.
		expect(computeUserMessageMetrics("ok!! sure??").dramaRuns).toBe(0);
	});

	it("absorbs shift-key `1` mishits into the surrounding drama run", () => {
		// "!!!111" and "!?!?!??111" are both single bursts, not separate hits.
		expect(computeUserMessageMetrics("what!!!111").dramaRuns).toBe(1);
		expect(computeUserMessageMetrics("are you serious!?!?!??111").dramaRuns).toBe(1);
		// Plain digits without a leading `!`/`?` are not drama.
		expect(computeUserMessageMetrics("port 8111 please").dramaRuns).toBe(0);
	});

	it("captures all three signals together with correct chars/words", () => {
		const m = computeUserMessageMetrics("WHY IS THIS SO SHITTY???");
		expect(m.yellingSentences).toBe(1);
		expect(m.profanity).toBe(1);
		expect(m.dramaRuns).toBe(1);
		expect(m.words).toBe(5);
		expect(m.chars).toBe("WHY IS THIS SO SHITTY???".length);
	});
});
