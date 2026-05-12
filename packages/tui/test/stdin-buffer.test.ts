/**
 * Tests for StdinBuffer
 *
 * Based on code from OpenTUI (https://github.com/anomalyco/opentui)
 * MIT License - Copyright (c) 2025 opentui
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { StdinBuffer } from "@oh-my-pi/pi-tui/stdin-buffer";

describe("StdinBuffer", () => {
	let buffer: StdinBuffer;
	let emittedSequences: string[];

	beforeEach(() => {
		buffer = new StdinBuffer({ timeout: 10 });

		// Collect emitted sequences
		emittedSequences = [];
		buffer.on("data", (sequence: string) => {
			emittedSequences.push(sequence);
		});
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
			processInput("\x1b[<35");
			expect(emittedSequences).toEqual([]);

			// Wait for timeout
			await Bun.sleep(15);

			expect(emittedSequences).toEqual(["\x1b[<35"]);
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
			processInput("\x1b[<35");
			expect(emittedSequences).toEqual([]);

			// Wait for timeout to flush
			await Bun.sleep(15);

			expect(emittedSequences).toEqual(["\x1b[<35"]);
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
