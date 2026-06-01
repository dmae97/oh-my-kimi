import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";

const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const processPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const stdinSetRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
const originalWslDistroName = Bun.env.WSL_DISTRO_NAME;
const originalWslInterop = Bun.env.WSL_INTEROP;

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(target, key, descriptor);
		return;
	}
	delete (target as Record<string, unknown>)[key];
}

function restoreEnv(key: string, original: string | undefined): void {
	if (original === undefined) {
		delete Bun.env[key];
		return;
	}
	Bun.env[key] = original;
}

describe("ProcessTerminal OSC 11 appearance detection", () => {
	beforeEach(() => {
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdin, "setRawMode", { value: vi.fn(), configurable: true });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		restoreProperty(process.stdin, "isTTY", stdinIsTtyDescriptor);
		restoreProperty(process.stdout, "isTTY", stdoutIsTtyDescriptor);
		restoreProperty(process.stdin, "setRawMode", stdinSetRawModeDescriptor);
		restoreProperty(process, "platform", processPlatformDescriptor);
		restoreEnv("WSL_INTEROP", originalWslInterop);
		restoreEnv("WSL_DISTRO_NAME", originalWslDistroName);
	});

	function setupTerminal() {
		const writes: string[] = [];
		const received: string[] = [];
		vi.spyOn(process, "kill").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			writes.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		});

		const terminal = new ProcessTerminal();
		terminal.start(
			data => received.push(data),
			() => {},
		);

		const queryCount = () => writes.filter(w => w === "\x1b]11;?\x07").length;
		const sentinelCount = () => writes.filter(w => w === "\x1b[c").length;

		return { terminal, writes, received, queryCount, sentinelCount };
	}

	it("swallows the DA1 sentinel even when the OSC 11 reply arrives first", () => {
		const { terminal, writes, received } = setupTerminal();

		process.stdin.emit("data", "\x1b]11;rgb:ffff/ffff/ffff\x07");
		process.stdin.emit("data", "\x1b[?1;2c");

		expect(received).toEqual([]);
		expect(writes).toContain("\x1b]11;?\x07");
		expect(writes).toContain("\x1b[c");

		terminal.stop();
	});

	it("queues overlapping OSC 11 queries until both in-flight DA1 sentinels are consumed", () => {
		vi.useFakeTimers();
		const { terminal, queryCount, sentinelCount } = setupTerminal();

		// Startup writes one OSC 11 query and one OSC 11 DA1 sentinel; the kitty
		// keyboard probe's sentinel is fused into a combined `\x1b[?u\x1b[c` write,
		// so it does not appear under the bare `\x1b[c` filter.
		expect(queryCount()).toBe(1);
		expect(sentinelCount()).toBe(1);

		process.stdin.emit("data", "\x1b[?997;1n");
		vi.advanceTimersByTime(100);

		expect(queryCount()).toBe(1);
		expect(sentinelCount()).toBe(1);

		// First DA1 drains the keyboard sentinel; OSC 11 still pending.
		process.stdin.emit("data", "\x1b[?1;2c");
		expect(queryCount()).toBe(1);

		// Second DA1 drains the OSC 11 sentinel and kicks the queued re-query.
		process.stdin.emit("data", "\x1b[?1;2c");
		expect(queryCount()).toBe(2);
		expect(sentinelCount()).toBe(2);

		terminal.stop();
	});

	it("OSC 11 updates terminal.appearance and fires callbacks with dedup", () => {
		const { terminal } = setupTerminal();
		const appearances: string[] = [];
		terminal.onAppearanceChange(a => appearances.push(a));

		// Send dark background response + DA1
		process.stdin.emit("data", "\x1b]11;rgb:0000/0000/0000\x07");
		process.stdin.emit("data", "\x1b[?1;2c");

		expect(terminal.appearance).toBe("dark");
		expect(appearances).toEqual(["dark"]);

		// Send same color again — callback should NOT fire again
		process.stdin.emit("data", "\x1b]11;rgb:0000/0000/0000\x07");
		process.stdin.emit("data", "\x1b[?1;2c");

		expect(appearances).toEqual(["dark"]);

		terminal.stop();
	});

	it("2-digit hex OSC 11 response is correctly normalized", () => {
		const { terminal } = setupTerminal();

		// Send dark 2-digit response + DA1
		process.stdin.emit("data", "\x1b]11;rgb:1a/1a/1a\x07");
		process.stdin.emit("data", "\x1b[?1;2c");
		expect(terminal.appearance).toBe("dark");

		terminal.stop();
	});

	it("2-digit hex light background is detected correctly", () => {
		const { terminal } = setupTerminal();

		process.stdin.emit("data", "\x1b]11;rgb:ff/ff/ff\x07");
		process.stdin.emit("data", "\x1b[?1;2c");
		expect(terminal.appearance).toBe("light");

		terminal.stop();
	});

	it("Mode 2031 debounce: multiple notifications coalesce into one re-query", () => {
		vi.useFakeTimers();
		const { terminal, queryCount } = setupTerminal();

		// Complete the initial OSC 11 + DA1 cycle (2 startup DA1 sentinels: keyboard + OSC 11)
		process.stdin.emit("data", "\x1b]11;rgb:ffff/ffff/ffff\x07");
		process.stdin.emit("data", "\x1b[?1;2c");
		process.stdin.emit("data", "\x1b[?1;2c");

		const baseline = queryCount();

		// Send 3 rapid Mode 2031 notifications
		process.stdin.emit("data", "\x1b[?997;1n");
		process.stdin.emit("data", "\x1b[?997;1n");
		process.stdin.emit("data", "\x1b[?997;1n");

		// Advance past debounce
		vi.advanceTimersByTime(100);

		// Only one additional query should have been sent (debounced)
		expect(queryCount()).toBe(baseline + 1);

		terminal.stop();
	});

	it("poll timer self-disables when Mode 2031 fires outside WSL", () => {
		vi.useFakeTimers();
		const { terminal, queryCount } = setupTerminal();

		// Complete initial OSC 11 + DA1 cycle. Two DA1 sentinels are in flight at
		// startup (keyboard probe + OSC 11), so emit two DA1 replies.
		process.stdin.emit("data", "\x1b]11;rgb:ffff/ffff/ffff\x07");
		process.stdin.emit("data", "\x1b[?1;2c");
		process.stdin.emit("data", "\x1b[?1;2c");

		const afterInitial = queryCount();

		// Advance 2s — poll should fire and send another query
		vi.advanceTimersByTime(2000);
		expect(queryCount()).toBe(afterInitial + 1);

		// Complete poll's OSC 11 + DA1 (only one DA1 sentinel — keyboard probe is one-shot)
		process.stdin.emit("data", "\x1b]11;rgb:ffff/ffff/ffff\x07");
		process.stdin.emit("data", "\x1b[?1;2c");
		// Send Mode 2031 notification — this activates push mode and stops polling
		process.stdin.emit("data", "\x1b[?997;1n");
		vi.advanceTimersByTime(100);

		// Complete Mode 2031's re-query
		process.stdin.emit("data", "\x1b]11;rgb:0000/0000/0000\x07");
		process.stdin.emit("data", "\x1b[?1;2c");

		const afterMode2031 = queryCount();

		// Advance 4s — no additional poll queries should fire
		vi.advanceTimersByTime(4000);
		expect(queryCount()).toBe(afterMode2031);

		terminal.stop();
	});

	it("does not start the OSC 11 poll timer under WSL", () => {
		vi.useFakeTimers();
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		Bun.env.WSL_INTEROP = "/run/WSL/1_interop";
		const { terminal, queryCount } = setupTerminal();

		process.stdin.emit("data", "\x1b]11;rgb:ffff/ffff/ffff\x07");
		process.stdin.emit("data", "\x1b[?1;2c");
		process.stdin.emit("data", "\x1b[?1;2c");
		const afterInitial = queryCount();

		vi.advanceTimersByTime(4000);

		expect(queryCount()).toBe(afterInitial);

		terminal.stop();
	});

	it("partial OSC 11 buffer does not swallow unrelated input", () => {
		vi.useFakeTimers();
		const { terminal, received } = setupTerminal();

		// Send a partial OSC 11 start (no terminator)
		process.stdin.emit("data", "\x1b]11;rgb:ff");
		// Flush StdinBuffer timeout so the partial sequence is emitted
		vi.advanceTimersByTime(50);

		// Send an unrelated escape sequence (up arrow)
		process.stdin.emit("data", "\x1b[A");
		vi.advanceTimersByTime(50);

		// The up arrow must be forwarded to the input handler
		expect(received).toContain("\x1b[A");

		terminal.stop();
	});

	it("DA1 from old query does not cancel new queued query", () => {
		vi.useFakeTimers();
		const { terminal, queryCount, sentinelCount } = setupTerminal();
		const appearances: string[] = [];
		terminal.onAppearanceChange(a => appearances.push(a));

		// Step 1: initial query was sent on start
		expect(queryCount()).toBe(1);
		expect(sentinelCount()).toBe(1);

		// Step 2: Mode 2031 notification arrives — queues re-query since initial is pending
		process.stdin.emit("data", "\x1b[?997;1n");

		// Step 3: Complete initial OSC 11 response (light)
		process.stdin.emit("data", "\x1b]11;rgb:ffff/ffff/ffff\x07");

		// Advance past debounce timer
		vi.advanceTimersByTime(100);

		// Step 4: Complete both initial DA1 sentinels — keyboard probe first, then OSC 11.
		// The keyboard sentinel doesn't kick the queued OSC 11 query; the OSC 11 one does.
		process.stdin.emit("data", "\x1b[?1;2c");
		process.stdin.emit("data", "\x1b[?1;2c");

		expect(queryCount()).toBe(2);
		expect(sentinelCount()).toBe(2);

		// Step 5: Complete 2nd OSC 11 response with a different color (dark)
		process.stdin.emit("data", "\x1b]11;rgb:0000/0000/0000\x07");

		// Step 6: Complete 2nd DA1
		process.stdin.emit("data", "\x1b[?1;2c");

		// Step 7: Verify appearance changed and callback fired
		expect(terminal.appearance).toBe("dark");
		expect(appearances).toContain("light");
		expect(appearances).toContain("dark");
		expect(appearances.length).toBe(2);

		terminal.stop();
	});

	it("reassembles a DA1 response split across stdin reads without leaking to input (#1238)", () => {
		vi.useFakeTimers();
		const { terminal, received } = setupTerminal();

		// OSC 11 completes normally.
		process.stdin.emit("data", "\x1b]11;rgb:1c1c/1c1c/1c1c\x07");

		// DA1 reply arrives split: the prefix appears as one event and then the StdinBuffer
		// flush timeout (10ms) elapses before the rest of the response is delivered.
		// xterm-style "VT420 with extensions" response: \x1b[?62;6;7;14;...;52c
		process.stdin.emit("data", "\x1b[?62");
		vi.advanceTimersByTime(50);
		process.stdin.emit("data", ";6;7;14;21;22;23;24;28;32;42;52c");

		expect(received).toEqual([]);
		expect(terminal.appearance).toBe("dark");

		terminal.stop();
	});

	it("reassembles a DA1 response delivered byte-by-byte", () => {
		vi.useFakeTimers();
		const { terminal, received } = setupTerminal();

		process.stdin.emit("data", "\x1b]11;rgb:1c1c/1c1c/1c1c\x07");
		process.stdin.emit("data", "\x1b[?62");
		vi.advanceTimersByTime(50);
		for (const ch of ";6;7;14;21;22;23;24;28;32;42;52c") {
			process.stdin.emit("data", ch);
		}

		expect(received).toEqual([]);
		expect(terminal.appearance).toBe("dark");

		terminal.stop();
	});

	it("abandons private CSI reassembly when a new escape arrives mid-stream", () => {
		vi.useFakeTimers();
		const { terminal, received } = setupTerminal();

		// Start a partial DA1, then a fresh CSI (up arrow) interrupts before the terminator.
		process.stdin.emit("data", "\x1b[?62");
		vi.advanceTimersByTime(50);
		process.stdin.emit("data", "\x1b[A");
		vi.advanceTimersByTime(50);

		// Up arrow must reach the input handler; probe noise must not.
		expect(received).toContain("\x1b[A");
		expect(received.some(seq => seq.includes("?62"))).toBe(false);

		terminal.stop();
	});

	it("kitty keyboard probe owns its own DA1 sentinel — does not consume OSC 11's", () => {
		const { terminal, writes, received } = setupTerminal();

		// The probe must use `\x1b[?u` (query only). Pushing `\x1b[>31u` would
		// leak a frame onto the kitty stack that shutdown's single pop cannot balance.
		expect(writes.some(w => w.includes("\x1b[>31u"))).toBe(false);
		expect(writes).toContain("\x1b[?u\x1b[c");

		// Two DA1 sentinels are in flight at startup (keyboard probe + OSC 11).
		// Consume them in send-order and verify neither leaks to the input handler.
		process.stdin.emit("data", "\x1b[?1;2c");
		process.stdin.emit("data", "\x1b[?1;2c");
		expect(received).toEqual([]);

		// A third stray DA1 has no owner and must reach the input handler — it is
		// no longer ours to swallow.
		process.stdin.emit("data", "\x1b[?1;2c");
		expect(received).toEqual(["\x1b[?1;2c"]);

		terminal.stop();
	});

	it("keyboard DA1 arriving before OSC 11 reply does not falsely mark OSC 11 unsupported", () => {
		const { terminal } = setupTerminal();

		// Keyboard's DA1 arrives first (sent-order). OSC 11 must remain pending.
		process.stdin.emit("data", "\x1b[?1;2c");

		// OSC 11 reply still arrives after — its handler should still parse it
		// (osc11Pending must not have been cleared by the keyboard DA1).
		process.stdin.emit("data", "\x1b]11;rgb:0000/0000/0000\x07");
		expect(terminal.appearance).toBe("dark");

		// OSC 11's own DA1 sentinel drains the FIFO without re-entering the bug path.
		process.stdin.emit("data", "\x1b[?1;2c");

		terminal.stop();
	});

	it("shutdown balances the single kitty push performed on detection", () => {
		const { terminal, writes } = setupTerminal();

		// Simulate kitty-capable terminal reply (level >=1).
		process.stdin.emit("data", "\x1b[?1u");

		const pushes = writes.filter(w => w === "\x1b[>1u" || w === "\x1b[>7u" || w === "\x1b[>31u").length;
		expect(pushes).toBe(1);

		terminal.stop();
		const pops = writes.filter(w => w === "\x1b[<u").length;
		expect(pops).toBe(1);
	});
});
