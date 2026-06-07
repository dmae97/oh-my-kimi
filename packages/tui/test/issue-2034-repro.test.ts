import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { chunkForConPTY, ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";

// Regression test for https://github.com/can1357/oh-my-pi/issues/2034
//
// Windows ConPTY ties viewport tracking to per-`WriteFile` boundaries: when
// a single `process.stdout.write` exceeds ~32-64 KB, the pseudo-console
// stops following the cursor and the host UI's scroll position stays parked
// at wherever the write began. The data lands in scrollback — Alt+Tab forces
// the host to re-query the cursor and the viewport jumps to the bottom —
// but until then the user sees only the first screenful of a long session
// or resume payload.
//
// Fix: `ProcessTerminal#safeWrite` chunks oversized writes into ≤ 8 KiB
// pieces on `process.platform === "win32"`. Non-win32 PTYs do not share the
// bug and keep the single-write fast path.

const ESC = "\x1b";

function buildFullPaint(lines: number, lineLength: number): string {
	// Mirrors the shape of `TUI#emitFullPaint`'s buffer: a clear-screen prefix,
	// rows terminated with `\r\n` and a per-line SGR reset, and a cursor/end
	// sequence trailer. The exact bytes do not matter for the chunker — only
	// that escapes are present and the buffer crosses the ConPTY threshold.
	let buf = `${ESC}[2J${ESC}[H${ESC}[3J`;
	for (let i = 0; i < lines; i++) {
		if (i > 0) buf += "\r\n";
		const content = `${ESC}[38;5;${i % 256}mrow-${i.toString().padStart(4, "0")}: ${"x".repeat(lineLength)}${ESC}[0m`;
		buf += content;
	}
	buf += `${ESC}[H${ESC}[?25h`;
	return buf;
}

describe("issue #2034: chunk large terminal writes on Windows ConPTY", () => {
	describe("chunkForConPTY()", () => {
		it("returns the original buffer untouched when under the chunk size", () => {
			const data = "small payload";
			expect(chunkForConPTY(data, 1024)).toEqual([data]);
		});

		it("splits a large multi-line buffer into pieces no larger than the chunk size", () => {
			const data = buildFullPaint(2000, 60);
			const max = 8 * 1024;
			expect(data.length).toBeGreaterThan(max);

			const chunks = chunkForConPTY(data, max);

			expect(chunks.length).toBeGreaterThan(1);
			for (const chunk of chunks) {
				expect(chunk.length).toBeLessThanOrEqual(max);
			}
		});

		it("preserves the full payload across chunks (no data loss or reordering)", () => {
			const data = buildFullPaint(500, 120);
			const chunks = chunkForConPTY(data, 4 * 1024);
			expect(chunks.join("")).toBe(data);
		});

		it("splits at newline boundaries so escape sequences are never sliced apart", () => {
			// Every row is bracketed by SGR escapes. If the chunker cut inside a
			// chunk's escape sequence, the trailing chunk would not start with
			// either an escape or the post-newline state — instead it would
			// start with a stray CSI byte (`[`, digits, `m`).
			const data = buildFullPaint(400, 80);
			const chunks = chunkForConPTY(data, 4 * 1024);
			// Exclude the head chunk (starts with the clear-screen prefix).
			for (const chunk of chunks.slice(1)) {
				// Every subsequent chunk begins on a fresh line: either the new
				// line's first byte is the SGR escape, the row's plaintext
				// prefix, or — for the trailing tail — the cursor sequence.
				const firstByte = chunk.charCodeAt(0);
				const startsWithEsc = chunk.startsWith(ESC);
				const startsWithRowText = chunk.startsWith("row-");
				expect(startsWithEsc || startsWithRowText).toBe(true);
				if (!startsWithEsc) {
					// Plain-text starts cannot be control characters that would
					// indicate a sliced escape (CSI `[`, digits, or `m`).
					expect(firstByte).toBeGreaterThanOrEqual(0x20);
				}
			}
		});

		it("makes forward progress on a single line longer than the chunk size", () => {
			// Pathological case: one very long line with no embedded `\n`. The
			// chunker must not loop, and the joined chunks must equal the input.
			const giantLine = "a".repeat(20_000);
			const data = `${giantLine}\nshort\n`;
			const chunks = chunkForConPTY(data, 4 * 1024);
			expect(chunks.length).toBeGreaterThanOrEqual(2);
			expect(chunks.join("")).toBe(data);
		});

		it("falls back to a raw split when the buffer contains no newlines", () => {
			const data = "x".repeat(20_000);
			const chunks = chunkForConPTY(data, 4 * 1024);
			expect(chunks.join("")).toBe(data);
			expect(chunks.length).toBeGreaterThan(1);
			// Every chunk except possibly the tail is exactly the chunk size.
			for (const chunk of chunks.slice(0, -1)) {
				expect(chunk.length).toBe(4 * 1024);
			}
		});
	});

	describe("ProcessTerminal#write platform gate", () => {
		const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		const originalWslDistro = Bun.env.WSL_DISTRO_NAME;
		const originalWslInterop = Bun.env.WSL_INTEROP;

		function setEnv(key: string, value: string | undefined): void {
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}

		beforeEach(() => {
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
			Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
			// Clear WSL markers by default; tests opt in.
			setEnv("WSL_DISTRO_NAME", undefined);
			setEnv("WSL_INTEROP", undefined);
		});

		afterEach(() => {
			vi.restoreAllMocks();
			if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
			if (stdinIsTtyDescriptor) Object.defineProperty(process.stdin, "isTTY", stdinIsTtyDescriptor);
			else Reflect.deleteProperty(process.stdin, "isTTY");
			if (stdoutIsTtyDescriptor) Object.defineProperty(process.stdout, "isTTY", stdoutIsTtyDescriptor);
			else Reflect.deleteProperty(process.stdout, "isTTY");
			setEnv("WSL_DISTRO_NAME", originalWslDistro);
			setEnv("WSL_INTEROP", originalWslInterop);
		});

		function captureStdoutWrites(): string[] {
			const writes: string[] = [];
			vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
				writes.push(typeof chunk === "string" ? chunk : chunk.toString());
				return true;
			});
			return writes;
		}

		it("splits >8 KiB writes into chunks on win32 so ConPTY can track the viewport", () => {
			Object.defineProperty(process, "platform", { value: "win32", configurable: true });
			const writes = captureStdoutWrites();
			const terminal = new ProcessTerminal();
			const payload = buildFullPaint(2000, 60);

			terminal.write(payload);

			const conptyChunks = writes.filter(w => w.length > 0);
			expect(conptyChunks.length).toBeGreaterThan(1);
			for (const chunk of conptyChunks) {
				expect(chunk.length).toBeLessThanOrEqual(8 * 1024);
			}
			expect(conptyChunks.join("")).toBe(payload);
		});

		it("splits >8 KiB writes inside WSL because stdout still crosses ConPTY at wslhost", () => {
			Object.defineProperty(process, "platform", { value: "linux", configurable: true });
			setEnv("WSL_DISTRO_NAME", "Ubuntu");
			setEnv("WSL_INTEROP", "/run/WSL/123_interop");
			const writes = captureStdoutWrites();
			const terminal = new ProcessTerminal();
			const payload = buildFullPaint(2000, 60);

			terminal.write(payload);

			const conptyChunks = writes.filter(w => w.length > 0);
			expect(conptyChunks.length).toBeGreaterThan(1);
			for (const chunk of conptyChunks) {
				expect(chunk.length).toBeLessThanOrEqual(8 * 1024);
			}
			expect(conptyChunks.join("")).toBe(payload);
		});

		it("keeps the single-write fast path on non-ConPTY platforms (clean linux, darwin)", () => {
			Object.defineProperty(process, "platform", { value: "linux", configurable: true });
			const writes = captureStdoutWrites();
			const terminal = new ProcessTerminal();
			const payload = buildFullPaint(2000, 60);

			terminal.write(payload);

			expect(writes).toEqual([payload]);
		});

		it("does not chunk small writes on win32", () => {
			Object.defineProperty(process, "platform", { value: "win32", configurable: true });
			const writes = captureStdoutWrites();
			const terminal = new ProcessTerminal();
			const payload = `${ESC}[H${ESC}[K`;

			terminal.write(payload);

			expect(writes).toEqual([payload]);
		});
	});
});
