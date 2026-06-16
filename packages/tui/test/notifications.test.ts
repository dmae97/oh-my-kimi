import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import {
	getTerminalInfo,
	isOsc99Supported,
	NotifyProtocol,
	setOsc99Supported,
	TERMINAL,
} from "@oh-my-pi/pi-tui/terminal-capabilities";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";

const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const stdinSetRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
const originalOsc99Probe = Bun.env.PI_TUI_OSC99_PROBE;
const mutableTerminal = TERMINAL as unknown as { notifyProtocol: NotifyProtocol };
const originalNotifyProtocol = mutableTerminal.notifyProtocol;

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

function setupProcessTerminal() {
	const writes: string[] = [];
	const received: string[] = [];
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdin, "setRawMode", { value: vi.fn(), configurable: true });
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
	return { terminal, writes, received };
}

// setupProcessTerminal() drives the real ProcessTerminal start()/probe path, so
// these cases opt out of the test-default headless suppression.
let previousHeadless = false;

describe("terminal notifications", () => {
	beforeEach(() => {
		setOsc99Supported(false);
		previousHeadless = setTerminalHeadless(false);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		setTerminalHeadless(previousHeadless);
		setOsc99Supported(false);
		mutableTerminal.notifyProtocol = originalNotifyProtocol;
		restoreEnv("PI_TUI_OSC99_PROBE", originalOsc99Probe);
		restoreProperty(process.stdin, "isTTY", stdinIsTtyDescriptor);
		restoreProperty(process.stdout, "isTTY", stdoutIsTtyDescriptor);
		restoreProperty(process.stdin, "setRawMode", stdinSetRawModeDescriptor);
	});

	it("keeps string notification formatting backward-compatible", () => {
		const terminal = getTerminalInfo("kitty");
		expect(terminal.formatNotification("hello")).toBe("\x1b]99;;hello\x1b\\");
	});

	it("falls back to a single OSC 99 line until rich support is confirmed", () => {
		const terminal = getTerminalInfo("kitty");
		expect(terminal.formatNotification({ title: "Session", body: "Complete" })).toBe(
			"\x1b]99;;Session: Complete\x1b\\",
		);
	});

	it("formats structured Kitty OSC 99 title and body chunks", () => {
		setOsc99Supported(true);
		const terminal = getTerminalInfo("kitty");
		const out = terminal.formatNotification({
			title: "Session",
			body: "Complete",
			id: "complete-1",
			type: "completion",
			urgency: "normal",
			iconName: "info",
			sound: "info",
			actions: "focus",
			expiresMs: 5000,
		});

		expect(out).toBe(
			"\x1b]99;i=complete-1:f=T2ggTXkgUGk=:a=focus:u=1:t=Y29tcGxldGlvbg==:n=aW5mbw==:s=aW5mbw==:w=5000:d=0;Session\x1b\\" +
				"\x1b]99;i=complete-1:p=body;Complete\x1b\\",
		);
	});

	it("base64-encodes unsafe OSC 99 payload controls", () => {
		setOsc99Supported(true);
		const terminal = getTerminalInfo("kitty");
		const out = terminal.formatNotification({ title: "Line 1\nLine 2", id: "unsafe" });
		expect(out).toBe("\x1b]99;i=unsafe:f=T2ggTXkgUGk=:e=1;TGluZSAxCkxpbmUgMg==\x1b\\");
	});

	it("queries and confirms OSC 99 support before rich notifications", () => {
		Bun.env.PI_TUI_OSC99_PROBE = "1";
		mutableTerminal.notifyProtocol = NotifyProtocol.Osc99;
		const { terminal, writes, received } = setupProcessTerminal();
		try {
			const query = writes.find(w => w.startsWith("\x1b]99;i=omp-probe-") && w.endsWith("\x1b\\\x1b[c"));
			expect(query).toBeDefined();
			const id = query!.match(/i=([^:;]+):p=\?/u)?.[1];
			expect(id).toBeDefined();

			process.stdin.emit("data", `\x1b]99;i=${id}:p=?;p=title,body:a=focus,report:s=system,silent:w=1\x1b\\`);

			expect(isOsc99Supported()).toBe(true);
			expect(received).toEqual([]);
		} finally {
			terminal.stop();
		}
	});

	it("marks OSC 99 unsupported when the DA1 sentinel wins", () => {
		Bun.env.PI_TUI_OSC99_PROBE = "1";
		mutableTerminal.notifyProtocol = NotifyProtocol.Osc99;
		const { terminal, received } = setupProcessTerminal();
		try {
			process.stdin.emit("data", "\x1b[?1;2c");
			process.stdin.emit("data", "\x1b[?1;2c");
			process.stdin.emit("data", "\x1b[?1;2c");

			expect(isOsc99Supported()).toBe(false);
			expect(received).toEqual([]);
		} finally {
			terminal.stop();
		}
	});
});
