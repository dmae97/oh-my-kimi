/**
 * Tests for StdinBuffer
 *
 * Based on code from OpenTUI (https://github.com/anomalyco/opentui)
 * MIT License - Copyright (c) 2025 opentui
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setKittyProtocolActive } from "@oh-my-pi/pi-tui/keys";
import { StdinBuffer } from "@oh-my-pi/pi-tui/stdin-buffer";

describe("StdinBuffer", () => {
	let buffer: StdinBuffer;
	let emittedSequences: string[];

	beforeEach(() => {
		setKittyProtocolActive(false);
		buffer = new StdinBuffer({ timeout: 10 });

		// Collect emitted sequences
		emittedSequences = [];
		buffer.on("data", (sequence: string) => {
			emittedSequences.push(sequence);
		});
	});

	afterEach(() => {
		// Kill pending flush/watchdog timers: a stale timer from a prior test's
		// buffer would otherwise emit into the current test's emittedSequences
		// (the data listener closes over the reassigned module variable).
		buffer.destroy();
		setKittyProtocolActive(false);
	});

	// Helper to process data through the buffer
	function processInput(data: string | Buffer): void {
		buffer.process(data);
	}

	describe("Regular Characters", () => {
		it("should handle unicode characters", () => {
			processInput("hello \u4e16\u754c");
			expect(emittedSequences).toEqual(["h", "e", "l", "l", "o", " ", "\u4e16", "\u754c"]);
		});

		it("emits surrogate-pair code points as one text sequence", () => {
			processInput("🙂");
			expect(emittedSequences).toEqual(["🙂"]);
		});
	});

	describe("Partial Escape Sequences", () => {
		it("should buffer incomplete mouse SGR sequence", () => {
			processInput("\x1b");
			expect(emittedSequences).toEqual([]);
			expect(buffer.getBuffer()).toBe("\x1b");

			processInput("[<35");
			expect(emittedSequences).toEqual([]);
			expect(buffer.getBuffer()).toBe("\x1b[<35");

			processInput(";20;5m");
			expect(emittedSequences).toEqual(["\x1b[<35;20;5m"]);
			expect(buffer.getBuffer()).toBe("");
		});

		it("should buffer incomplete CSI sequence", () => {
			processInput("\x1b[");
			expect(emittedSequences).toEqual([]);

			processInput("1;");
			expect(emittedSequences).toEqual([]);

			processInput("5H");
			expect(emittedSequences).toEqual(["\x1b[1;5H"]);
		});

		it("should buffer split across many chunks", () => {
			processInput("\x1b");
			processInput("[");
			processInput("<");
			processInput("3");
			processInput("5");
			processInput(";");
			processInput("2");
			processInput("0");
			processInput(";");
			processInput("5");
			processInput("m");

			expect(emittedSequences).toEqual(["\x1b[<35;20;5m"]);
		});

		it("should flush incomplete sequence after timeout", async () => {
			// Non-mouse CSI partial: ambiguous, so it flushes after the timeout.
			processInput("\x1b[1;5");
			expect(emittedSequences).toEqual([]);

			// Wait for timeout
			await Bun.sleep(25);

			expect(emittedSequences).toEqual(["\x1b[1;5"]);
		});

		it("should hold a split SGR mouse partial past the flush timeout and reassemble it", async () => {
			// `\x1b[<…` is unambiguously a mouse report: the partial must never
			// flush on timeout, or its tail leaks as typed text (settings search
			// filling with `[<35;8;16M`).
			processInput("\x1b[<35;8;16");
			await Bun.sleep(30);
			expect(emittedSequences).toEqual([]);

			processInput("M");
			expect(emittedSequences).toEqual(["\x1b[<35;8;16M"]);
		});

		it("should deliver a held mouse partial raw once the hold cap expires", async () => {
			const capped = new StdinBuffer({ timeout: 5, partialHoldTimeout: 20 });
			const emitted: string[] = [];
			capped.on("data", sequence => emitted.push(sequence));
			try {
				capped.process("\x1b[<35;8;16");
				await Bun.sleep(60);
				// Tail never arrived: delivered as one raw sequence (ESC intact,
				// so downstream treats it as control data, not typed text).
				expect(emitted).toEqual(["\x1b[<35;8;16"]);
			} finally {
				capped.destroy();
			}
		});

		it("should hold a lone ESC while the kitty protocol is active and join the mouse tail", async () => {
			setKittyProtocolActive(true);
			try {
				// Under kitty the ESC key arrives as \x1b[27u, so a bare \x1b is
				// always the head of a split sequence.
				processInput("\x1b");
				await Bun.sleep(30);
				expect(emittedSequences).toEqual([]);

				processInput("[<35;8;16M");
				expect(emittedSequences).toEqual(["\x1b[<35;8;16M"]);
			} finally {
				setKittyProtocolActive(false);
			}
		});

		it("should flush a lone ESC after timeout when the kitty protocol is inactive", async () => {
			// Legacy terminals: a bare ESC is a real keypress and must not lag
			// behind the flush timeout by more than the deferral.
			processInput("\x1b");
			await Bun.sleep(30);
			expect(emittedSequences).toEqual(["\x1b"]);
		});
	});

	describe("Mixed Content", () => {
		it("should handle partial sequence with preceding characters", () => {
			processInput("abc\x1b[<35");
			expect(emittedSequences).toEqual(["a", "b", "c"]);
			expect(buffer.getBuffer()).toBe("\x1b[<35");

			processInput(";20;5m");
			expect(emittedSequences).toEqual(["a", "b", "c", "\x1b[<35;20;5m"]);
		});
	});

	describe("Kitty Keyboard Protocol", () => {
		it("should handle batched Kitty press and release", () => {
			// Press 'a', release 'a' batched together (common over SSH)
			processInput("\x1b[97u\x1b[97;1:3u");
			expect(emittedSequences).toEqual(["\x1b[97u", "\x1b[97;1:3u"]);
		});

		it("should handle multiple batched Kitty events", () => {
			// Press 'a', release 'a', press 'b', release 'b'
			processInput("\x1b[97u\x1b[97;1:3u\x1b[98u\x1b[98;1:3u");
			expect(emittedSequences).toEqual(["\x1b[97u", "\x1b[97;1:3u", "\x1b[98u", "\x1b[98;1:3u"]);
		});

		it("should handle Kitty functional keys with event type", () => {
			// Delete key release
			processInput("\x1b[3;1:3~");
			expect(emittedSequences).toEqual(["\x1b[3;1:3~"]);
		});

		it("should handle rapid typing simulation with Kitty protocol", () => {
			// Simulates typing "hi" quickly with releases interleaved
			processInput("\x1b[104u\x1b[104;1:3u\x1b[105u\x1b[105;1:3u");
			expect(emittedSequences).toEqual(["\x1b[104u", "\x1b[104;1:3u", "\x1b[105u", "\x1b[105;1:3u"]);
		});
	});

	describe("Kitty Printable Dedup Window", () => {
		it("swallows the immediate bare duplicate of a kitty printable", () => {
			// Buggy double-report: CSI-u event plus the bare char in one write.
			processInput("\x1b[97ua");
			expect(emittedSequences).toEqual(["\x1b[97u"]);
		});

		it("does not swallow a real keystroke after the dedup window expires", async () => {
			processInput("\x1b[97u");
			await Bun.sleep(50);
			processInput("a");
			expect(emittedSequences).toEqual(["\x1b[97u", "a"]);
		});
	});

	describe("Mouse Events", () => {
		it("should handle mouse press event", () => {
			processInput("\x1b[<0;10;5M");
			expect(emittedSequences).toEqual(["\x1b[<0;10;5M"]);
		});

		it("should handle mouse release event", () => {
			processInput("\x1b[<0;10;5m");
			expect(emittedSequences).toEqual(["\x1b[<0;10;5m"]);
		});

		it("should handle mouse move event", () => {
			processInput("\x1b[<35;20;5m");
			expect(emittedSequences).toEqual(["\x1b[<35;20;5m"]);
		});

		it("should handle split mouse events", () => {
			processInput("\x1b[<3");
			processInput("5;1");
			processInput("5;");
			processInput("10m");
			expect(emittedSequences).toEqual(["\x1b[<35;15;10m"]);
		});

		it("should handle multiple mouse events", () => {
			processInput("\x1b[<35;1;1m\x1b[<35;2;2m\x1b[<35;3;3m");
			expect(emittedSequences).toEqual(["\x1b[<35;1;1m", "\x1b[<35;2;2m", "\x1b[<35;3;3m"]);
		});

		it("should handle old-style mouse sequence (ESC[M + 3 bytes)", () => {
			processInput("\x1b[M abc");
			expect(emittedSequences).toEqual(["\x1b[M ab", "c"]);
		});

		it("should buffer incomplete old-style mouse sequence", () => {
			processInput("\x1b[M");
			expect(buffer.getBuffer()).toBe("\x1b[M");

			processInput(" a");
			expect(buffer.getBuffer()).toBe("\x1b[M a");

			processInput("b");
			expect(emittedSequences).toEqual(["\x1b[M ab"]);
		});
	});

	describe("Edge Cases", () => {
		it("should handle empty input", () => {
			processInput("");
			// Empty string emits an empty data event
			expect(emittedSequences).toEqual([""]);
		});

		it("should handle lone escape character with timeout", async () => {
			processInput("\x1b");
			expect(emittedSequences).toEqual([]);

			// After timeout, should emit
			await Bun.sleep(15);
			expect(emittedSequences).toEqual(["\x1b"]);
		});

		it("should handle lone escape character with explicit flush", () => {
			processInput("\x1b");
			expect(emittedSequences).toEqual([]);

			const flushed = buffer.flush();
			expect(flushed).toEqual(["\x1b"]);
		});

		it("should handle buffer input", () => {
			processInput(Buffer.from("\x1b[A"));
			expect(emittedSequences).toEqual(["\x1b[A"]);
		});

		it("should handle very long sequences", () => {
			const longSeq = `\x1b[${"1;".repeat(50)}H`;
			processInput(longSeq);
			expect(emittedSequences).toEqual([longSeq]);
		});
	});

	describe("Large Plain-Text Bursts", () => {
		it("splits a large non-bracketed burst into per-character events quickly", () => {
			// Pins the O(n) scan: the prior per-iteration slice/Array.from made
			// this O(n²) — a 64KB burst would blow the test timeout.
			const content = "0123456789abcdef".repeat(4096); // 64 KB
			processInput(content);
			expect(emittedSequences.length).toBe(content.length);
			expect(emittedSequences[0]).toBe("0");
			expect(emittedSequences[emittedSequences.length - 1]).toBe("f");
		});

		it("keeps escape parsing and surrogate pairs intact inside a burst", () => {
			processInput("abc🙂\x1b[A\u{1f389}def\x1b[<35;20;5m\x1b");
			expect(emittedSequences).toEqual([
				"a",
				"b",
				"c",
				"🙂",
				"\x1b[A",
				"\u{1f389}",
				"d",
				"e",
				"f",
				"\x1b[<35;20;5m",
			]);
			expect(buffer.getBuffer()).toBe("\x1b");
		});
	});

	describe("Flush", () => {
		it("should flush incomplete sequences", () => {
			processInput("\x1b[<35");
			const flushed = buffer.flush();
			expect(flushed).toEqual(["\x1b[<35"]);
			expect(buffer.getBuffer()).toBe("");
		});

		it("should return empty array if nothing to flush", () => {
			const flushed = buffer.flush();
			expect(flushed).toEqual([]);
		});

		it("should emit flushed data via timeout", async () => {
			processInput("\x1b[1;5");
			expect(emittedSequences).toEqual([]);

			// Wait for timeout to flush
			await Bun.sleep(25);

			expect(emittedSequences).toEqual(["\x1b[1;5"]);
		});
	});

	describe("Clear", () => {
		it("should clear buffered content without emitting", () => {
			processInput("\x1b[<35");
			expect(buffer.getBuffer()).toBe("\x1b[<35");

			buffer.clear();
			expect(buffer.getBuffer()).toBe("");
			expect(emittedSequences).toEqual([]);
		});
	});

	describe("Bracketed Paste", () => {
		let emittedPaste: string[] = [];

		beforeEach(() => {
			buffer = new StdinBuffer({ timeout: 10 });

			// Collect emitted sequences
			emittedSequences = [];
			buffer.on("data", (sequence: string) => {
				emittedSequences.push(sequence);
			});

			// Collect paste events
			emittedPaste = [];
			buffer.on("paste", (data: string) => {
				emittedPaste.push(data);
			});
		});

		it("should emit paste event for complete bracketed paste", () => {
			const pasteStart = "\x1b[200~";
			const pasteEnd = "\x1b[201~";
			const content = "hello world";

			processInput(pasteStart + content + pasteEnd);

			expect(emittedPaste).toEqual(["hello world"]);
			expect(emittedSequences).toEqual([]); // No data events during paste
		});

		it("should handle paste arriving in chunks", () => {
			processInput("\x1b[200~");
			expect(emittedPaste).toEqual([]);

			processInput("hello ");
			expect(emittedPaste).toEqual([]);

			processInput("world\x1b[201~");
			expect(emittedPaste).toEqual(["hello world"]);
			expect(emittedSequences).toEqual([]);
		});

		it("should handle paste with input before and after", () => {
			processInput("a");
			processInput("\x1b[200~pasted\x1b[201~");
			processInput("b");

			expect(emittedSequences).toEqual(["a", "b"]);
			expect(emittedPaste).toEqual(["pasted"]);
		});

		it("should handle paste with newlines", () => {
			processInput("\x1b[200~line1\nline2\nline3\x1b[201~");

			expect(emittedPaste).toEqual(["line1\nline2\nline3"]);
			expect(emittedSequences).toEqual([]);
		});

		it("should handle paste with unicode", () => {
			processInput("\x1b[200~Hello \u4e16\u754c \u{1f389}\x1b[201~");

			expect(emittedPaste).toEqual(["Hello \u4e16\u754c \u{1f389}"]);
			expect(emittedSequences).toEqual([]);
		});

		it("assembles paste when the end marker is split across chunks", () => {
			processInput("\x1b[200~hello world\x1b[201");
			expect(emittedPaste).toEqual([]);

			processInput("~");
			expect(emittedPaste).toEqual(["hello world"]);
			expect(emittedSequences).toEqual([]);
		});

		it("assembles paste when the start and end markers arrive one byte at a time", () => {
			for (const ch of "\x1b[200~ab\x1b[201~") {
				processInput(ch);
			}
			expect(emittedPaste).toEqual(["ab"]);
			expect(emittedSequences).toEqual([]);
		});

		it("preserves trailing input after a boundary-split end marker", () => {
			processInput("\x1b[200~paste\x1b");
			processInput("[201~x");
			expect(emittedPaste).toEqual(["paste"]);
			expect(emittedSequences).toEqual(["x"]);
		});

		it("does not end the paste on a partial end-marker prefix in the body", () => {
			// Body contains the first five bytes of the end marker but no `~`.
			processInput("\x1b[200~before\x1b[201");
			expect(emittedPaste).toEqual([]);

			processInput("after\x1b[201~");
			expect(emittedPaste).toEqual(["before\x1b[201after"]);
			expect(emittedSequences).toEqual([]);
		});

		it("reconstructs a large paste delivered in many small chunks", () => {
			const content = "0123456789abcdef".repeat(8192); // 128 KB
			processInput("\x1b[200~");
			for (let i = 0; i < content.length; i += 64) {
				processInput(content.slice(i, i + 64));
			}
			processInput("\x1b[201~");

			expect(emittedPaste).toEqual([content]);
			expect(emittedSequences).toEqual([]);
		});
	});

	describe("Paste Recovery", () => {
		it("recovers from a lost end marker via the inactivity watchdog", async () => {
			buffer = new StdinBuffer({ timeout: 10, pasteTimeout: 20 });
			const pastes: string[] = [];
			const data: string[] = [];
			buffer.on("paste", d => pastes.push(d));
			buffer.on("data", s => data.push(s));

			buffer.process("\x1b[200~lost marker content");
			expect(pastes).toEqual([]);

			await Bun.sleep(60);
			expect(pastes).toEqual(["lost marker content"]);

			// Input is alive again after recovery.
			buffer.process("a");
			expect(data).toEqual(["a"]);
		});

		it("re-arms the watchdog while paste chunks keep arriving", async () => {
			buffer = new StdinBuffer({ timeout: 10, pasteTimeout: 50 });
			const pastes: string[] = [];
			buffer.on("paste", d => pastes.push(d));

			buffer.process("\x1b[200~part1 ");
			await Bun.sleep(20);
			buffer.process("part2");
			await Bun.sleep(20);
			expect(pastes).toEqual([]); // still inside the re-armed window

			buffer.process("\x1b[201~");
			expect(pastes).toEqual(["part1 part2"]);
		});

		it("aborts paste mode when the byte cap is exceeded", () => {
			buffer = new StdinBuffer({ timeout: 10, pasteByteLimit: 8 });
			const pastes: string[] = [];
			const data: string[] = [];
			buffer.on("paste", d => pastes.push(d));
			buffer.on("data", s => data.push(s));

			buffer.process("\x1b[200~0123456789abcdef");
			expect(pastes).toEqual(["0123456789abcdef"]);

			buffer.process("x");
			expect(data).toEqual(["x"]);
		});
	});

	describe("Destroy", () => {
		it("should clear buffer on destroy", () => {
			processInput("\x1b[<35");
			expect(buffer.getBuffer()).toBe("\x1b[<35");

			buffer.destroy();
			expect(buffer.getBuffer()).toBe("");
		});

		it("should clear pending timeouts on destroy", async () => {
			processInput("\x1b[<35");
			buffer.destroy();

			// Wait longer than timeout
			await Bun.sleep(15);

			// Should not have emitted anything
			expect(emittedSequences).toEqual([]);
		});
	});
});
