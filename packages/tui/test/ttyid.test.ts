import { afterEach, describe, expect, it } from "bun:test";
import { getTerminalId } from "@oh-my-pi/pi-tui/ttyid";

const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const terminalEnvKeys = [
	"KITTY_WINDOW_ID",
	"CMUX_SURFACE_ID",
	"TMUX_PANE",
	"TERM_SESSION_ID",
	"WT_SESSION",
] as const;
const originalTerminalEnv = Object.fromEntries(terminalEnvKeys.map(key => [key, process.env[key]]));

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(target, key, descriptor);
		return;
	}
	delete (target as Record<string, unknown>)[key];
}

function setTerminalEnv(overrides: Partial<Record<(typeof terminalEnvKeys)[number], string>>): void {
	for (const key of terminalEnvKeys) {
		const value = overrides[key];
		if (value === undefined) {
			delete process.env[key];
			continue;
		}
		process.env[key] = value;
	}
}

describe("getTerminalId", () => {
	afterEach(() => {
		restoreProperty(process.stdin, "isTTY", stdinIsTtyDescriptor);
		for (const key of terminalEnvKeys) {
			const value = originalTerminalEnv[key];
			if (value === undefined) {
				delete process.env[key];
				continue;
			}
			process.env[key] = value;
		}
	});

	it("uses CMUX_SURFACE_ID as the terminal identity when stdin is piped", () => {
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
		setTerminalEnv({ CMUX_SURFACE_ID: "surface-1234" });

		expect(getTerminalId()).toBe("cmux-surface-1234");
	});
});
